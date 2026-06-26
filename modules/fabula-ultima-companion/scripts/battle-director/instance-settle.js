/**
 * Transaction "instance" settle — Tier-1 forced, non-action drain.
 *
 * Part of the transactional Start-of-Turn architecture (see the
 * `project_bd_hp_change_and_crisis_trigger` memory). An "instance" runs the
 * system to QUIESCENCE before yielding to the player: gather deltas → commit →
 * checkpoint → settle. This module owns the settle's first tier — draining the
 * resource ledger (`director.ctx._postResolveTriggers`) and re-firing reactions
 * until no new events appear.
 *
 * Tiering (the caller, SRW, orchestrates the rest):
 *   T1  forced, non-action  — HERE. Drain the ledger; built-in engine reactors
 *                             (crisis, Batch 3) + authored subject-scoped
 *                             reactions fire; both may append MORE events
 *                             (cascade: HP-loss → crisis AE → status event → …).
 *                             Loop until a pass adds nothing.
 *   T2  mandatory cards     — NOT here. Firing an action-creating reaction only
 *                             ENQUEUES to freeActionQueue; the caller drains
 *                             that queue AFTER the checkpoint (players-first),
 *                             so player cards land post-commit.
 *   T3  ask                 — NOT here. The caller runs the ask pass last.
 *
 * Termination: `maxIters` cap + a per-instance firedKey dedup set, so a reactor
 * can't re-fire on its own cascade (crisis⇄uncrisis ping-pong). No silent cap —
 * hitting the limit warns and drops the residue rather than hanging the FSM.
 */
import { log, warn } from "./logger.js";

// Built-in engine reactors — invoked per ledger event during T1, BEFORE
// authored reactions. Each is `async (director, cfg, { firedKeys }) => void`
// and may append events to `ctx._postResolveTriggers`. Batch 3 registers the
// crisis reactor via registerBuiltinReactor.
const BUILTIN_REACTORS = [];

// Resource/status ledger events are dispatched OBSERVER-AWARE: walked across
// every combatant so a reaction on a DIFFERENT creature can match (On the
// Hunt: "when an ENEMY enters Crisis"). The reaction_source filter gates
// self/ally/enemy off the event subject (payload.sourceActorUuid). All other
// triggers stay SUBJECT-scoped (firePassiveTriggers) to preserve legacy
// behavior — esp. rows with a blank source filter, which a combatant-walk
// would otherwise over-fire.
const LEDGER_FAMILY = new Set([
  "creature_lose_resource", "creature_gain_resource",
  "creature_status_applied", "creature_loses_status",
  // creature_defeated fans out observer-aware too — an onlooker reacts to
  // ANOTHER creature's defeat (Phantasmal Echo: recover MP when MY phantasm is
  // shattered), gated by the row's condition_formula (SUBJECT_IS_MY_PHANTASM).
  "creature_defeated",
  // creature_unleashes_zero_power is a BROADCAST — an ALLY reacts to the
  // caster unleashing a Zero Power (Matador's Zero Trigger: gain 6 ZP). Must
  // fan out observer-aware so it reaches allied combatants, not just the caster;
  // the row's reaction_source "ally" matches the unleasher (and excludes self).
  "creature_unleashes_zero_power",
  // creature_status_triggered fans out observer-aware — an ONLOOKER reacts to
  // ANOTHER creature's status producing its effect (Wandering Flame's Ignition:
  // +10 MP +1 ZP whenever ANY creature's Burn triggers). Emitted by emit_trigger
  // deal_damage rows (the Burn tick + trigger_status replays); listeners scope by
  // status via reaction_status_filter. Subject = the afflicted creature.
  "creature_status_triggered",
]);

export function registerBuiltinReactor(fn) {
  if (typeof fn === "function" && !BUILTIN_REACTORS.includes(fn)) BUILTIN_REACTORS.push(fn);
}

export function clearBuiltinReactors() {
  BUILTIN_REACTORS.length = 0;
}

