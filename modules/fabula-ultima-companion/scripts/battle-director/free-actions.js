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

const FLAG_NS = "fabula-ultima-companion";
const _registry = new Map();  // actor.id → grant

// Free-attack prevention check. Looks up the live actor and walks its
// appliedEffects for any AE carrying `flags.fabula-ultima-companion
// .preventFreeAttack: true`. Used by Quaking Titan's "No Free Attack"
// debuff (May 4 2026 playtest); pays forward to any future "this
// creature can't free-attack" status.
function actorHasFreeAttackPrevention(actorId) {
  if (!actorId) return false;
  try {
    const actor = game?.actors?.get?.(actorId);
    if (!actor) return false;
    const effs = actor.appliedEffects
      ? Array.from(actor.appliedEffects)
      : (actor.allApplicableEffects
          ? Array.from(actor.allApplicableEffects()).filter((e) => !e.disabled)
          : (actor.effects?.contents ?? []));
    for (const ae of effs) {
      if (ae?.disabled) continue;
      if (ae?.flags?.[FLAG_NS]?.preventFreeAttack === true) return true;
    }
  } catch (e) {
    warn("actorHasFreeAttackPrevention threw", e);
  }
  return false;
}

export const freeActions = {
  /**
   * Get the pending grant for `actorId`, or null. Returns null when the
   * actor has an active `preventFreeAttack` AE (Quaking Titan etc.) —
   * the grant is shelved but not consumed, so a subsequent expiry of
   * the prevention AE would surface the grant naturally on the next
   * read (typical use is one-shot: the prevention covers exactly the
   * window in which a counterattack-style grant would have fired).
   */
  get(actorId) {
    if (!actorId) return null;
    if (actorHasFreeAttackPrevention(actorId)) {
      log(`freeActions.get: ${actorId} has preventFreeAttack AE — grant suppressed`);
      return null;
    }
    return _registry.get(actorId) ?? null;
  },

  /**
   * Register a grant. Overwrites any prior grant on the same actor.
   * Pass `null` / `undefined` for the grant to clear (equivalent to
   * `clear(actorId)`).
   *
   * Refuses to register a grant on an actor with an active
   * preventFreeAttack AE — the grant source (typically a reaction)
   * gets told "no" at the dispatch site so the player isn't shown a
   * misleading free-action affordance the engine would later swallow.
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
    if (actorHasFreeAttackPrevention(actorId)) {
      log(`freeActions.set: ${actorId} has preventFreeAttack AE — grant refused`);
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
