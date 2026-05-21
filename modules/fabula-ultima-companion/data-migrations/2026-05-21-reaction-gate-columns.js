/**
 * Migration: 2026-05-21-reaction-gate-columns
 * ---------------------------------------------------------------------------
 * Adds two new gate columns to the `_Skill Template`'s `reaction_config_table`
 * rowLayout:
 *
 *   - `condition_formula` — string formula. When non-blank, the trigger
 *     matcher evaluates it via window["oni.ReactionFormula"] and only fires
 *     the row when the result is truthy. Covers gates like
 *     `ROUND % 2 == 0`, `ACTION_TARGET_COUNT >= 2`, `BOND_COUNT >= 3`, etc.
 *     Replaces what would otherwise be dozens of single-purpose columns.
 *
 *   - `requires_skill` — string. When non-blank, the trigger matcher
 *     resolves the reactor's actor item collection and only fires the row
 *     if at least one owned item's `system.uniqueId` equals this value
 *     (a skill master id). Lets Hina's Prophetic Defender Style gate its
 *     even-round PP gain on "knows Divination".
 *
 * Both columns are always visible — they apply uniformly across all
 * trigger keys. Blank = no gating.
 *
 * IDEMPOTENT — gated on observable state.
 *
 * SCOPE: `_Skill Template` (id `j0F5Msw5RZ8aIB3j`).
 */

export const key = "2026-05-21-reaction-gate-columns";
export const description =
  "Skill template editor surgery: add condition_formula and requires_skill " +
  "columns to reaction_config_table (generic gate hooks).";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

function textFieldColumn(spec) {
  return {
    key: spec.key,
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: spec.tooltip ?? "",
    visibilityFormula: spec.visibilityFormula ?? "",
    type: "textField",
    size: "full-size",
    label: "",
    defaultValue: spec.defaultValue ?? "",
    charList: "",
    maxLength: null,
    autocomplete: "",
    align: "left",
    colName: spec.colName ?? spec.key,
    readonlyPredefined: false
  };
}

const COLUMNS_TO_ADD = [
  textFieldColumn({
    key: "condition_formula",
    tooltip:
      "Optional formula gate. When non-blank, the row only fires when this " +
      "formula evaluates to truthy. Grammar supports arithmetic, modulo, " +
      "comparison (==, !=, <, >, <=, >=), logical (&&, ||, !), and the " +
      "identifiers listed in window['oni.ReactionFormula'].describeIdentifiers(). " +
      "Examples: 'ROUND % 2 == 0' (only even rounds), " +
      "'ACTION_TARGET_COUNT >= 2' (only multi-target dangers), " +
      "'BOND_COUNT >= 3'. Blank = no gating.",
    defaultValue: "",
    colName: "Condition Formula"
  }),
  textFieldColumn({
    key: "requires_skill",
    tooltip:
      "Optional skill prerequisite. When non-blank, the row only fires when " +
      "the reactor's actor owns an item whose system.uniqueId equals this " +
      "value (i.e. the actor has learned the skill master with this ID). " +
      "Use the master skill's uniqueId, not the actor-copy id. " +
      "Example: Prophetic Defender Style's even-round PP gain sets this to " +
      "Divination's master uniqueId so the gain only fires when Hina " +
      "actually knows Divination. Blank = no gating.",
    defaultValue: "",
    colName: "Requires Skill"
  })
];

function findReactionConfigTable(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "reaction_config_table" && node.type === "compactDynamicTable") {
    return node;
  }
  const contents = Array.isArray(node.contents) ? node.contents : [];
  for (const child of contents) {
    const hit = findReactionConfigTable(child);
    if (hit) return hit;
  }
  return null;
}

function rowLayoutOf(table) {
  return Array.isArray(table?.rowLayout) ? table.rowLayout : null;
}

async function migrateTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const table = findReactionConfigTable({ contents: [sysClone.body] });
  if (!table) {
    log("reaction_config_table compactDynamicTable not found in template body — aborting");
    return { ok: false, summary: "reaction_config_table not found" };
  }
  const rows = rowLayoutOf(table);
  if (!rows) {
    log("reaction_config_table has no rowLayout array — aborting");
    return { ok: false, summary: "rowLayout missing" };
  }

  let needsWrite = false;

  for (const newCol of COLUMNS_TO_ADD) {
    if (rows.some(r => r?.key === newCol.key)) continue;
    rows.push(newCol);
    log(`added column "${newCol.key}"`);
    needsWrite = true;
  }

  if (!needsWrite) {
    return { ok: true, summary: "template already migrated" };
  }

  await template.update({ system: sysClone });
  return { ok: true, summary: `template updated (rowLayout columns: ${rows.length})` };
}

export async function migrate(game, log) {
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }
  const result = await migrateTemplate(template, log);
  if (!result.ok) {
    return { applied: false, summary: result.summary };
  }
  return { applied: true, summary: result.summary };
}
