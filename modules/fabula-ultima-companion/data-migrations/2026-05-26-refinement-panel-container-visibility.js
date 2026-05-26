/**
 * Migration: 2026-05-26-refinement-panel-container-visibility
 * ---------------------------------------------------------------------------
 * Clears the visibilityFormula on the `refinement_panel` container so it is
 * always visible in the template editor (which evaluates formulas against an
 * empty item_type, hiding it).
 *
 * The inner `refine_level` and `refine_count` fields retain their own
 * visibilityFormula and will hide themselves on non-refinable item types
 * (accessory, consumable, etc.).
 *
 * Idempotent: no-ops if already cleared.
 */

export const key = "2026-05-26-refinement-panel-container-visibility";
export const description =
  "Clear visibilityFormula on refinement_panel container so it shows in the " +
  "item template editor (inner fields still hide on non-refinable types).";

const ITEM_TEMPLATE_ID = "ZoiV53VaLzeRsEps";

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

  const sysClone       = foundry.utils.duplicate(template.system);
  const refinementPanel = findPanel({ contents: [sysClone.body] }, "refinement_panel");

  if (!refinementPanel) {
    return { applied: false, summary: "refinement_panel not found — run refinement-item-template-fields first" };
  }

  if (refinementPanel.visibilityFormula === "") {
    return { applied: true, summary: "refinement_panel visibilityFormula already cleared — skipped" };
  }

  refinementPanel.visibilityFormula = "";
  await template.update({ system: sysClone });
  log("cleared visibilityFormula on refinement_panel container");
  return { applied: true, summary: "refinement_panel container visibilityFormula cleared" };
}
