/**
 * Migration: 2026-06-12-template-options-free-action
 * ---------------------------------------------------------------------------
 * Template surgery: adds `free_action` to the effect_kind select column in the
 * _Skill Template.
 *
 * Why: the new `free_action` effect_kind (perform ONE free turn-action — Blazing
 * Sweep's compounding repeat, future Counterattack, etc.) is dispatched by the
 * engine, but per [[csb-template-gating]] a select value absent from the column
 * options is silently stripped (→ falls back to "grant") the moment a human opens
 * + saves the sheet in CSB. The boot-3 dropdown sync is a safety net that auto-
 * adds it from SUPPORTED_EFFECT_KINDS, but it isn't 100% reliable across boots —
 * this migration is the canonical, co-dev-deliverable guarantee (mirrors
 * 2026-06-05-template-options-open-action-menu / 2026-06-07-template-adjust-damage-option).
 *
 * Idempotent: re-runs no-op when the option is already present.
 */

export const key = "2026-06-12-template-options-free-action";
export const description =
  "Add `free_action` to effect_kind options in the _Skill Template.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const NEW_EFFECT_KIND_OPTION = {
  key: "free_action",
  value: "Free Action (perform single action)",
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
    if (ensureOption(node.options, NEW_EFFECT_KIND_OPTION)) {
      added += 1;
      log(`  effect_kind column: added "free_action"`);
    }
  }

  if (added === 0) {
    log(`Template already has the option — no changes.`);
    return { applied: true, summary: "already canon" };
  }

  try {
    await tmpl.update({ system: sysClone });
    log(`_Skill Template: added ${added} option(s).`);
  } catch (e) {
    log(`_Skill Template update failed: ${e?.message ?? e}`);
    return { applied: false, summary: `template update failed: ${e?.message ?? e}` };
  }

  return { applied: true, summary: `added ${added} dropdown option(s)` };
}
