// FSM state constants + transition table for the Battle Director.
// See docs/battle-director-design.md §4 + §5 for design intent.

export const STATES = Object.freeze({
  IDLE:             "IDLE",
  // PREP — explicit pre-combat phase that owns the work currently done by
  // runDirectorInit (curtain, encounter resolution, party resolution, scene
  // activate, spawn, preload, entrance animation, combat creation, initial
  // initiative roll, startCombat). Only entered when the director is started
  // with a payload; the manual-fallback path (start with a combatId on an
  // existing combat) skips straight to ROUND_START.
  PREP:             "PREP",
  ROUND_START:      "ROUND_START",
  TURN_START:       "TURN_START",
  DECLARE:          "DECLARE",
  TARGET:           "TARGET",
  COMPUTE:          "COMPUTE",
  CONFIRM:          "CONFIRM",
  RESOLVE:          "RESOLVE",
  REACTION_WINDOW:  "REACTION_WINDOW",
  CLEANUP:          "CLEANUP",
  TURN_END:         "TURN_END",
  ROUND_END:        "ROUND_END",
  ABORTED:          "ABORTED",
  STOPPED:          "STOPPED",
});

// Default timeout per state in ms. null = synchronous, no timeout.
// Used by Director to set a fallback timer on state entry.
export const STATE_TIMEOUT_MS = Object.freeze({
  [STATES.IDLE]:            null,
  [STATES.PREP]:            120 * 1000,      // 2 min — full prep (preload + entrance + combat create); overrun signals a stuck pipeline
  [STATES.ROUND_START]:     null,
  [STATES.TURN_START]:      null,
  [STATES.DECLARE]:         5 * 60 * 1000,   // 5 min — player thinks
  [STATES.TARGET]:          2 * 60 * 1000,   // 2 min — target picker
  [STATES.COMPUTE]:         null,
  [STATES.CONFIRM]:         5 * 60 * 1000,   // 5 min — player reads the card
  [STATES.RESOLVE]:         null,
  [STATES.REACTION_WINDOW]: 30 * 1000,       // 30 s for reactions in v1
  [STATES.CLEANUP]:         null,
  [STATES.TURN_END]:        null,
  [STATES.ROUND_END]:       null,
  [STATES.ABORTED]:         null,
  [STATES.STOPPED]:         null,
});

// Transition table.
// Keyed by current-state, then by event-type, value is { next, guard?, commit? }.
// Events received in a state with no matching entry are queued (if persistent)
// or logged-and-dropped (if transient).
//
// "next" can be a state constant, or a function (ctx, event) => stateConstant
// for branching transitions.
//
// "guard" is an optional predicate (ctx, event) => bool|string. Returning
// false or a string rejects the transition; the string is logged as the reason.
//
// "commit" is an optional async hook (ctx, event) => void called after the
// state has transitioned but before the next state's onEnter fires. Used to
// write any state-entry side effects atomically with the transition.

import { INTENTS } from "./intents.js";

export const TRANSITIONS = Object.freeze({
  [STATES.IDLE]: {
    // Branching: if the director was started with a payload, run PREP to
    // do the full curtain/spawn/preload/entrance/combat-create pipeline.
    // If started with an already-existing combat (manual fallback), skip
    // PREP and go straight to ROUND_START.
    [INTENTS.START_COMBAT]: { next: (ctx) => ctx.payload ? STATES.PREP : STATES.ROUND_START },
  },

  [STATES.PREP]: {
    INTERNAL_DONE:   { next: STATES.ROUND_START },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    [INTENTS.TIMEOUT]: { next: STATES.ABORTED },
  },

  [STATES.ROUND_START]: {
    INTERNAL_DONE: { next: (ctx) => ctx.endOfCombat ? STATES.STOPPED : STATES.TURN_START },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.TURN_START]: {
    INTERNAL_DONE: { next: (ctx) => ctx.endOfCombat ? STATES.STOPPED : STATES.DECLARE },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.DECLARE]: {
    [INTENTS.DECLARE_COMMAND]: { next: STATES.TARGET },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    [INTENTS.TIMEOUT]: { next: STATES.TURN_END },
  },

  [STATES.TARGET]: {
    [INTENTS.TARGET_PICKED]: { next: STATES.COMPUTE },
    [INTENTS.TARGET_BACK]: { next: STATES.DECLARE },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    [INTENTS.TIMEOUT]: { next: STATES.ABORTED },
  },

  [STATES.COMPUTE]: {
    INTERNAL_DONE: { next: STATES.CONFIRM },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.CONFIRM]: {
    [INTENTS.CONFIRM_ACTION]: { next: STATES.RESOLVE },
    [INTENTS.CANCEL_ACTION]: { next: STATES.DECLARE },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    [INTENTS.TIMEOUT]: { next: STATES.ABORTED },
  },

  [STATES.RESOLVE]: {
    INTERNAL_DONE: { next: STATES.REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.REACTION_WINDOW]: {
    INTERNAL_DONE: { next: STATES.CLEANUP },
    [INTENTS.TIMEOUT]: { next: STATES.CLEANUP },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.CLEANUP]: {
    INTERNAL_DONE: { next: STATES.TURN_END },
    [INTENTS.ABORT]: { next: STATES.STOPPED },
  },

  [STATES.TURN_END]: {
    INTERNAL_DONE: { next: (ctx) => ctx.endOfRound ? STATES.ROUND_END : STATES.TURN_START },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.ROUND_END]: {
    INTERNAL_DONE: { next: (ctx) => ctx.endOfCombat ? STATES.STOPPED : STATES.ROUND_START },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.ABORTED]: {
    // If the abort happened before combat actually started (e.g. mid-PREP
    // failure), there's no turn flow to clean up — go straight to STOPPED
    // and let the boot do final cleanup (spawned-token deletion, suppressor
    // restore). Otherwise route through the normal per-turn CLEANUP path.
    // Authoritative source is DirectorCombat (the director-owned model);
    // we fall back to the Foundry combat's `started` for backward compat
    // when manual-fallback entry skips PREP.
    INTERNAL_DONE: { next: (ctx) => (ctx.dCombat?.started || ctx.combat?.started) ? STATES.CLEANUP : STATES.STOPPED },
  },

  [STATES.STOPPED]: {},
});
