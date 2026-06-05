/**
 * Migration: 2026-06-06-consumable-skillshape-author  (Item Action B.2)
 * ---------------------------------------------------------------------------
 * Make consumables SKILL-SHAPED: give each its own targeting (`skill_target`)
 * + effect (`effect_table` + `on_activate_effect_ref`) directly on the item,
 * using the SAME schema keys as Skill/weapon. The Item action then reads
 * targeting from the chosen consumable, runs the target picker, and resolves
 * its effect through `resolveAction` (see
 * docs/battle-director-items-as-skillshaped-plan.md).
 *
 * No template surgery: consumables share weapons' `_Item Template`
 * (ZoiV53VaLzeRsEps), which weapons-as-skillshaped already extended with
 * `skill_target` + the effect_table/reaction panels. We only AUTHOR values +
 * reloadTemplate so the sheet renders them.
 *
 * Patches the world MASTER (⚗️ Consumable folder) AND every copy (CSB embedded
 * folder + actor-embedded), matched by name + item_type "consumable", since the
 * two world folders carry divergent uniqueIds. [[edit-master-not-copy]],
 * [[master-update-doesnt-sync-actor-copies]].
 *
 * Phase I-1 scope = recovery/grant items. AE-based + offensive items land in
 * follow-up specs once their AE templates / the defense_target_type column are
 * confirmed. IDEMPOTENT. Foundry V12.
 */

export const key = "2026-06-06-consumable-skillshape-author";
export const description =
  "Author skill_target + effect_table (grant) on recovery consumables so the " +
  "Item action targets + resolves them through resolveAction.";

// Each spec: name (match key) + the props to overlay. effect_table is replaced
// wholesale (delete-then-set). target_ref "action_targets" = the Item action's
// picked target(s).
// NOTE: `_Item Template` has no `on_activate_effect_ref` / `isCheck` columns
// (CSB strips writes to absent columns). The fire-point is SYNTHESIZED in
// `getRuntimeActionView` from the effect_table's ENTRY row (key "0"), so each
// spec only needs `skill_target` + `effect_table` with the entry at key "0".
const SPECS = [
  {
    name: "Apple Juice",
    props: {
      skill_target: "One Ally",
      // Recovery item: clear the vestigial type_damage so the shared COMPUTE
      // treats it as non-damaging (the grant below does the healing).
      type_damage: "",
      effect_table: {
        "0": { effect_label: "applejuice_heal", effect_kind: "grant",
               grant_resource: "hp", grant_amount: "30", target_ref: "action_targets" },
      },
    },
  },
  {
    name: "Grape Juice",
    props: {
      skill_target: "One Ally",
      type_damage: "",
      effect_table: {
        "0": { effect_label: "grapejuice_restore", effect_kind: "grant",
               grant_resource: "mp", grant_amount: "20", target_ref: "action_targets" },
      },
    },
  },
];

const TABLE_KEYS = ["effect_table", "reaction_config_table", "reaction_effect_table"];

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// Patch one item to a spec. Returns true if it changed anything.
async function patchConsumable(game, item, spec, ownerLabel, log) {
  if (item.system?.props?.item_type !== "consumable") return false;
  let touched = false;

  const baseProps = foundry.utils.deepClone(item.system?.props ?? {});
  const merged = foundry.utils.mergeObject(baseProps, spec.props, {
    inplace: false, insertKeys: true, insertValues: true, overwrite: true, recursive: true,
  });

  if (!deepEqual(item.system?.props ?? {}, merged)) {
    // Replace dynamic tables wholesale to avoid CSB merge artefacts.
    for (const tk of TABLE_KEYS) {
      if (spec.props[tk] && !deepEqual(item.system?.props?.[tk] ?? {}, spec.props[tk])) {
        await item.update({ [`system.props.-=${tk}`]: null });
      }
    }
    await item.update({ "system.props": merged });
    touched = true;
    log(`  ${ownerLabel} ${item.name}: props written (skill_target=${spec.props.skill_target})`);
  }

  // Step A — sync CSB template version stamp. [[csb-template-version-sync]]
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    touched = true;
    log(`  ${ownerLabel} ${item.name}: templateSystemUniqueVersion → ${wantVersion}`);
  }

  // Step B — rebuild the sheet's cached field schema so the new effect_table /
  // skill_target render without a manual "Refresh from Template".
  if (touched && item.templateSystem?.reloadTemplate) {
    try { await item.templateSystem.reloadTemplate(); log(`  ${ownerLabel} ${item.name}: reloadTemplate fired`); }
    catch (e) { log(`  ${ownerLabel} ${item.name}: reloadTemplate threw — ${e?.message ?? e}`); }
  }
  return touched;
}

export async function migrate(game, log = () => {}) {
  const byName = new Map(SPECS.map((s) => [s.name, s]));
  let world = 0, embedded = 0;

  // World items (masters in ⚗️ Consumable + CSB embedded-folder dups).
  for (const item of game.items.contents) {
    const spec = byName.get(item.name);
    if (!spec) continue;
    if (await patchConsumable(game, item, spec, "[world]", log)) world++;
  }

  // Actor-embedded copies.
  for (const actor of game.actors.contents) {
    for (const item of actor.items.contents) {
      const spec = byName.get(item.name);
      if (!spec) continue;
      if (await patchConsumable(game, item, spec, `[${actor.name}]`, log)) embedded++;
    }
  }

  return {
    applied: true,
    summary: `consumable-skillshape: ${world} world + ${embedded} embedded item(s) patched across ${SPECS.length} spec(s)`,
  };
}