export async function settleInstance(director, { reason = "", maxIters = 8, recordForReoffer = false } = {}) {
  const ctx = director?.ctx;
  if (!ctx) return { reason, iters: 0, fired: 0 };
  if (!Array.isArray(ctx._postResolveTriggers)) ctx._postResolveTriggers = [];

  // Re-offer recording — the RESOLVE caller (post-action-card reactions) sets
  // recordForReoffer so REACTION_WINDOW can re-offer this action's reaction
  // group after a queued free action drains (the deferred-action → return-to-
  // reaction-phase loop). We snapshot the ACTION-LEVEL trigger configs only
  // (the initial batch queued by resolveAction — not the transient ledger
  // cascade) in a persistence-safe shape (actor UUID, not the live doc), and
  // accumulate every fired reaction into a WINDOW-SCOPED used-set so the
  // re-offer skips it. "Window-scoped" = this one action's resolution: the set
  // is cleared at CLEANUP, so the next action starts fresh. This mirrors SRW's
  // standaloneFired and is what makes a reaction once-per-window — re-offering
  // surfaces OTHER reactions/reactors, never the same row twice, which also
  // bounds the counter chain (no infinite Counter Pass on one miss).
  // Lifecycle (SRW) callers leave this false — SRW owns its own re-offer loop.
  if (recordForReoffer) {
    ctx._reactionWindowTriggers = ctx._postResolveTriggers
      .map((cfg) => ({
        trigger: cfg?.trigger ?? null,
        payload: cfg?.payload ?? null,
        casterActorUuid: cfg?.casterActor?.uuid ?? null,
      }))
      .filter((c) => c.trigger);
    if (!Array.isArray(ctx._postResolveUsed)) ctx._postResolveUsed = [];
  }
  const rememberUsed = (f) => {
    if (!recordForReoffer || f?.carrierUuid == null || f?.rowKey == null) return;
    const key = `${f.carrierUuid}:${f.rowKey}`;
    if (!ctx._postResolveUsed.some((e) => `${e.carrierUuid}:${e.rowKey}` === key)) {
      ctx._postResolveUsed.push({ carrierUuid: f.carrierUuid, rowKey: f.rowKey });
    }
  };

  // Dynamic import keeps the cross-module hop cache-bust-friendly and avoids
  // any load-order coupling with the (large) skill-effects module.
  const { firePassiveTriggers } = await import("./skill-effects.js");
  const { collectReactors, dispatchReactionMenu } = await import("./standalone-reactions.js");

  const firedKeys = new Set();   // reactor-level dedup, shared across passes

  // Re-entrancy guard — "a reaction doesn't trigger from itself by default".
  // An authored ledger reaction that DEALS damage (Searing Brand's mark =
  // creature_lose_resource → deal_damage to the bearer) emits a NEW lose_resource
  // event into the next pass; without a guard that event re-matches the SAME
  // reaction → it explodes every pass until maxIters drops the residue. We
  // accumulate each authored reaction's (carrierUuid:rowKey) once it fires and
  // pass them as `skipEvaluated` on SUBSEQUENT passes, so a reaction never fires
  // on its own cascade. Crucially the skip set is built from PRIOR passes only —
  // every event already queued when a pass begins (e.g. a multi-hit attack's
  // per-hit losses, all in pass 1) still fires the reaction once each; only the
  // reaction's OWN downstream emission (pass 2+) is suppressed.
  const authoredFiredEntries = [];     // [{ carrierUuid, rowKey }] for skipEvaluated
  const authoredFiredSeen = new Set();  // dedup `${carrierUuid}:${rowKey}`
  let iters = 0;
  let fired = 0;

  while (iters < maxIters) {
    iters++;
    const batch = ctx._postResolveTriggers;
    if (!batch.length) break;
    // Take the batch; a fresh sink collects cascade events appended during the
    // drain, which the next pass picks up.
    ctx._postResolveTriggers = [];

    // Snapshot the prior-pass fired set — only these are skipped this pass.
    const skipEvaluated = authoredFiredEntries.slice();
    const firedThisPass = [];

    for (const cfg of batch) {
      // Built-in engine reactors first (crisis etc.) — they read the event and
      // may apply AEs / append further events.
      for (const fn of BUILTIN_REACTORS) {
        try { await fn(director, cfg, { firedKeys }); }
        catch (e) { warn(`settleInstance(${reason}): builtin reactor threw for ${cfg?.trigger}`, e); }
      }
      // Authored reactions. Ledger-family events dispatch observer-aware
      // (combatant-walk) so a reaction on another creature can match; all
      // other triggers stay subject-scoped.
      try {
        if (LEDGER_FAMILY.has(cfg?.trigger)) {
          const reactors = await collectReactors(director);
          for (const { actor, token } of reactors) {
            const r = await dispatchReactionMenu({ director, reactor: actor, token, trigger: cfg.trigger, payload: cfg.payload, skipEvaluated });
            for (const f of (r?.fired ?? [])) {
              fired += 1;
              if (f?.carrierUuid != null && f?.rowKey != null) {
                firedThisPass.push({ carrierUuid: f.carrierUuid, rowKey: f.rowKey });
              }
              rememberUsed(f);
            }
          }
        } else {
          const res = await firePassiveTriggers({ director, ...cfg });
          const ff = res?.fired ?? [];
          fired += ff.length;
          for (const f of ff) rememberUsed(f);
        }
      } catch (e) {
        warn(`settleInstance(${reason}): drain threw for ${cfg?.trigger}`, e);
      }
    }

    // Promote this pass's authored firings so the NEXT pass skips them (the
    // self-cascade guard). Deferred to pass end so same-pass siblings aren't
    // suppressed.
    for (const e of firedThisPass) {
      const key = `${e.carrierUuid}:${e.rowKey}`;
      if (!authoredFiredSeen.has(key)) { authoredFiredSeen.add(key); authoredFiredEntries.push(e); }
    }
  }

  if (iters >= maxIters && ctx._postResolveTriggers.length) {
    warn(`settleInstance(${reason}): hit maxIters=${maxIters} with ${ctx._postResolveTriggers.length} event(s) still queued — possible non-terminating cascade; dropping the residue to avoid a hang`);
    ctx._postResolveTriggers = [];
  }
  if (fired || iters > 1) {
    log(`settleInstance(${reason}): ${iters} pass(es), ${fired} reaction(s) fired`);
  }
  return { reason, iters, fired };
}

