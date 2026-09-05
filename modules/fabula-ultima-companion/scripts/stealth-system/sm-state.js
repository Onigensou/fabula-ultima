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

      // Concealment — a held breath, not a buff. See breakConcealment().
      conceal: { tier: 0, roundsLeft: 0, hidInCover: false },
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
    anchor: null,          // where an unrouted guard drifts around
    mark: null,            // "spot" | "suspect" — transient, for the overlay
    markAt: 0,
    raisedOnce: false,     // has this guard already cost the party a tier?
    reinforcement: false,
    defeated: false,
    stupor: 0,             // rounds left skipping activation (see applyStupor)
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
export function bumpAwareness(state, enemyId, delta, tune, lastKnownCell = null, { ceiling = null } = {}) {
  const e = state.enemies?.[enemyId];
  if (!e || e.defeated) return null;

  const before = e.ai;

  // A CEILING lets a weak signal raise a guard only so far.
  //
  // Glimpses pass searchAt - 1 here, so no accumulation of half-sightings can
  // ever tip a guard into hunting: only being genuinely seen does that. Before
  // this, a suspicious reading was worth up to 3 and searchAt is 4, so walking
  // two cells across a distant cone flipped a patrolling guard into SEARCH —
  // pathing at a position the party had merely been GLIMPSED at.
  //
  // A capped bump never pulls awareness DOWN. Being glimpsed after being seen
  // outright must not calm anyone.
  const cap = ceiling == null ? tune.awarenessMax : Math.min(tune.awarenessMax, ceiling);
  const raw = e.awareness + delta;
  e.awareness = delta > 0
    ? Math.max(e.awareness, Math.min(raw, cap))
    : Math.max(0, Math.min(tune.awarenessMax, raw));

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

    // Marks are per-round: the "!" over a guard's head belongs to the moment it
    // saw something, not to the rest of the infiltration.
    e.mark = null;

    if (e.ai === AI.SUSPICIOUS && e.awareness < tune.suspiciousAt) {
      // Investigated, found nothing, back to the round. Clearing the latch is
      // the point: this guard can be startled again by a NEW approach, but a
      // single crossing of its cone only ever cost the party one tier.
      e.ai = AI.PATROL;
      e.raisedOnce = false;
      // Drop the lead as well. Leaving it behind meant the next thing to
      // startle this guard sent it to a stale point from an episode it had
      // already given up on.
      e.lastKnownCell = null;
    } else if (e.ai === AI.SEARCH) {
      // A well-hidden party makes a search fruitless faster: the guard is
      // sweeping an area that genuinely has nothing in it.
      if (concealTier(state) >= 2) {
        e.awareness = Math.max(0, e.awareness - tune.concealSearchDecay);
      }
      e.searchRounds += 1;
      if (e.searchRounds > tune.searchPersistence) {
        e.ai = AI.PATROL;
        e.awareness = 0;
        e.lastKnownCell = null;
        e.searchRounds = 0;
        e.raisedOnce = false;
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

// ── Concealment ─────────────────────────────────────────────────────────────

/** Margin over the DL -> tier. Tier 1 is the floor for any successful hide. */
export function concealTierFor(margin, tune) {
  if (margin >= tune.concealTier3Margin) return 3;
  if (margin >= tune.concealTier2Margin) return 2;
  return 1;
}

export const concealTier = (state) => state?.party?.conceal?.tier ?? 0;

export function setConcealment(state, tier, tune, { hidInCover = false } = {}) {
  state.party.conceal = {
    tier,
    roundsLeft: tune.concealDuration,
    hidInCover: !!hidInCover,
  };
}

/**
 * End concealment.
 *
 * Deliberately NOT called by ordinary movement. The whole point of the change
 * is that hiding and then slipping away has to work, or the party is pinned in
 * place by the very system meant to free them. It ends on being seen outright,
 * on noise, on leaving the cover you hid behind, and on time.
 */
export function breakConcealment(state, reason = "") {
  if (!state?.party?.conceal?.tier) return false;
  state.party.conceal = { tier: 0, roundsLeft: 0, hidInCover: false };
  pushLog(state, "Concealment lost (" + reason + ")");
  return true;
}

/** Per-round countdown. Returns true when it lapsed this round. */
export function tickConcealment(state) {
  const c = state?.party?.conceal;
  if (!c?.tier) return false;
  c.roundsLeft -= 1;
  if (c.roundsLeft <= 0) {
    state.party.conceal = { tier: 0, roundsLeft: 0, hidInCover: false };
    pushLog(state, "Concealment lapsed");
    return true;
  }
  return false;
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

// ── Stupor ──────────────────────────────────────────────────────────────────

/**
 * Daze the guards a fled fight left behind.
 *
 * Running away used to leave the party standing next to the exact enemies they
 * just escaped, who then acted immediately — so escaping bought nothing and the
 * fight simply restarted. Stupor is the breather: a stupored guard is skipped
 * entirely in the enemy phase, which gives the party the round they paid for
 * without deleting enemies they never actually beat.
 */
export function applyStupor(state, tokenIds, tune) {
  let n = 0;
  for (const id of tokenIds ?? []) {
    const e = state.enemies?.[id];
    if (!e || e.defeated) continue;
    e.stupor = tune.stuporRounds;
    // Whatever they knew, they are in no state to act on it.
    e.awareness = 0;
    e.ai = AI.PATROL;
    e.lastKnownCell = null;
    e.raisedOnce = false;
    n++;
  }
  if (n) pushLog(state, `${n} enemy(ies) left reeling`);
  return n;
}

/** Count down every stupor. Called once per round. */
export function tickStupor(state) {
  for (const e of enemyRecords(state)) {
    if (e.stupor > 0) e.stupor -= 1;
  }
}

export const isStupored = (e) => (e?.stupor ?? 0) > 0;
