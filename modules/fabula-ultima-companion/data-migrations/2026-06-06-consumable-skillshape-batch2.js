/**
 * Migration: 2026-06-06-consumable-skillshape-batch2  (Item Action B.2)
 * ---------------------------------------------------------------------------
 * Author the next batch of skill-shaped consumables (effect on the item, same
 * schema as Skill). See docs/battle-director-items-as-skillshaped-plan.md +
 * 2026-06-06-consumable-skillshape-author.js (batch 1).
 *
 *   Grape Wine     — One Ally: grant 60 MP, then apply Dazed (chain).
 *   Café au Lait   — Self:     apply Swift (the existing Buff-library AE).
 *   Love Potion    — One Enemy: apply Charmed.
 *
 * apply_ae resolves the named AE (Dazed / Swift / Charmed) from the world's
 * activeEffectContainer library. The fire-point is synthesized from the
 * effect_table entry row (key "0") by getRuntimeActionView. No template surgery
 * (consumables share weapons' _Item Template). Durations use the AE templates'
 * defaults (3-turn director-applied); exact per-item durations (Swift=scene,
 * Love=end-of-round) are a follow-up tuning pass. IDEMPOTENT. Foundry V12.
 */

export const key = "2026-06-06-consumable-skillshape-batch2";
export const description =
  "Author skill-shaped Grape Wine / Café au Lait / Love Potion (grant + apply_ae).";

const SPECS = [
  {
    name: "Grape Wine",
    props: {
      skill_target: "One Ally",
      type_damage: "",
      effect_table: {
        "0": { effect_label: "grapewine_use", effect_kind: "chain", chain_steps: "grapewine_mp,grapewine_daze" },
        "1": { effect_label: "grapewine_mp", effect_kind: "grant",
               grant_resource: "mp", grant_amount: "60", target_ref: "action_targets" },
        "2": { effect_label: "grapewine_daze", effect_kind: "apply_ae",
               ae_template_ref: "Dazed", target_ref: "action_targets" },
      },
    },
  },
  {
    name: "Café au Lait",
    props: {
      skill_target: "Self",
      type_damage: "",
      effect_table: {
        "0": { effect_label: "cafeaulait_swift", effect_kind: "apply_ae",
               ae_template_ref: "Swift", target_ref: "self" },
      },
    },
  },
  {
    name: "Love Potion",
    props: {
      skill_target: "One Enemy",
      type_damage: "",
      effect_table: {
        "0": { effect_label: "lovepotion_charm", effect_kind: "apply_ae",
               ae_template_ref: "Charmed", target_ref: "action_targets" },
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

async function patchConsumable(game, item, spec, ownerLabel, log) {
  if (item.system?.props?.item_type !== "consumable") return false;
  let touched = false;
  const baseProps = foundry.utils.deepClone(item.system?.props ?? {});
  const merged = foundry.utils.mergeObject(baseProps, spec.props, {
    inplace: false, insertKeys: true, insertValues: true, overwrite: true, recursive: true,
  });
  if (!deepEqual(item.system?.props ?? {}, merged)) {
    for (const tk of TABLE_KEYS) {
      if (spec.props[tk] && !deepEqual(item.system?.props?.[tk] ?? {}, spec.props[tk])) {
        await item.update({ [`system.props.-=${tk}`]: null });
      }
    }
    await item.update({ "system.props": merged });
    touched = true;
    log(`  ${ownerLabel} ${item.name}: props written (skill_target=${spec.props.skill_target})`);
  }
  // CSB template version stamp + reload (sheet renders the new tables). [[csb-template-version-sync]]
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    touched = true;
  }
  if (touched && item.templateSystem?.reloadTemplate) {
    try { await item.templateSystem.reloadTemplate(); }
    catch (e) { log(`  ${ownerLabel} ${item.name}: reloadTemplate threw — ${e?.message ?? e}`); }
  }
  return touched;
}

export async function migrate(game, log = () => {}) {
  const byName = new Map(SPECS.map((s) => [s.name, s]));
  let world = 0, embedded = 0;
  for (const item of game.items.contents) {
    const spec = byName.get(item.name);
    if (spec && await patchConsumable(game, item, spec, "[world]", log)) world++;
  }
  for (const actor of game.actors.contents) {
    for (const item of actor.items.contents) {
      const spec = byName.get(item.name);
      if (spec && await patchConsumable(game, item, spec, `[${actor.name}]`, log)) embedded++;
    }
  }
  return { applied: true, summary: `consumable batch2: ${world} world + ${embedded} embedded item(s) patched` };
}
