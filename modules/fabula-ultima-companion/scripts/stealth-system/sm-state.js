// ============================================================================
// Stealth Mode — the runtime state model, alert tiers and persistence.
//
// ONE scene flag holds everything: alert tier, per-enemy AI state and
// awareness, the party's position and movement budget, the takedown ledger,
// the round counter. Writing it as a single document is what makes an F5
// mid-turn survivable, and what makes "what is going on right now" one thing
// to read rather than six.
//
// ── Alert vs awareness ─────────────────────────────────────────────────────
// Two different quantities, deliberately:
//
//   ALERT is scene-wide and has three tiers. It is what the party sees, and it
//   decides how a conflict opens — Stealth → advantage, Neutral → normal,
//   Alert → ambush, straight onto battlePlan.engagement.
//
//   AWARENESS is per-enemy and continuous. It is what makes ONE guard turn
//   around and walk over while the rest of the room carries on. A guard's
//   awareness drives its own AI state; only a spot or a loud event moves the
//   scene-wide tier.
//
// Conflating them gives you either a room that all reacts as one organism, or
// a tier that nobody can read. Keeping them apart is most of the feel.
// ============================================================================

import {
  MODULE_ID, TAG, STATE_FLAG, ALERT, ALERT_ORDER, ALERT_ENGAGEMENT, AI, HOOKS,
} from "./sm-constants.js";
import { cellKey } from "./sm-grid.js";

// ── Shape ───────────────────────────────────────────────────────────────────

export function emptyState() {
  return {
    version: 1,
    active: false,
    round: 0,
    phase: null,           // FSM state name, for display and recovery
    alert: ALERT.STEALTH,

    party: {
      tokenId: null,
      cell: null,
      moveLeft: 0,
      objectiveUsed: false,
      controllerActorId: null,   // whose stats every check this round uses
      controllerUserId: null,
    },

    // enemyId → per-enemy record. Enemies are ordinary scene tokens the GM
    // placed; this is the state we layer on top of them.
    enemies: {},

    // Takedown ledger — banked, paid at scene end. Batched on purpose: paying
    // each kill out immediately would take the full first-enemy weight and its
    // own EXP floor every time, and stealth would out-earn combat outright.
    ledger: [],

    reinforcements: { spawned: 0, thisRound: 0 },

    // Which enemies have already acted this round.
    activatedThisRound: [],

    log: [],   // recent beats, for the GM panel
  };
}

