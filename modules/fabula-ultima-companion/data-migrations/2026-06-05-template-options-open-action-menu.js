/**
 * Migration: 2026-06-05-template-options-open-action-menu
 * ---------------------------------------------------------------------------
 * Template surgery: adds `open_action_menu` to the effect_kind select column
 * in the _Skill Template.
 *
 * Why: Centauros's Blazing Sweep uses open_action_menu (free_mode: true) to
 * enqueue the repeat sweep through the full BD pipeline. Per
 * [[csb-template-gating]], select-column values not listed in the template
 * options are silently stripped (and replaced with the rendered fallback) when
 * the sheet is saved — so authoring this effect kind requires the option here.
 *
 * Idempotent: re-runs no-op when the option is already present.
 */

export const key = "2026-06-05-template-options-open-action-menu";
export const description =
  "Add `open_action_menu` to effect_kind options in the _Skill Template.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const NEW_EFFECT_KIND_OPTION = {
  key: "open_action_menu",
  value: "Open Action Menu (free action grant)",
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

export async function migrate(game, log) {
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
      log(`  effect_kind column: added "open_action_menu"`);
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

  return {
    applied: true,
    summary: `added ${added} dropdown option(s)`,
  };
}
