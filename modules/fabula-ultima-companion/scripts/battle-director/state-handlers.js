// State handlers — the per-state onEnter / onExit / onAbort logic.
//
// For v1 prototype, only Attack and Guard are fully wired. Other commands
// log a "not implemented in director v1" notice and return the FSM to
// DECLARE so the user can pick again.
//
// Damage / accuracy computation lives here too (kept simple — full Fabula
// rules require equipped-weapon lookup, status effects, affinities, etc.,
// which are deliberately out of scope for the prototype).

import { log, warn, err } from "./logger.js";
import { STATES } from "./states.js";
import { INTENTS } from "./intents.js";
import { snapshotCombatant, snapshotDirectorCombatant, snapshotEligibleTargets, snapshotEligibleTargetsFromDCombat, readPropNum, attrDieSize, freezeActionResult } from "./snapshot.js";
import { TurnUI } from "./turn-ui.js";
import { TurnPicker } from "./turn-picker.js";
import { requestTargeting } from "./target-picker.js";
import { postActionCard } from "./action-card.js";
import { runDirectorInit } from "./director-init.js";

// ─── PREP ──────────────────────────────────────────────────────────────
// Runs the full pre-combat pipeline: curtain raise, encounter / party
// resolution, scene activate, layout, hidden token spawn, asset preload,
// curtain drop, entrance animation, Combat doc create + combatant add +
// initiative roll + startCombat.
//
// On success, sets director.dCombat (via _setDirectorCombat) and
// INTERNAL_DONE transitions to ROUND_START. No Foundry Combat doc is created
// in director mode — dCombat is the sole authority.
//
// On failure (resolveScene fails, both party + enemies empty, network
// timeout during preload, etc.), sets ctx.abortReason and dispatches
// ABORT. The transition table routes ABORTED → STOPPED when combat
// hasn't started, so the boot's cleanup runs without trying to advance
// any turns.
const Prep = {
  async onEnter(director) {
    const payload = director.ctx.payload;
    if (!payload) {
      warn("PREP entered without a payload — aborting");
      director.ctx.abortReason = "no payload";
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    log("PREP: running director-owned battle init");
    let result = null;
    try {
      result = await runDirectorInit(payload);
    } catch (e) {
      err("PREP: runDirectorInit threw", e);
      director.ctx.abortReason = `prep threw: ${e?.message ?? e}`;
      ui.notifications?.error?.(`Battle Director prep failed: ${e?.message ?? e}`);
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    if (!result?.dCombat) {
      warn("PREP: runDirectorInit returned no dCombat");
      director.ctx.abortReason = "no dCombat produced";
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Hand the director-owned DirectorCombat to the FSM. From this point
    // forward all turn/round/current decisions read `director.dCombat`.
    director._setDirectorCombat(result.dCombat);
    log(`PREP done: dCombat ${result.dCombat.id} with ${result.partyTokens} party + ${result.enemyTokens} enemies, sourceScene=${result.dCombat?.sourceSceneId ?? "(none)"}`);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ROUND_START ───────────────────────────────────────────────────────
// In v1 nothing happens here; we just advance. Real implementation would
// drain round-start reaction triggers.
const RoundStart = {
  async onEnter(director) {
    director.ctx.endOfRound = false;
    director.ctx.endOfCombat = false;
    log(`ROUND_START — round ${director.dCombat?.round ?? director.combat?.round ?? "?"}`);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── TURN_START ────────────────────────────────────────────────────────
// In Phase 2 this state is responsible for *resolving who acts* on the
// current side via the turn picker. nextTurn() (in TURN_END) only flips the
// side and clears currentCombatantId; here we either auto-pick (single
// eligible) or prompt (multiple eligible) via TurnPicker.
const TurnStart = {
  async onEnter(director) {
    // Authoritative path — DirectorCombat owns turn order.
    let snap = null;
    if (director.dCombat) {
      const dc = director.dCombat;
      // Resolve current via picker if not already set (the normal path: a
      // prior TURN_END cleared it).
      if (!dc.currentCombatantId) {
        let eligible = dc.eligibleOnSide(dc.currentSide);
        // Defensive: if the active side has no eligible, try the other side
        // (handles unusual mid-combat defeats not yet seen by nextTurn).
        if (eligible.length === 0) {
          const other = dc._otherSide(dc.currentSide);
          const otherE = dc.eligibleOnSide(other);
          if (otherE.length > 0) {
            warn(`TURN_START: ${dc.currentSide} side has no eligible, swapping to ${other}`);
            dc.currentSide = other;
            eligible = otherE;
          }
        }
        if (eligible.length === 0) {
          warn("TURN_START: no eligible combatants on either side — ending combat");
          director.ctx.endOfCombat = true;
          director.enqueue({ type: INTENTS.INTERNAL_DONE });
          return;
        }
        if (eligible.length === 1) {
          dc.currentCombatantId = eligible[0].id;
          log(`TURN_START: auto-picked ${eligible[0].name} (only eligible on ${dc.currentSide})`);
        } else {
          log(`TURN_START: ${eligible.length} eligible on ${dc.currentSide} — prompting picker`);
          const pickedId = await TurnPicker.show({ director, eligible });
          if (!pickedId) {
            warn("TURN_START: picker cancelled — aborting turn");
            director.ctx.abortReason = "no combatant picked";
            director.enqueue({ type: INTENTS.ABORT });
            return;
          }
          dc.currentCombatantId = pickedId;
        }
      }
      const current = dc.current;
      if (!current) {
        warn("TURN_START: dCombat has no current combatant after pick — ending combat");
        director.ctx.endOfCombat = true;
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
      snap = snapshotDirectorCombatant(current);
    } else {
      // Manual-fallback path (no PREP, no dCombat — direct attach to an
      // existing Foundry combat). Read from Foundry combat.combatant.
      const combat = director.combat;
      if (!combat || combat.combatant == null) {
        warn("TURN_START with no current combatant (Foundry path) — ending combat");
        director.ctx.endOfCombat = true;
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
      snap = snapshotCombatant(combat);
    }
    if (!snap) {
      warn("TURN_START: failed to snapshot combatant");
      director.ctx.endOfCombat = true;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    director.ctx.turnSnapshot = snap;
    director.ctx.declaredCommand = null;
    director.ctx.actionResult = null;
    log(`TURN_START — ${snap.name}`);
    // No-op for triggers in v1. Pass through.
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── DECLARE ───────────────────────────────────────────────────────────
// Spawn the Octopath buttons over the current combatant's token. Wait for
// the user to click a command.
const Declare = {
  async onEnter(director) {
    const snap = director.ctx.turnSnapshot;
    if (!snap) {
      warn("DECLARE entered without turnSnapshot");
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    const token = canvas?.tokens?.get(snap.tokenId);
    if (!token) {
      warn("DECLARE: token not on canvas", snap.tokenId);
      // For NPC turns the GM still needs the UI somewhere; bail to TURN_END.
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }
    TurnUI.spawn({ director, token });
  },

  async onExit(director) {
    TurnUI.despawn({ director });
  },
};

// ─── TARGET ────────────────────────────────────────────────────────────
const Target = {
  async onEnter(director, { triggerIntent }) {
    const command = triggerIntent?.body?.command ?? director.ctx.declaredCommand;
    director.ctx.declaredCommand = command;
    log(`TARGET — command: ${command}`);

    // Guard / Equipment / Objective / Switch don't need a target picker
    if (command === "Guard") {
      // Self-targeted; skip picker
      director.ctx.actionResult = freezeActionResult({
        kind: "Guard",
        attacker: director.ctx.turnSnapshot,
        targets: [director.ctx.turnSnapshot],
      });
      director.enqueue({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: [director.ctx.turnSnapshot.tokenUuid] } });
      return;
    }

    if (command !== "Attack") {
      // Stub: any other command shows a notification and returns to DECLARE
      ui.notifications?.info(`"${command}" is not implemented in Director v1. Pick Attack or Guard.`);
      director.enqueue({ type: INTENTS.TARGET_BACK });
      return;
    }

    // Attack — pick exactly 1 enemy. Read eligibility from dCombat in the
    // normal director-mode path; fall back to the Foundry combat doc if a
    // manual-fallback attach was used.
    const eligible = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, director.ctx.turnSnapshot, { category: "enemy" })
      : snapshotEligibleTargets(director.combat, director.ctx.turnSnapshot, { category: "enemy" });
    director.ctx.eligibleTargets = eligible;
    if (eligible.length === 0) {
      ui.notifications?.warn("No eligible enemy targets on this scene.");
      director.enqueue({ type: INTENTS.TARGET_BACK });
      return;
    }
    const result = await requestTargeting({
      director,
      eligible,
      mode: "exact",
      count: 1,
      titleText: `Pick a target for ${director.ctx.turnSnapshot.name}'s Attack`,
    });
    if (!result.ok) {
      director.dispatch({ type: result.cancelled ? INTENTS.TARGET_BACK : INTENTS.ABORT });
      return;
    }
    director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: result.tokenUuids } });
  },
};

// ─── COMPUTE ───────────────────────────────────────────────────────────
// Roll accuracy + damage. Build an immutable actionResult.
const Compute = {
  async onEnter(director, { triggerIntent }) {
    const command = director.ctx.declaredCommand;
    const attacker = director.ctx.turnSnapshot;
    const tokenUuids = triggerIntent?.body?.targetTokenUuids ?? [];

    if (command === "Guard") {
      // Guard's actionResult was already shaped in TARGET; just pass through.
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    if (command === "Attack") {
      // Roll MIG + DEX (simple default; ignores equipped-weapon attribute pairs).
      // Read from the entry snapshot rather than the live actor — the snapshot
      // is the authoritative input for this state per §8 of the design doc.
      const dA = attacker.attributes?.MIG ?? 8;
      const dB = attacker.attributes?.DEX ?? 8;
      const roll = await new Roll(`1d${dA} + 1d${dB}`).roll({ async: true });
      const dice = roll.dice.map((d) => d.results?.[0]?.result ?? 0);
      const rA = dice[0] ?? 0;
      const rB = dice[1] ?? 0;
      const total = (rA + rB) | 0;
      const hr = Math.max(rA, rB);
      const isFumble = (rA === 1 && rB === 1);
      const isCrit = (rA === rB) && !isFumble && rA >= 6;

      // Per-target hit/damage resolution
      const perTargetResults = [];
      for (const uuid of tokenUuids) {
        const e = director.ctx.eligibleTargets.find((x) => x.tokenUuid === uuid);
        if (!e) continue;
        let hit = false;
        let damage = 0;
        if (isFumble) {
          hit = false;
        } else if (isCrit) {
          hit = true;
          damage = hr + 5;
        } else if (total >= e.defense) {
          hit = true;
          damage = hr + 5;
        }
        perTargetResults.push({
          tokenUuid: e.tokenUuid,
          actorUuid: e.actorUuid,
          name: e.name,
          defense: e.defense,
          hit,
          crit: isCrit,
          damage,
        });
      }

      director.ctx.actionResult = freezeActionResult({
        kind: "Attack",
        attacker,
        attackerActorRef: attacker.actorUuid,
        targets: director.ctx.eligibleTargets.filter((e) => tokenUuids.includes(e.tokenUuid)),
        roll: {
          A1: "MIG", A2: "DEX", dA, dB, rA, rB, total, hr, isCrit, isFumble,
        },
        perTargetResults,
      });
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Unknown command — shouldn't happen if TARGET filtered correctly.
    warn("COMPUTE: unknown command", command);
    director.enqueue({ type: INTENTS.ABORT });
  },
};

// ─── CONFIRM ───────────────────────────────────────────────────────────
const Confirm = {
  async onEnter(director) {
    const ar = director.ctx.actionResult;
    if (!ar) {
      warn("CONFIRM with no actionResult");
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Resolve the attacker actor for the chat speaker
    let attackerActor = null;
    try { attackerActor = await fromUuid(ar.attackerActorRef ?? ar.attacker.actorUuid); } catch {}

    const result = await postActionCard({
      director,
      kind: ar.kind,
      payload: {
        attacker: ar.attacker,
        attackerActor,
        targets: ar.targets,
        roll: ar.roll,
        perTargetResults: ar.perTargetResults,
      },
    });
    director.dispatch({ type: result.confirmed ? INTENTS.CONFIRM_ACTION : INTENTS.CANCEL_ACTION });
  },
};

// ─── RESOLVE ───────────────────────────────────────────────────────────
// Apply damage / AE / etc. directly to live docs. GM-side, serialized by
// dispatch lock.
const Resolve = {
  async onEnter(director) {
    const ar = director.ctx.actionResult;
    if (!ar) {
      warn("RESOLVE with no actionResult");
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    if (ar.kind === "Attack") {
      for (const r of ar.perTargetResults) {
        if (!r.hit || r.damage <= 0) continue;
        try {
          const actor = await fromUuid(r.actorUuid);
          if (!actor) { warn("RESOLVE: actor not found", r.actorUuid); continue; }
          const curHp = readPropNum(actor, ["current_hp", "hp"]);
          const newHp = Math.max(0, curHp - r.damage);
          await actor.update({ "system.props.current_hp": newHp });
          log(`Applied ${r.damage} dmg to ${r.name}: ${curHp} → ${newHp}`);
        } catch (e) {
          err("RESOLVE: failed to apply damage", r, e);
        }
      }
    } else if (ar.kind === "Guard") {
      // Apply a transient AE on the attacker — Resistance to all damage until
      // start of next turn. v1 just posts a chat note since the legacy AE
      // manager is out of scope for the prototype.
      const att = ar.attacker;
      try {
        const actor = await fromUuid(att.actorUuid);
        if (actor) {
          // Tag a custom flag the director can read in TURN_START next turn.
          // (In a fuller implementation this would be a proper Active Effect.)
          await actor.setFlag("fabula-ultima-companion", "directorGuardUntilCombatantId", att.combatantId);
          log(`Guard applied to ${att.name} until next turn`);
        }
      } catch (e) {
        warn("RESOLVE: Guard flag failed", e);
      }
    }

    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── REACTION_WINDOW ───────────────────────────────────────────────────
// v1 stub: no reactions fire. Just pass through.
// A real implementation runs MATCH → PASSIVE → MANUAL → DRAIN here.
const ReactionWindow = {
  async onEnter(director) {
    log("REACTION_WINDOW — v1 stub, no reactions in prototype");
    // Tiny delay to demonstrate the FSM is genuinely waiting in this state.
    // Routes through director.timers so stop() guarantees cleanup.
    director.timers.setTimeout(
      () => director.dispatch({ type: INTENTS.INTERNAL_DONE }),
      100,
      { label: "reactionWindow:stubDelay" }
    );
  },
};

// ─── CLEANUP ───────────────────────────────────────────────────────────
// Per-turn cleanup. Releases any transient state that shouldn't survive.
const Cleanup = {
  async onEnter(director) {
    director.ctx.declaredCommand = null;
    director.ctx.actionResult = null;
    director.ctx.eligibleTargets = null;
    director.ctx.pendingTriggers.length = 0;
    director.ctx.reactionDepth = 0;
    log("CLEANUP done");
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── TURN_END ──────────────────────────────────────────────────────────
// Bumps the turn counter + flips side if needed (per Fabula side-based
// alternation). Does NOT pick the next combatant — that's TURN_START's job
// (via the picker). Does NOT mirror to Foundry — mirroring happens in
// TURN_START once `currentCombatantId` is resolved.
const TurnEnd = {
  async onEnter(director) {
    if (director.dCombat) {
      try {
        const r = director.dCombat.nextTurn();
        director.ctx.endOfRound = !!r.wrappedRound;
        director.ctx.endOfCombat = !!r.ended;
        log(`TURN_END (dCombat) → round ${r.round}, currentSide=${r.currentSide}, eligible=${r.eligibleIds.length}${r.wrappedRound ? " [wrapped round]" : ""}${r.ended ? " [ended]" : ""}`);
      } catch (e) {
        warn("TURN_END: dCombat.nextTurn threw", e);
        director.ctx.endOfCombat = true;
      }
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Manual-fallback path: no dCombat, drive the Foundry combat directly.
    const combat = director.combat;
    if (!combat) {
      director.ctx.endOfCombat = true;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    const wasRound = combat.round;
    try {
      await combat.nextTurn();
    } catch (e) {
      warn("TURN_END: combat.nextTurn() threw", e);
      director.ctx.endOfCombat = true;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    director.ctx.endOfRound = (combat.round !== wasRound);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ROUND_END ─────────────────────────────────────────────────────────
const RoundEnd = {
  async onEnter(director) {
    log(`ROUND_END`);
    // v1 just passes through. Real implementation drains round-end triggers.
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ABORTED ───────────────────────────────────────────────────────────
const Aborted = {
  async onEnter(director, { triggerIntent }) {
    const reason = director.ctx.abortReason ?? triggerIntent?.body?.reason ?? "aborted";
    log(`ABORTED — ${reason}`);
    ui.notifications?.warn(`Director: action aborted (${reason})`);
    director.ctx.abortReason = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── STOPPED ───────────────────────────────────────────────────────────
const Stopped = {
  async onEnter(director) {
    log("STOPPED");
    TurnUI.despawn({ director });
    TurnPicker.despawn({ director });
  },
};

export const STATE_HANDLERS = Object.freeze({
  [STATES.PREP]:            Prep,
  [STATES.ROUND_START]:     RoundStart,
  [STATES.TURN_START]:      TurnStart,
  [STATES.DECLARE]:         Declare,
  [STATES.TARGET]:          Target,
  [STATES.COMPUTE]:         Compute,
  [STATES.CONFIRM]:         Confirm,
  [STATES.RESOLVE]:         Resolve,
  [STATES.REACTION_WINDOW]: ReactionWindow,
  [STATES.CLEANUP]:         Cleanup,
  [STATES.TURN_END]:        TurnEnd,
  [STATES.ROUND_END]:       RoundEnd,
  [STATES.ABORTED]:         Aborted,
  [STATES.STOPPED]:         Stopped,
});
