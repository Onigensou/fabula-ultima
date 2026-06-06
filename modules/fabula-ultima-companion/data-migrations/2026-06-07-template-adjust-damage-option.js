/**
 * Migration: 2026-06-07-template-adjust-damage-option
 * ---------------------------------------------------------------------------
 * Template surgery for the adjust_damage unify refactor. In the `effect_kind`
 * select column of BOTH the _Skill Template and the _Item Template:
 *   + add   "adjust_damage"
 *   - remove "add_damage" and "modify_damage_taken" (engine no longer dispatches
 *     them; the 2026-06-07-unify-adjust-damage migration converts all data).
 *
 * Per [[csb-template-gating]] a select value absent from the column options is
 * stripped on save, so the new kind must be registered before sheet authors can
 * pick it; the dead options are removed so the dropdown reflects the engine.
 *
 * Idempotent.
 */

export const key = "2026-06-07-template-adjust-damage-option";
export const description =
  "effect_kind dropdown: add adjust_damage, remove add_damage + modify_damage_taken " +
  "in the _Skill + _Item templates.";

const TEMPLATE_IDS = ["j0F5Msw5RZ8aIB3j", "ZoiV53VaLzeRsEps"]; // _Skill, _Item
const ADD_OPTIONS = [
  { key: "adjust_damage", value: "Adjust damage (operation + stage)" },
];
const REMOVE_KEYS = new Set(["add_damage", "modify_damage_taken"]);

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

export async function migrate(game, log = () => {}) {
  let changedTemplates = 0;
  for (const id of TEMPLATE_IDS) {
    const tmpl = game.items.get(id);
    if (!tmpl) { log(`template "${id}" not found — skipping.`); continue; }
    const sysClone = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});
    let added = 0, removed = 0;
    for (const node of findOptionNodes(sysClone, "effect_kind")) {
      // remove dead options
      const before = node.options.length;
      node.options = node.options.filter((o) => !REMOVE_KEYS.has(o?.key));
      removed += before - node.options.length;
      // add new option(s)
      for (const opt of ADD_OPTIONS) {
        if (!node.options.some((o) => o?.key === opt.key)) { node.options.push(opt); added += 1; }
      }
    }
    if (!added && !removed) { log(`  ${tmpl.name}: effect_kind options already canon.`); continue; }
    try {
      await tmpl.update({ system: sysClone });
      changedTemplates += 1;
      log(`  ${tmpl.name}: effect_kind +${added} / -${removed}.`);
    } catch (e) {
      log(`  ${tmpl.name}: update failed — ${e?.message ?? e}`);
    }
  }
  return { applied: true, summary: `adjust_damage option synced on ${changedTemplates} template(s)` };
}
