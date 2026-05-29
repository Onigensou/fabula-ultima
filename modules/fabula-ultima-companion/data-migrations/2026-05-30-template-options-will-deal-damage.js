/**
 * Migration: 2026-05-30-template-options-will-deal-damage
 * ---------------------------------------------------------------------------
 * Template surgery: adds two CSB dropdown options:
 *
 *   • `creature_will_deal_damage` → reaction_trigger select (skill template
 *     row column + AE-flag editor row column)
 *   • `add_damage`                → effect_kind select
 *
 * Why: Cheap Shot needs a pre-resolve "I'm about to deal damage, may I add
 * more?" hook that modifies rawDamage BEFORE affinity is applied. The
 * existing creature_deals_damage trigger fires AFTER damage commits and
 * is wrong-side for value modification. New trigger + new effect_kind
 * give authors the canonical surface.
 *
 * Per [[csb-template-gating]]: writes to system.props.X are silently
 * stripped if X isn't a template column (or if it's a select column,
 * if the value isn't a listed option). So just adding the strings to
 * the engine isn't enough — the dropdown options must be authored too.
 *
 * Idempotent: re-runs no-op when the options are already present.
 */

export const key = "2026-05-30-template-options-will-deal-damage";
export const description =
  "Add `creature_will_deal_damage` to reaction_trigger options + `add_damage` " +
  "to effect_kind options in the _Skill Template.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const NEW_TRIGGER_OPTION = {
  key: "creature_will_deal_damage",
  value: "Creature is about to deal damage (pre-resolve)",
};

const NEW_EFFECT_KIND_OPTION = {
  key: "add_damage",
  value: "Add Damage (in-flight base-damage bonus)",
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
      log(`  reaction_trigger column: added "creature_will_deal_damage"`);
    }
  }
  for (const node of findOptionNodes(sysClone, "effect_kind")) {
    if (ensureOption(node.options, NEW_EFFECT_KIND_OPTION)) {
      added += 1;
      log(`  effect_kind column: added "add_damage"`);
    }
  }

  if (added === 0) {
    log(`Template already has both options — no changes.`);
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
