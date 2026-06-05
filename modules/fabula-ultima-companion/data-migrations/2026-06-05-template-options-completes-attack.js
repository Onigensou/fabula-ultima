/**
 * Migration: 2026-06-05-template-options-completes-attack
 * ---------------------------------------------------------------------------
 * Template surgery: adds `creature_completes_attack` to the reaction_trigger
 * select column in the _Skill Template.
 *
 * Why: Centauros's Blazing Sweep uses this trigger for its "repeat if all
 * targets hit" passive. Per [[csb-template-gating]], select-column values
 * not listed in the template options are silently stripped on save — so the
 * trigger must be registered here before any skill can author it via CSB.
 *
 * Idempotent: re-runs no-op when the option is already present.
 */

export const key = "2026-06-05-template-options-completes-attack";
export const description =
  "Add `creature_completes_attack` to reaction_trigger options in the _Skill Template.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const NEW_TRIGGER_OPTION = {
  key: "creature_completes_attack",
  value: "Creature completes an attack (post-resolve, once per action)",
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
  for (const node of findOptionNodes(sysClone, "reaction_trigger")) {
    if (ensureOption(node.options, NEW_TRIGGER_OPTION)) {
      added += 1;
      log(`  reaction_trigger column: added "creature_completes_attack"`);
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
