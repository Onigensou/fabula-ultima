// DirectorCombat — director-owned combat state.
//
// As of the "no Foundry Combat doc" rework, this is the SOLE authority for
// combat state. The director does NOT create a Foundry `Combat` document —
// dropping it removes the dual-source-of-truth problem (Lancer Initiative
// would render the Foundry "current combatant" as activating before the
// director's picker resolved, confusing the UI).
//
// `sourceSceneId` is stamped here at construction (formerly stamped on the
// Combat doc's `directorMode` flag) so [BattleEnd: Director Manager] can
// return to the source scene on stop.
//
// Phase 2 scope (current):
//   - Side-based alternation per Fabula Ultima Feb 2026 playtest variant
//   - First-side rule: any Villain on the enemy side → enemies go first;
//     else PCs go first. No initiative roll for Director ordering.
//   - Per-combatant turnsPerRound (from system.props.activation, default 1)
//     and turnsRemaining counters. Champions naturally get multi-turn rounds.
//   - Outnumbered side burns its remaining turns once the other side is
//     exhausted (per Core p. 62).
//   - Defeated combatants forfeit remaining turns.
//   - Dynamic turn order within a side: caller (TurnStart) picks via
//     turn-picker UI when multiple eligible; auto-picks when only one.
//
// Future phases:
//   - Phase 3: activation counters fully here (drop Lancer flag dependency)
//   - Phase 4: reload survival (persist to world flag)

import { log, warn } from "./logger.js";

