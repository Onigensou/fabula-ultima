/**
 * Migration: 2026-06-12-template-options-adjust-charges
 * ---------------------------------------------------------------------------
 * Template surgery: adds `adjust_charges` to the effect_kind select column in
 * the _Skill Template.
 *
 * Why: the new `adjust_charges` effect_kind (charge arithmetic on a target's
 * named charge-AE — Enkindle "double the target's Burn") is engine-dispatched,
 * but per [[csb-template-gating]] a select value absent from the column options
 * is stripped on a CSB sheet save. The boot-3 dropdown sync auto-adds it from
 * SUPPORTED_EFFECT_KINDS but isn't reliable across boots — this is the canonical,
 * co-dev-deliverable guarantee (mirrors 2026-06-12-template-options-free-action).
 * The charge_* columns self-heal via the boot-3b registry pass (no migration).
 *
 * Idempotent: re-runs no-op when the option is already present.
 */

export const key = "2026-06-12-template-options-adjust-charges";
export const description =
  "Add `adjust_charges` to effect_kind options in the _Skill Template.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const NEW_EFFECT_KIND_OPTION = {
  key: "adjust_charges",
  value: "Adjust Charges (multiply/add a target's stacks)",
};

function findOptionNodes(node, columnKey, out = [], depth = 0) {
  if (depth > 14 || !node || typeof node !== "object") return out;
  if (node.key === columnKey && Array.isArray(node.options)) out.push(node);
  if (Array.isArray(node)) {
    for (const v of node) findOptionNodes(v, columnKey, out, depth + 1);
  } else {
    for (const k of Object.keys(node)) findOptionNodes(node[k], columnKey, out, depth + 1);
  }
  return out;
}

function ensureOption(optionsArr, newOpt) {
  if (optionsArr.some((o) => o?.key === newOpt.key)) return false;
  optionsArr.push(newOpt);
  return true;
}

export async function migrate(game, log = () => {}) {
  const tmpl = game.items.get(TEMPLATE_ID);
  if (!tmpl) {
    log(`_Skill Template "${TEMPLATE_ID}" not found — nothing to do.`);
    return { applied: true, summary: "no template" };
  }
  const sysClone = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});
  let added = 0;
  for (const node of findOptionNodes(sysClone, "effect_kind")) {
    if (ensureOption(node.options, NEW_EFFECT_KIND_OPTION)) { added += 1; log(`  effect_kind column: added "adjust_charges"`); }
  }
  if (added === 0) { log(`Template already has the option — no changes.`); return { applied: true, summary: "already canon" }; }
  try {
    await tmpl.update({ system: sysClone });
    log(`_Skill Template: added ${added} option(s).`);
  } catch (e) {
    log(`_Skill Template update failed: ${e?.message ?? e}`);
    return { applied: false, summary: `template update failed: ${e?.message ?? e}` };
  }
  return { applied: true, summary: `added ${added} dropdown option(s)` };
}
