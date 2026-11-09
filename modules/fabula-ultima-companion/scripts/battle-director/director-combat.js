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
// Speed phases (2026-11-09): every round plays QUICKEN → NORMAL → DELAY
// (speed-phase.js). eligibleOnSide() only offers the earliest phase that still
// has turns, so the turn picker AND the enemy autopilot follow it without
// knowing phases exist. The side alternation is untouched and carries straight
// across a phase border. A creature's phase locks at its first turn of the
// round (a status landing after that applies next round); an un-acted creature
// reads its statuses live, so Quicken/Delay applied mid-round move it at once.
//
// Free Round (2026-11-09): an Ambush / Player Advantage engagement gives the
// favoured side ONE extra round, before Round 1, with all of its activations.
// It is round 0 with `freeRound` set: ROUND reads 0, enemy patterns keyed to
// "Round No. 1" still open Round 1, and round-level rules (round_start /
// round_end triggers, conflict-event beats, the initiative roll, Dominance)
// wait for Round 1. Turn-level rules run as usual. See enterFreeRound().

import { log, warn } from "./logger.js";
import { speedTierOf as actorSpeedTier, PHASE_ORDER, tierName } from "./speed-phase.js";

// Base activation count from actor (Champions/Elites can have >1; PCs default 1).
// Mirrors the legacy `readDesiredActivations` in `Battle Initiator`.
function readBaseActivation(actor) {
  const candidates = [
    actor?.system?.props?.activation,
    actor?.system?.activation,
    actor?.system?.attributes?.activation,
    actor?.system?.details?.activation,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    let n;
    if (typeof c === "number") {
      n = c;
    } else {
      // Strip formatting but keep an explicit "0" (an Active Effect can set
      // activation to 0 to make a creature skip its turn). Treat an empty/
      // blank value as "not set" so the default still kicks in.
      const s = String(c).replace(/[^0-9.\-]/g, "");
      if (s === "" || s === "-" || s === ".") continue;
      n = Number(s);
    }
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 1;
}

// Effective actions per round = base activation + `bonus_activation` accumulator
// (buffs/debuffs add to the bonus; Haste = +1, Slow = −1). Clamped to ≥ 0
// (0 = the creature gets no turn this round). This is re-read each round so
// changes to either prop — via Active Effects or a direct edit — take effect
// live without rebuilding the combat. See _effectiveActivation / start /
// _resetRoundCounters for the read sites.
function readActivations(actor) {
  const base = readBaseActivation(actor);
  const raw = actor?.system?.props?.bonus_activation;
  const bonus = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  return Math.max(0, base + bonus);
}

// A combatant is a Phantasm when its actor carries `isPhantasm` (the Fox fire
// template) OR its token was stamped `isPhantasm` by summon_type:"phantasm".
// Reads only persistent state so the 0-turns/round result survives reload.
function combatantIsPhantasm(c) {
  if (c?.actorDoc?.system?.props?.isPhantasm) return true;
  try { return !!c?.tokenDoc?.getFlag?.("fabula-ultima-companion", "isPhantasm"); }
  catch { return false; }
}

// An authored activation pin stamped on the token by `summon_turns_per_round`
// (skill-effects.summon). Returns the pinned turns/round, or null when the
// spawn carries no pin and activation should be read off the actor as usual.
//
// Token FLAG, not an actor prop, for two reasons: the pin belongs to THIS
// spawn (the same base actor may be summoned elsewhere with its own turn), and
// a flag survives the reload + round-wrap recompute that made a combatant-only
// write silently revert. Reads only persistent state for that reason.
function combatantPinnedTurns(c) {
  let raw;
  try { raw = c?.tokenDoc?.getFlag?.("fabula-ultima-companion", "turnsPerRound"); }
  catch { return null; }
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
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

    // Speed-phase lock: { round, tier } stamped when this creature takes its
    // FIRST turn of a round. While it matches the live round, the creature
    // stays in that phase for the rest of the round (all its activations move
    // together); a Quicken/Delay landing after that applies next round.
    this.phaseLock = null;

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

    // ── Runaway watchdog ────────────────────────────────────
    // Turns actually TAKEN in the current round, and how many rounds in a row
    // have passed with none. A healthy round always has at least one combatant
    // act; a round in which literally nobody acts means the combat has lost the
    // world it was running in — scene deactivated, tokens gone — and is spinning
    // rather than playing.
    //
    // Seen live: a director whose Foundry Combat had been deleted and whose
    // scene was switched out from under it kept wrapping rounds at roughly 40
    // a minute, announcing every one, until it was stopped by hand.
    // director-boot states plainly that the End-Battle button is the only way
    // out, which is exactly why nothing else ever caught this.
    this._turnsTakenThisRound = 0;
    this._barrenRounds = 0;
    this.started = false;
    this.ended = false;
    this.combatants = [];

    // ── Initiative rule + engagement (set by buildDirectorCombat from payload) ──
    // initiativeMode:
    //   "rolled"       — Fabula Ultima Initiative Group Check, RE-ROLLED every
    //                    round (custom ruling). Whichever side wins the check
    //                    seizes initiative (acts first) that round. The roll is
    //                    run backend at ROUND_START (director-initiative.js) and
    //                    the winning side is written to firstSide/currentSide +
    //                    recorded in initiativeThisRound. This is the DEFAULT.
    //   "sidePriority" — the legacy fixed rule: any enemy Villain/Boss present →
    //                    enemies act first all fight; else the party acts first.
    //                    No roll, no initiative banner.
    this.initiativeMode = "rolled";
    // engagement: "normal" | "ambush" | "advantage". Ambush/Advantage add a Free
    // Round BEFORE Round 1: only the favoured side acts, with all its
    // activations. Round 1 onward is a normal round (initiativeMode decides who
    // leads). See enterFreeRound().
    this.engagement = "normal";
    // Free Round state. `freeRoundPending` is set at start() for an
    // Ambush/Advantage fight and consumed by the first ROUND_START, which calls
    // enterFreeRound(). `freeRound` is true for the whole Free Round (round 0),
    // including its round-end phase, and cleared by beginPendingRound() as Round
    // 1 begins. `freeRoundSide` is the side that acts in it.
    this.freeRoundPending = false;
    this.freeRound = false;
    this.freeRoundSide = null;

    // Held summon free actions (Quicken/Delay on a summon with no turn of its
    // own — Birth of the Cruel's Minion). A held action waits for the END of its
    // phase: Delay → the end of the round; Quicken → the end of the Quicken
    // phase (next round's, when this round's is already over). Released by
    // takeDueHeldActions() from the standalone reaction window. Shape:
    //   { request, tier, round, heldAtPhase, performerTokenUuid, name }
    // `request` is the FreeActionRequest exactly as it would have been queued.
    this.heldSummonActions = [];
    // Per-round initiative result, committed by ROUND_START's resolver so a
    // mid-round reload doesn't re-roll and flip sides. Shape:
    //   { round, side, leaderName?, leaderTotal?, dl?, bonus?, forced? }
    // `forced:true` marks a round whose side came from ambush/advantage (round 1)
    // rather than a rolled check. Serialized by persistence.js.
    this.initiativeThisRound = null;

    // Side-based alternation state.
    this.firstSide = "party";        // computed by buildDirectorCombat
    this.currentSide = "party";      // flips during nextTurn
    this.currentCombatantId = null;  // resolved by the picker (or auto-pick)
    // Turn manipulation: a combatant id that should act IMMEDIATELY after the
    // current turn (one-shot, consumed in nextTurn). Set via forceNextTurn().
    this.forcedNextCombatantId = null;
    // Set by nextTurn() when both sides are exhausted; consumed by
    // beginPendingRound() from ROUND_START. Between the two the round-end phase
    // runs (ROUND_END -> round_end reactions -> Late Actor free actions) still
    // INSIDE the round that just finished — see nextTurn's wrap branch.
    this.pendingRoundWrap = false;

    // Solo-player test mode (dev Test Battle tool): when set, every combatant
    // whose actorUuid differs gets 0 turns per round, so only the main player
    // ever acts. The FSM's empty-side handling skips the 0-turn side cleanly.
    this.soloPlayerActorUuid = null;

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

    // Study guard (RAW Core p.74: "you can study the same aspect of a creature
    // only once"). Tracks which target TOKENS each studier ACTOR has
    // successfully (non-fumbled) Studied this fight, so a second Study by the
    // same person on the same enemy token is shown as not-targetable in the
    // Study target picker (mirrors the Provoked / cannot_target overlay).
    // Keyed by studier actor id → Set<target token uuid>. In-memory and
    // fight-scoped: a fresh DirectorCombat (new fight) starts empty, and the
    // scene-end teardown discards it. NOT serialized, so a mid-fight reload
    // resets it — acceptable, since the encyclopedia already prevents a
    // re-study from revealing anything new. See markStudied / hasStudied.
    this.studyLog = new Map();

    // Per-turn SPELL MP-spend tally (Bimagus). actorId → MP spent on Spell
    // actions this turn. Reset at the actor's TURN_START. See addSpellMpSpent /
    // spellMpSpentThisTurn / resetSpellMpSpent and the MP_SPENT_THIS_TURN
    // formula identifier.
    this.mpSpentOnSpells = new Map();

    // Per-turn, per-TARGET landed-hit tally (Champion Gloves / Hot Pants).
    // `${actorId}::${targetTokenUuid}` → how many times that actor has hit that
    // target during their CURRENT turn. Reset at the actor's TURN_START, same
    // lifetime and trade-offs as mpSpentOnSpells (in-memory, not serialized).
    // Read via HITS_ON_TARGET_THIS_TURN. Distinct from HIT_COUNT, which counts
    // targets struck by the CURRENT action only.
    this.hitsOnTargets = new Map();
  }

  // Record that `studierActorId` has Studied the token `targetTokenUuid` this
  // fight (called from RESOLVE on a non-fumbled Study). Idempotent.
  markStudied(studierActorId, targetTokenUuid) {
    if (!studierActorId || !targetTokenUuid) return;
    let set = this.studyLog.get(studierActorId);
    if (!set) { set = new Set(); this.studyLog.set(studierActorId, set); }
    set.add(targetTokenUuid);
  }

  // Has `studierActorId` already Studied this exact token this fight?
  hasStudied(studierActorId, targetTokenUuid) {
    if (!studierActorId || !targetTokenUuid) return false;
    return this.studyLog.get(studierActorId)?.has(targetTokenUuid) ?? false;
  }

  // The token uuids `studierActorId` has already Studied this fight (array,
  // never null) — used to build the Study target-picker exclusion overlay.
  studiedTokensFor(studierActorId) {
    const set = studierActorId ? this.studyLog.get(studierActorId) : null;
    return set ? [...set] : [];
  }

  // Per-turn SPELL MP-spend accumulator (Bimagus). Sums the MP an actor spends
  // on Spell actions during their CURRENT turn — the native spell cost PLUS any
  // in-chain `consume_resource` MP that is part of the spell's cost (e.g.
  // Cataclysm's cost-raise). Reset at the actor's TURN_START. Read via the
  // `MP_SPENT_THIS_TURN` formula identifier so a `turn_end` reaction can size a
  // free-cast budget. Keyed by actor id. In-memory + turn-scoped (NOT
  // serialized — a mid-turn reload resets it, same trade-off as studyLog).
  addSpellMpSpent(actorId, amount) {
    const n = Number(amount) || 0;
    if (!actorId || n <= 0) return;
    this.mpSpentOnSpells.set(actorId, (this.mpSpentOnSpells.get(actorId) ?? 0) + n);
  }

  // MP this actor has spent on Spell actions so far THIS turn (0 if none).
  spellMpSpentThisTurn(actorId) {
    return actorId ? (this.mpSpentOnSpells.get(actorId) ?? 0) : 0;
  }

  // Clear the actor's spell-MP tally — called at their TURN_START so the
  // budget only ever reflects the current turn.
  resetSpellMpSpent(actorId) {
    if (actorId) this.mpSpentOnSpells.delete(actorId);
  }

  // ── Per-turn, per-target landed-hit tally (Champion Gloves / Hot Pants) ──
  // Recorded once per GENUINELY hit target as an attack resolves (a pierce-miss
  // is a miss and is NOT counted). Keyed by actor + target token so "hit the
  // target" means that specific creature, not any creature.
  addHitOnTarget(actorId, targetTokenUuid) {
    if (!actorId || !targetTokenUuid) return;
    const k = `${actorId}::${targetTokenUuid}`;
    this.hitsOnTargets.set(k, (this.hitsOnTargets.get(k) ?? 0) + 1);
  }

  // How many times `actorId` has already hit `targetTokenUuid` this turn.
  // The tally is bumped AFTER an action resolves, so a bonus read during an
  // action sees the hits that landed BEFORE it. That ordering is forced by Hot
  // Pants: accuracy is consumed before the hit is known, so "times you hit this
  // turn" can only mean prior hits. Champion Gloves uses the same reading so the
  // pair stays consistent.
  hitsOnTargetThisTurn(actorId, targetTokenUuid) {
    if (!actorId || !targetTokenUuid) return 0;
    return this.hitsOnTargets.get(`${actorId}::${targetTokenUuid}`) ?? 0;
  }

  // Drop every tally belonging to this actor — called at their TURN_START.
  resetHitsOnTargets(actorId) {
    if (!actorId) return;
    const prefix = `${actorId}::`;
    for (const k of [...this.hitsOnTargets.keys()]) {
      if (k.startsWith(prefix)) this.hitsOnTargets.delete(k);
    }
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

  // Un-defeated with turnsRemaining > 0, on either side, ignoring phases.
  _hasTurnsLeft(c) {
    return !c.isDefeatedLive() && c.turnsRemaining > 0;
  }

  // The phase tier this combatant acts in THIS round: its lock if it has
  // already taken a turn this round, else its live Quicken/Delay statuses.
  // The token's actor first — an unlinked NPC's statuses live on its synthetic
  // actor, not the base actor `actorDoc` may point at.
  speedTierOf(c) {
    if (c?.phaseLock && c.phaseLock.round === this.round) return c.phaseLock.tier;
    try { return actorSpeedTier(c?.tokenDoc?.actor ?? c?.actorDoc ?? null); }
    catch (e) { warn(`speedTierOf(${c?.name}) threw — treating as Normal`, e); return 0; }
  }

  // The phase being played: the earliest phase (Quicken → Normal → Delay) that
  // still has a combatant with turns left on EITHER side. null = nobody left.
  currentPhaseTier() {
    const live = this.combatants.filter((c) => this._hasTurnsLeft(c));
    if (!live.length) return null;
    const tiers = new Set(live.map((c) => this.speedTierOf(c)));
    for (const t of PHASE_ORDER) if (tiers.has(t)) return t;
    return null;
  }

  // Stamp the combatant's phase for the rest of this round. Called when its
  // turn is picked (TURN_START), so a status it lands on itself during that
  // turn does not move its remaining activations. Idempotent within a round.
  lockPhase(c) {
    if (!c) return;
    if (c.phaseLock && c.phaseLock.round === this.round) return;
    const tier = this.speedTierOf(c);
    c.phaseLock = { round: this.round, tier };
    if (tier !== 0) log(`phase: ${c.name} acts in the ${tierName(tier)} phase this round`);
  }

  // Eligible combatants on a side = un-defeated, turnsRemaining > 0, AND in the
  // phase currently being played. Everything that picks a turn (TURN_START's
  // picker, the enemy autopilot, nextTurn's side choice) reads this, so the
  // phases need no other wiring. An empty list for one side while the other
  // still has turns in the phase is normal — the side alternation moves on.
  eligibleOnSide(side) {
    const phase = this.currentPhaseTier();
    if (phase === null) return [];
    return this.combatants.filter((c) =>
      c.side === side && this._hasTurnsLeft(c) && this.speedTierOf(c) === phase
    );
  }

  _otherSide(side) {
    return side === "party" ? "enemy" : "party";
  }

  // Turn-ordering policy. Always the RAW side-by-side alternation now: the old
  // "consecutive" Ambush/Advantage round 1 is replaced by the Free Round, where
  // only the favoured side has turns at all. Kept as a method so nextTurn reads
  // one place if a policy ever returns.
  _alternationPolicyForRound(_round) {
    return "alternate";
  }

  // ── Free Round ──────────────────────────────────────────────────────

  // Enter the Free Round (round 0). Called by the first ROUND_START when
  // freeRoundPending is set. The favoured side gets all of its activations;
  // the other side gets none (its reactions still work — they don't use turns).
  enterFreeRound() {
    if (!this.freeRoundPending) return false;
    this.freeRoundPending = false;
    const side = this.engagement === "ambush" ? "enemy" : "party";
    this.freeRound = true;
    this.freeRoundSide = side;
    this.round = 0;
    this.turn = 0;
    this._turnsTakenThisRound = 0;
    for (const c of this.combatants) {
      const perRound = this._effectiveActivation(c);
      c.turnsPerRound = perRound;
      c.turnsRemaining = (c.side === side && !c.isDefeatedLive()) ? perRound : 0;
    }
    this.currentSide = side;
    this.currentCombatantId = null;
    log(`Free Round (${this.engagement}): ${side} acts with all activations`);
    this._notifyTurnActions();
    return true;
  }

  // ── Held summon free actions ────────────────────────────────────────

  // Hold a summon's free action until the end of its phase. `entry` carries the
  // queued FreeActionRequest plus the performer's tier (+1 / -1).
  // `sourcePhase` = the phase of the turn that granted it (the summoner's,
  // read off its lock). Without it, the phase in play now is used — but by a
  // turn_end window nextTurn() has already run, so when the summoner was the
  // LAST Quickened creature the live phase has moved on to Normal and the
  // action would wait a whole extra round.
  holdSummonAction({ request, tier, performerTokenUuid = null, name = "", sourcePhase = undefined }) {
    const entry = {
      request, tier, round: this.round,
      // A Quicken action held after this round's Quicken phase is over waits
      // for next round's.
      heldAtPhase: sourcePhase === undefined ? this.currentPhaseTier() : sourcePhase,
      performerTokenUuid, name,
    };
    this.heldSummonActions.push(entry);
    log(`held ${name || "summon"}'s free action until the end of the ${tierName(tier)} phase (round ${this.round})`);
    return entry;
  }

  // Remove and return every held action whose phase has ended. Dead/removed
  // performers are dropped (their action never happens).
  //   Delay   → due once this round's turns are all spent (the round-end
  //             phase), or any later point.
  //   Quicken → due once the Quicken phase it is waiting for is over: this
  //             round's if it was held DURING it, else the next round's.
  takeDueHeldActions() {
    if (!this.heldSummonActions.length) return [];
    const phase = this.currentPhaseTier();
    const roundOver = this.pendingRoundWrap || phase === null;
    const due = [];
    const keep = [];
    for (const h of this.heldSummonActions) {
      const performer = this.combatants.find((c) => c.tokenUuid === h.performerTokenUuid) ?? null;
      if (!performer || performer.isDefeatedLive()) {
        log(`held action for ${h.name || "?"} dropped — performer gone`);
        continue;
      }
      let isDue = false;
      if (h.tier < 0) {
        isDue = this.round > h.round || (this.round === h.round && roundOver);
      } else {
        // The round wrap is deferred, so `this.round` is still the old round
        // through its round-end phase: an action held after this round's
        // Quicken phase stays put until the next round's has played out.
        const quickenOver = phase === null || phase < 1;
        isDue = quickenOver && (this.round > h.round || h.heldAtPhase === 1);
      }
      (isDue ? due : keep).push(h);
    }
    this.heldSummonActions = keep;
    return due;
  }

  // ── Mutators ────────────────────────────────────────────────────────

  addCombatant(opts) {
    const c = (opts instanceof DirectorCombatant) ? opts : new DirectorCombatant(opts);
    this.combatants.push(c);
    // Solo mode: a freshly-added non-player combatant gets 0 turns too.
    if (this.soloPlayerActorUuid && c.actorUuid !== this.soloPlayerActorUuid) {
      c.turnsPerRound = 0;
      c.turnsRemaining = 0;
    }
    return c;
  }

  // Turn manipulation — mark a combatant to act IMMEDIATELY after the current
  // turn (consumed once by nextTurn, overriding side-alternation). The caller is
  // responsible for ensuring the combatant has a turn available (turnsRemaining
  // > 0) — take_turn_next grants one to a freshly-summoned creature. Accepts a
  // combatant id; returns true if the combatant exists.
  forceNextTurn(combatantId) {
    const c = this.combatants.find((x) => x.id === combatantId);
    if (!c) return false;
    this.forcedNextCombatantId = combatantId;
    return true;
  }

  // Enable solo-player mode: only the given actor keeps its turns; every other
  // combatant (current + future adds) gets 0 turns per round. Pass null to
  // clear (does not restore prior turn counts).
  setSoloPlayer(actorUuid) {
    this.soloPlayerActorUuid = actorUuid || null;
    if (!actorUuid) return;
    for (const c of this.combatants) {
      if (c.actorUuid !== actorUuid) {
        c.turnsPerRound = 0;
        c.turnsRemaining = 0;
      }
    }
    log(`DirectorCombat: solo-player mode → only ${actorUuid} acts`);
  }

  // Drop combatants whose token no longer exists on the scene (deleted out from
  // under us). Without this they linger as "ghost" targets in the player's
  // target list with nothing on the canvas. Returns the number removed.
  pruneStaleCombatants() {
    const scene = this.scene;
    if (!scene?.tokens) return 0;
    const removed = [];
    this.combatants = this.combatants.filter((c) => {
      if (scene.tokens.get(c.tokenId)) return true;
      removed.push(c);
      if (this.currentCombatantId === c.id) this.currentCombatantId = null;
      return false;
    });
    if (removed.length) log(`pruneStaleCombatants: removed ${removed.length} ghost(s) — ${removed.map((c) => c.name).join(", ")}`);
    return removed.length;
  }

  // Remove a combatant by its id. Clears the current pointer if it was acting.
  // Returns the removed combatant (or null). Caller deletes the token doc.
  removeCombatantById(id) {
    const i = this.combatants.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const [removed] = this.combatants.splice(i, 1);
    if (this.currentCombatantId === id) this.currentCombatantId = null;
    return removed;
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
    // Expose the live combat as the ambient active dCombat so formula
    // identifiers that need combat-scoped, per-actor state (MP_SPENT_THIS_TURN —
    // Bimagus) can read it from the sync resolver, which only carries `actor`.
    // Cleared by director-boot.stop(); re-set by the resume reconstruct.
    try { globalThis.__fudActiveDCombat = this; } catch { /* sandbox */ }
    // Round 0 is the pre-combat phase (PREP + conflict_start reactions).
    // ROUND_START.onEnter bumps to 1 when entering the first real round,
    // and nextTurn() bumps further on wraps. The resume-routing layer
    // uses round=0 as the unambiguous "Battle Start" signal — see
    // director-boot.js' Battle Start branch.
    this.round = 0;
    this.turn = 0;
    // A restart begins with a clean watchdog; a barren streak from a previous
    // run must not carry over and end round 1 of the next battle.
    this._turnsTakenThisRound = 0;
    this._barrenRounds = 0;
    this.pendingRoundWrap = false;
    // Initialize round-1 turn counts from the live activation stat (re-read so
    // any pre-battle change / solo-mode is honored; combatants appended after
    // construction also get a correct count).
    for (const c of this.combatants) {
      c.turnsPerRound = this._effectiveActivation(c);
      c.turnsRemaining = c.isDefeatedLive() ? 0 : c.turnsPerRound;
      c.phaseLock = null;
    }
    // Ambush / Advantage → a Free Round before Round 1. The first ROUND_START
    // enters it (enterFreeRound), after conflict_start has fully played out.
    this.freeRoundPending = (this.engagement === "ambush" || this.engagement === "advantage");
    this.freeRound = false;
    this.freeRoundSide = null;
    this.heldSummonActions = [];
    this.currentSide = this.firstSide;
    this.currentCombatantId = null; // resolved by the first TurnStart pick
    log(`DirectorCombat started: ${this.combatants.length} combatants on ${this.scene?.name ?? "?"}, firstSide=${this.firstSide}${this.freeRoundPending ? `, Free Round (${this.engagement}) first` : ""}`);
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

  // Current effective actions-per-round for a combatant: the LIVE activation
  // stat (base + bonus_activation), or 0 if solo-excluded. Re-reading the actor
  // here is what makes activation a manipulable stat — an effect or sheet edit
  // changing `activation`/`bonus_activation` is picked up at the next round.
  _effectiveActivation(c) {
    if (this.soloPlayerActorUuid && c.actorUuid !== this.soloPlayerActorUuid) return 0;
    // Phantasms (Illusionist summons) never take their own turn — they act on
    // the summoner's turn (FU summon rules). 0 turns/round, recomputed every
    // round + after reload from persistent state (actor prop or token flag).
    if (combatantIsPhantasm(c)) return 0;
    // Authored per-spawn pin (summon_turns_per_round). Sits BELOW the phantasm
    // rule — a phantasm never acts on its own whatever a row claims — and ABOVE
    // the actor read, which is the whole point: a Numen whose activation is the
    // free action Create Phantasm: Numen grants at its summoner's turn end holds
    // 0 turns of its own, without touching the base actor everyone shares.
    const pinned = combatantPinnedTurns(c);
    if (pinned !== null) return pinned;
    return readActivations(c.actorDoc);
  }

  // Reset all un-defeated combatants' turnsRemaining for a new round, re-reading
  // their live activation. Defeated combatants get 0 remaining (but keep their
  // would-be turnsPerRound so the tracker reads right if they're revived).
  _resetRoundCounters() {
    for (const c of this.combatants) {
      const { perRound, remaining, debtConsumed } = this._nextRoundTurns(c);
      c.turnsPerRound = perRound;
      c.turnsRemaining = remaining;
      if (debtConsumed) c.flags.pendingTurnDebt = 0;
    }
  }

  // What a combatant's counters WOULD be at the next round reset — pure read, no
  // mutation, so nextTurn() can decide "is anyone left to act next round" without
  // performing the reset (the reset itself is deferred to ROUND_START).
  //
  // The modify_turns effect_kind (Stop) leaves a one-time turn debt when a
  // reduction couldn't land because the target was already out of turns. It
  // lands on their genuine NEXT turn, then clears. Negative value; floored at 0.
  _nextRoundTurns(c) {
    const perRound = this._effectiveActivation(c);
    let remaining = c.isDefeatedLive() ? 0 : perRound;
    let debtConsumed = false;
    const debt = Number(c.flags?.pendingTurnDebt ?? 0);
    if (debt < 0 && remaining > 0) {
      remaining = Math.max(0, remaining + debt);
      debtConsumed = true;
    }
    return { perRound, remaining, debtConsumed };
  }

  // Apply a wrap that nextTurn() deferred: bump the round, refill every
  // combatant's turns, hand the first turn to firstSide. Called from
  // ROUND_START.onEnter, AFTER the round-end phase has fully played out, so the
  // tracker refills and the round number advances only when the new round
  // actually begins. Returns true when a wrap was pending and got applied.
  //
  // ROUND_START's initiative resolution runs after this and may override
  // currentSide — that is the intended precedence (initiative beats firstSide).
  beginPendingRound() {
    if (!this.pendingRoundWrap) return false;
    this.pendingRoundWrap = false;
    // The Free Round is round 0, so the bump below lands on Round 1 exactly.
    if (this.freeRound) {
      log(`Free Round over — Round 1 begins`);
      this.freeRound = false;
    }
    this.round++;
    this.turn = 0;
    this._resetRoundCounters();
    this.currentSide = this.firstSide;
    // If firstSide has nothing eligible post-wrap (e.g. wholly defeated),
    // switch to the other side for this round.
    if (this.eligibleOnSide(this.currentSide).length === 0) {
      this.currentSide = this._otherSide(this.currentSide);
    }
    log(`Round advanced to ${this.round} (firstSide=${this.firstSide}, currentSide=${this.currentSide})`);
    this._notifyTurnActions();
    return true;
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
      this._turnsTakenThisRound++;
      acted.turnsRemaining = Math.max(0, acted.turnsRemaining - 1);
      log(`nextTurn: ${acted.name} acted (turnsRemaining now ${acted.turnsRemaining}/${acted.turnsPerRound})`);
    }

    // 1b. Forced-next override (turn manipulation: a creature acts IMMEDIATELY
    // after the current turn — Create Phantasm: Numen). One-shot: PIN the
    // combatant directly so TURN_START uses it without the side-alternation or
    // the picker (TURN_START only re-picks when currentCombatantId is null).
    // Overrides RAW alternation by design (a granted extra/priority turn).
    if (this.forcedNextCombatantId) {
      const forcedId = this.forcedNextCombatantId;
      this.forcedNextCombatantId = null;
      const forced = this.combatants.find((c) => c.id === forcedId);
      if (forced && !forced.isDefeatedLive?.() && forced.turnsRemaining > 0) {
        this.currentSide = forced.side;
        this.currentCombatantId = forced.id;   // PIN — TURN_START honors a set id
        log(`nextTurn: FORCED next turn → ${forced.name} (turn manipulation)`);
        this._notifyTurnActions();
        return { round: this.round, currentSide: this.currentSide, wrappedRound: false, ended: false, eligibleIds: [forced.id], forced: true };
      }
      log(`nextTurn: forced-next ${forcedId} not eligible (defeated/no turns) — ignoring`);
    }

    // Always clear; the picker fills it.
    this.currentCombatantId = null;

    // 2. Compute remaining eligibility per side.
    const sameSide = this.currentSide;
    const otherSide = this._otherSide(sameSide);
    let sameEligible = this.eligibleOnSide(sameSide);
    let otherEligible = this.eligibleOnSide(otherSide);

    // Ordering policy for the CURRENT round — always "alternate" now (see
    // _alternationPolicyForRound). The eligible lists above are phase-filtered,
    // so this same alternation carries across a Quicken → Normal → Delay border.
    const consecutive = this._alternationPolicyForRound(this.round) === "consecutive";

    let wrappedRound = false;
    if (consecutive && sameEligible.length > 0) {
      // Surprise round: the leading side keeps acting until it runs out.
      // currentSide stays.
    } else if (otherEligible.length > 0) {
      // Alternate to other side (works whether sameSide is also eligible
      // or not — RAW says "alternate as long as possible"). Under the
      // consecutive policy this branch is only reached once the leading
      // side is exhausted, so it hands the block to the other side.
      this.currentSide = otherSide;
    } else if (sameEligible.length > 0) {
      // Other side exhausted; outnumbered side burns remaining turns here.
      // currentSide stays.
    } else {
      // Both exhausted → wrap to a new round.
      //
      // A round nobody acted in is not a round — it is a spin. Refilling the
      // counters and going again would just produce another one, forever, and
      // each lap fires the round announcer. Two barren rounds is already past
      // anything legitimate: even a party stunned to a standstill has its
      // turns decremented by whatever skipped them.
      if (this._turnsTakenThisRound === 0) {
        this._barrenRounds++;
        if (this._barrenRounds >= 2) {
          warn(
            `nextTurn: ${this._barrenRounds} rounds with no combatant acting — ` +
            `the combat has lost its world (round ${this.round}). Ending rather ` +
            `than spinning.`
          );
          this.end();
          this._notifyTurnActions();
          return { round: this.round, currentSide: this.currentSide, wrappedRound: true, ended: true, eligibleIds: [], barren: true };
        }
      } else {
        this._barrenRounds = 0;
      }
      this._turnsTakenThisRound = 0;

      // No one un-defeated would have any turns next round — combat is
      // effectively over. The director detects side-wipe elsewhere; here we
      // just signal. Decided on a dry read of the next-round counters so the
      // reset itself can stay deferred.
      if (!this.combatants.some((c) => this._nextRoundTurns(c).remaining > 0)) {
        warn("nextTurn: round wrapped but no eligible combatants remain — ending");
        this.end();
        this._notifyTurnActions();
        return { round: this.round, currentSide: this.currentSide, wrappedRound: true, ended: true, eligibleIds: [] };
      }

      // DEFER the wrap. The round is over, but the round-END phase has not run
      // yet: ROUND_END -> round_end reactions -> any Late Actor free action
      // (Kalina) all happen after this return. Bumping `round`, refilling every
      // combatant's turns and flipping currentSide here — as this used to —
      // pushed "Round N+1, everyone's turns are back" out to every tracker
      // while the round-end actor was still acting in round N, and stamped her
      // action, its AEs and the round_end payload with the WRONG round.
      // ROUND_START.onEnter calls beginPendingRound() once the new round really
      // begins. Persisted (persistence.js) so a reload inside the round-end
      // phase still applies it (director-boot routes a pending wrap to
      // ROUND_START rather than a picker nobody is eligible for).
      this.pendingRoundWrap = true;
      wrappedRound = true;
      log(`nextTurn: round ${this.round} complete — wrap deferred to ROUND_START`);
      this._notifyTurnActions();
      return { round: this.round, currentSide: this.currentSide, wrappedRound: true, ended: false, eligibleIds: [] };
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
      initiativeMode: this.initiativeMode,
      engagement: this.engagement,
      freeRound: this.freeRound,
      freeRoundPending: this.freeRoundPending,
      phase: this.currentPhaseTier(),
      heldSummonActions: this.heldSummonActions.map((h) => ({ name: h.name, tier: h.tier, round: h.round })),
      initiativeThisRound: this.initiativeThisRound,
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
        speedTier: this.speedTierOf(c),
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
// First-side rule (who leads Round 1 onward) depends on initiativeMode only:
//   • "rolled"       → provisional (party); each round's Initiative Group Check
//     at ROUND_START (director-initiative.js) rolls and OVERRIDES
//     firstSide/currentSide before the first turn is picked.
//   • "sidePriority" → legacy fixed rule: any enemy Villain/Boss present →
//     enemies first; else party first.
// Ambush / Advantage no longer touch it: they add a Free Round BEFORE Round 1
// (DirectorCombat.enterFreeRound), and Round 1 is a normal round.
// True if `actor` carries a live `prevent_ambush` AE change. A gear carrier
// (accessory / armor / weapon / shield) only counts while equipped — the same
// rule snapshot.js applies to the other raw rule keys, restated here because
// this file deliberately imports nothing but the logger.
const _AMBUSH_GEAR_TYPES = new Set(["accessory", "armor", "weapon", "shield"]);
function actorPreventsAmbush(actor) {
  const effs = actor?.appliedEffects ?? actor?.effects?.contents ?? actor?.effects ?? [];
  for (const ae of effs) {
    if (ae?.disabled) continue;
    if (!(ae.changes ?? []).some((ch) => ch?.key === "prevent_ambush")) continue;
    const item = ae?.parent?.documentName === "Item" ? ae.parent : null;
    const itemType = String(item?.system?.props?.item_type ?? "").toLowerCase();
    if (_AMBUSH_GEAR_TYPES.has(itemType) && item?.system?.props?.isEquipped !== true) continue;
    return true;
  }
  return false;
}

export function buildDirectorCombat({
  scene, partyTokens, enemyTokens, sourceSceneId = null,
  initiativeMode = "rolled", engagement = "normal",
} = {}) {
  const dc = new DirectorCombat({ scene, sourceSceneId });
  dc.initiativeMode = (initiativeMode === "sidePriority") ? "sidePriority" : "rolled";
  dc.engagement = (engagement === "ambush" || engagement === "advantage") ? engagement : "normal";
  for (const td of (partyTokens ?? [])) {
    if (!td) continue;
    dc.addCombatant({ tokenDoc: td, side: "party", disposition: 1 });
  }
  for (const td of (enemyTokens ?? [])) {
    if (!td) continue;
    dc.addCombatant({ tokenDoc: td, side: "enemy", disposition: -1 });
  }

  // Ambush immunity (Intruder Alarm "prevents your party from getting Ambushed"):
  // a party member carrying a live `prevent_ambush` AE change turns an Ambush
  // into a normal engagement, before the first side is decided.
  if (dc.engagement === "ambush" && (partyTokens ?? []).some((td) => actorPreventsAmbush(td?.actor))) {
    log("buildDirectorCombat: ambush prevented by a party member's prevent_ambush effect");
    dc.engagement = "normal";
  }

  const villainPresent = dc.combatants.some((c) => c.side === "enemy" && (c.isVillain || c.isBoss));
  if (dc.initiativeMode === "sidePriority") {
    dc.firstSide = villainPresent ? "enemy" : "party";
  } else {
    // rolled + normal: provisional; ROUND_START round-1 resolver sets the real side.
    dc.firstSide = "party";
  }
  dc.currentSide = dc.firstSide;
  log(`buildDirectorCombat: ${dc.size} combatants, initiativeMode=${dc.initiativeMode}, engagement=${dc.engagement}, villainPresent=${villainPresent}, firstSide=${dc.firstSide}`);
  return dc;
}

// (mirrorTurnToFoundry / mirrorEndToFoundry removed — no Foundry Combat doc
// exists in director mode anymore. dCombat is the sole authority.)
