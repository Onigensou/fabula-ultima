/**
 * Migration: 2026-05-26-refinement-field-visibility-formula
 * ---------------------------------------------------------------------------
 * Updates refine_level and refine_count visibilityFormula to also show when
 * item_type is blank (the template editor context), so the fields are
 * interactable in the _Item Template sheet.
 *
 * Root cause: custom-system-builder hides a panel when all its children are
 * hidden. The original formula only matched weapon/armor/shield, which
 * evaluates false on the template item (item_type = ""), causing the whole
 * Refinement panel to vanish.
 *
 * Idempotent: no-ops if formula already includes the empty-string check.
 */

export const key = "2026-05-26-refinement-field-visibility-formula";
export const description =
  "Fix refine_level and refine_count visibilityFormula to show in template editor " +
  "(adds or(equalText(item_type,''), ...) so the fields are visible when item_type is blank).";

const ITEM_TEMPLATE_ID = "ZoiV53VaLzeRsEps";

const VF_CORRECT = "or(equalText(item_type, ''), switchCase(item_type, 'weapon', true, 'armor', true, 'shield', true, false))";

function findPanel(node, targetKey) {
  if (!node || typeof node !== "object") return null;
  if (node.key === targetKey) return node;
  for (const child of node.contents ?? []) {
    const hit = findPanel(child, targetKey);
    if (hit) return hit;
  }
  return null;
}

export async function migrate(game, log) {
  const template = game.items?.get(ITEM_TEMPLATE_ID);
  if (!template) {
    return { applied: false, summary: `item template ${ITEM_TEMPLATE_ID} not found` };
  }

  const sysClone        = foundry.utils.duplicate(template.system);
  const statusTab       = findPanel({ contents: [sysClone.body] }, "status");
  const refinementPanel = statusTab ? findPanel(statusTab, "refinement_panel") : null;

  if (!refinementPanel) {
    return { applied: false, summary: "refinement_panel not found — run refinement-item-template-fields first" };
  }

  const rl = findPanel(refinementPanel, "refine_level");
  const rc = findPanel(refinementPanel, "refine_count");

  if (!rl && !rc) {
    return { applied: false, summary: "refine_level and refine_count fields not found inside refinement_panel" };
  }

  if (rl?.visibilityFormula === VF_CORRECT && rc?.visibilityFormula === VF_CORRECT) {
    return { applied: true, summary: "field formulas already correct — skipped" };
  }

  if (rl) rl.visibilityFormula = VF_CORRECT;
  if (rc) rc.visibilityFormula = VF_CORRECT;

  await template.update({ system: sysClone });
  log("updated refine_level and refine_count visibilityFormula to include empty item_type check");
  return { applied: true, summary: "field visibility formulas updated" };
}
