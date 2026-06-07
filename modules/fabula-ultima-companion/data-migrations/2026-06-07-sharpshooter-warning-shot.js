/**
 * Migration: 2026-06-07-sharpshooter-warning-shot
 * ---------------------------------------------------------------------------
 * Author the Battle Director master for Warning Shot (Sharpshooter, max SL 4)
 * and equip it on the BD test dummy ("BD Test — Sharpshooter").
 *
 * RAW: "When you hit one or more targets with a ranged attack that would deal
 * damage, you may have the attack deal no damage. If you do, choose one option:
 * inflict shaken on each target hit; or inflict slow on each target hit; or
 * each target hit loses SL × 10 Mind Points."
 *
 * ENGINE MAPPING (no new primitives — mirrors Cheap Shot's pre-resolve hook):
 *   reaction_config_table[0]
 *     reaction_trigger      = creature_will_deal_damage  (single-fire-per-action,
 *                             pre-resolve; the only window where the attacker can
 *                             still zero outgoing damage and RESOLVE recomputes)
 *     reaction_source       = self        (my own attack)
 *     reaction_action_target= enemy       (only when I'm hitting enemies)
 *     reaction_isPassive    = true
 *     reaction_passive_mode = ask         (shows as a clickable pill on the
 *                             action card — player chooses to use it)
 *     reaction_effect_ref   = warning_shot
 *     condition_formula     = HAS_RANGED_WEAPON   (ranged-attack gate)
 *
 *   effect_table
 *     warning_shot  chain → [ws_nullify, ws_menu]
 *     ws_nullify    adjust_damage outgoing ×0 to hit_action_targets ("no damage")
 *     ws_menu       open_action_menu → [ws_shaken, ws_slow, ws_mp]
 *     ws_shaken     apply_ae Shaken to hit_action_targets
 *     ws_slow       apply_ae Slow   to hit_action_targets
 *     ws_mp         consume_resource mp = SL × 10 from hit_action_targets
 *
 * NOTE on the ranged gate: `HAS_RANGED_WEAPON` checks the reactor has a ranged
 * weapon equipped (the only ranged-related reaction identifier today). A
 * Sharpshooter dual-wielding melee+ranged could in theory surface the pill on a
 * melee swing — acceptable for now; a per-attack range payload gate is a future
 * engine refinement.
 *
 * NOTE on the MP option: consume_resource with on_empty:"skip" debits SL×10 MP;
 * a target with less than that keeps its MP (rather than draining to 0). Edge
 * case only — a flooring MP-drain primitive is a future refinement.
 *
 * IDEMPOTENT: create-if-missing + drift-correct on the master; create-if-absent
 * copy on the dummy.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-07-sharpshooter-warning-shot";
export const description =
  "Author the Battle Director Warning Shot master + equip it on the " +
  "BD Test — Sharpshooter dummy.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Sharpshooter";
const SKILL_SUBFOLDER = "Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const DUMMY_NAME = "BD Test — Sharpshooter";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

const REACTION_CONFIG_TABLE = {
  // RAW fires on "one or more targets [you] hit with a ranged attack" — no
  // enemy restriction (you choose), so no reaction_action_target filter.
  "0": {
    reaction_trigger: "creature_will_deal_damage",
    reaction_source: "self",
    reaction_isPassive: true,
    reaction_passive_mode: "ask",
    reaction_effect_ref: "warning_shot",
    // ATTACK_IS_RANGED (the attack weapon's range) — not HAS_RANGED_WEAPON,
    // which checks for an *equipped* ranged weapon (isEquipped) and mis-gates
    // when the attack weapon's isEquipped flag is out of sync with the
    // main_hand slot. See the Barrage migration for the full rationale.
    condition_formula: "ATTACK_IS_RANGED == 1",
  },
};

const EFFECT_TABLE = {
  "0": { effect_label: "warning_shot", effect_kind: "chain", chain_steps: "ws_nullify,ws_menu" },
  "1": {
    effect_label: "ws_nullify", effect_kind: "adjust_damage",
    damage_operation: "multiply", damage_amount: "0", damage_stage: "outgoing",
    target_ref: "hit_action_targets",
  },
  "2": {
    effect_label: "ws_menu", effect_kind: "open_action_menu",
    menu_title: "Warning Shot", menu_subtitle: "The attack deals no damage — choose one effect.",
    menu_option_refs: "ws_shaken,ws_slow,ws_mp",
  },
  "3": {
    effect_label: "ws_shaken", effect_kind: "apply_ae", ae_template_ref: "Shaken",
    target_ref: "hit_action_targets",
    menu_label: "Inflict Shaken", menu_description: "Each target hit by the attack becomes Shaken.",
  },
  "4": {
    effect_label: "ws_slow", effect_kind: "apply_ae", ae_template_ref: "Slow",
    target_ref: "hit_action_targets",
    menu_label: "Inflict Slow", menu_description: "Each target hit by the attack becomes Slow.",
  },
  "5": {
    effect_label: "ws_mp", effect_kind: "consume_resource",
    consume_resource: "mp", consume_amount: "SL * 10", target_ref: "hit_action_targets", on_empty: "skip",
    menu_label: "Drain Mind Points", menu_description: "Each target hit loses SL × 10 Mind Points.",
  },
};

const BASE_PROPS = {
  rolled_atr1: "-", rolled_atr2: "-", isCheck: false, isReaction: true,
  isFacet: false, isHeroic: false, isZeroPower: false, isOffensiveSpell: false,
  ignore_hr: false, class: CLASS_NAME, cost: "", skill_target: "-", skill_range: "",
  type_damage: "", damage_bonus: "0", check_bonus: "0", defense_target_type: "def",
  duration: "-", on_activate_effect_ref: "", post_damage_effect_ref: "",
  reaction_config_table: REACTION_CONFIG_TABLE,
  effect_table: EFFECT_TABLE,
  active_effect_config_table: {},
};

const SPEC = {
  name: "Warning Shot",
  img: "icons/skills/ranged/arrow-strike-glowing-orange.webp",
  props: {
    skill_type: "Passive", level: "1", max_level: "4",
    description:
      "<p>When you hit one or more targets with a <strong>ranged attack</strong> " +
      "that would deal damage, you may have the attack deal no damage. If you do, " +
      "choose one option: inflict <strong>shaken</strong> on each target hit by the " +
      "attack; or inflict <strong>slow</strong> on each target hit by the attack; or " +
      "each target hit by the attack loses <strong>【SL】× 10</strong> Mind Points. " +
      "Describe your maneuver!</p>",
  },
};

function allInFolder(game, folder, name) {
  return (game.items?.contents ?? []).filter((i) => i.name === name && i.folder?.id === folder.id);
}
function findInFolder(game, folder, name) {
  return allInFolder(game, folder, name)[0] ?? null;
}

async function ensureMaster(game, folder, log) {
  const wantProps = { ...BASE_PROPS, ...SPEC.props, name: SPEC.name, img: SPEC.img };
  const dups = allInFolder(game, folder, SPEC.name);
  if (dups.length > 1) {
    const extra = dups.slice(1);
    await Item.deleteDocuments(extra.map((i) => i.id));
    log(`  removed ${extra.length} duplicate BD master(s)`);
  }
  let item = dups[0] ?? null;
  if (!item) {
    const tpl = game.items.get(SKILL_TEMPLATE_ID);
    const versionStamp = tpl?.system?.templateSystemUniqueVersion;
    await Item.create({
      name: SPEC.name, img: SPEC.img, type: "equippableItem", folder: folder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
        props: wantProps,
      },
    });
    item = findInFolder(game, folder, SPEC.name);
    log(`  created BD master "${SPEC.name}" (id=${item?.id ?? "??"})`);
    return item;
  }
  const updates = {};
  for (const [k, v] of Object.entries(wantProps)) {
    if (!deepEqual(item.system?.props?.[k], v)) updates[`system.props.${k}`] = v;
  }
  if (Object.keys(updates).length) { await item.update(updates); log(`  updated BD master props (${Object.keys(updates).length})`); }
  return item;
}

async function ensureOnDummy(game, master, log) {
  if (!master) { log(`  no master to equip — skipped dummy`); return false; }
  const dummy = game.actors?.getName?.(DUMMY_NAME);
  if (!dummy) { log(`  dummy "${DUMMY_NAME}" not found — skipped equip`); return false; }
  const existing = dummy.items.find((i) => i.name === SPEC.name);
  if (existing) {
    // Drift-correct the copy's mechanical tables so harness tests see canon.
    const updates = {};
    for (const k of ["reaction_config_table", "effect_table", "isReaction"]) {
      if (!deepEqual(existing.system?.props?.[k], BASE_PROPS[k])) updates[`system.props.${k}`] = BASE_PROPS[k];
    }
    if (Object.keys(updates).length) { await existing.update(updates); log(`  synced dummy copy tables`); }
    else log(`  dummy already has "${SPEC.name}"`);
    return false;
  }
  const data = master.toObject(false);
  delete data._id;
  data.system = data.system ?? {};
  data.system.uniqueId = master.system?.uniqueId ?? master.id;
  await dummy.createEmbeddedDocuments("Item", [data]);
  log(`  equipped "${SPEC.name}" on dummy "${DUMMY_NAME}"`);
  return true;
}

// Foundry deep-MERGES object updates, so writing a table that DROPPED a key
// (e.g. removing reaction_action_target) silently retains the stale key. Force
// a clean replace by nulling the column first, then setting the fresh object.
async function forceSetTables(item, log, label) {
  if (!item) return;
  const cur0 = item.system?.props?.reaction_config_table?.["0"] ?? {};
  const needsClean = "reaction_action_target" in cur0
    || !deepEqual(item.system?.props?.reaction_config_table, REACTION_CONFIG_TABLE)
    || !deepEqual(item.system?.props?.effect_table, EFFECT_TABLE);
  if (!needsClean) return;
  await item.update({ "system.props.reaction_config_table": null, "system.props.effect_table": null });
  await item.update({ "system.props.reaction_config_table": REACTION_CONFIG_TABLE, "system.props.effect_table": EFFECT_TABLE });
  log(`  force-replaced tables on ${label}`);
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, CLASS_NAME, SKILL_SUBFOLDER], { log });
  if (!folder) return { applied: false, summary: "BD Sharpshooter/Skill folder missing" };
  await ensureMaster(game, folder, log);
  const master = findInFolder(game, folder, SPEC.name);
  const equipped = await ensureOnDummy(game, master, log);
  // Clean-replace tables on master + dummy copy (defeats Foundry's merge).
  await forceSetTables(master, log, "BD master");
  const dummy = game.actors?.getName?.(DUMMY_NAME);
  await forceSetTables(dummy?.items?.find((i) => i.name === SPEC.name), log, "dummy copy");
  return { applied: true, summary: `Warning Shot BD master ensured; dummy equipped: ${equipped}` };
}