export function emptyEnemy(tokenId, cell, facing) {
  return {
    tokenId,
    cell,
    facing: facing ?? "S",
    ai: AI.PATROL,
    awareness: 0,
    lastKnownCell: null,   // where the guard THINKS the party is — the trick
    searchRounds: 0,
    lostRounds: 0,
    routeIndex: 0,
    reinforcement: false,
    defeated: false,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function readState(scene = canvas?.scene) {
  const raw = scene?.flags?.[MODULE_ID]?.[STATE_FLAG];
  if (!raw || typeof raw !== "object") return null;
  // Merge onto a fresh shape so a state written by an older version still
  // loads with every field present.
  return foundry.utils.mergeObject(emptyState(), raw, { inplace: false });
}

export async function writeState(state, scene = canvas?.scene) {
  if (!scene) return null;
  if (!game.user?.isGM) {
    console.warn(TAG, "writeState called off the GM — ignored.");
    return null;
  }
  await scene.setFlag(MODULE_ID, STATE_FLAG, state);
  return state;
}

export async function clearState(scene = canvas?.scene) {
  if (!scene || !game.user?.isGM) return;
  await scene.unsetFlag(MODULE_ID, STATE_FLAG);
}

// ── Alert ───────────────────────────────────────────────────────────────────

export const alertIndex = (tier) => Math.max(0, ALERT_ORDER.indexOf(tier));

export function engagementFor(tier) {
  return ALERT_ENGAGEMENT[tier] ?? "normal";
}

/**
 * Move the alert tier by `delta` tiers, clamped.
 * Returns { changed, from, to }. Callers persist and broadcast.
 */
export function shiftAlert(state, delta, reason = "") {
  const from = state.alert;
  const idx = Math.min(ALERT_ORDER.length - 1, Math.max(0, alertIndex(from) + delta));
  const to = ALERT_ORDER[idx];
  state.alert = to;

  if (to !== from) {
    pushLog(state, `Alert ${from} → ${to}${reason ? ` (${reason})` : ""}`);
    try { Hooks.callAll(HOOKS.ALERT_CHANGED, { from, to, reason }); } catch (_) {}
  }
  return { changed: to !== from, from, to };
}

export const isAlert = (state) => state?.alert === ALERT.ALERT;

// ── Enemies ─────────────────────────────────────────────────────────────────

export function enemyRecords(state) {
  return Object.values(state?.enemies ?? {}).filter((e) => e && !e.defeated);
}

export function awareEnemies(state, threshold = 1) {
  return enemyRecords(state).filter((e) => e.awareness >= threshold);
}

/**
 * Raise one enemy's awareness and move its AI state if a threshold was crossed.
 * Returns the transition, if any.
 */
export function bumpAwareness(state, enemyId, delta, tune, lastKnownCell = null) {
  const e = state.enemies?.[enemyId];
  if (!e || e.defeated) return null;

  const before = e.ai;
  e.awareness = Math.max(0, Math.min(tune.awarenessMax, e.awareness + delta));

  if (lastKnownCell) e.lastKnownCell = lastKnownCell;

  if (e.awareness >= tune.searchAt) {
    // CHASE is reserved for the Alert tier. Below it a guard investigates but
    // never truly hunts, which is what keeps Neutral from feeling like Alert.
    e.ai = isAlert(state) ? AI.CHASE : AI.SEARCH;
    e.searchRounds = 0;
    e.lostRounds = 0;
  } else if (e.awareness >= tune.suspiciousAt) {
    if (e.ai === AI.PATROL) e.ai = AI.SUSPICIOUS;
  }

  return before === e.ai ? null : { enemyId, from: before, to: e.ai };
}

/** Per-round awareness cooldown for anyone who saw nothing. */
export function decayAwareness(state, tune, sawPartyIds = new Set()) {
  for (const e of enemyRecords(state)) {
    if (sawPartyIds.has(e.tokenId)) continue;
    e.awareness = Math.max(0, e.awareness - tune.awarenessDecay);

    if (e.ai === AI.SUSPICIOUS && e.awareness < tune.suspiciousAt) {
      e.ai = AI.PATROL;
    } else if (e.ai === AI.SEARCH) {
      e.searchRounds += 1;
      if (e.searchRounds > tune.searchPersistence) {
        e.ai = AI.PATROL;
        e.awareness = 0;
        e.lastKnownCell = null;
        e.searchRounds = 0;
      }
    } else if (e.ai === AI.CHASE) {
      e.lostRounds += 1;
      if (e.lostRounds > tune.chaseGiveUp) {
        e.ai = AI.SEARCH;
        e.searchRounds = 0;
      }
    }
  }
}

// ── Ledger ──────────────────────────────────────────────────────────────────

/**
 * Bank a silent kill. The actor id is what matters — payout re-runs the shared
 * v1.2 formula over the whole banked list as ONE virtual encounter, so the
 * diminishing weights and the single clamp apply exactly as in a fight.
 */
export function bankTakedown(state, { actorId, actorName, tokenId, cell }) {
  state.ledger.push({ actorId, actorName, tokenId, cell, at: Date.now() });
  pushLog(state, `Takedown banked: ${actorName}`);
}

// ── Log ─────────────────────────────────────────────────────────────────────

const LOG_MAX = 40;

export function pushLog(state, text) {
  if (!state) return;
  state.log = state.log ?? [];
  state.log.push({ t: Date.now(), round: state.round, text: String(text) });
  if (state.log.length > LOG_MAX) state.log = state.log.slice(-LOG_MAX);
}

// ── Misc ────────────────────────────────────────────────────────────────────

/** Enemies that have not yet acted this round, as records. */
export function pendingActivations(state) {
  const done = new Set(state.activatedThisRound ?? []);
  return enemyRecords(state).filter((e) => !done.has(e.tokenId));
}

export function markActivated(state, enemyId) {
  state.activatedThisRound = state.activatedThisRound ?? [];
  if (!state.activatedThisRound.includes(enemyId)) state.activatedThisRound.push(enemyId);
}

export function resetRoundCounters(state) {
  state.activatedThisRound = [];
  state.reinforcements.thisRound = 0;
  state.party.objectiveUsed = false;
}

export { cellKey };
