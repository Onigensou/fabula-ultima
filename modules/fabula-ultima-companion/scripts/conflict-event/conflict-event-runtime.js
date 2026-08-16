// ============================================================================
// Conflict Event System — Battle Director binding.
//
// The whole BD footprint of this feature is four call sites:
//
//   director-boot.js            registerBuiltinReactor(conflictEventReactor)
//   state-handlers.js (SRW)     dispatchConflictEventLifecycle(...)
//   battle-end-orchestrator.js  teardownConflictEvent(...)
//
// Everything else lives in this folder. With `none` selected — the default
// everywhere — every entry point below returns before doing anything, so the
// director behaves exactly as it did before this system existed.
//
// ── Why the ledger half rides registerBuiltinReactor ────────────────────────
//
// The obvious seam for "observe BD from outside" is the `fu-director-trigger`
// Hook that skill-effects.js broadcasts, which is how the clock system
// listens. It is the WRONG seam here. That hook is `Hooks.callAll` —
// synchronous and unawaited — so an async subscriber that applies an AE races
// the settle loop it was reacting to. Clocks get away with it because
// incrementing a counter can land late; moving a status cannot.
//
// registerBuiltinReactor runs INSIDE settleInstance, is awaited, is handed the
// shared `firedKeys` dedupe set, and fires before the authored-reaction walk.
// The crisis, defeat, derived-status and Blackest Night reactors all ride it.
//
// ── Why nothing is cached on ctx ────────────────────────────────────────────
//
// persistence.js captures an ALLOWLIST of ctx fields (the continuation stack,
// standalone*, payload) — not the whole object. A `ctx.conflictEventId` cache
// would therefore be silently undefined after an F5 mid-battle, and the hazard
// would stop running for the rest of the fight with nothing in the log.
//
// So the event is re-resolved on every dispatch from `ctx.payload` and the
// battle scene, both of which ARE restored. Resolution is a couple of property
// reads; there is no cache to go stale, and F5-resume works for free.
// ============================================================================

import { getConflictEvent } from "./conflict-event-registry.js";
import { resolveConflictEventId } from "./conflict-event-binding.js";

const TAG = "[FU][ConflictEvent]";

const log = (...a) => console.debug(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

/** Lifecycle trigger → event handler name. */
const LIFECYCLE_HANDLERS = Object.freeze({
  conflict_start: "onConflictStart",
  round_start: "onRoundStart",
});

/**
 * The event in play for this director, or null.
 *
 * Re-resolved on every call (see the header). Returns null for `none`, for an
 * unknown id, and whenever there is no live combat.
 */
export function activeConflictEvent(director) {
  const dCombat = director?.dCombat ?? null;
  if (!dCombat) return null;

  const scene = dCombat.scene ?? canvas?.scene ?? null;
  const { id, source } = resolveConflictEventId({ scene, payload: director?.ctx?.payload ?? null });
  const event = getConflictEvent(id);
  if (!event) {
    // A selection that names an event nobody registered is a real problem —
    // the arena is configured for a hazard that will not run. Warn once per
    // conflict rather than on every damage event.
    if (id && id !== "none" && !director.ctx._conflictEventMissingWarned) {
      director.ctx._conflictEventMissingWarned = true;
      warn(`scene selects conflict event "${id}" but no such event is registered — running a standard conflict`);
    }
    return null;
  }
  return { id, event, source };
}

/**
 * Build the context handed to every event handler.
 *
 * Deliberately narrow. An event gets the director, the battlefield, and BD's
 * OWN effect executor — it must never write HP or roll damage itself. Routing
 * through applyEffectRow is what makes an event's damage pick up affinities,
 * absorb, the resource ledger and the downstream trigger cascade, exactly like
 * any authored skill. Three of the four Valley of the Dragon monsters absorb
 * Bolt, so a hazard that bypassed that path would be wrong on its first hit.
 */
async function buildEventCtx(director, eventId) {
  const [{ applyEffectRow, applyEffectByLabel }, { collectReactors }] = await Promise.all([
    import("../battle-director/skill-effects.js"),
    import("../battle-director/standalone-reactions.js"),
  ]);

  return {
    director,
    eventId,
    dCombat: director?.dCombat ?? null,
    scene: director?.dCombat?.scene ?? canvas?.scene ?? null,

    /**
     * Live, non-defeated combatants as [{ actor, token, combatantId }].
     * Shared with the reaction dispatcher, so "who is in this conflict" means
     * the same thing to an event as it does to BD.
     */
    combatants: () => collectReactors(director),

    applyEffectRow,
    applyEffectByLabel,

    log: (...a) => log(`(${eventId})`, ...a),
    warn: (...a) => warn(`(${eventId})`, ...a),
  };
}

/**
 * Lifecycle dispatch — called from STANDALONE_REACTION_WINDOW's forced phase,
 * alongside the crisis / derived-status / defeat sweeps.
 *
 * `conflict_start` and `round_start` only: the per-turn beat of an event
 * belongs on an Active Effect (which fires per ACTIVATION for free and works
 * on PCs and NPCs with no per-actor authoring), not here.
 */
export async function dispatchConflictEventLifecycle(director, trigger) {
  const handlerName = LIFECYCLE_HANDLERS[trigger];
  if (!handlerName) return;
  if (!game.user?.isGM) return;

  const active = activeConflictEvent(director);
  if (!active) return;

  const handler = active.event[handlerName];
  if (typeof handler !== "function") return;

  try {
    const ctx = await buildEventCtx(director, active.id);
    log(`${trigger} → ${active.id}.${handlerName}()`);
    await handler(ctx);
  } catch (e) {
    // An event must never take the battle down with it. The fight continues
    // without the extra rule rather than aborting to a broken FSM state.
    warn(`"${active.id}" ${handlerName} threw — the conflict continues without it`, e);
  }
}

/**
 * Ledger dispatch — registered via registerBuiltinReactor, so it runs inside
 * settleInstance for every resource/status ledger event (creature_lose_resource,
 * creature_gain_resource, creature_defeated, ...).
 *
 * `extra.firedKeys` is the settle loop's shared dedupe set; an event that must
 * act at most once per settle claims a key in it (a multi-hit kill emits
 * several HP events).
 */
export async function conflictEventReactor(director, cfg, extra) {
  if (!game.user?.isGM) return;
  if (!director?.ctx || !director?.dCombat?.started) return;

  const active = activeConflictEvent(director);
  if (!active) return;

  const handler = active.event.onLedgerEvent;
  if (typeof handler !== "function") return;

  try {
    const ctx = await buildEventCtx(director, active.id);
    await handler(ctx, cfg, extra);
  } catch (e) {
    warn(`"${active.id}" onLedgerEvent threw — the conflict continues without it`, e);
  }
}

/**
 * Teardown — called from the battle-end orchestrator.
 *
 * BD has no `conflict_end` dispatch site yet (state-handlers.js says so where
 * STOPPED tears the menus down: it needs a pre-STOPPED hook so players can
 * react before tokens are wiped). Until that lands, battle end is where an
 * event sweeps up, which matters because a status an event seeded must not
 * follow a creature out of the fight.
 */
export async function teardownConflictEvent(director) {
  if (!game.user?.isGM) return;

  const active = activeConflictEvent(director);
  if (!active) return;

  const handler = active.event.onConflictEnd;
  if (typeof handler !== "function") return;

  try {
    const ctx = await buildEventCtx(director, active.id);
    log(`conflict end → ${active.id}.onConflictEnd()`);
    await handler(ctx);
  } catch (e) {
    warn(`"${active.id}" onConflictEnd threw — cleanup may be incomplete`, e);
  }
}
