// ============================================================================
// force-skip-guard — when may the GM's Next Turn / Next Round take effect?
//
// forceNextTurn / forceNextRound call director.transitionTo(TURN_END) WITHOUT
// the dispatch lock. A state whose onEnter is still running holds that lock
// while it waits on a human (an open reaction menu, a picker): TURN_END's
// INTERNAL_DONE then queues behind the lock forever, wedging the FSM.
// Pure (no Foundry globals) so node tests can import it.
// ============================================================================
import { STATES } from "./states.js";

export const TURN_START_BUSY = "A side is choosing who acts. Pick a unit first, then skip.";
export const REACTION_WINDOW_BUSY = "Reactions are open. Resolve or skip them first (Skip open reactions), then skip the turn.";

/** Returns an error string when a forced skip must be refused in `state`, else null. */
export function forceSkipRefusal(state) {
  if (state === STATES.TURN_START) return TURN_START_BUSY;
  if (state === STATES.STANDALONE_REACTION_WINDOW || state === STATES.FREE_ACTION_WINDOW) return REACTION_WINDOW_BUSY;
  return null;
}

/**
 * True while the FSM is still in the same ENTRY of `state` that captured
 * `epoch` (director._stateEpoch). A handler's onEnter awaits long things
 * (autopilot decide); a forced transition can move the FSM on meanwhile, and
 * the handler must then not open menus / take the lock for a state that is gone.
 */
export function stillInEntry(director, state, epoch) {
  return director?.state === state && director?._stateEpoch === epoch;
}
