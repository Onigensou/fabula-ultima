// Free-action grant registry — singleton in-memory store of pending
// free-action grants keyed by actor.id. Mirrors the legacy
// `FUCompanion.api.freeActions` shape (in scripts/reaction-system/) so
// authoring patterns transfer cleanly: a reaction's `open_action_menu`
// row with `free_mode: true` calls `set(actorId, grant)`, then
// `composeAction` reads via `get(actorId)` and:
//   - filters the Octopath to `enabledLabels`
//   - applies `checkBonus` / `damageBonus` to the composed action's roll
//   - clears the grant after the action commits (or is cancelled)
//
// Grant shape:
//   {
//     enabledLabels:        string[]  — Octopath buttons that should be enabled
//                                       (others greyed out). E.g. ["Attack","Hinder"]
//     sourceEffectUuid:     string|null — AE this grant originated from, if any
//     sourceLabel:          string    — display name ("High Speed")
//     checkBonus:           number    — flat +N to the action's Check total
//     damageBonus:          number    — flat +N to the action's damage roll
//     maxMpCost:            number|null — Spell-only: caps the spell's MP cost
//     lockedTargetTokenUuid:string|null — if set, force this target (Painful Lesson use case)
//   }
//
// In-memory only — no persistence to scene flags. Free-action grants
// are conflict-scoped at most; on FSM stop / scene reload they reset.

import { log, warn } from "./logger.js";

const _registry = new Map();  // actor.id → grant

export const freeActions = {
  /** Get the pending grant for `actorId`, or null. */
  get(actorId) {
    if (!actorId) return null;
    return _registry.get(actorId) ?? null;
  },

  /**
   * Register a grant. Overwrites any prior grant on the same actor.
   * Pass `null` / `undefined` for the grant to clear (equivalent to
   * `clear(actorId)`).
   */
  set(actorId, grant) {
    if (!actorId) {
      warn("freeActions.set: missing actorId");
      return;
    }
    if (grant == null) {
      _registry.delete(actorId);
      log(`freeActions: cleared grant for ${actorId}`);
      return;
    }
    _registry.set(actorId, { ...grant });
    log(`freeActions: registered grant for ${actorId}`, grant);
  },

  /** Clear the grant for `actorId`. */
  clear(actorId) {
    if (!actorId) return;
    if (_registry.has(actorId)) {
      _registry.delete(actorId);
      log(`freeActions: cleared grant for ${actorId}`);
    }
  },

  /** Clear ALL grants. Called on FSM stop / scene end / battle end. */
  clearAll() {
    if (_registry.size === 0) return;
    log(`freeActions: clearAll (${_registry.size} grants)`);
    _registry.clear();
  },

  /** Snapshot — returns a plain object copy keyed by actor.id. Diag only. */
  snapshot() {
    const out = {};
    for (const [k, v] of _registry.entries()) out[k] = { ...v };
    return out;
  },
};
