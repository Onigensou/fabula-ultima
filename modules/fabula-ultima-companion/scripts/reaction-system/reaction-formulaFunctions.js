/**
 * [ONI] Reaction System — CSB Formula Functions
 * ---------------------------------------------------------------------------
 * Exposes the reaction-triggers registry to CSB visibility/value formulas.
 *
 * CSB's `visibilityFormula` field is evaluated by mathjs (not the async
 * ${%{...}%}$ phrase parser). To avoid hand-rolling `or(or(or(equalText(...)
 * ...)))` chains in every cell, we register two math functions that read the
 * trigger registry directly:
 *
 *   triggerNeeds(triggerKey, filterName)
 *     → 1 if the trigger declares `filterName` in its `filters: [...]` list,
 *       0 otherwise. Used to decide whether a per-trigger filter cell
 *       (damage_type, debuff_count, damage_amount, ...) should be visible.
 *
 *   triggerHasSubject(triggerKey)
 *     → 1 if the trigger has a per-creature subject (i.e. `subjectFrom !== null`),
 *       0 otherwise. Lifecycle triggers like `conflict_start` / `round_start`
 *       have no subject; the `Source` cell is meaningless for them.
 *
 * Conservative defaults:
 *   - Empty / unknown trigger key → return 1 (show the cell). Authors picking
 *     the trigger first should see all relevant fields available.
 *   - Registry not yet loaded → return 1 for the same reason. The registry
 *     installs at "ready"; sheet renders before that should not hide cells.
 *
 * Returns 1/0 (not true/false) because mathjs treats those uniformly inside
 * boolean contexts and `canBeRendered` does `!!formula.result`.
 */
Hooks.once("ready", () => {
  const TAG = "[ReactionFormulaFunctions]";

  if (typeof globalThis.math?.import !== "function") {
    console.warn(`${TAG} mathjs not available on globalThis; CSB visibility helpers not registered.`);
    return;
  }

  function getRegistry() {
    return window["oni.ReactionTriggers"] ?? null;
  }

  // A trigger key that is non-empty but absent from the registry is NOT the same
  // as "this trigger declares no filters". The dropdown offers more keys than the
  // registry lists (15 of 47, measured 2026-08-16), so treating unregistered as
  // "declares nothing" hid 178 authored cells — reaction_source alone on 155 rows
  // across 75 skills. Unknown means UNKNOWN: show the cell, exactly as the
  // "Conservative defaults" note above promises.
  function isRegistered(reg, key) {
    if (typeof reg?.isValidKey === "function") return !!reg.isValidKey(key);
    return typeof reg?.getTrigger === "function" ? reg.getTrigger(key) !== null : false;
  }

  function triggerNeeds(triggerKey, filterName) {
    const key = String(triggerKey ?? "").trim();
    const filter = String(filterName ?? "").trim();
    if (!key || !filter) return 1;

    const reg = getRegistry();
    if (!reg?.filtersFor) return 1;
    if (!isRegistered(reg, key)) return 1;

    const filters = reg.filtersFor(key);
    return Array.isArray(filters) && filters.includes(filter) ? 1 : 0;
  }

  function triggerHasSubject(triggerKey) {
    const key = String(triggerKey ?? "").trim();
    if (!key) return 1;

    const reg = getRegistry();
    if (!reg?.subjectShapeFor) return 1;
    if (!isRegistered(reg, key)) return 1;

    return reg.subjectShapeFor(key) !== null ? 1 : 0;
  }

  //   triggerInFamily(triggerKey, familyName)
  //     → 1 if the trigger belongs to a coarse visibility family
  //       (resource | status | action), 0 otherwise. Backs the BROAD filter
  //       cells, where a per-trigger capability list would be ~25 edits and one
  //       omission silently hides live config.
  function triggerInFamily(triggerKey, familyName) {
    const key = String(triggerKey ?? "").trim();
    const family = String(familyName ?? "").trim();
    if (!key || !family) return 1;

    const reg = getRegistry();
    if (typeof reg?.triggerInFamily !== "function") return 1;
    if (!isRegistered(reg, key)) return 1;

    return reg.triggerInFamily(key, family) ? 1 : 0;
  }

  try {
    globalThis.math.import(
      { triggerNeeds, triggerHasSubject, triggerInFamily },
      { override: true }
    );
    console.debug(`${TAG} Installed mathjs functions: triggerNeeds, triggerHasSubject, triggerInFamily.`);
  } catch (e) {
    console.error(`${TAG} Failed to register mathjs functions.`, e);
  }
});
