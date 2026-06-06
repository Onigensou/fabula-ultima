/**
 * Migration: 2026-06-06-template-options-ae-duplicate-add-charges
 * ---------------------------------------------------------------------------
 * Adds two engine-supported `ae_duplicate_mode` options that were previously
 * authorable only via migration (not selectable in the CSB sheet):
 *
 *   - add_charges          — find existing AE by name; increment its charges by
 *                            ae_initial_charges (or the template's charges) up to
 *                            ae_initial_charges_max / chargesMax. The canonical
 *                            charge-status apply mode (Burn 3 → 6 → …).
 *   - replace_same_status  — Hinder dedup: distinct statuses coexist (Weak+Slow),
 *                            but re-applying the SAME status replaces the prior.
 *
 * Both already drive engine behaviour in skill-effects.js's apply_ae handler
 * (`baseMode === "add_charges"` / `"replace_same_status"`). Per
 * [[csb-template-gating]], a select value not listed in the template options is
 * silently stripped on save — so they must be registered here before a skill can
 * author them through the sheet. Mirrors the AE-sheet reaction editor, which
 * gained the same options in ActiveEffectManager-reaction-ui.js.
 *
 * Touches BOTH the `_Item Template` and `_Skill Template` (each carries an
 * `ae_duplicate_mode` select in its effect_table). Option additions are read
 * live from the template body at render — no per-item templateSystemUniqueVersion
 * sync needed (that gates field SCHEMA, not option lists; see
 * 2026-06-05-template-options-completes-attack for the same no-sync precedent).
 *
 * IDEMPOTENT: re-runs no-op when both options are already present.
 */

export const key = "2026-06-06-template-options-ae-duplicate-add-charges";
export const description =
  "Add `add_charges` + `replace_same_status` to the ae_duplicate_mode select in " +
  "the _Item Template and _Skill Template (exposes engine modes in the CSB sheet).";

const TEMPLATE_NAMES = ["_Item Template", "_Skill Template"];
const COLUMN_KEY = "ae_duplicate_mode";

const NEW_OPTIONS = [
  { key: "add_charges",         value: "Add charges (stack count)" },
  { key: "replace_same_status", value: "Replace same status" },
];

function findOptionNodes(node, columnKey, out = [], depth = 0) {
  if (depth > 16 || !node || typeof node !== "object") return out;
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
  const templates = (game.items?.contents ?? []).filter(
    (i) => i.type === "_equippableItemTemplate" && TEMPLATE_NAMES.includes(i.name)
  );
  if (!templates.length) {
    log(`no _Item/_Skill template found — nothing to do.`);
    return { applied: true, summary: "no template" };
  }

  let totalAdded = 0;
  for (const tmpl of templates) {
    const sysClone = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});
    let added = 0;
    for (const node of findOptionNodes(sysClone, COLUMN_KEY)) {
      for (const opt of NEW_OPTIONS) {
        if (ensureOption(node.options, opt)) {
          added += 1;
          log(`  ${tmpl.name} / ${COLUMN_KEY}: added "${opt.key}"`);
        }
      }
    }
    if (added === 0) {
      log(`  ${tmpl.name}: options already present — no change.`);
      continue;
    }
    try {
      await tmpl.update({ system: sysClone });
      totalAdded += added;
      log(`  ${tmpl.name}: ${added} option(s) added.`);
    } catch (e) {
      log(`  ${tmpl.name} update failed: ${e?.message ?? e}`);
      return { applied: false, summary: `template update failed: ${e?.message ?? e}` };
    }
  }

  return {
    applied: true,
    summary: totalAdded ? `added ${totalAdded} dropdown option(s)` : "already canon",
  };
}