// Resolve a reactor actor's canvas token for menu anchoring. Prefers the
// active-scene placeable (the menu anchors on token.center); null when the
// reactor isn't on the current canvas (off-scene → no menu, skip).
function resolveReactorToken(actor) {
  if (!actor) return null;
  return canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === actor.uuid) ?? null;
}

// Re-offer the post-resolve (post-action-card) reaction group after a queued
// free action has drained — the "return to step 1" half of the deferred-action
// loop. Mirrors settleInstance's FIRST offer but:
//   - ASK ONLY (`phase: "ask"`) — the forced/cascade pass already committed in
//     RESOLVE; re-running it would double-fire Burn/charges/crisis.
//   - re-dispatches only the ACTION-LEVEL triggers (`triggers`, captured by
//     settleInstance's recordForReoffer) — not the transient ledger cascade.
//   - threads the window's used-set (`used`) as skipEvaluated so a reaction
//     already fired in this window isn't re-offered — once-per-window, which
//     bounds the counter chain. Other (un-used) reactions still surface, so the
//     window genuinely "re-opens" for everyone who hasn't acted yet.
// Newly-fired rows are appended to the used-set (both the local skip list AND
// ctx._postResolveUsed) so the NEXT loop iteration skips them too.
// Returns `{ fired }` — the count that fired this pass. The caller (REACTION_
// WINDOW) loops while the free-action queue keeps refilling.
export async function reofferPostResolveReactions(director, { triggers, used } = {}) {
  const ctx = director?.ctx;
  if (!ctx || !Array.isArray(triggers) || !triggers.length) return { fired: 0 };
  const { collectReactors, dispatchReactionMenu } = await import("./standalone-reactions.js");
  const skipEvaluated = Array.isArray(used) ? used.slice() : [];
  let fired = 0;

  const remember = (f) => {
    if (f?.carrierUuid == null || f?.rowKey == null) return;
    const key = `${f.carrierUuid}:${f.rowKey}`;
    if (!skipEvaluated.some((e) => `${e.carrierUuid}:${e.rowKey}` === key)) {
      skipEvaluated.push({ carrierUuid: f.carrierUuid, rowKey: f.rowKey });
    }
    if (Array.isArray(ctx._postResolveUsed) &&
        !ctx._postResolveUsed.some((e) => `${e.carrierUuid}:${e.rowKey}` === key)) {
      ctx._postResolveUsed.push({ carrierUuid: f.carrierUuid, rowKey: f.rowKey });
    }
  };

  for (const cfg of triggers) {
    if (!cfg?.trigger) continue;
    try {
      if (LEDGER_FAMILY.has(cfg.trigger)) {
        // Observer-aware: walk every live reactor (a creature other than the
        // event subject may match), exactly as settleInstance does.
        const reactors = await collectReactors(director);
        for (const { actor, token } of reactors) {
          const r = await dispatchReactionMenu({
            director, reactor: actor, token,
            trigger: cfg.trigger, payload: cfg.payload, skipEvaluated, phase: "ask",
          });
          for (const f of (r?.fired ?? [])) { fired += 1; remember(f); }
        }
      } else {
        // Subject-scoped — re-offer to the recorded caster only.
        const reactor = cfg.casterActorUuid ? await fromUuid(cfg.casterActorUuid).catch(() => null) : null;
        if (!reactor) continue;
        const token = resolveReactorToken(reactor);
        if (!token) continue;
        const r = await dispatchReactionMenu({
          director, reactor, token,
          trigger: cfg.trigger, payload: cfg.payload, skipEvaluated, phase: "ask",
        });
        for (const f of (r?.fired ?? [])) { fired += 1; remember(f); }
      }
    } catch (e) {
      warn(`reofferPostResolveReactions: dispatch threw for ${cfg.trigger}`, e);
    }
  }
  if (fired) log(`reofferPostResolveReactions: ${fired} reaction(s) re-offered + fired`);
  return { fired };
}
