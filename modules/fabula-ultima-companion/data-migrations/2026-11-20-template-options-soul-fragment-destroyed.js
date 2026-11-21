/**
 * Migration: 2026-11-20-template-options-soul-fragment-destroyed
 * ---------------------------------------------------------------------------
 * Template surgery: adds `soul_fragment_destroyed` to the `reaction_trigger`
 * select column in BOTH the _Skill Template and the _Item Template.
 *
 * Why: the Soul Tithe conflict event now fires `soul_fragment_destroyed` to
 * every combatant whenever a Soul Fragment is destroyed (party kill, eaten by
 * consumeFragment, Beheading) — the Nox Priest's Soul Siphon listens for it.
 * Per [[csb-template-gating]], a select value not in the column's options is
 * silently stripped on save, so the trigger must be an option before any
 * skill, item or status can keep such a row through a sheet save.
 *
 * Idempotent: re-runs no-op when the option is already present.
 */

export const key = "2026-11-20-template-options-soul-fragment-destroyed";
export const description =
  "Add `soul_fragment_destroyed` (Soul Tithe) to reaction_trigger options in the _Skill + _Item templates.";

const TEMPLATE_IDS = ["j0F5Msw5RZ8aIB3j", "ZoiV53VaLzeRsEps"]; // _Skill, _Item

const NEW_TRIGGER_OPTIONS = [
  { key: "soul_fragment_destroyed", value: "When a Soul Fragment is destroyed (Soul Tithe)" },
];

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
  let totalAdded = 0;
  for (const id of TEMPLATE_IDS) {
    const tmpl = game.items.get(id);
    if (!tmpl) { log(`template "${id}" not found — skipping.`); continue; }

    const sysClone = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});
    let added = 0;
    for (const node of findOptionNodes(sysClone, "reaction_trigger")) {
      for (const opt of NEW_TRIGGER_OPTIONS) {
        if (ensureOption(node.options, opt)) added += 1;
      }
    }
    if (!added) { log(`  ${tmpl.name}: already has soul_fragment_destroyed.`); continue; }
    try {
      await tmpl.update({ system: sysClone });
      totalAdded += added;
      log(`  ${tmpl.name}: added ${added} Soul Fragment trigger option(s) to reaction_trigger.`);
    } catch (e) {
      log(`  ${tmpl.name}: update failed — ${e?.message ?? e}`);
    }
  }

  return {
    applied: true,
    summary: totalAdded ? `added ${totalAdded} Soul Fragment trigger option(s)` : "already canon",
  };
}
