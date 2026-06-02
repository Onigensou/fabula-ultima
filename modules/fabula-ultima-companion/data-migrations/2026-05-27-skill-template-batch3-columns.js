/**
 * Migration: 2026-05-27-skill-template-batch3-columns
 * ---------------------------------------------------------------------------
 * Adds the `remove_tagged_ae` effect_kind to the _Skill Template's effect_kind
 * dropdown, plus two new column definitions inside the effect_table:
 *   - `filter_tag` (textField, default "debuff") — gated on remove_tagged_ae
 *   - `count`      (textField, default "1")      — gated on remove_tagged_ae
 *
 * This is the structural prerequisite for the Spiritist Batch 2 authoring
 * migration that creates Cleanse (which uses `remove_tagged_ae`). Per the
 * CSB-template-gating rule ([[csb-template-gating]]), writes to nested
 * column props in `effect_table` rows ARE accepted even when the column
 * is undeclared, BUT the CSB sheet won't show / let the GM edit them
 * without the column entry. Authoring the column up front keeps the
 * sheet experience consistent.
 *
 * IDEMPOTENT: scans the body tree for the effect_kind <select> + the
 * menu_title cell as anchor; skips the run if `remove_tagged_ae` is
 * already in the dropdown options.
 */

export const key = "2026-05-27-skill-template-batch3-columns";
export const description =
  "Add remove_tagged_ae to _Skill Template's effect_kind dropdown and " +
  "author filter_tag + count columns inside effect_table.";

const SKILL_TEMPLATE_UUID = "Item.j0F5Msw5RZ8aIB3j";
const NEW_KIND_KEY = "remove_tagged_ae";
const NEW_KIND_LABEL = "Remove Tagged AE";
const GATE_FORMULA = `equalText(sameRow("effect_kind",""), "${NEW_KIND_KEY}")`;

// New columns to insert immediately after the existing menu_title cell.
const FILTER_TAG_COL = Object.freeze({
  key: "filter_tag",
  colSpan: 1, rowSpan: 1,
  cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: 'AE system.tags entry the picker filters on (e.g. "debuff", "buff"). Required for remove_tagged_ae.',
  visibilityFormula: GATE_FORMULA,
  type: "textField", size: "full-size", label: "Filter Tag",
  defaultValue: "debuff",
  charList: "", maxLength: null, autocomplete: ""
});
const COUNT_COL = Object.freeze({
  key: "count",
  colSpan: 1, rowSpan: 1,
  cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: 'How many AEs to remove per target. "1" pops a picker; integer > 1 loops the picker N times; "all" removes every match without prompting.',
  visibilityFormula: GATE_FORMULA,
  type: "textField", size: "full-size", label: "Count",
  defaultValue: "1",
  charList: "", maxLength: null, autocomplete: ""
});

function findInBody(body, key) {
  let foundCol = null;
  let foundParent = null;
  let foundIdx = -1;
  const walk = (node, parentArr, idx) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], node, i);
      return;
    }
    if (node.key === key && parentArr) {
      foundCol = node;
      foundParent = parentArr;
      foundIdx = idx;
    }
    for (const v of Object.values(node)) walk(v, null, null);
  };
  walk(body, null, null);
  return { col: foundCol, parent: foundParent, index: foundIdx };
}

function findColAnywhere(body, key) {
  let result = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || result) return;
    if (Array.isArray(node)) { for (const c of node) walk(c); return; }
    if (node.key === key && Array.isArray(node.options)) { result = node; return; }
    for (const v of Object.values(node)) walk(v);
  };
  walk(body);
  return result;
}

export async function migrate(game, log) {
  const tpl = await fromUuid(SKILL_TEMPLATE_UUID);
  if (!tpl) {
    log(`skill template ${SKILL_TEMPLATE_UUID} not found — skipping`);
    return { applied: true, summary: "no template present" };
  }

  const body = foundry.utils.deepClone(tpl.system?.body ?? {});

  const effectKindCol = findColAnywhere(body, "effect_kind");
  const menuTitle = findInBody(body, "menu_title");

  if (!effectKindCol) {
    log(`could not find effect_kind dropdown — bailing without changes`);
    return { applied: true, summary: "effect_kind dropdown not found" };
  }
  if (!menuTitle.col || !menuTitle.parent) {
    log(`could not find menu_title cell (anchor) — bailing without changes`);
    return { applied: true, summary: "menu_title anchor not found" };
  }

  let changed = false;

  if (!effectKindCol.options.find((o) => o.key === NEW_KIND_KEY)) {
    effectKindCol.options.push({ key: NEW_KIND_KEY, value: NEW_KIND_LABEL });
    changed = true;
    log(`added "${NEW_KIND_KEY}" → "${NEW_KIND_LABEL}" to effect_kind dropdown`);
  } else {
    log(`effect_kind dropdown already includes "${NEW_KIND_KEY}"`);
  }

  const hasFilterTag = !!findColAnywhere(body, "filter_tag");
  const hasCount = !!findInBody(body, "count").col;
  if (hasFilterTag && hasCount) {
    log(`filter_tag + count columns already present`);
  } else {
    const colsToInsert = [];
    if (!hasFilterTag) colsToInsert.push({ ...FILTER_TAG_COL });
    if (!hasCount) colsToInsert.push({ ...COUNT_COL });
    menuTitle.parent.splice(menuTitle.index + 1, 0, ...colsToInsert);
    changed = true;
    log(`inserted ${colsToInsert.length} new column(s) after menu_title: ${colsToInsert.map((c) => c.key).join(", ")}`);
  }

  if (!changed) return { applied: true, summary: "already authored" };

  await tpl.update({ "system.body": body });
  return { applied: true, summary: "template patched" };
}
