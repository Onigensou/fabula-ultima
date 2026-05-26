/**
 * Migration: 2026-05-26-refinement-item-template-fields
 * ---------------------------------------------------------------------------
 * Adds `refinement_panel` (containing `refine_level` + `refine_count`) to the
 * `backyard_panel` inside the `status` tab of the equippable item template
 * (Item.ZoiV53VaLzeRsEps).
 *
 * Both fields:
 *   - role 0      — visible to all players
 *   - editRole 4  — GM-only edit
 *   - visible only on weapon / armor / shield (hidden on accessory etc.)
 *
 * Idempotent: no-ops if refinement_panel already present.
 */

export const key = "2026-05-26-refinement-item-template-fields";
export const description =
  "Add refine_level and refine_count numberFields to the item template " +
  "status tab (backyard_panel) for the equipment refinement system.";

const ITEM_TEMPLATE_ID = "ZoiV53VaLzeRsEps";

const VF_REFINABLE = "switchCase(item_type, 'weapon', true, 'armor', true, 'shield', true, false)";

const NUMBER_FIELD_BASE = {
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 4,
  permission: 0,
  tooltip: "",
  visibilityFormula: VF_REFINABLE,
  type: "numberField",
  size: "medium",
  label: "",
  defaultValue: "0",
  allowDecimal: false,
  minVal: "0",
  maxVal: "",
  allowRelative: false,
  showControls: false,
  controlsStyle: "hover",
  controlsCustomIncrements: "",
  inputStyle: "text",
};

const REFINEMENT_PANEL = {
  key: "refinement_panel",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 4,
  permission: 0,
  tooltip: "",
  visibilityFormula: "",  // container always visible; inner fields carry the type filter
  type: "panel",
  contents: [
    {
      ...NUMBER_FIELD_BASE,
      key:     "refine_level",
      label:   "Refine Level",
      tooltip: "Current refinement level (+0 to +10 for weapons, +0 to +2 for armor/shield)",
    },
    {
      ...NUMBER_FIELD_BASE,
      key:     "refine_count",
      label:   "Refine Count",
      tooltip: "Total lifetime refinement attempts (successes + failures combined)",
    },
  ],
  flow:             "grid-2",
  align:            "left",
  collapsible:      true,
  defaultCollapsed: false,
  title:            "Refinement",
  titleStyle:       "default",
};

function findPanel(node, targetKey) {
  if (!node || typeof node !== "object") return null;
  if (node.key === targetKey) return node;
  for (const child of node.contents ?? []) {
    const hit = findPanel(child, targetKey);
    if (hit) return hit;
  }
  return null;
}

async function migrateTemplate(template, log) {
  const sysClone    = foundry.utils.duplicate(template.system);
  const backyardPanel = findPanel({ contents: [sysClone.body] }, "backyard_panel");

  if (!backyardPanel) {
    return { ok: false, summary: "backyard_panel not found in item template" };
  }

  if (backyardPanel.contents?.some(c => c?.key === "refinement_panel")) {
    return { ok: true, summary: "refinement_panel already present — skipped" };
  }

  backyardPanel.contents = backyardPanel.contents ?? [];
  backyardPanel.contents.push(REFINEMENT_PANEL);

  await template.update({ system: sysClone });
  log("added refinement_panel (refine_level + refine_count) to backyard_panel in status tab");
  return { ok: true, summary: "refinement_panel added successfully" };
}

export async function migrate(game, log) {
  const template = game.items?.get(ITEM_TEMPLATE_ID);
  if (!template) {
    return { applied: false, summary: `item template ${ITEM_TEMPLATE_ID} not found` };
  }

  const r = await migrateTemplate(template, log);
  return { applied: true, summary: r.summary };
}
