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
  // PRE_ROLL — the pre-roll half of the two-phase Action Card. Entered after
  // TARGET, before the dice. Hosts performer-side reactions that must commit
  // BEFORE the result is known (rollPhase "pre" — Barrage). Renders the
  // pre-roll Action Card (formula + masked DEF, NO result) and awaits the
  // Roll confirm, then flows to COMPUTE which rolls the (possibly augmented)
  // target list. Auto-skips straight to COMPUTE when no pre-roll reaction is
  // eligible (a plain attack gains zero extra clicks).
  PRE_ROLL:         "PRE_ROLL",
  COMPUTE:          "COMPUTE",
  CONFIRM:          "CONFIRM",
  RESOLVE:          "RESOLVE",
  REACTION_WINDOW:  "REACTION_WINDOW",
  OPPORTUNITY_WINDOW: "OPPORTUNITY_WINDOW",
  CLEANUP:          "CLEANUP",
  TURN_END:         "TURN_END",
  ROUND_END:        "ROUND_END",
  // STANDALONE_REACTION_WINDOW — a transient state inserted between
  // FSM transitions (PREP↔ROUND_START, ROUND_START↔TURN_START, etc.) to
  // host standalone-trigger reactions (conflict_start, round_start,
  // turn_start, turn_end, round_end) per [[reaction-menu-on-token]].
  // The predecessor sets ctx.standaloneTrigger + ctx.standaloneAfter
  // before INTERNAL_DONE; this state's onEnter dispatches the trigger
  // (blocking until all reactor menus close) and the transition reads
  // ctx.standaloneAfter to route. F5-safe + ABORT-safe — dispatch
  // idempotency is keyed via scene flag.
  STANDALONE_REACTION_WINDOW: "STANDALONE_REACTION_WINDOW",
  // FREE_ACTION_WINDOW — drains the free-action queue (populated by
  // open_action_menu free_mode in reaction chains). Each entry runs
  // through the full DECLARE → TARGET → COMPUTE → CONFIRM → RESOLVE
  // pipeline with the reactor's turn snapshot swapped in + the
  // freeActions singleton holding the bonus to apply at COMPUTE. After
  // the action's RESOLVE/REACTION_WINDOW, the transition table routes
  // back here (when top of continuationStack is a `freeAction:*` frame).
  // FAW pops the frame on re-entry, restoring turnSnapshot+actionResult,
  // then drains the next request or exits to the frame underneath
  // (typically an `srwDetour:*` → SRW for re-dispatch).
  // See [[free-actions]] / [[continuation-stack]].
  FREE_ACTION_WINDOW: "FREE_ACTION_WINDOW",
  ABORTED:          "ABORTED",
  STOPPED:          "STOPPED",
});

