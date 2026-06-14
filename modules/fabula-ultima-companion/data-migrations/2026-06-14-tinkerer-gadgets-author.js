/**
 * Migration: 2026-06-14-tinkerer-gadgets-author
 * ---------------------------------------------------------------------------
 * Author the consolidated Tinkerer "Gadgets" meta-skill — ONE skill item that
 * holds all three branches (RAW: Gadgets is a single skill you take repeatedly
 * to unlock infusion tiers / the alchemy + magitech facets):
 *
 *   ├─ Infusions  → creature_will_deal_damage reaction (FULL — this pass)
 *   ├─ Alchemy    → on-activate Inventory-action (STUB: notify "not implemented")
 *   └─ Magitech   → on-activate Inventory-action (STUB)
 *
 * INFUSIONS (RAW common rule): "When you successfully hit one or more targets
 * with an attack, you may spend 2 Inventory Points to produce an infusion and
 * apply its effect to that attack (Multi → each target). One infusion per
 * attack; producing + using it are part of the attack action."
 *
 *   Basic    (tier ≥ 1): Cryo→ice, Pyro→fire, Volt→bolt           (+5 dmg)
 *   Advanced (tier ≥ 2): Cyclone→air, Exorcism→light, Seismic→earth, Shadow→dark (+5)
 *   Superior (tier ≥ 3): Venom→poison (+5, Envenomed on each hit); Vampire (P3)
 *
 * UNLOCK STATE: with one skill, "which tiers a character has" lives in numeric
 * props on the skill instance — gadget_infusion_tier / _alchemy_tier /
 * _magitech_tier (0 none … 3 superior), read by the GADGET_<TYPE>_TIER formula
 * identifier and used in each option's condition_formula gate (the menu hides
 * options the character hasn't unlocked). Requires the gadget-tier template
 * columns (2026-06-14-skill-template-gadget-tier-columns).
 *
 * ENGINE: `change_damage_element` (overrides the in-flight attack's element +
 * recomputes affinity, riding computeSenderDamageBonuses → recomputePerTarget-
 * Damages so element + the +5 compose in one affinity pass) and `notify` (stub
 * branches). The infusion menu (open_action_menu) is followed by the recompute
 * walker via the player's captured pick. All in skill-effects.js.
 *
 * Folder: Battle Director / Tinkerer / Skill.
 *
 * SEED-ONLY (world data authoritative): if the master already exists this
 * migration leaves it (and Zarg's copy) untouched. It only seeds a world that
 * lacks Gadgets. Legacy Basic/Advance/Superior Infusion items are left in place
 * (retired later); they don't conflict with the new skill's behavior.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-14-tinkerer-gadgets-author";
export const description =
  "Author the consolidated Tinkerer Gadgets meta-skill: Infusions (7 element + " +
  "Venom, tier-gated, change_damage_element +5/2 IP) + Alchemy/Magitech stubs. " +
  "Seed-only; seeds Zarg's copy at infusion tier 3.";

const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Tinkerer";
const SUBFOLDER = "Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const SKILL_NAME = "Gadgets";
const GADGETS_UID = "fuGadgetsMeta001";
const ZARG_NAME = "Zarg";

// Foundry core icon (cosmetic; safe path).
const GADGETS_ICON = "icons/svg/item-bag.svg";

const GADGETS_DESCRIPTION =
  "<p>You can produce <strong>infusions</strong> and other gadgets on the fly.</p>" +
  "<p><strong>Infusions.</strong> When you successfully <strong>hit one or more " +
  "targets with an attack</strong>, you may spend <strong>2 Inventory Points</strong> " +
  "to produce a special infusion and apply its effect to that attack. If the attack " +
  "had the <em>multi</em> property, the effect applies to <strong>each</strong> target. " +
  "You cannot apply more than one infusion to the same attack; producing and using an " +
  "infusion are both part of the attack.</p>" +
  "<ul>" +
  "<li><strong>Cryo / Pyro / Volt:</strong> deal 5 extra damage; the attack's damage " +
  "becomes <strong>ice / fire / bolt</strong>.</li>" +
  "<li><strong>Cyclone / Exorcism / Seismic / Shadow:</strong> deal 5 extra damage; the " +
  "attack's damage becomes <strong>air / light / earth / dark</strong>.</li>" +
  "<li><strong>Venom:</strong> deal 5 extra damage; the attack's damage becomes " +
  "<strong>poison</strong>; each creature hit suffers <strong>poisoned</strong>.</li>" +
  "<li><strong>Vampire:</strong> heal HP equal to <strong>half the damage dealt</strong>. " +
  "<em>Single-target attacks only.</em></li>" +
  "</ul>";

// ── reaction_config_table — the on-hit infusion offer ────────────────────────
const REACTION_CONFIG_TABLE = {
  "0": {
    reaction_trigger: "creature_will_deal_damage",
    reaction_source: "self",
    reaction_action_kind: "Attack",        // RAW: infusions apply to ATTACKS only
    reaction_passive_mode: "ask",          // "you MAY spend 2 IP" → clickable pill
    reaction_effect_ref: "inf_offer",
  },
};

// ── effect_table ─────────────────────────────────────────────────────────────
const EFFECT_TABLE = {
  // — Infusion offer menu (one infusion per attack) —
  "0": {
    effect_label: "inf_offer",
    effect_kind: "open_action_menu",
    menu_title: "Produce an Infusion",
    menu_subtitle: "Spend 2 IP — the attack's damage changes",
    menu_pick_count: "1",
    menu_option_refs:
      "inf_cryo,inf_pyro,inf_volt,inf_cyclone,inf_exorcism,inf_seismic,inf_shadow,inf_venom,inf_vampire",
    menu_option_labels:
      "Cryo|Pyro|Volt|Cyclone|Exorcism|Seismic|Shadow|Venom|Vampire",
    menu_option_descriptions:
      "+5; becomes Ice|+5; becomes Fire|+5; becomes Bolt|+5; becomes Air|+5; becomes Light|+5; becomes Earth|+5; becomes Dark|+5; becomes Poison + Poisoned|Single-target: heal 50% of damage dealt",
  },

  // — Basic infusions (tier ≥ 1) —
  "1": { effect_label: "inf_cryo", effect_kind: "chain", chain_steps: "inf_pay,inf_el_ice,inf_plus5",  condition_formula: "GADGET_INFUSION_TIER >= 1", menu_label: "Cryo" },
  "2": { effect_label: "inf_pyro", effect_kind: "chain", chain_steps: "inf_pay,inf_el_fire,inf_plus5", condition_formula: "GADGET_INFUSION_TIER >= 1", menu_label: "Pyro" },
  "3": { effect_label: "inf_volt", effect_kind: "chain", chain_steps: "inf_pay,inf_el_bolt,inf_plus5", condition_formula: "GADGET_INFUSION_TIER >= 1", menu_label: "Volt" },

  // — Advanced infusions (tier ≥ 2) —
  "4": { effect_label: "inf_cyclone",  effect_kind: "chain", chain_steps: "inf_pay,inf_el_air,inf_plus5",   condition_formula: "GADGET_INFUSION_TIER >= 2", menu_label: "Cyclone" },
  "5": { effect_label: "inf_exorcism", effect_kind: "chain", chain_steps: "inf_pay,inf_el_light,inf_plus5", condition_formula: "GADGET_INFUSION_TIER >= 2", menu_label: "Exorcism" },
  "6": { effect_label: "inf_seismic",  effect_kind: "chain", chain_steps: "inf_pay,inf_el_earth,inf_plus5", condition_formula: "GADGET_INFUSION_TIER >= 2", menu_label: "Seismic" },
  "7": { effect_label: "inf_shadow",   effect_kind: "chain", chain_steps: "inf_pay,inf_el_dark,inf_plus5",  condition_formula: "GADGET_INFUSION_TIER >= 2", menu_label: "Shadow" },

  // — Superior infusion: Venom (tier ≥ 3) —
  "8": { effect_label: "inf_venom", effect_kind: "chain", chain_steps: "inf_pay,inf_el_poison,inf_plus5,inf_poison", condition_formula: "GADGET_INFUSION_TIER >= 3", menu_label: "Venom" },

  // — Superior infusion: Vampire (tier ≥ 3, single-target) — pure lifesteal via
  //   the `drain` action keyword (heal the attacker 50% of HP damage dealt). No
  //   +5, no element change. Gated to a single hit (RAW "single-target only").
  "23": { effect_label: "inf_vampire", effect_kind: "chain", chain_steps: "inf_pay,inf_drain", condition_formula: "GADGET_INFUSION_TIER >= 3 && HIT_COUNT == 1", menu_label: "Vampire" },
  "24": { effect_label: "inf_drain", effect_kind: "apply_action_keyword", action_keyword: "drain" },

  // — Shared infusion steps —
  "9":  { effect_label: "inf_pay",   effect_kind: "consume_resource", consume_resource: "ip", consume_amount: "2", target_ref: "self", on_empty: "abort" },
  "10": { effect_label: "inf_plus5", effect_kind: "adjust_damage", damage_operation: "add", damage_amount: "5", damage_stage: "outgoing" },

  // — Element-override rows (one literal per element) —
  "11": { effect_label: "inf_el_ice",    effect_kind: "change_damage_element", change_element: "ice" },
  "12": { effect_label: "inf_el_fire",   effect_kind: "change_damage_element", change_element: "fire" },
  "13": { effect_label: "inf_el_bolt",   effect_kind: "change_damage_element", change_element: "bolt" },
  "14": { effect_label: "inf_el_air",    effect_kind: "change_damage_element", change_element: "air" },
  "15": { effect_label: "inf_el_light",  effect_kind: "change_damage_element", change_element: "light" },
  "16": { effect_label: "inf_el_earth",  effect_kind: "change_damage_element", change_element: "earth" },
  "17": { effect_label: "inf_el_dark",   effect_kind: "change_damage_element", change_element: "dark" },
  "18": { effect_label: "inf_el_poison", effect_kind: "change_damage_element", change_element: "poison" },

  // — Venom rider: Poisoned (MIG+WLP -2, 3 turns) on each hit target — the
  //   canonical FU "poisoned" status (NOT Envenomed, which is the deals-damage-
  //   on-action variant). Duration/changes live on the world Poisoned template.
  "19": { effect_label: "inf_poison", effect_kind: "apply_ae", ae_template_ref: "Poisoned", target_ref: "hit_action_targets", ae_duplicate_mode: "replace" },

  // — Active branches (Alchemy / Magitech) — STUBS —
  "20": {
    effect_label: "gadget_active_root",
    effect_kind: "open_action_menu",
    menu_title: "Use a Gadget",
    menu_subtitle: "Choose a gadget branch",
    menu_pick_count: "1",
    menu_option_refs: "stub_alchemy,stub_magitech",
    menu_option_labels: "Alchemy|Magitech",
    menu_option_descriptions: "Mix a potion|Build a magitech device",
  },
  "21": { effect_label: "stub_alchemy",  effect_kind: "notify", notify_message: "Alchemy gadgets (potion-mixing) are not yet implemented.",  notify_type: "info", condition_formula: "GADGET_ALCHEMY_TIER >= 1",  menu_label: "Alchemy" },
  "22": { effect_label: "stub_magitech", effect_kind: "notify", notify_message: "Magitech gadgets are not yet implemented.", notify_type: "info", condition_formula: "GADGET_MAGITECH_TIER >= 1", menu_label: "Magitech" },
};

const BASE_PROPS = {
  skill_type: "Active",
  isCheck: false,
  isReaction: false,
  isHeroic: false,
  isFacet: false,
  class: CLASS_NAME,
  cost: "2 IP",
  skill_target: "Special",
  skill_range: "-",
  duration: "Instantaneous",
  max_level: "1",
  level: "1",
  on_activate_effect_ref: "gadget_active_root",
  reaction_config_table: REACTION_CONFIG_TABLE,
  effect_table: EFFECT_TABLE,
  // Unlock tiers (per character; master defaults to 0 — inert until set).
  gadget_infusion_tier: 0,
  gadget_alchemy_tier: 0,
  gadget_magitech_tier: 0,
  description: GADGETS_DESCRIPTION,
};

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);
const templateMatches = (item) => String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;

async function replaceTable(item, field, table) {
  await item.update({ [`system.props.-=${field}`]: null });
  await item.update({ [`system.props.${field}`]: foundry.utils.deepClone(table) });
}

async function patchMaster(item, log) {
  const p = item.system?.props ?? {};
  const propUpdates = {};
  for (const [k, v] of Object.entries(BASE_PROPS)) {
    if (k === "reaction_config_table" || k === "effect_table") continue;
    if (!deepEqual(p[k], v)) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) await item.update(propUpdates);
  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) await replaceTable(item, "effect_table", EFFECT_TABLE);
  if (!deepEqual(p.reaction_config_table ?? {}, REACTION_CONFIG_TABLE)) await replaceTable(item, "reaction_config_table", REACTION_CONFIG_TABLE);

  // CSB template version stamp + reload so the new columns (tiers, change_element,
  // notify_*) bind and the props survive the compiled-template gate.
  const tpl = game.items.get(SKILL_TEMPLATE_ID);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
  }
  if (item.templateSystem?.reloadTemplate) {
    try { await item.templateSystem.reloadTemplate(); }
    catch (e) { log(`  Gadgets: reloadTemplate threw — ${e?.message ?? e}`); }
  }
}

// Seed Zarg's copy at infusion tier 3 (superior). Create-if-missing; never
// override an existing copy (seed-only). Legacy infusion items are left in place.
async function seedZargCopy(game, master, log) {
  const zarg = game.actors?.getName?.(ZARG_NAME);
  if (!zarg) { log(`  Gadgets: actor "${ZARG_NAME}" not found — skipped copy seed`); return; }
  const existing = zarg.items.find((i) => i.name === SKILL_NAME && templateMatches(i));
  if (existing) { log(`  Gadgets: ${ZARG_NAME} already has a copy — left untouched (seed-only)`); return; }
  const data = master.toObject(false);
  delete data._id;
  data.system = data.system ?? {};
  data.system.props = { ...(data.system.props ?? {}), gadget_infusion_tier: 3 };
  await zarg.createEmbeddedDocuments("Item", [data]);
  log(`  Gadgets: seeded ${ZARG_NAME}'s copy at infusion tier 3`);
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, CLASS_NAME, SUBFOLDER], { log });
  if (!folder) {
    return { applied: false, summary: `Gadgets: missing folder "${BD_ROOT_NAME}/${CLASS_NAME}/${SUBFOLDER}"` };
  }

  let master = game.items?.contents?.find?.((i) =>
    i.name === SKILL_NAME && i.folder?.id === folder.id && templateMatches(i));

  if (master) {
    log("  Gadgets already present — seed-only; leaving world data untouched");
    return { applied: true, summary: "Gadgets already present; left untouched (seed-only)" };
  }

  const tpl = game.items.get(SKILL_TEMPLATE_ID);
  const versionStamp = tpl?.system?.templateSystemUniqueVersion;
  master = await Item.create({
    name: SKILL_NAME,
    type: "equippableItem",
    img: GADGETS_ICON,
    folder: folder.id,
    system: {
      template: SKILL_TEMPLATE_ID,
      uniqueId: GADGETS_UID,
      unique: true,
      ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
      props: { skill_type: "Active", level: "1", max_level: "1" },
    },
  });
  log(`  Gadgets: master created in ${BD_ROOT_NAME}/${CLASS_NAME}/${SUBFOLDER} (uid ${GADGETS_UID})`);

  await patchMaster(master, log);
  await seedZargCopy(game, master, log);

  return { applied: true, summary: "Gadgets seeded: master + Zarg copy (infusion tier 3)" };
}
