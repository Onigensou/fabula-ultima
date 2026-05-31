// Free-action queue — FIFO list of pending FreeActionRequests produced
// by reaction chains' `open_action_menu free_mode` step. The FSM's
// FREE_ACTION_WINDOW state drains this queue one request at a time;
// each request runs through the full DECLARE → ... → RESOLVE pipeline
// with the reactor's turn snapshot swapped in + the `freeActions`
// singleton holding the bonus to apply at COMPUTE.
//
// FreeActionRequest shape:
//   {
//     reactorActorId:        string         — actor.id of the reactor
//     reactorActorUuid:      string         — Actor.X (for fromUuid)
//     reactorTokenUuid:      string         — Scene.Y.Token.Z (canvas lookup)
//     enabledLabels:         string[]       — Octopath filter ("Attack" / "Hinder" / ...)
//     checkBonus:            number         — COMPUTE adds to roll
//     damageBonus:           number         — COMPUTE adds to damage
//     maxMpCost:             number | null  — Spell cost cap (future)
//     lockedTargetTokenUuid: string | null  — Forced target (future, Painful Lesson)
//     sourceLabel:           string         — "High Speed" / "Acceleration" / etc.
//     sourceItemUuid:        string         — Actor.X.Item.Y of the granting skill/AE
//   }
//
// Ordering: FIFO. First reaction to fire wins. Matches the locked
// reaction-architecture rule (first-to-click after re-gate). Currently
// in-memory only — F5 mid-queue resets the queue (the standaloneFired
// flag is the persistence layer for which reactions have committed, so
// re-running the standalone trigger after F5 only re-spawns pills for
// undecided reactors). Scene-flag persistence is a future iteration if
// mid-queue F5 turns out to be a real-world concern.

import { log, warn } from "./logger.js";

const _queue = [];

export const freeActionQueue = {
  enqueue(request) {
    if (!request?.reactorActorId) {
      warn("freeActionQueue.enqueue: missing reactorActorId", request);
      return;
    }
    _queue.push({ ...request });
    log(`freeActionQueue: enqueued "${request.sourceLabel ?? "?"}" for ${request.reactorActorId} (len ${_queue.length})`);
  },

  peek() {
    return _queue[0] ?? null;
  },

  dequeue() {
    if (_queue.length === 0) return null;
    const popped = _queue.shift();
    log(`freeActionQueue: dequeued "${popped.sourceLabel ?? "?"}" for ${popped.reactorActorId} (len ${_queue.length})`);
    return popped;
  },

  isEmpty() {
    return _queue.length === 0;
  },

  size() {
    return _queue.length;
  },

  clear() {
    if (_queue.length === 0) return;
    log(`freeActionQueue: clearing ${_queue.length} pending request(s)`);
    _queue.length = 0;
  },

  /** Diagnostic snapshot — plain array copy. */
  snapshot() {
    return _queue.map((r) => ({ ...r }));
  },
};
