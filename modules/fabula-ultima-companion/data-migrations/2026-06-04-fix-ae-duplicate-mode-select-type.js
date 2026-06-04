/**
 * Migration: 2026-06-04-fix-ae-duplicate-mode-select-type
 * ---------------------------------------------------------------------------
 * Repair migration for 2026-06-04-template-options-ae-duplicate-mode, which
 * inserted the `ae_duplicate_mode` column with the WRONG CSB component type
 * `"selectBox"`. CSB 4.8.5 has no such component — the correct type is
 * `"select"` (every other dropdown column uses it). The bad type made the
 * _Skill Template fail data preparation at boot:
 *
 *   Error: Failed data preparation for Item.j0F5Msw5RZ8aIB3j.
 *          Unrecognized component type selectBox
 *
 * Found via the Playwright control-plane harness (tools/fvtt-playwright) while
 * validating the origin merge — the template item (j0F5Msw5RZ8aIB3j) threw on
 * derivation, so its effect_table column never rendered.
 *
 * This migration:
 *   1. Finds the ae_duplicate_mode column in the _Skill Template body.
 *   2. If its type is "selectBox", rewrites it to "select".
 *   3. Bumps the template's CSB version stamp + reloadTemplate so the template
 *      item's own schema rebuilds and stops failing data prep.
 *
 * Scope note: this deliberately does NOT mass-sync the stamp to all ~750 linked
 * skill items. That loop is slow and unnecessary to clear the error — CSB
 * re-derives each skill's schema from the corrected template the next time its
 * sheet opens, surfacing the (now valid) Duplicate Mode column on demand.
 *
 * IDEMPOTENT: bails cleanly if the column is missing or already "select".
 */

export const key = "2026-06-04-fix-ae-duplicate-mode-select-type";
export const description =
  "Repair the ae_duplicate_mode column's CSB component type from the invalid " +
  "'selectBox' to 'select' on the _Skill Template, then stamp-sync + reload so " +
  "the column renders. Fixes a 'Unrecognized component type selectBox' " +
  "data-prep failure introduced by the ae-duplicate-mode template migration.";

const SKILL_TEMPLATE_UUID = "Item.j0F5Msw5RZ8aIB3j";
const COL_KEY = "ae_duplicate_mode";

/** Locate a component node by `key` anywhere in the CSB body tree. */
function findCol(body, key) {
  let found = null;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.key === key) found = node;
    for (const v of Object.values(node)) walk(v);
  };
  walk(body);
  return found;
}

export async function migrate(game, log) {
  const tpl = await fromUuid(SKILL_TEMPLATE_UUID);
  if (!tpl) {
    log(`_Skill Template ${SKILL_TEMPLATE_UUID} not found — skipping`);
    return { applied: true, summary: "no template present" };
  }

  const body = foundry.utils.deepClone(tpl.system?.body ?? {});
  const col = findCol(body, COL_KEY);
  if (!col) {
    log(`no ${COL_KEY} column present — nothing to repair`);
    return { applied: true, summary: "column absent" };
  }
  if (col.type !== "selectBox") {
    log(`${COL_KEY} column type is already "${col.type}" — nothing to repair`);
    return { applied: true, summary: "already correct" };
  }

  col.type = "select";
  await tpl.update({ "system.body": body });
  log(`fixed ${COL_KEY} component type: selectBox → select`);

  // Bump the template's CSB version stamp so dependent items know the schema
  // changed, then force the template item's own schema rebuild (this item was
  // the one failing data prep).
  const prev = Number(tpl.system?.templateSystemUniqueVersion ?? 0) || 0;
  const nextVersion = prev + 1;
  await tpl.update({ "system.templateSystemUniqueVersion": nextVersion });
  if (tpl.templateSystem?.reloadTemplate) {
    try { await tpl.templateSystem.reloadTemplate(); log(`template reloadTemplate() fired`); }
    catch (e) { log(`template reloadTemplate threw — ${e?.message ?? e}`); }
  }

  return { applied: true, summary: `ae_duplicate_mode type fixed (selectBox → select)` };
}
