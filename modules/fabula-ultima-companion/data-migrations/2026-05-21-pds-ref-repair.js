/**
 * Migration: 2026-05-21-pds-ref-repair
 * ---------------------------------------------------------------------------
 * Repair two regressions on PROPHETIC DEFENDER STYLE items:
 *
 *   1. effect_table rows for pds_gain / pds_clear have a stale `ae_template_ref`
 *      pointing at a UUID (`Item.TSCAUfjpOlNl6WwV.ActiveEffect.propheticPoint01`).
 *      That UUID points at the Black & White item id (PDS's pre-rekey uniqueId
 *      collision) which doesn't host the Prophecy Point AE. The AEM registry
 *      lookup falls back to `findByName` only if the input is name-shaped — a
 *      UUID-shaped string fails both `getById` and `findByName`, yielding
 *      `no_valid_effects` and silently dropping the apply. Cleared by rewriting
 *      to the plain AE name "Prophecy Point" so the AEM name-registry resolves
 *      it on every actor.
 *
 *      Why this slipped past v6: v6's `authorPdsItem` only re-writes
 *      effect_table when the `pds_self` row is absent. Items already authored
 *      by v5 (which produced the UUID ref) kept the broken refs forever.
 *
 *   2. reaction_config_table row for pds_clear has `reaction_trigger: ""`
 *      again, despite the earlier `trigger-add-conflict-end` migration
 *      repairing it. Something clobbered Hina's row between then and now
 *      (most likely a UI edit + save while the row was open). Re-pin to
 *      `conflict_end`. Same narrow predicate as before: empty trigger AND
 *      effect_ref ending in `_clear`.
 *
 * IDEMPOTENT — gated on observable state, safe to re-run.
 * SCOPE — every item literally named "PROPHETIC DEFENDER STYLE" (master + actor
 *         copies). Black & White is never inspected; PDS forked from it and
 *         still shares its old uniqueId, so uniqueId-keyed scans corrupt B&W.
 */

export const key = "2026-05-21-pds-ref-repair";
export const description =
  "Repair PDS effect_table ae_template_ref UUIDs back to 'Prophecy Point' " +
  "name refs, and re-pin pds_clear's reaction_trigger to 'conflict_end'.";

const PDS_NAME = "PROPHETIC DEFENDER STYLE";
const PP_AE_NAME = "Prophecy Point";

// Anything matching this pattern is a broken UUID-shaped ref pointing at the
// old PDS master id. The string used by v5 was fully literal; matching on
// "propheticPoint01" alone catches any UUID variant pointing at the same AE.
const BROKEN_REF_NEEDLE = "propheticPoint01";

function isPdsNamed(item) {
  return String(item?.name ?? "").trim().toUpperCase() === PDS_NAME;
}

function* iterateAllPdsItems(game) {
  for (const item of game.items?.contents ?? []) {
    if (isPdsNamed(item)) yield item;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (isPdsNamed(item)) yield item;
    }
  }
}

function repairEffectTable(table) {
  if (!table || typeof table !== "object") return { next: table, changed: false };

  const entries = Array.isArray(table)
    ? table.map((row, i) => [String(i), row])
    : Object.entries(table);

  let changed = false;
  const next = {};
  for (const [k, row] of entries) {
    if (!row || typeof row !== "object") { next[k] = row; continue; }

    // Only `apply_ae` rows carry ae_template_ref.
    if (row.effect_kind === "apply_ae") {
      const ref = String(row.ae_template_ref ?? "");
      if (ref.includes(BROKEN_REF_NEEDLE) && ref !== PP_AE_NAME) {
        next[k] = { ...row, ae_template_ref: PP_AE_NAME };
        changed = true;
        continue;
      }
    }
    next[k] = row;
  }
  return { next, changed };
}

function repairReactionConfig(table) {
  if (!table || typeof table !== "object") return { next: table, changed: false };

  const entries = Array.isArray(table)
    ? table.map((row, i) => [String(i), row])
    : Object.entries(table);

  let changed = false;
  const next = {};
  for (const [k, row] of entries) {
    if (!row || typeof row !== "object") { next[k] = row; continue; }

    const trig = String(row.reaction_trigger ?? "").trim();
    const eff  = String(row.reaction_effect_ref ?? "").trim();
    if (trig === "" && /(^|_)clear$/.test(eff)) {
      next[k] = { ...row, reaction_trigger: "conflict_end" };
      changed = true;
      continue;
    }
    next[k] = row;
  }
  return { next, changed };
}

async function repairItem(item, log) {
  let touched = false;

  const effRes = repairEffectTable(item.system?.props?.effect_table ?? {});
  const cfgRes = repairReactionConfig(item.system?.props?.reaction_config_table ?? {});

  if (effRes.changed || cfgRes.changed) {
    const patch = {};
    if (effRes.changed) patch["system.props.effect_table"] = effRes.next;
    if (cfgRes.changed) patch["system.props.reaction_config_table"] = cfgRes.next;
    await item.update(patch);
    log(`repaired ${item.id} (parent="${item.parent?.name ?? "world"}") — ${effRes.changed ? "effect_table " : ""}${cfgRes.changed ? "reaction_config_table" : ""}`);
    touched = true;
  }

  return touched;
}

export async function migrate(game, log) {
  let touched = 0;
  for (const item of iterateAllPdsItems(game)) {
    try { if (await repairItem(item, log)) touched++; }
    catch (e) { log(`item ${item.id} (parent="${item.parent?.name ?? "world"}") repair threw: ${e?.message ?? e}`); }
  }
  return {
    applied: true,
    summary: `${touched} PDS-named item${touched === 1 ? "" : "s"} repaired`
  };
}
