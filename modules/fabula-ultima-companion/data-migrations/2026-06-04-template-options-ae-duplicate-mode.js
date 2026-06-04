/**
 * Migration: 2026-06-04-template-options-ae-duplicate-mode
 * ---------------------------------------------------------------------------
 * Add an `ae_duplicate_mode` column to the _Skill Template's effect_table,
 * gated on `effect_kind === "apply_ae"`. The field already drives engine
 * behavior in skill-effects.js (line ~1897), but until now it was only
 * settable via author-time migrations or the JSON spec — never editable
 * through the CSB sheet.
 *
 * Column shape:
 *   key:            ae_duplicate_mode
 *   type:           select
 *   options:        replace / stack / skip / remove +
 *                   replace_per_caster / skip_per_caster / remove_per_caster
 *   visibility:     effect_kind == "apply_ae"
 *   defaultValue:   replace
 *
 * Mode semantics (mirrored from skill-effects.js handler):
 *   - replace            (default): delete existing duplicate, apply new
 *   - stack:             create another instance regardless of duplicates
 *                        (Prophecy Point, Cheap Shot stacks)
 *   - skip:              don't apply if a duplicate exists
 *   - remove:            delete existing duplicate, don't apply new
 *                        (cure / dispel pattern)
 *   - replace_per_caster: same as replace but match restricted to AEs
 *                         from THIS caster (Bodyguard, Mercy)
 *   - skip_per_caster:   skip if THIS caster already applied one
 *   - remove_per_caster: remove THIS caster's prior application
 *
 * IDEMPOTENT: scans body for an existing ae_duplicate_mode column; bails
 * if already present.
 */

export const key = "2026-06-04-template-options-ae-duplicate-mode";
export const description =
  "Add the ae_duplicate_mode column to the _Skill Template's effect_table " +
  "as a select column gated on effect_kind=apply_ae (replace / stack / skip / " +
  "remove + per-caster variants). Exposes the field that already drives " +
  "engine behavior in skill-effects.js.";

const SKILL_TEMPLATE_UUID = "Item.j0F5Msw5RZ8aIB3j";
const NEW_COL_KEY = "ae_duplicate_mode";
const GATE_FORMULA = `equalText(sameRow("effect_kind",""), "apply_ae")`;

const DUP_MODE_COL = Object.freeze({
  key: NEW_COL_KEY,
  colSpan: 1, rowSpan: 1,
  cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: "How to handle the case when the target already has a copy of this AE. 'replace' (default) removes the prior; 'stack' adds another; 'skip' aborts; 'remove' cures without applying. *_per_caster variants restrict the duplicate match to AEs THIS caster previously applied.",
  visibilityFormula: GATE_FORMULA,
  type: "select", size: "full-size", label: "Duplicate Mode",
  defaultValue: "replace",
  options: [
    { key: "replace",             value: "Replace" },
    { key: "stack",               value: "Stack" },
    { key: "skip",                value: "Skip if present" },
    { key: "remove",              value: "Remove (cure)" },
    { key: "replace_per_caster",  value: "Replace (per caster)" },
    { key: "skip_per_caster",     value: "Skip (per caster)" },
    { key: "remove_per_caster",   value: "Remove (per caster)" },
  ],
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

export async function migrate(game, log) {
  const tpl = await fromUuid(SKILL_TEMPLATE_UUID);
  if (!tpl) {
    log(`skill template ${SKILL_TEMPLATE_UUID} not found — skipping`);
    return { applied: true, summary: "no template present" };
  }

  const body = foundry.utils.deepClone(tpl.system?.body ?? {});

  if (findInBody(body, NEW_COL_KEY).col) {
    log(`ae_duplicate_mode column already present — skipping`);
    return { applied: true, summary: "already present" };
  }

  // Anchor: insert right after the ae_template_ref column. That's the
  // existing apply_ae-gated field, so the new column lives next to its
  // sibling visually.
  const anchor = findInBody(body, "ae_template_ref");
  if (!anchor.col || !anchor.parent) {
    log(`could not find ae_template_ref anchor — bailing without changes`);
    return { applied: true, summary: "anchor not found" };
  }

  anchor.parent.splice(anchor.index + 1, 0, foundry.utils.deepClone(DUP_MODE_COL));
  log(`inserted ae_duplicate_mode column after ae_template_ref`);

  await tpl.update({ "system.body": body });
  log(`_Skill Template body updated`);

  return { applied: true, summary: "ae_duplicate_mode column added" };
}
