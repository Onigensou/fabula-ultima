/**
 * Migration: 2026-11-21-template-options-stays-down
 * ---------------------------------------------------------------------------
 * Template surgery: adds `creature_stays_down` to the `reaction_trigger`
 * select column in BOTH the _Skill Template and the _Item Template.
 *
 * Why: the defeat reactor now fires `creature_stays_down` for a creature still
 * at 0 HP after the KO and every immediate revive (battle-director/
 * stays-down.js); first consumer is Nidhogg's Zero Trigger: Nox Servant. Per
 * [[csb-template-gating]], a select value not in the column's options is
 * silently stripped on save, so the trigger must be an option before any skill,
 * item or status can author a stays-down row. Copy of
 * 2026-11-03-template-options-knocked-out.
 *
 * Idempotent: re-runs no-op when the option is already present.
 */

export const key = "2026-11-21-template-options-stays-down";
export const description =
  "Add `creature_stays_down` (a fall not saved by an immediate revive) to reaction_trigger options in the _Skill + _Item templates.";

const TEMPLATE_IDS = ["j0F5Msw5RZ8aIB3j", "ZoiV53VaLzeRsEps"]; // _Skill, _Item

const NEW_TRIGGER_OPTIONS = [
  { key: "creature_stays_down", value: "When a creature is reduced to 0 HP and not revived" },
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
  let failed = 0;
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
    if (!added) { log(`  ${tmpl.name}: already has creature_stays_down.`); continue; }
    try {
      await tmpl.update({ system: sysClone });
      totalAdded += added;
      log(`  ${tmpl.name}: added ${added} stays-down trigger option(s) to reaction_trigger.`);
    } catch (e) {
      failed += 1;
      log(`  ${tmpl.name}: update failed — ${e?.message ?? e}`);
    }
  }

  // A failed template write must not mark the migration done: return not-applied so it retries.
  if (failed) return { applied: false, summary: `${failed} template update(s) failed; will retry` };
  return {
    applied: true,
    summary: totalAdded ? `added ${totalAdded} stays-down trigger option(s)` : "already canon",
  };
}
