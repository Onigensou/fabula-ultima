/**
 * Free-Action State — Foundry V12
 * -----------------------------------------------------------------------------
 * In-memory store for a single pending "free action" handoff between a
 * reaction (e.g. Acceleration's `open_action_menu` effect_kind) and the
 * next action the reactor takes.
 *
 * Lifecycle of one entry:
 *   1. Reactor picks Acceleration. `applyOpenActionMenuEffect` (reaction-grant)
 *      calls `api.set(actorId, { enabledLabels, sourceEffectUuid })`.
 *   2. The Octopath action menu spawns over the reactor's token with only
 *      the enabled labels clickable. `updateBudgetLabel` (turn-ui-manager)
 *      calls `api.peek(actorId)` to render the source label instead of the
 *      normal turn budget.
 *   3. Reactor clicks an enabled action button. ActionDataFetch calls
 *      `api.consume(actorId)` once; the returned info is stamped onto
 *      `meta.budgetReservation = { kind: "free_action", ... }` so the
 *      action-execution-core success terminal can drain the source AE charge.
 *   4. If the reactor does NOT click an action button, the `updateCombat`
 *      hook below clears every entry on the next turn change — a free
 *      action that wasn't used is gone, by spec.
 *
 * Why in-memory and not an actor flag:
 *   - The previous design (a `flags.fabula-ultima-companion.freeActionPending`
 *     flag on the actor) was persistent. Any path that didn't reach the ADF
 *     consumer left the flag stamped on the actor across turns, sessions,
 *     and world reloads — every subsequent normal turn for that actor would
 *     read the stale flag and render "Acceleration" instead of "Turn Action".
 *   - This module is the same client that sets it (reactor's local client
 *     runs both the picker dispatch and the action menu), so there is no
 *     cross-client sync requirement. State that doesn't need to outlive the
 *     client doesn't belong in a persistent flag.
 *
 * Hook contract:
 *   Hooks.callAll("oni:freeAction:updated", { actorId, info: info|null })
 *     — fired after every set/consume/clear so the budget label refreshes.
 *
 * Public API: globalThis.FUCompanion.api.freeActions
 *   set(actorId, info) → info
 *   peek(actorId)      → info|null
 *   consume(actorId)   → info|null
 *   clear(actorId)     → boolean
 *   clearAll()         → number   (count cleared)
 *   list()             → { actorId, info }[]
 */
(() => {
  const TAG = "[ONI][FreeActions]";

  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};

  if (globalThis.FUCompanion.api.freeActions) {
    console.debug(`${TAG} Already installed.`);
    return;
  }

  const log = (...a) => console.log(TAG, ...a);

  // actorId → { enabledLabels: string[], sourceEffectUuid: string|null, stampedAt: number }
  const STORE = new Map();

  function fireUpdated(actorId, info) {
    try { Hooks.callAll("oni:freeAction:updated", { actorId, info }); }
    catch (e) { console.warn(TAG, "oni:freeAction:updated hook listener threw.", e); }
  }

  function normalizeInfo(raw) {
    if (!raw || typeof raw !== "object") return null;
    // maxMpCost: per-action upper bound on a spell's MP cost (playtest
    // Acceleration: "spell with a total MP cost ≤ 10"). Null/undefined =
    // no cap. Stored as an integer to make picker filters trivial.
    let mpCap = null;
    if (raw.maxMpCost != null) {
      const n = Number(raw.maxMpCost);
      mpCap = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }
    return {
      enabledLabels: Array.isArray(raw.enabledLabels)
        ? raw.enabledLabels.map(s => String(s))
        : [],
      sourceEffectUuid: raw.sourceEffectUuid ?? null,
      maxMpCost: mpCap,
      stampedAt: Number(raw.stampedAt) || Date.now()
    };
  }

  function set(actorId, info) {
    if (!actorId) return null;
    const normalized = normalizeInfo({ ...info, stampedAt: Date.now() });
    STORE.set(String(actorId), normalized);
    fireUpdated(String(actorId), normalized);
    return normalized;
  }

  function peek(actorId) {
    if (!actorId) return null;
    return STORE.get(String(actorId)) ?? null;
  }

  function consume(actorId) {
    if (!actorId) return null;
    const key = String(actorId);
    const info = STORE.get(key) ?? null;
    if (info) {
      STORE.delete(key);
      fireUpdated(key, null);
    }
    return info;
  }

  function clear(actorId) {
    if (!actorId) return false;
    const key = String(actorId);
    if (!STORE.has(key)) return false;
    STORE.delete(key);
    fireUpdated(key, null);
    return true;
  }

  function clearAll() {
    if (!STORE.size) return 0;
    const ids = Array.from(STORE.keys());
    STORE.clear();
    for (const id of ids) fireUpdated(id, null);
    return ids.length;
  }

  function list() {
    return Array.from(STORE.entries()).map(([actorId, info]) => ({ actorId, info }));
  }

  // Turn-change cleanup. A free action that wasn't taken is gone by spec —
  // when the active combatant shifts (turn or round change), drop every
  // entry. Cheap: the store is rarely larger than 1 element.
  Hooks.on("updateCombat", (combat, changes) => {
    if (!combat) return;
    const turnShifted = changes && (("turn" in changes) || ("round" in changes));
    if (!turnShifted) return;
    const n = clearAll();
    if (n > 0) log(`updateCombat: cleared ${n} stale free-action entr${n === 1 ? "y" : "ies"} on turn shift.`);
  });

  Hooks.on("deleteCombat", () => {
    const n = clearAll();
    if (n > 0) log(`deleteCombat: cleared ${n} free-action entr${n === 1 ? "y" : "ies"}.`);
  });

  globalThis.FUCompanion.api.freeActions = { set, peek, consume, clear, clearAll, list };
  log("API registered at FUCompanion.api.freeActions");
})();
