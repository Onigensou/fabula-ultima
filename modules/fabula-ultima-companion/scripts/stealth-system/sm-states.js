// ============================================================================
// Stealth Mode — FSM state set and transition table.
//
// Same discipline as the Battle Director, and for the same reason: a mode this
// stateful is only debuggable if every step is a named state you can query,
// log and recover into. What is copied is the SHAPE — a frozen transition
// table, one serial dispatch lock, hooks and timers in registries — not the
// Director's 82k lines of combat, none of which applies here.
//
// ── The loop ───────────────────────────────────────────────────────────────
//
//   IDLE → PREP → ROUND_START
//     → PLAYER_START → CONTROLLER_PICK → ACTION ⇄ RESOLUTION → PLAYER_END
//     → ENEMY_START → ACTIVATE (×N) → REINFORCE → ENEMY_END
//     → ROUND_END → ROUND_START …
//
//   exits: CONFLICT_HANDOFF (a fight starts) · STOPPED
//
// ACTION ⇄ RESOLUTION is the important pair. The player spends from a movement
// pool and one Objective slot in any order — 5e-style freedom — and every
// committed step round-trips through RESOLUTION so detection is evaluated per
// cell entered rather than once at the end of a move.
// ============================================================================

export const S = Object.freeze({
  IDLE:             "IDLE",
  PREP:             "PREP",              // lattice build, enemy adoption, camera
  ROUND_START:      "ROUND_START",
  PLAYER_START:     "PLAYER_START",      // start-of-turn effects, budget reset
  CONTROLLER_PICK:  "CONTROLLER_PICK",   // who leads this round
  ACTION:           "ACTION",            // command UI is up, awaiting intent
  RESOLUTION:       "RESOLUTION",        // an intent just committed; detect + react
  PLAYER_END:       "PLAYER_END",
  ENEMY_START:      "ENEMY_START",
  ACTIVATE:         "ACTIVATE",          // one enemy: sense → decide → move
  REINFORCE:        "REINFORCE",         // Alert tier only
  ENEMY_END:        "ENEMY_END",
  ROUND_END:        "ROUND_END",
  CONFLICT_HANDOFF: "CONFLICT_HANDOFF",  // building the Battle Director payload
  STOPPED:          "STOPPED",
});

/** Events the director accepts. */
export const E = Object.freeze({
  START:          "START",
  DONE:           "DONE",            // the current state finished its own work
  MOVE:           "MOVE",            // player committed a move
  OBJECTIVE:      "OBJECTIVE",       // player committed an objective
  SWITCH:         "SWITCH",          // player changed the Main Controller
  END_TURN:       "END_TURN",        // player is done
  CONTACT:        "CONTACT",         // an enemy reached the party
  MORE_ENEMIES:   "MORE_ENEMIES",    // activation budget not yet spent
  NO_MORE:        "NO_MORE",
  STOP:           "STOP",
  ABORT:          "ABORT",
});

/**
 * next: a state, or (ctx, event) => state.
 * guard: optional (ctx, event) => true | false | "reason".
 *
 * An event with no entry in the current state is dropped and logged rather
 * than silently mutating anything — the Director's rule, and the reason a
 * mis-sequenced click cannot corrupt a turn.
 */
export const TRANSITIONS = Object.freeze({
  [S.IDLE]: {
    [E.START]: { next: S.PREP },
  },

  [S.PREP]: {
    [E.DONE]:  { next: S.ROUND_START },
    [E.ABORT]: { next: S.STOPPED },
  },

  [S.ROUND_START]: {
    [E.DONE]: { next: S.PLAYER_START },
  },

  [S.PLAYER_START]: {
    [E.DONE]: { next: S.CONTROLLER_PICK },
  },

  // Picking a leader is its own state because the choice is made ONCE per
  // round and every check that round uses that actor's stats. Folding it into
  // ACTION would let a player re-pick mid-turn after seeing a bad roll.
  [S.CONTROLLER_PICK]: {
    [E.DONE]: { next: S.ACTION },
  },

  [S.ACTION]: {
    [E.MOVE]:      { next: S.RESOLUTION },
    [E.OBJECTIVE]: { next: S.RESOLUTION },
    [E.SWITCH]:    { next: S.ACTION },      // free; does not consume the turn
    [E.END_TURN]:  { next: S.PLAYER_END },
    [E.CONTACT]:   { next: S.CONFLICT_HANDOFF },
    [E.STOP]:      { next: S.STOPPED },
  },

  [S.RESOLUTION]: {
    // Back to ACTION while the player still has anything left to spend.
    [E.DONE]:    { next: (ctx) => (ctx.turnExhausted() ? S.PLAYER_END : S.ACTION) },
    [E.CONTACT]: { next: S.CONFLICT_HANDOFF },
    [E.STOP]:    { next: S.STOPPED },
  },

  [S.PLAYER_END]: {
    [E.DONE]: { next: S.ENEMY_START },
  },

  [S.ENEMY_START]: {
    [E.MORE_ENEMIES]: { next: S.ACTIVATE },
    [E.NO_MORE]:      { next: S.REINFORCE },
  },

  [S.ACTIVATE]: {
    [E.MORE_ENEMIES]: { next: S.ACTIVATE },
    [E.NO_MORE]:      { next: S.REINFORCE },
    [E.CONTACT]:      { next: S.CONFLICT_HANDOFF },
    [E.STOP]:         { next: S.STOPPED },
  },

  [S.REINFORCE]: {
    [E.DONE]: { next: S.ENEMY_END },
  },

  [S.ENEMY_END]: {
    [E.DONE]: { next: S.ROUND_END },
  },

  [S.ROUND_END]: {
    [E.DONE]: { next: S.ROUND_START },
    [E.STOP]: { next: S.STOPPED },
  },

  // Terminal until the Battle Director hands control back, which arrives as a
  // fresh START rather than a resume — the fight may have changed everything.
  [S.CONFLICT_HANDOFF]: {
    [E.DONE]: { next: S.STOPPED },
    [E.STOP]: { next: S.STOPPED },
  },

  [S.STOPPED]: {
    [E.START]: { next: S.PREP },
  },
});

/** States in which the player's command UI should be up. */
export const PLAYER_INPUT_STATES = Object.freeze([S.CONTROLLER_PICK, S.ACTION]);

/** No timeouts: a GM composing a narration beat is not a hung pipeline. */
export const STATE_TIMEOUT_MS = Object.freeze({
  [S.PREP]: 30000,
  [S.ACTIVATE]: 20000,
});