// Default timeout per state in ms. null = synchronous, no timeout.
// Used by Director to set a fallback timer on state entry.
//
// Player/GM-input states (DECLARE / TARGET / CONFIRM / REACTION_WINDOW)
// are NOT timed in v1 — the director is GM-only, the GM sees every
// player's menu, and a long pause is far more likely to be the GM
// composing an equipment swap, scrolling the action menu, or waiting
// for a player to decide than a hung pipeline. The previous 5-min
// CONFIRM timeout caused silent turn-skips when a user lingered on the
// Equipment card. The dispatch-loop rate limiter in director.js still
// catches genuinely runaway transition loops, and the GM can always End
// Battle to recover. Re-enable specific timeouts later if player-side
// flows ship without GM oversight.
export const STATE_TIMEOUT_MS = Object.freeze({
  [STATES.IDLE]:            null,
  [STATES.PREP]:            120 * 1000,      // 2 min — full prep (preload + entrance + combat create); overrun signals a stuck pipeline
  [STATES.ROUND_START]:     null,
  [STATES.TURN_START]:      null,
  [STATES.DECLARE]:         null,            // was 5 min — disabled to prevent silent turn-skip on long menu pause
  [STATES.TARGET]:          null,            // was 2 min — disabled, same reason
  [STATES.PRE_ROLL]:        null,            // awaits the player's pre-roll reaction / Roll confirm
  [STATES.COMPUTE]:         null,
  [STATES.CONFIRM]:         null,            // was 5 min — disabled, same reason (Equipment / Item composition can be long)
  [STATES.RESOLVE]:         null,
  [STATES.REACTION_WINDOW]: null,            // was 30 s — disabled; GM manually advances when player reactions are done (GM sees all menus). v1 stub still self-fires INTERNAL_DONE after 100ms.
  [STATES.OPPORTUNITY_WINDOW]: null,         // no timeout — awaits player choice; offer() has a 120s built-in safety timeout
  [STATES.CLEANUP]:         null,
  [STATES.TURN_END]:        null,
  [STATES.ROUND_END]:       null,
  [STATES.STANDALONE_REACTION_WINDOW]: null, // no timeout — GM may wait on multiple players resolving their reaction menus simultaneously
  [STATES.FREE_ACTION_WINDOW]: null,         // owns full compose+commit; same reasoning as the per-action input states
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
import { topIsFreeAction, peekTop } from "./continuation-stack.js";

export const TRANSITIONS = Object.freeze({
  [STATES.IDLE]: {
    // Branching: if the director was started with a payload, run PREP to
    // do the full curtain/spawn/preload/entrance/combat-create pipeline.
    // If started with an already-existing combat (manual fallback), skip
    // PREP and go straight to ROUND_START.
    [INTENTS.START_COMBAT]: { next: (ctx) => ctx.payload ? STATES.PREP : STATES.ROUND_START },
  },

  [STATES.PREP]: {
    // PREP → STANDALONE_REACTION_WINDOW (conflict_start) → ROUND_START.
    // PREP.onEnter sets ctx.standaloneTrigger="conflict_start" +
    // ctx.standaloneAfter=ROUND_START before enqueueing INTERNAL_DONE.
    INTERNAL_DONE:   { next: STATES.STANDALONE_REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    [INTENTS.TIMEOUT]: { next: STATES.ABORTED },
  },

  [STATES.ROUND_START]: {
    // round_start reactions fire unless combat is ending. ROUND_START.onEnter
    // sets ctx.standaloneTrigger="round_start" + ctx.standaloneAfter=TURN_START.
    INTERNAL_DONE: { next: (ctx) => ctx.endOfCombat ? STATES.STOPPED : STATES.STANDALONE_REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.TURN_START]: {
    // turn_start reactions fire unless combat ended on auto-fail (no
    // eligible). TURN_START.onEnter sets ctx.standaloneTrigger="turn_start"
    // + ctx.standaloneAfter=DECLARE.
    INTERNAL_DONE: { next: (ctx) => ctx.endOfCombat ? STATES.STOPPED : STATES.STANDALONE_REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.DECLARE]: {
    [INTENTS.DECLARE_COMMAND]: { next: STATES.TARGET },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    // Compose cancel (Esc from Octopath). For a free action, top of
    // the continuation stack is a `freeAction:*` frame; cancelling
    // forfeits the request — route back to FREE_ACTION_WINDOW so FAW
    // pops the frame, restores the original snapshot, and drains the
    // next request (or exits to top.resumeAt). For a regular turn,
    // fall through to TURN_END.
    [INTENTS.TIMEOUT]: { next: (ctx) => topIsFreeAction(ctx) ? STATES.FREE_ACTION_WINDOW : STATES.TURN_END },
  },

  [STATES.TARGET]: {
    [INTENTS.TARGET_PICKED]: { next: STATES.PRE_ROLL },
    [INTENTS.TARGET_BACK]: { next: STATES.DECLARE },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    [INTENTS.TIMEOUT]: { next: STATES.ABORTED },
  },

  [STATES.PRE_ROLL]: {
    // PreRoll.onEnter runs the pre-roll reaction window (auto-skips when none
    // eligible) + awaits the Roll confirm, then enqueues INTERNAL_DONE to roll.
    INTERNAL_DONE: { next: STATES.COMPUTE },
    // Back-out from the pre-roll card returns to the action picker.
    [INTENTS.CANCEL_ACTION]: { next: STATES.DECLARE },
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
    INTERNAL_DONE: { next: (ctx) => ctx.hasPendingOpportunity ? STATES.OPPORTUNITY_WINDOW : STATES.REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.OPPORTUNITY_WINDOW]: {
    INTERNAL_DONE: { next: STATES.REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.REACTION_WINDOW]: {
    // Free-action sub-flow: top of continuation stack is a `freeAction:*`
    // frame. Skip CLEANUP/TURN_END (which would advance the real
    // combatant's turn). Re-enter FREE_ACTION_WINDOW so the queue
    // drains its next request or pops back to the SRW detour frame.
    INTERNAL_DONE: { next: (ctx) => topIsFreeAction(ctx) ? STATES.FREE_ACTION_WINDOW : STATES.CLEANUP },
    [INTENTS.TIMEOUT]: { next: (ctx) => topIsFreeAction(ctx) ? STATES.FREE_ACTION_WINDOW : STATES.CLEANUP },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.CLEANUP]: {
    // Multi-pass attacks (Two-Weapon Fighting per RAW Core p.69): when
    // CLEANUP runs and the attack queue still has weapons, loop back to
    // TARGET so the player can pick a (possibly different) target for the
    // next pass. RAW: "they may both be aimed at the same target or
    // different targets." The Cleanup handler preserves attackMode +
    // pendingPasses + passIndex; TARGET detects re-entry and skips the
    // weapon-mode picker.
    INTERNAL_DONE: {
      next: (ctx) => (Array.isArray(ctx.pendingPasses) && ctx.pendingPasses.length > 0)
        ? STATES.TARGET
        : STATES.TURN_END
    },
    [INTENTS.ABORT]: { next: STATES.STOPPED },
  },

  [STATES.TURN_END]: {
    // turn_end always routes through STANDALONE_REACTION_WINDOW —
    // end-of-turn reactions fire even on the last turn before round
    // wrap. TURN_END.onEnter sets ctx.standaloneTrigger="turn_end" +
    // ctx.standaloneAfter = endOfRound ? ROUND_END : TURN_START.
    INTERNAL_DONE: { next: STATES.STANDALONE_REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.ROUND_END]: {
    // round_end fires unless combat ended this round. ROUND_END.onEnter
    // sets ctx.standaloneTrigger="round_end" + ctx.standaloneAfter=ROUND_START.
    INTERNAL_DONE: { next: (ctx) => ctx.endOfCombat ? STATES.STOPPED : STATES.STANDALONE_REACTION_WINDOW },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
  },

  [STATES.STANDALONE_REACTION_WINDOW]: {
    // Routes to whatever predecessor set as ctx.standaloneAfter. The
    // ABORTED fallback prevents wedge if the field is missing (e.g. a
    // direct ENTER via test injection). The window handler may have
    // re-pointed ctx.standaloneAfter at FREE_ACTION_WINDOW if any
    // reactions registered a free-action grant — see
    // StandaloneReactionWindow.onEnter.
    INTERNAL_DONE: { next: (ctx) => ctx.standaloneAfter ?? STATES.ABORTED },
    [INTENTS.ABORT]: { next: STATES.ABORTED },
    [INTENTS.TIMEOUT]: { next: STATES.ABORTED },
  },

  [STATES.FREE_ACTION_WINDOW]: {
    // Routing fork — read off the continuation stack:
    //   top is `freeAction:*` (just pushed by onEnter)  → DECLARE
    //     The player composes + commits this free action. On
    //     completion, RESOLVE → REACTION_WINDOW routes back here,
    //     onEnter pops, and we re-evaluate.
    //   top is `srwDetour:*` (SRW pushed before routing here) → SRW
    //     Queue empty AND we have an SRW frame underneath; FAW exit
    //     routes back to SRW which pops its own frame.
    //   no top                                          → TURN_START
    //     Queue empty AND no frame; fall back to the normal turn flow.
    INTERNAL_DONE: { next: (ctx) => {
      const top = peekTop(ctx);
      if (top?.reason?.startsWith?.("freeAction:")) return STATES.DECLARE;
      return top?.resumeAt ?? STATES.TURN_START;
    } },
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