// Read activation count from actor (Champions/Elites can have >1).
// Mirrors the legacy `readDesiredActivations` in `Battle Initiator`.
function readActivations(actor) {
  const candidates = [
    actor?.system?.props?.activation,
    actor?.system?.activation,
    actor?.system?.attributes?.activation,
    actor?.system?.details?.activation,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const n = typeof c === "number" ? c : Number(String(c).replace(/[^0-9]/g, ""));
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 1;
}

function readBool(actor, keys) {
  for (const k of keys) {
    const v = actor?.system?.props?.[k];
    if (v === true || v === "true" || v === 1 || v === "1") return true;
  }
  return false;
}

function readRank(actor) {
  const direct = actor?.system?.props?.npc_rank ?? actor?.system?.props?.rank;
  if (typeof direct === "string") {
    const s = direct.trim().toLowerCase();
    if (s === "champion" || s === "elite" || s === "soldier") return s;
  }
  if (readBool(actor, ["champion"])) return "champion";
  if (readBool(actor, ["elite"])) return "elite";
  return "soldier";
}

export class DirectorCombatant {
  constructor({ tokenDoc, actorDoc, side, disposition, initiative = null }) {
    if (!tokenDoc) throw new Error("DirectorCombatant: tokenDoc is required");
    this.id = foundry.utils?.randomID?.() ?? `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Live refs — the FSM uses these directly so it doesn't have to
    // re-resolve from canvas/Foundry every transition. They go stale if
    // the underlying doc is deleted; the director must clean up its
    // combatant list when that happens (cleanup in a later phase).
    this.tokenDoc = tokenDoc;
    this.actorDoc = actorDoc ?? tokenDoc.actor ?? null;

    this.tokenId = tokenDoc.id;
    this.tokenUuid = tokenDoc.uuid;
    this.actorId = this.actorDoc?.id ?? tokenDoc.actorId ?? null;
    this.actorUuid = this.actorDoc?.uuid ?? null;
    this.name = this.actorDoc?.name ?? tokenDoc.name ?? "Unknown";
    this.disposition = disposition ?? tokenDoc.disposition ?? 0;

    this.side = side ?? (this.disposition === -1 ? "enemy" : "party");

    const a = this.actorDoc;
    this.isVillain = readBool(a, ["isVillain", "villain"]);
    this.isBoss = readBool(a, ["isBoss", "boss"]);
    this.rank = readRank(a);
    this.turnsPerRound = readActivations(a);
    this.turnsRemaining = this.turnsPerRound;

    this.initiative = initiative;
    this.defeated = false;

    // Free-form flags slot.
    this.flags = Object.create(null);
  }

  // Has live actor HP ≤ 0? Defensive — used by eligibility checks.
  isDefeatedLive() {
    if (this.defeated) return true;
    const a = this.actorDoc;
    const hp = a?.system?.props?.current_hp ?? a?.system?.props?.hp;
    if (hp == null) return false;
    const n = typeof hp === "number" ? hp : Number(String(hp).replace(/[^0-9-]/g, ""));
    return Number.isFinite(n) && n <= 0;
  }
}

export class DirectorCombat {
  constructor({ scene, sourceSceneId = null }) {
    if (!scene) throw new Error("DirectorCombat: scene is required");
    this.id = foundry.utils?.randomID?.() ?? `dc-${Date.now()}`;
    this.scene = scene;
    this.sceneId = scene.id;
    // Where the GM was before the battle started; used to return on stop.
    this.sourceSceneId = sourceSceneId;

    this.round = 0;
    // `turn` is kept for Foundry-mirror diagnostics only; not used for ordering.
    this.turn = 0;
    this.started = false;
    this.ended = false;
    this.combatants = [];

    // Side-based alternation state.
    this.firstSide = "party";        // computed by buildDirectorCombat
    this.currentSide = "party";      // flips during nextTurn
    this.currentCombatantId = null;  // resolved by the picker (or auto-pick)

    // Reload-survival commit marker. Flipped to true when RESOLVE has
    // applied damage/AE/equipment for the current turn (after that, a
    // reload should resume at TURN_END so the player doesn't re-trigger
    // the action and double-apply damage). Reset to false at TurnStart
    // for a fresh turn. See persistence.js + state-handlers TurnStart /
    // RESOLVE for the write sites, and director-boot resumeFromSavedState
    // for the read site.
    this.currentTurnResolved = false;

    // Active Guards table — tracks each guarder's Guard AE + optional
    // Covered AE for cleanup at the start of their next turn (TURN_START
    // releases them). One entry per active Guard. Generic enough to also
    // hold future "until-next-turn" effects (e.g. Provoke), since the
    // expiry condition is the same: the source actor's turn coming back
    // around.
    //   {
    //     guarderActorUuid: string,
    //     guarderActorId:   string,    (fast lookup)
    //     guarderEffectId:  string,    AE id on the guarder
    //     coveredActorUuid: string|null,
    //     coveredEffectId:  string|null,
    //     appliedAtRound:   number,
    //   }
    this.activeGuards = [];
  }

  // Append a new Guard entry. Caller is responsible for the AE create on
  // the actors first (so the AE ids can be passed in).
  addActiveGuard(entry) {
    if (!entry?.guarderActorUuid) return null;
    this.activeGuards.push({
      guarderActorUuid: entry.guarderActorUuid,
      guarderActorId:   entry.guarderActorId   ?? null,
      guarderEffectId:  entry.guarderEffectId  ?? null,
      coveredActorUuid: entry.coveredActorUuid ?? null,
      coveredEffectId:  entry.coveredEffectId  ?? null,
      appliedAtRound:   entry.appliedAtRound   ?? this.round,
    });
    return this.activeGuards[this.activeGuards.length - 1];
  }

  // Pull (and return) all entries where the guarder matches. Removes
  // them from the list in one pass. Caller then deletes the AEs.
  popActiveGuardsFor(guarderActorId) {
    if (!guarderActorId) return [];
    const matched = [];
    const remaining = [];
    for (const g of this.activeGuards) {
      if (g.guarderActorId === guarderActorId) matched.push(g);
      else remaining.push(g);
    }
    this.activeGuards = remaining;
    return matched;
  }

  // ── Accessors ───────────────────────────────────────────────────────

  // currentCombatantId is an accessor so that ASSIGNING it (the picker does
  // `dc.currentCombatantId = id` at turn start, and nextTurn clears it) fires
  // the turn-action hook — that's how the tracker moves the "active turn" glow
  // onto whoever's acting. Backed by `_currentCombatantId`; only fires on a
  // real change once combat is live (avoids construction/reconstruct noise).
  get currentCombatantId() { return this._currentCombatantId ?? null; }
  set currentCombatantId(id) {
    const next = id ?? null;
    if (next === (this._currentCombatantId ?? null)) return;
    this._currentCombatantId = next;
    if (this.started && !this.ended) {
      try { this._notifyTurnActions(); } catch (_e) {}
    }
  }

  get current() {
    if (this.ended || !this.started) return null;
    if (!this.currentCombatantId) return null;
    return this.findById(this.currentCombatantId);
  }

  get size() {
    return this.combatants.length;
  }

  findByTokenId(tokenId) {
    return this.combatants.find((c) => c.tokenId === tokenId) ?? null;
  }

  findById(id) {
    return this.combatants.find((c) => c.id === id) ?? null;
  }

  // Eligible combatants on a side = un-defeated with turnsRemaining > 0.
  eligibleOnSide(side) {
    return this.combatants.filter((c) =>
      c.side === side && !c.isDefeatedLive() && c.turnsRemaining > 0
    );
  }

  _otherSide(side) {
    return side === "party" ? "enemy" : "party";
  }

  // ── Mutators ────────────────────────────────────────────────────────

  addCombatant(opts) {
    const c = (opts instanceof DirectorCombatant) ? opts : new DirectorCombatant(opts);
    this.combatants.push(c);
    return c;
  }

  removeCombatant(combatantOrId) {
    const id = (typeof combatantOrId === "string") ? combatantOrId : combatantOrId?.id;
    const idx = this.combatants.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    if (this.currentCombatantId === id) this.currentCombatantId = null;
    this.combatants.splice(idx, 1);
    return true;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  start() {
    if (this.ended) {
      warn("DirectorCombat.start on an ended combat — ignoring");
      return;
    }
    if (this.started) {
      warn("DirectorCombat.start: already started");
      return;
    }
    if (!this.combatants.length) {
      warn("DirectorCombat.start: no combatants");
    }
    this.started = true;
    // Round 0 is the pre-combat phase (PREP + conflict_start reactions).
    // ROUND_START.onEnter bumps to 1 when entering the first real round,
    // and nextTurn() bumps further on wraps. The resume-routing layer
    // uses round=0 as the unambiguous "Battle Start" signal — see
    // director-boot.js' Battle Start branch.
    this.round = 0;
    this.turn = 0;
    // Initialize round-1 turn counts (constructor already set them, but
    // re-sync in case combatants were appended after construction).
    for (const c of this.combatants) c.turnsRemaining = c.turnsPerRound;
    this.currentSide = this.firstSide;
    this.currentCombatantId = null; // resolved by the first TurnStart pick
    log(`DirectorCombat started: ${this.combatants.length} combatants on ${this.scene?.name ?? "?"}, firstSide=${this.firstSide}`);
    this._notifyTurnActions();
  }

  // Fire-and-forget notification that per-combatant turn-action counts
  // changed (start / a turn was spent / a round reset). The turn-action
  // tracker UI (director-round-banner.js) listens GM-side and fans the new
  // state out to every client. Decoupled via a Foundry hook so dCombat keeps
  // no UI dependency. Never throws into the FSM.
  _notifyTurnActions() {
    try { Hooks.callAll("fu-director-turnactions", this); } catch (_e) {}
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    log(`DirectorCombat ended at round ${this.round}`);
  }

  // Reset all un-defeated combatants' turnsRemaining for a new round. Defeated
  // combatants stay at 0 — they don't get a fresh turn pool.
  _resetRoundCounters() {
    for (const c of this.combatants) {
      c.turnsRemaining = c.isDefeatedLive() ? 0 : c.turnsPerRound;
    }
  }

  // Advance past the just-acted combatant. Caller (TURN_END) calls this once
  // per turn AFTER the action resolves. Returns a result object describing
  // what side acts next + whether the round wrapped + whether combat ended.
  //
  // Does NOT pick which specific combatant acts next — that's the picker's
  // job in TURN_START. We just set `currentSide` and clear
  // `currentCombatantId`. The picker re-fills it.
  //
  // Returns:
  //   { round, currentSide, wrappedRound, ended, eligibleIds }
  nextTurn() {
    if (!this.started || this.ended) {
      warn(`nextTurn on non-active combat (started=${this.started}, ended=${this.ended})`);
      return { round: this.round, currentSide: this.currentSide, wrappedRound: false, ended: this.ended, eligibleIds: [] };
    }

    // 1. Decrement the just-acted combatant's remaining count.
    const acted = this.current;
    if (acted) {
      acted.turnsRemaining = Math.max(0, acted.turnsRemaining - 1);
      log(`nextTurn: ${acted.name} acted (turnsRemaining now ${acted.turnsRemaining}/${acted.turnsPerRound})`);
    }
    // Always clear; the picker fills it.
    this.currentCombatantId = null;

    // 2. Compute remaining eligibility per side.
    const sameSide = this.currentSide;
    const otherSide = this._otherSide(sameSide);
    let sameEligible = this.eligibleOnSide(sameSide);
    let otherEligible = this.eligibleOnSide(otherSide);

    let wrappedRound = false;
    if (otherEligible.length > 0) {
      // Alternate to other side (works whether sameSide is also eligible
      // or not — RAW says "alternate as long as possible").
      this.currentSide = otherSide;
    } else if (sameEligible.length > 0) {
      // Other side exhausted; outnumbered side burns remaining turns here.
      // currentSide stays.
    } else {
      // Both exhausted → wrap to a new round.
      this.round++;
      this.turn = 0;
      wrappedRound = true;
      this._resetRoundCounters();
      this.currentSide = this.firstSide;
      sameEligible = this.eligibleOnSide(this.currentSide);
      otherEligible = this.eligibleOnSide(this._otherSide(this.currentSide));
      log(`Round advanced to ${this.round} (firstSide=${this.firstSide})`);
      if (sameEligible.length === 0 && otherEligible.length === 0) {
        // No one un-defeated has any turns — combat is effectively over.
        // The director will detect side-wipe elsewhere; here we just signal.
        warn("nextTurn: round wrapped but no eligible combatants remain — ending");
        this.end();
        this._notifyTurnActions();
        return { round: this.round, currentSide: this.currentSide, wrappedRound: true, ended: true, eligibleIds: [] };
      }
      // If firstSide has nothing eligible post-wrap (e.g. wholly defeated),
      // switch to the other side for this round.
      if (sameEligible.length === 0) {
        this.currentSide = this._otherSide(this.currentSide);
        sameEligible = otherEligible;
      }
    }

    const eligibleIds = this.eligibleOnSide(this.currentSide).map((c) => c.id);
    this._notifyTurnActions();
    return {
      round: this.round,
      currentSide: this.currentSide,
      wrappedRound,
      ended: false,
      eligibleIds,
    };
  }

  // ── Diagnostic ──────────────────────────────────────────────────────

  snapshot() {
    return {
      id: this.id,
      sceneId: this.sceneId,
      sceneName: this.scene?.name,
      round: this.round,
      firstSide: this.firstSide,
      currentSide: this.currentSide,
      currentCombatantId: this.currentCombatantId,
      started: this.started,
      ended: this.ended,
      current: this.current?.name ?? null,
      combatants: this.combatants.map((c) => ({
        id: c.id,
        name: c.name,
        side: c.side,
        isVillain: c.isVillain,
        isBoss: c.isBoss,
        rank: c.rank,
        turnsPerRound: c.turnsPerRound,
        turnsRemaining: c.turnsRemaining,
        disposition: c.disposition,
        tokenId: c.tokenId,
        defeated: c.isDefeatedLive(),
      })),
    };
  }
}

// Build a DirectorCombat from a list of TokenDocument arrays. Used by
// PrepState directly (no Foundry Combat doc is created in director mode).
//
// First-side rule (Fabula Ultima Feb 2026 playtest variant): if ANY enemy
// is a Villain (or Boss), the enemy side acts first. Otherwise the party
// acts first. No initiative roll, no Initiative Score reads.
export function buildDirectorCombat({ scene, partyTokens, enemyTokens, sourceSceneId = null }) {
  const dc = new DirectorCombat({ scene, sourceSceneId });
  for (const td of (partyTokens ?? [])) {
    if (!td) continue;
    dc.addCombatant({ tokenDoc: td, side: "party", disposition: 1 });
  }
  for (const td of (enemyTokens ?? [])) {
    if (!td) continue;
    dc.addCombatant({ tokenDoc: td, side: "enemy", disposition: -1 });
  }

  const villainPresent = dc.combatants.some((c) => c.side === "enemy" && (c.isVillain || c.isBoss));
  dc.firstSide = villainPresent ? "enemy" : "party";
  dc.currentSide = dc.firstSide;
  log(`buildDirectorCombat: ${dc.size} combatants, villainPresent=${villainPresent}, firstSide=${dc.firstSide}`);
  return dc;
}

// (mirrorTurnToFoundry / mirrorEndToFoundry removed — no Foundry Combat doc
// exists in director mode anymore. dCombat is the sole authority.)
