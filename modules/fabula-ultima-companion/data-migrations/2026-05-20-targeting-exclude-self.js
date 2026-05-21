/**
 * Migration: 2026-05-20-targeting-exclude-self
 * ---------------------------------------------------------------------------
 * Tiny refinement on the unified-targeting refactor:
 *
 *   1. Add the `exclude_self` checkbox column to the `_Skill Template`'s
 *      effect_table rowLayout (visible when effect_kind === "targeting").
 *   2. Set `exclude_self: true` on Protect's `protect_incoming` row
 *      (master + actor copies) so the "pick who to protect" picker no
 *      longer offers the reactor themselves — picking yourself would be
 *      a no-op redirect.
 *
 * Both phases are idempotent. Safe to re-run.
 */

export const key = "2026-05-20-targeting-exclude-self";
export const description =
  "Add `exclude_self` column to _Skill Template's effect_table; " +
  "set `exclude_self: true` on Protect's protect_incoming targeting row.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";   // _Skill Template
const PROTECT_MASTER_ID = "gTXdzJjV4Lmwfm7i";

const NEW_COLUMN = {
  key: "exclude_self",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip:
    "When checked, the reactor's own token is removed from the candidate " +
    "pool. Useful for Protect-style skills picking from action_targets — " +
    "picking yourself would be a no-op redirect.",
  visibilityFormula: "equalText(sameRow(\"effect_kind\",''), \"targeting\")",
  type: "checkbox",
  size: "full-size",
  label: "",
  defaultChecked: false,
  align: "left",
  colName: "Exclude Self",
  readonlyPredefined: false
};

function findEffectTable(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "effect_table" && node.type === "compactDynamicTable") return node;
  for (const child of node.contents ?? []) {
    const hit = findEffectTable(child);
    if (hit) return hit;
  }
  return null;
}

async function migrateTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const table = findEffectTable({ contents: [sysClone.body] });
  if (!table) return { ok: false, summary: "effect_table not found" };
  const rows = Array.isArray(table.rowLayout) ? table.rowLayout : null;
  if (!rows) return { ok: false, summary: "rowLayout missing" };
  if (rows.some(r => r?.key === "exclude_self")) {
    return { ok: true, summary: "exclude_self column already present" };
  }
  // Insert after `auto_confirm_when_obvious` if present, else at end.
  const insertAfter = rows.findIndex(r => r?.key === "auto_confirm_when_obvious");
  if (insertAfter >= 0) {
    rows.splice(insertAfter + 1, 0, NEW_COLUMN);
  } else {
    rows.push(NEW_COLUMN);
  }
  await template.update({ system: sysClone });
  log(`added exclude_self column (now ${rows.length} columns in effect_table rowLayout)`);
  return { ok: true, summary: "column added" };
}

function tableToArray(tbl) {
  if (!tbl) return [];
  if (Array.isArray(tbl)) return tbl.slice();
  return Object.keys(tbl).map(k => tbl[k]);
}
function arrayToObjectTable(arr) {
  const out = {};
  arr.forEach((row, i) => { out[String(i)] = row; });
  return out;
}

async function migrateProtectItem(item, log) {
  // Only the real Protect item (master + actor copies of it).
  const matches = item.id === PROTECT_MASTER_ID
               || item.system?.uniqueId === PROTECT_MASTER_ID;
  if (!matches) return false;

  const tbl = item.system?.props?.effect_table;
  if (!tbl) return false;
  const rows = tableToArray(tbl);

  const targetingRow = rows.find(r =>
    r && r.effect_label === "protect_incoming" && r.effect_kind === "targeting"
  );
  if (!targetingRow) {
    log(`Protect item "${item.name}" [${item.id}] has no protect_incoming row — skipping (data migration prerequisite missing)`);
    return false;
  }
  if (targetingRow.exclude_self === true) return false; // already set

  targetingRow.exclude_self = true;
  const newTable = arrayToObjectTable(rows);
  await item.update({ "system.props.effect_table": newTable });
  log(`set exclude_self=true on Protect "${item.name}" [${item.id}] / protect_incoming`);
  return true;
}

export async function migrate(game, log) {
  // Phase 1 — template column.
  const template = game.items?.get(TEMPLATE_ID);
  let templateSummary = "no template";
  if (template) {
    const r = await migrateTemplate(template, log);
    templateSummary = r.summary;
  }

  // Phase 2 — Protect data.
  let dataCount = 0;
  for (const item of game.items?.contents ?? []) {
    try { if (await migrateProtectItem(item, log)) dataCount++; }
    catch (e) { log(`master "${item.name}" [${item.id}] failed: ${e?.message ?? e}`); }
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      try { if (await migrateProtectItem(item, log)) dataCount++; }
      catch (e) { log(`actor "${actor.name}" item "${item.name}" failed: ${e?.message ?? e}`); }
    }
  }

  return {
    applied: true,
    summary: `template: ${templateSummary}; protect_incoming.exclude_self set on ${dataCount} item${dataCount === 1 ? "" : "s"}`
  };
}
