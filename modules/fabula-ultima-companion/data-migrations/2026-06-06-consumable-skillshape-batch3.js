/**
 * Migration: 2026-06-06-consumable-skillshape-batch3  (Item Action B.2)
 * ---------------------------------------------------------------------------
 * Author the shield / revive consumables (skill-shaped, set_resource).
 *
 *   Golem Soulstone — One Ally: gain 10 Shield. Uses set_resource (raise-to-
 *     value): shield_value = max(current, 10). RAW: a new Shield doesn't stack
 *     — you keep the BIGGER. Damage hits shield_value before HP (handled in
 *     applyDamageToTarget).
 *   Phoenix Feather — One Ally: revive to the Crisis score. set_resource hp =
 *     max(current, MAX_HP/2); a KO ally (0 HP) returns at Crisis. Setting HP > 0
 *     un-defeats them (defeated is HP-derived). Raise-only → safe if mis-targeted
 *     at a healthy ally (no-op).
 *
 * Requires the `set_resource` effect_kind + `shield` resource (skill-effects.js).
 * IDEMPOTENT. Foundry V12.
 */

export const key = "2026-06-06-consumable-skillshape-batch3";
export const description =
  "Author skill-shaped Golem Soulstone (shield) + Phoenix Feather (revive) via set_resource.";

const SPECS = [
  {
    name: "Golem Soulstone",
    props: {
      skill_target: "One Ally",
      type_damage: "",
      effect_table: {
        "0": { effect_label: "golemstone_shield", effect_kind: "set_resource",
               grant_resource: "shield", grant_amount: "10", target_ref: "action_targets" },
      },
    },
  },
  {
    name: "Phoenix Feather",
    props: {
      skill_target: "One Ally",
      type_damage: "",
      effect_table: {
        "0": { effect_label: "phoenix_revive", effect_kind: "set_resource",
               grant_resource: "hp", grant_amount: "MAX_HP / 2", target_ref: "action_targets" },
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
  return { applied: true, summary: `consumable batch3: ${world} world + ${embedded} embedded item(s) patched` };
}
