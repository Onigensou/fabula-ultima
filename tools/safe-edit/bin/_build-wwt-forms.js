// Polymorph forms from the old campaign, The Winterlands Witch Trials (WWT).
// Six legacy monsters RECONSTRUCTED in the current format (user ruling
// 2026-11-12: reconstruct, never port; only stats and actions matter; keep the
// old levels, there was no universal balance metric back then). Source record:
// the archive world (worlds/fabula-ultima-2-archive/_authored-export/actors):
//   Ice Ring Ld2lRA2NZNicUvpw · Lava Golem 1ZzI3edFx9jDJYYz · Walrog 5Uyo51jXXO0igr14
//   Hunger SELbtLBE9piPcIhT · Crazy Merman dCXXlDHDrrNpxYJZ · Scaldra VXlqBI4ybeipYclT
// Polymorph traversal tags (user 2026-11-12): aquatic = Walrog, Crazy Merman;
// lava = Lava Golem, Scaldra (Scaldra lava only: "a shark that swims in lava").
//
// Run from tools/safe-edit:
//   node bin/_build-wwt-forms.js folder [--apply]   (the "Polymorph Forms" folder)
//   node bin/_build-wwt-forms.js [--apply]          (the six actors)
const { getByKey } = require("../lib/db");
const { blankActor, run } = require("./_fafnir-util");
const { link, ICON } = require("./_fafnir-lib");
const D = require("./_dragon-lib");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const BEST = FORGE + "Beastiary/";
const NS = "fabula-ultima-companion";
const FOLDER_MONSTER_ROOT = "Nd8LnosrPid1eX1r";       // The Legend of Dragonslayer / Monster
const FOLDER_FORMS = "PolymorphForms01";              // NEW: .../Monster/Polymorph Forms
const FOLDER_TEMPLATE = "334KROpobXWVeG1Z";           // Fafnir Castle (clone source for the folder doc)

// ── keyword / status links ───────────────────────────────────────────────
const J = (id, label) => link(`JournalEntry.${id}`, label);
const K = {
  physical: D.L.physical ?? link("Item.XpKZuGo3VmT0TlTu", "Physical"),
  air: D.L.air, earth: link("Item.ZyOMe6IkUTlBzfjw", "Earth"), fire: link("Item.0sFCVCoM6FRrQP2f", "Fire"),
  ice: link("Item.Osq3NN3QCtiW7otU", "Ice"), dark: link("Item.vKU8UYT6DBhgOjtE", "Dark"),
  disarmed: J("MM2SvLRyVhazkNq3", "Disarmed"), burn: J("MSRXG4jUMPFpM9sN", "Burn"), grappled: J("FV8JefaHsehzgXR7", "Grappled"),
  weak: J("KYehgac3Pw1fKC9S", "Weak"), dazed: J("3nmUvPei3zrOJkEt", "Dazed"), stagger: J("IBN7DtvWLFDo8jNh", "Stagger"),
  wet: J("2rh5lyMNU5yL8Btk", "Wet"), turbulence: J("vzkQ7MNkmqRDJIXV", "Turbulence"), petrify: J("thBevyZDOURijH8I", "Petrify"),
  bane: J("SNK1IJTKfxjAy2NS", "Bane"), berserk: J("aPF9gzkqnUkcQmIC", "Berserk"), hidden: J("DMaL1B3Z5Y5AUrvC", "Hidden"),
  bleed: J("GePNxftPupElcCWp", "Bleed"), enraged: J("XkuOy0BFvKJTewGS", "Enraged"), slow: J("HHmYmj7xffQMqtzT", "Slow"),
  zombie: J("RZIAnKw95vY6yh2W", "Zombie"), crisis: J("GJevbCPM8cffm1QM", "Crisis"),
  overflow: J("NUaxIAIPUu5Qnk8l", "Overflow"), pierce: J("2hNU23YLpCcZCCmf", "Pierce"), drain: J("CRPjA4dHUYLSAh0M", "Drain"),
  trigger: J("P7eaFojxra2gTRTG", "Trigger"), unleash: J("UqXGUQM31kWc7BTc", "Unleash"), shield: J("wrw2ENSwzCBjztvt", "Shield"),
};
const ul = (...items) => `<ul>${items.map((x) => `<li><p>${x}</p></li>`).join("")}</ul>`;
const P = (s) => `<p>${s}</p>`;
const trig = (s) => `${K.trigger}&nbsp;${s}`;

// ── ids (16 chars, fixed so a re-run is the same build) ──────────────────
const IDS = {
  ICE: "706pcXzVf41lQNI2", ICE_FINIS: "P3BfwaAOtPli0Xpr", ICE_ALTA: "95GjvRCmTmi9Tdh8", ICE_DANGER: "EoJQS2IrAOqNieL3",
  LAVA: "1Ua5E4XOPy3oS7nA", LAVA_HUG: "PXeusfx7qkT1aM6R", LAVA_SLAM: "ErPNReZ3DHn06V4m", LAVA_MELT: "orTNnkfw2nylQahx",
  LAVA_EMBRACE: "pmI0JQ2GhaOfC8w9", LAVA_DEATH: "rsCswNNcAqhiQ9Mt",
  WAL: "C0SAjRdzVnQldsVn", WAL_STAB: "TTCpho4uIwlMpG8p", WAL_SPIN: "Vjw5bMeEzH9jfsyj", WAL_SHOT: "tHb3FPfUdXQPpcjE",
  WAL_BUTT: "LNaivOOfn3nisQ9u", WAL_ROCK: "UzvUjfguKJBJJAde", WAL_ICE: "zeLgWjHipdbLc8Eg", WAL_GALE: "wJZC1nFcjEQMXFq7",
  WAL_FOOD: "MOR6wAiBiIadZEua", WAL_HUNGER: "u4eVp1Oe7Q5vxFwA",
  HUN: "az20eSM6K9FJTpsN", HUN_CHOMP: "XUkLPKJqfDwHEBiX", HUN_BANE: "xi8cj2zCq2E6XAa0", HUN_THIRST: "nrvTbDucWQq3Li3E",
  HUN_ETHEREAL: "lzLLpLV6cC20nMQ4", HUN_UNDEAD: "eIwdK4nO8vfttyZs", HUN_STARVE: "MpPE3igCrHa4mCKh", HUN_INSATIABLE: "SdoZ3pFU1B0C1LoC",
  MER: "ZJehqVHDbsh8ngNC", MER_SLAP: "hfXrt4lKTNBiP3r8", MER_GUARD: "GnQbQZwL4e2cbduZ", MER_BASH: "gBu5XZAvK2iwbIhV",
  MER_RAGE: "o8TSW61J3Hk7ZKbw", MER_CRAZY: "j6nBTVh1n4xdpxML",
  SCA: "4iuVZBcU2zuBxGTQ", SCA_CHOMP: "UINbFAjA3RG1rY0z", SCA_SHARK: "FVgKOydTJNOmBnKq", SCA_WAVER: "chRpDT7tvj0Tv6Kc",
  SCA_BLOOD: "6jECFEkPEXVt1cxV",
};

// ── builders ─────────────────────────────────────────────────────────────
function skillFrom(src, actorId, id, name, img, props) {
  const d = JSON.parse(JSON.stringify(src));
  d._id = id; d.name = name; d.img = img; d.effects = [];
  d.folder = null; d.ownership = { default: 0 };
  if (d._stats) { d._stats.createdTime = null; d._stats.modifiedTime = null; d._stats.duplicateSource = null; }
  for (const k of ["reaction_config_table", "effect_table", "optional_params", "active_effect_config_table"]) d.system.props[k] = {};
  Object.assign(d.system.props, {
    name, img, id: "${item.id}", uuid: `Actor.${actorId}.Item.${id}`,
    level: "1", max_level: "1", class: "NPC", check_bonus: "0",
    isFacet: false, isHeroic: false, isZeroPower: false, ignore_hr: false, use_optional_params: false,
    skill_animation_mode: "default", animation_script: "", on_activate_effect_ref: "",
    ae_chance_percent: "", ae_template_ref: "", target_eligibility: "", no_polymorph: false,
    details_roller: "Show", duration: "Instantaneous", action_keywords: "",
  }, props);
  return d;
}
// On-hit status rider (house idiom: Mist Dragon / Obsidrax).
const rider = (skillName, rows) => {
  const rc = {}, et = {};
  rows.forEach(([status, pct], i) => {
    const label = `rider_${i}`;
    rc[String(i)] = { $deleted: false, reaction_trigger: "creature_deals_damage", reaction_source: "self",
      reaction_source_skill: skillName, reaction_passive_mode: "force", reaction_effect_ref: label,
      reaction_cause_filter: "", reaction_resource_filter: "" };
    et[String(i)] = { $deleted: false, effect_kind: "apply_ae", effect_label: label, ae_template_ref: status,
      target_ref: "hit_action_targets", ae_duplicate_mode: "skip", ae_chance_percent: String(pct) };
  });
  return { reaction_config_table: rc, effect_table: et, isReaction: true };
};
const pattern = (rows) => Object.fromEntries(rows.map(([name, cond, v1, v2, prio, focus = "auto"], i) => [String(i), {
  $deleted: false, action_pattern_name: name, action_pattern_condition: cond, action_pattern_string: "",
  action_pattern_value_1: String(v1), action_pattern_value_2: String(v2), action_pattern_priority: String(prio),
  action_pattern_target_focus: focus, action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0",
}]));

// Sheet list mirrors (CSB renders the sheet from these, not from the items).
function mirrors(A, items) {
  const attack_list = {}, normal_spell_list = {}, skill_passive_list = {}, skill_active_list = {};
  for (const it of items) {
    const p = it.system.props; const base = { name: it.name, id: "${item.id}", uuid: `Actor.${A}.Item.${it._id}`, roll: "" };
    if (p.skill_type === "Attack") attack_list[it._id] = { ...base, active_target: p.skill_target, attribute_die1: p.rolled_atr1, attribute_die2: p.rolled_atr2, attack_description: p.description };
    else if (p.skill_type === "Spell") normal_spell_list[it._id] = { ...base, cost: p.cost, spell_target: p.skill_target, duration: p.duration, spell_description: p.description };
    else if (p.skill_type === "Passive") skill_passive_list[it._id] = { ...base, passive_description: p.description };
    else skill_active_list[it._id] = { ...base, active_target: p.skill_target, active_cost: p.cost, active_duration: p.duration, active_description: p.description };
  }
  return { attack_list, normal_spell_list, skill_passive_list, skill_active_list };
}

// ── the six records ──────────────────────────────────────────────────────
function monsters(don) {
  const atk = (A, id, name, o, desc, extra = {}) => skillFrom(don.atk, A, id, name, o.range === "Range" ? ICON.range : ICON.melee, {
    skill_type: "Attack", skill_target: o.target ?? "One Creature", skill_range: o.range ?? "Melee",
    rolled_atr1: o.a1, rolled_atr2: o.a2, check_bonus: String(o.check), damage_bonus: String(o.dmg),
    type_damage: o.el, defense_target_type: "def", isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: o.cost ?? "-", description: desc, ...extra });
  const spell = (A, id, name, o, desc, extra = {}) => skillFrom(don.spell, A, id, name, ICON.ospell, {
    skill_type: "Spell", skill_target: o.target ?? "One Creature", skill_range: "Any",
    rolled_atr1: o.a1, rolled_atr2: o.a2, check_bonus: String(o.check), damage_bonus: String(o.dmg),
    type_damage: o.el, defense_target_type: "mdef", isCheck: true, isOffensiveSpell: true, isReaction: false,
    cost: o.cost, description: desc, ...extra });
  const active = (A, id, name, o, desc, extra = {}) => skillFrom(don.spell, A, id, name, ICON.spell, {
    skill_type: "Active", skill_target: o.target ?? "Self", skill_range: o.range ?? "-",
    rolled_atr1: "-", rolled_atr2: "-", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false, cost: o.cost ?? "-", description: desc, ...extra });
  const passive = (A, id, name, desc, extra = {}) => skillFrom(don.pas, A, id, name, extra.isReaction ? ICON.reaction : ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-", rolled_atr1: "-", rolled_atr2: "-",
    damage_bonus: "0", type_damage: "", defense_target_type: "def", isCheck: false, isOffensiveSpell: false,
    isReaction: false, cost: "-", duration: "-", description: desc, ...extra });
  const NOPOLY = { no_polymorph: true };

  const out = [];

  // ── ICE RING — Lv35 soldier, Elemental, ice ────────────────────────────
  {
    const A = IDS.ICE;
    const finisName = "Glacies Finis";
    const items = [
      spell(A, IDS.ICE_FINIS, finisName, { a1: "WLP", a2: "WLP", check: 4, dmg: 40, el: "Ice", cost: "30 MP" },
        P(`Deal <strong>heavy</strong> ${K.ice}&nbsp;damage to one creature, with an <strong>80%</strong> chance to inflict ${K.disarmed}.`),
        rider(finisName, [["Disarmed", 80]])),
      spell(A, IDS.ICE_ALTA, "Magna Glacies Alta", { a1: "WLP", a2: "WLP", check: 3, dmg: 30, el: "Ice", cost: "30 MP", target: "All Enemies" },
        ul(K.overflow) + P(`Deal ${K.ice}&nbsp;damage to every enemy.`)),
      passive(A, IDS.ICE_DANGER, "Danger Sensitivity",
        ul(trig("an enemy equips or unequips an item")) + P(`This creature casts ${finisName} on that enemy for free.`), {
          isReaction: true,
          reaction_config_table: {
            "0": { $deleted: false, reaction_trigger: "creature_equips_item", reaction_source: "enemy", reaction_passive_mode: "force", reaction_effect_ref: "ds_cast", reaction_max_per_round: "1" },
            "1": { $deleted: false, reaction_trigger: "creature_unequips_item", reaction_source: "enemy", reaction_passive_mode: "force", reaction_effect_ref: "ds_cast", reaction_max_per_round: "1" },
          },
          effect_table: { "0": { $deleted: false, effect_kind: "free_action", effect_label: "ds_cast", action_ref: finisName, target_ref: "trigger_subject" } },
        }),
    ];
    out.push({
      A, name: "Ice Ring", art: BEST + "Ice_Ring.png", scale: 1.3, tags: [],
      props: {
        level: "35", npc_rank: "soldier", species: "ELEMENTAL", subtype_list: "", attribute: "ICE", traits: "Elemental Creature, Construct",
        dex_base: "6", ins_base: "12", mig_base: "6", wlp_base: "12", def_mod: "+5", mdef_mod: "+0", defense: 11, magic_defense: 12,
        max_hp: "132", current_hp: "132", max_mp: "150", current_mp: "150", init: "6",
        affinity_1: "RS", affinity_3: "VU", affinity_6: "IM", affinity_7: "AB",
        condition_poisoned: "IM", condition_envenomed: "IM", condition_burn: "IM", condition_zombie: "IM", condition_bleed: "IM",
        condition_oil: "IM", condition_hypothermia: "IM",
        arcane_ef: "200", brawling_ef: "50", heavy_ef: "150",
        study_text: "<p>A hovering construct of crystallised frost and arcane ice that chills the air around it. It reacts violently when someone changes equipment, and its bursts can freeze gear solid.</p>",
      },
      items,
      pattern: pattern([[finisName, "mp", 20, 100, 5], ["Magna Glacies Alta", "mp", 20, 100, 4]]),
    });
  }

  // ── LAVA GOLEM — Lv38 soldier, Elemental/Golem, fire ───────────────────
  {
    const A = IDS.LAVA;
    const items = [
      atk(A, IDS.LAVA_HUG, "Lava Hug", { a1: "MIG", a2: "DEX", check: 3, dmg: 20, el: "Fire" },
        P(`Deal ${K.fire}&nbsp;damage to one creature, with a <strong>50%</strong> chance to inflict ${K.burn}.`), rider("Lava Hug", [["Burn", 50]])),
      atk(A, IDS.LAVA_SLAM, "Lava Slam", { a1: "MIG", a2: "WLP", check: 3, dmg: 25, el: "Fire" },
        P(`Deal ${K.fire}&nbsp;damage to one creature and inflict ${K.grappled}.`), {
          isReaction: true,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_source_skill: "Lava Slam", reaction_passive_mode: "force", reaction_effect_ref: "slam_chain" } },
          effect_table: {
            "0": { $deleted: false, effect_kind: "chain", effect_label: "slam_chain", chain_steps: "slam_hold,slam_mark" },
            "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "slam_hold", ae_template_ref: "Grappled", target_ref: "hit_action_targets", ae_duplicate_mode: "skip" },
            "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "slam_mark", ae_template_ref: "Grappling", target_ref: "self", ae_duplicate_mode: "skip" },
          },
        }),
      // Legacy: the weapon is "temporarily damaged until the end of the scene".
      // User 2026-11-12: Imp's Strip Weapon logic — hide the weapon slot + the
      // "Weapon Stripped" marker, back at the end of the battle. A monster has no
      // weapon, so against one it does nothing.
      passive(A, IDS.LAVA_MELT, "Melting Body",
        ul(trig(`a melee attack hits this creature with an Accuracy Check below <strong>10</strong>`)) + P(`The weapon melts in the lava: the attacker can't use it until the end of the battle.`), {
          isReaction: true,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_hit_by_action", reaction_source: "self", reaction_damage_source: "enemy", reaction_action_intent: "harmful", reaction_passive_mode: "force", condition_formula: "ATTACK_IS_MELEE == 1 && ATTACK_CHECK_RESULT < 10 && USED_WEAPON_IS_EQUIPPED == 1", reaction_effect_ref: "melt_chain" } },
          effect_table: {
            "0": { $deleted: false, effect_kind: "chain", effect_label: "melt_chain", chain_steps: "melt_take,melt_mark" },
            "1": { $deleted: false, effect_kind: "hide_item", effect_label: "melt_take", hide_item_slot: "weapon", target_ref: "trigger_attacker" },
            "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "melt_mark", ae_template_ref: "Weapon Stripped", target_ref: "trigger_attacker", ae_duplicate_mode: "replace" },
          },
        }),
      passive(A, IDS.LAVA_EMBRACE, "Melting Embrace",
        ul(trig(`this creature starts its turn while Grappling`)) + P(`Every creature it holds becomes ${K.burn}.`), {
          isReaction: true,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "turn_start", reaction_source: "", reaction_passive_mode: "force", condition_formula: "SUBJECT_IS_SELF == 1 && AE_COUNT_GRAPPLING > 0", reaction_effect_ref: "emb_chain" } },
          effect_table: {
            "0": { $deleted: false, effect_kind: "chain", effect_label: "emb_chain", chain_steps: "emb_burn" },
            "1": { $deleted: false, effect_kind: "targeting", effect_label: "emb_held", candidate_source: "combat", category: "enemy", exclude_self: true, mode: "all", allow_empty: true, target_filter: "HAS_STATUS_GRAPPLED == 1" },
            "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "emb_burn", ae_template_ref: "Burn", target_ref: "emb_held", ae_duplicate_mode: "skip" },
          },
        }),
      passive(A, IDS.LAVA_DEATH, "Solidifying Death",
        ul(trig(`this creature is defeated while Grappling`)) + P(`The lava hardens around its catch: every creature it held becomes ${K.slow}, ${K.petrify}&nbsp;and ${K.stagger}.`), {
          isReaction: true, ...NOPOLY,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_defeated", reaction_source: "self", reaction_passive_mode: "force", condition_formula: "AE_COUNT_GRAPPLING > 0", reaction_effect_ref: "sd_chain" } },
          effect_table: {
            "0": { $deleted: false, effect_kind: "chain", effect_label: "sd_chain", chain_steps: "sd_slow,sd_petrify,sd_stagger" },
            "1": { $deleted: false, effect_kind: "targeting", effect_label: "sd_held", candidate_source: "combat", category: "enemy", exclude_self: true, mode: "all", allow_empty: true, target_filter: "HAS_STATUS_GRAPPLED == 1" },
            "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "sd_slow", ae_template_ref: "Slow", target_ref: "sd_held", ae_duplicate_mode: "skip" },
            "3": { $deleted: false, effect_kind: "apply_ae", effect_label: "sd_petrify", ae_template_ref: "Petrify", target_ref: "sd_held", ae_duplicate_mode: "skip" },
            "4": { $deleted: false, effect_kind: "apply_ae", effect_label: "sd_stagger", ae_template_ref: "Stagger", target_ref: "sd_held", ae_duplicate_mode: "skip" },
          },
        }),
    ];
    out.push({
      A, name: "Lava Golem", art: BEST + "Lava%20Golem.png", scale: 1.8, tags: ["lava"],
      props: {
        level: "38", npc_rank: "soldier", species: "ELEMENTAL", subtype_list: "GOLEM", attribute: "FIRE", traits: "Elemental Creature, Golem, Volcanic",
        dex_base: "6", ins_base: "8", mig_base: "12", wlp_base: "12", def_mod: "+0", mdef_mod: "+6", defense: 6, magic_defense: 14,
        max_hp: "140", current_hp: "140", max_mp: "100", current_mp: "100", init: "6",
        affinity_1: "RS", affinity_5: "AB", affinity_6: "IM", affinity_7: "VU", affinity_9: "IM",
        condition_poisoned: "IM", condition_envenomed: "IM", condition_zombie: "IM",
        condition_burn: "IM", condition_bleed: "IM", condition_oil: "IM", condition_petrify: "IM",
        study_text: "<p>A golem made of lava, found where the ground runs hot. Its heart is its weak point, buried deep under layers of molten rock.</p>",
      },
      items,
      pattern: pattern([["Lava Slam", "random", 40, "", 6], ["Lava Hug", "always", 0, 100, 2]]),
    });
  }

  // ── WALROG — Lv37 elite, Beast/Aquatic, ice ────────────────────────────
  {
    const A = IDS.WAL;
    const spin = (id, name, el, link_, status, statusLink) => spell(A, id, name, { a1: "WLP", a2: "WLP", check: 3, dmg: 25, el, cost: "-", target: "All Enemies" },
      ul(K.overflow) + P(`Deal ${link_}&nbsp;damage to every enemy and inflict ${statusLink}.`), rider(name, [[status, 100]]));
    const items = [
      atk(A, IDS.WAL_STAB, "Drill Stab", { a1: "MIG", a2: "DEX", check: 4, dmg: 20, el: "Physical" },
        P(`Deal ${K.physical}&nbsp;damage to one creature and inflict ${K.grappled}. This creature then performs Drill Spin on it for free.`), {
          isReaction: true,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_source_skill: "Drill Stab", reaction_passive_mode: "force", reaction_effect_ref: "stab_chain" } },
          effect_table: {
            "0": { $deleted: false, effect_kind: "chain", effect_label: "stab_chain", chain_steps: "stab_hold,stab_spin" },
            "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "stab_hold", ae_template_ref: "Grappled", target_ref: "hit_action_targets", ae_duplicate_mode: "skip" },
            "2": { $deleted: false, effect_kind: "free_action", effect_label: "stab_spin", action_ref: "Drill Spin", target_ref: "hit_action_targets", max_mp_cost: "0" },
          },
        }),
      atk(A, IDS.WAL_SPIN, "Drill Spin", { a1: "MIG", a2: "MIG", check: 99, dmg: 50, el: "Physical" },
        P(`Can only target a ${K.grappled}&nbsp;creature. Deal <strong>heavy</strong> ${K.physical}&nbsp;damage to it, and it is no longer ${K.grappled}.`), {
          target_eligibility: "HAS_STATUS_GRAPPLED == 1", isReaction: true,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_source_skill: "Drill Spin", reaction_passive_mode: "force", reaction_effect_ref: "spin_free" } },
          effect_table: { "0": { $deleted: false, effect_kind: "remove_ae", effect_label: "spin_free", ae_template_ref: "Grappled", include_persistent: true, count: "all", target_ref: "hit_action_targets" } },
        }),
      atk(A, IDS.WAL_SHOT, "Drill Shot", { a1: "MIG", a2: "DEX", check: 3, dmg: 20, el: "Physical", range: "Range" },
        ul(K.pierce) + P(`Deal ${K.physical}&nbsp;damage to one creature.`), { action_keywords: "pierce" }),
      atk(A, IDS.WAL_BUTT, "Head Butt", { a1: "MIG", a2: "MIG", check: 3, dmg: 15, el: "Physical" },
        P(`Deal <strong>light</strong> ${K.physical}&nbsp;damage to one creature and inflict ${K.weak}.`), rider("Head Butt", [["Weak", 100]])),
      spin(IDS.WAL_ROCK, "Rock Spin", "Earth", K.earth, "Petrify", K.petrify),
      spin(IDS.WAL_ICE, "Ice Spin", "Ice", K.ice, "Wet", K.wet),
      spin(IDS.WAL_GALE, "Gale Spin", "Air", K.air, "Turbulence", K.turbulence),
      // User 2026-11-12 (simplified): eat an ally SOLDIER under 30 HP, recover
      // 50 HP / 50 MP; if the eaten creature has an element (props.attribute), the
      // attacks take it on for the rest of the battle (Asura's Elemental Aspect
      // pattern: an "Imbued <El>" status + change_damage_element). Three guards so a
      // TRANSFORMED PC can never eat its own summons (they are rank soldier too):
      // no_polymorph (never copied onto a PC) + IS_NPC == 1 on the eater (polymorph
      // never writes npc_rank/species onto a PC) + TARGET_RANK_IS_SOLDIER on the
      // victim (PCs carry no rank). The imbue is applied BEFORE the kill, while the
      // victim's sheet can still be read.
      (() => {
        const EL = [
          ["Fire", "fire", "TARGET_ATTRIBUTE_IS_FIRE > 0", "zQO0zLuji9j9gpR5"],
          ["Ice", "ice", "TARGET_ATTRIBUTE_IS_ICE > 0", "ag2HSGal5oKlNi8G"],
          ["Earth", "earth", "TARGET_ATTRIBUTE_IS_EARTH > 0", "qr7sSLaIPqNxzfPT"],
          ["Dark", "dark", "TARGET_ATTRIBUTE_IS_DARK > 0", "JvPFbjTudacJ1xDJ"],
          ["Light", "light", "TARGET_ATTRIBUTE_IS_LIGHT > 0", "pNjB83jeSYpMJ4Sw"],
          ["Poison", "poison", "TARGET_ATTRIBUTE_IS_POISON > 0", "9HsMvgUHfyDzrZxr"],
          ["Air", "air", "(TARGET_ATTRIBUTE_IS_WIND + TARGET_ATTRIBUTE_IS_AIR) > 0", "GR7ahYPYNwizPsZP"],
          ["Bolt", "bolt", "(TARGET_ATTRIBUTE_IS_LIGHTNING + TARGET_ATTRIBUTE_IS_BOLT) > 0", "tlvPxmE6gDELaOcF"],
        ];
        const rc = {
          "0": { $deleted: false, reaction_trigger: "creature_lose_resource", reaction_resource_filter: "hp", reaction_cause_filter: "", reaction_source: "ally",
                 reaction_passive_mode: "force", reaction_max_per_round: "1", reaction_effect_ref: "food_chain",
                 condition_formula: "IS_NPC == 1 && SUBJECT_IS_SELF == 0 && SUBJECT_IS_ALLY == 1 && TARGET_RANK_IS_SOLDIER == 1 && TARGET_CURRENT_HP > 0 && TARGET_CURRENT_HP < 30" },
        };
        const et = {
          "0": { $deleted: false, effect_kind: "chain", effect_label: "food_chain", chain_steps: ["food_clear", ...EL.map(([n]) => `imbue_${n.toLowerCase()}`), "food_hp", "food_mp", "food_eat"].join(",") },
          "1": { $deleted: false, effect_kind: "remove_tagged_ae", effect_label: "food_clear", filter_tag: "walrog_imbue", count: "all", target_ref: "self" },
          "2": { $deleted: false, effect_kind: "grant", effect_label: "food_hp", grant_resource: "hp", grant_amount: "50", target_ref: "self" },
          "3": { $deleted: false, effect_kind: "grant", effect_label: "food_mp", grant_resource: "mp", grant_amount: "50", target_ref: "self" },
          "4": { $deleted: false, effect_kind: "deal_damage", effect_label: "food_eat", damage_amount: "99999", damage_element: "elementless", damage_ignore_affinity: true, damage_cause: "hazard", damage_verbosity: "full", attacker_name: "food, Food, FOOD", target_ref: "trigger_subject" },
        };
        let r = 1, e = 5;
        const aes = [];
        for (const [n, el, cond, aeId] of EL) {
          et[String(e++)] = { $deleted: false, effect_kind: "apply_ae", effect_label: `imbue_${n.toLowerCase()}`, ae_template_ref: `Imbued ${n}`, target_ref: "self", ae_duplicate_mode: "replace", ae_duration_rounds: "scene", condition_formula: cond, on_condition_fail: "skip" };
          et[String(e++)] = { $deleted: false, effect_kind: "change_damage_element", effect_label: `food_el_${el}`, change_element: el };
          rc[String(r++)] = { $deleted: false, reaction_trigger: "creature_will_deal_damage", reaction_source: "self", reaction_action_kind: "Attack", reaction_passive_mode: "force", condition_formula: `AE_COUNT_IMBUED_${n.toUpperCase()} > 0`, reaction_effect_ref: `food_el_${el}` };
          aes.push({ _id: aeId, name: `Imbued ${n}`, img: ICON.passive, icon: ICON.passive, transfer: false, disabled: false, statuses: [], changes: [],
            description: `<p>Walrog's attacks deal ${n} damage until the end of the battle.</p>`, duration: {}, origin: `Actor.${A}.Item.${IDS.WAL_FOOD}`,
            system: { tags: ["walrog_imbue"] }, flags: { [NS]: { crossScene: false } } });
        }
        const it = passive(A, IDS.WAL_FOOD, "food, Food, FOOD",
          ul(trig(`a Soldier ally falls below <strong>30</strong> Hit Points`)) + P(`This creature eats it and recovers <strong>50</strong> Hit Points and <strong>50</strong> Mind Points. If the eaten creature had an element, this creature's attacks deal that element until the end of the battle.`),
          { isReaction: true, ...NOPOLY, reaction_config_table: rc, effect_table: et });
        it.effects = aes.map((x) => x._id);
        it._aes = aes;
        return it;
      })(),
      passive(A, IDS.WAL_HUNGER, "Hunger", P(`This creature only comes out when it is hungry.`), NOPOLY),
    ];
    out.push({
      A, name: "Walrog", art: BEST + "Walrog.png", scale: 2.2, tags: ["aquatic"],
      props: {
        level: "37", npc_rank: "elite", species: "BEAST", subtype_list: "AQUATIC", attribute: "ICE", traits: "Beast, Aquatic, Glutton",
        dex_base: "6", ins_base: "6", mig_base: "12", wlp_base: "12", def_mod: "+6", mdef_mod: "+4", defense: 12, magic_defense: 10,
        max_hp: "295", current_hp: "295", max_mp: "50", current_mp: "50", init: "6",
        affinity_5: "RS", affinity_6: "VU", affinity_7: "RS", affinity_9: "VU",
        condition_oil: "IM", condition_hypothermia: "IM",
        bow_ef: "50", brawling_ef: "75", flail_ef: "75", heavy_ef: "75", spear_ef: "150", sword_ef: "125", thrown_ef: "75",
        study_text: "<p>This mammal swims through icy water hunting for food with its powerful drill-like horn. The horn grows back, and it takes on the power of whatever it ate last.</p>",
      },
      items,
      pattern: pattern([["Ice Spin", "random", 25, "", 11], ["Head Butt", "random", 30, "", 8], ["Drill Shot", "random", 30, "", 5], ["Drill Stab", "always", 0, 100, 2]]),
    });
  }

  // ── HUNGER — Lv27 soldier, Undead/Spirit, dark ─────────────────────────
  {
    const A = IDS.HUN;
    const items = [
      atk(A, IDS.HUN_CHOMP, "Chomp", { a1: "MIG", a2: "WLP", check: 3, dmg: 15, el: "Dark" },
        ul(K.drain) + P(`Deal <strong>light</strong> ${K.dark}&nbsp;damage to one creature, with a <strong>50%</strong> chance to inflict ${K.bleed}. The healing ignores ${K.zombie}.`), {
          action_keywords: "drain", ...rider("Chomp", [["Bleed", 50]]),
        }),
      spell(A, IDS.HUN_BANE, "Bane", { a1: "WLP", a2: "WLP", check: 0, dmg: 0, el: "Dark", cost: "20 MP" },
        P(`Deal <strong>light</strong> ${K.dark}&nbsp;damage to one creature and inflict ${K.bane}.`), rider("Bane", [["Bane", 100]])),
      active(A, IDS.HUN_THIRST, "Thirst", { target: "One Creature", range: "Any" },
        P(`One creature makes a 【WLP + WLP】 check against <strong>10</strong>. On a failure, it becomes ${K.berserk}.`), {
          on_activate_effect_ref: "th_chain",
          effect_table: {
            "0": { $deleted: false, effect_kind: "chain", effect_label: "th_chain", chain_steps: "th_save,th_berserk" },
            "1": { $deleted: false, effect_kind: "save_check", effect_label: "th_save", save_attr1: "wlp", save_attr2: "wlp", save_dl: "10", save_mode: "interactive", target_ref: "action_targets" },
            "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "th_berserk", ae_template_ref: "Berserk", target_ref: "save_failed_targets", ae_duplicate_mode: "skip" },
          },
        }),
      passive(A, IDS.HUN_ETHEREAL, "Ethereal", P(`${K.physical}&nbsp;actions have no effect on this creature.`)),
      passive(A, IDS.HUN_UNDEAD, "Undead", P(`This creature is always ${K.zombie}.`), {
        isReaction: true, ...NOPOLY,
        reaction_config_table: { "0": { $deleted: false, reaction_trigger: "conflict_start", reaction_source: "", reaction_passive_mode: "force", reaction_effect_ref: "und_z" } },
        effect_table: { "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "und_z", ae_template_ref: "Zombie", target_ref: "self", ae_duplicate_mode: "skip" } },
      }),
      // Every creature's turn start; TARGET_* reads the creature whose turn it is.
      passive(A, IDS.HUN_STARVE, "Starvation", ul(trig(`a creature that is ${K.enraged}&nbsp;or ${K.berserk}&nbsp;starts its turn`)) + P(`It loses a quarter of its current Hit Points.`), {
        isReaction: true, ...NOPOLY,
        reaction_config_table: { "0": { $deleted: false, reaction_trigger: "turn_start", reaction_source: "", reaction_passive_mode: "force", condition_formula: "IS_NPC == 1 && (TARGET_AE_COUNT_BERSERK + TARGET_AE_COUNT_ENRAGED) > 0 && TARGET_CURRENT_HP > 0", reaction_effect_ref: "starve" } },
        effect_table: { "0": { $deleted: false, effect_kind: "deal_damage", effect_label: "starve", damage_amount: "floor(TARGET_CURRENT_HP / 4)", damage_element: "elementless", damage_ignore_affinity: true, damage_cause: "hazard", damage_verbosity: "full", attacker_name: "Starvation", target_ref: "trigger_subject" } },
      }),
      passive(A, IDS.HUN_INSATIABLE, "Insatiable",
        ul(trig(`this creature is in ${K.crisis}&nbsp;and misses with Chomp`)) + P(`It attacks with Chomp once more.`), {
          isReaction: true,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_completes_attack", reaction_source: "self", reaction_source_skill: "Chomp", reaction_passive_mode: "force", reaction_max_per_round: "1", condition_formula: "HIT_COUNT == 0 && HAS_STATUS_CRISIS == 1", reaction_effect_ref: "ins_again" } },
          effect_table: { "0": { $deleted: false, effect_kind: "free_action", effect_label: "ins_again", action_ref: "Chomp", target_ref: "action_targets", max_mp_cost: "0" } },
        }),
    ];
    out.push({
      A, name: "Hunger", art: BEST + "Hunger.png", scale: 1.5, tags: [],
      props: {
        level: "27", npc_rank: "soldier", species: "UNDEAD", subtype_list: "SPIRIT", attribute: "DARK", traits: "Undead, Spirit, Ravenous",
        dex_base: "6", ins_base: "8", mig_base: "10", wlp_base: "10", def_mod: "+2", mdef_mod: "+2", defense: 8, magic_defense: 10,
        max_hp: "80", current_hp: "80", max_mp: "60", current_mp: "60", init: "6",
        affinity_1: "IM", affinity_4: "RS", affinity_8: "VU", affinity_9: "IM",
        condition_poisoned: "IM", condition_grappled: "IM", condition_envenomed: "IM", condition_burn: "IM", condition_bleed: "IM",
        condition_despair: "IM", condition_doom: "IM", condition_bane: "IM", condition_curse: "IM",
        study_text: "<p>A starving spirit from the peaks of Mt. Elbrus. It drives whatever it touches into a frenzy, then feeds on the fury.</p>",
      },
      items,
      pattern: pattern([["Bane", "mp", 34, 100, 8], ["Thirst", "random", 30, "", 5], ["Chomp", "always", 0, 100, 2]]),
    });
  }

  // ── CRAZY MERMAN — Lv20 soldier, Humanoid/Aquatic, ice ─────────────────
  {
    const A = IDS.MER;
    const items = [
      atk(A, IDS.MER_SLAP, "Tuna Slap", { a1: "MIG", a2: "MIG", check: 1, dmg: 10, el: "Physical" },
        P(`Deal <strong>light</strong> ${K.physical}&nbsp;damage to one creature, with a <strong>70%</strong> chance to inflict ${K.dazed}.`), rider("Tuna Slap", [["Dazed", 70]])),
      atk(A, IDS.MER_GUARD, "Guard Breaker", { a1: "MIG", a2: "MIG", check: 3, dmg: 0, el: "Physical" },
        P(`Deal <strong>light</strong> ${K.physical}&nbsp;damage to one creature and inflict ${K.stagger}.`), rider("Guard Breaker", [["Stagger", 100]])),
      // Legacy "Stun" (user 2026-11-12): NOT a status — "remove 1 turn activation
      // from the target", like Stop. Built into Bash only (Maids Pocketwatch's
      // modify_turns -1), behind a 25% chance row.
      spell(A, IDS.MER_BASH, "Bash", { a1: "MIG", a2: "MIG", check: 0, dmg: 15, el: "Physical", cost: "20 MP" },
        P(`Deal <strong>light</strong> ${K.physical}&nbsp;damage to one creature, with a <strong>25%</strong> chance that it loses <strong>1</strong> turn this round.`), {
          isReaction: true,
          reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_source_skill: "Bash", reaction_passive_mode: "force", reaction_effect_ref: "bash_roll" } },
          effect_table: {
            "0": { $deleted: false, effect_kind: "chance", effect_label: "bash_roll", chance_percent: "25", chance_then_ref: "bash_stun" },
            "1": { $deleted: false, effect_kind: "modify_turns", effect_label: "bash_stun", target_ref: "trigger_subject", turns_delta: "-1", turns_floor: "0" },
          },
        }),
      active(A, IDS.MER_RAGE, "Rage", { target: "Self" }, P(`This creature becomes ${K.berserk}.`), {
        on_activate_effect_ref: "rage",
        effect_table: { "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "rage", ae_template_ref: "Berserk", target_ref: "self", ae_duplicate_mode: "skip" } },
      }),
      passive(A, IDS.MER_CRAZY, "Craziness", P(`This creature ignores ${K.slow}, ${K.dazed}, ${K.weak}, Shaken, Poisoned and ${K.enraged}.`)),
    ];
    out.push({
      A, name: "Crazy Merman", art: BEST + "Crazy%20Merman_Standard.png", scale: 1.5, tags: ["aquatic"],
      props: {
        level: "20", npc_rank: "soldier", species: "HUMANOID", subtype_list: "AQUATIC", attribute: "ICE", traits: "Humanoid, Aquatic, Unhinged",
        dex_base: "8", ins_base: "6", mig_base: "12", wlp_base: "6", def_mod: "+2", mdef_mod: "+0", defense: 10, magic_defense: 6,
        max_hp: "80", current_hp: "80", max_mp: "50", current_mp: "50", init: "6",
        affinity_3: "VU", affinity_7: "RS",
        condition_slow: "IM", condition_dazed: "IM", condition_weak: "IM", condition_shaken: "IM", condition_poisoned: "IM", condition_enraged: "IM",
        study_text: "<p>A merman who lost his mind somewhere under the ice. He swings whatever fish is nearest, and nothing seems to slow him down.</p>",
      },
      items,
      pattern: pattern([["Rage", "random", 20, "", 11], ["Bash", "mp", 40, 100, 8], ["Guard Breaker", "random", 30, "", 5], ["Tuna Slap", "always", 0, 100, 2]]),
    });
  }

  // ── SCALDRA — Lv30 soldier, Beast/Aquatic (a lava shark), fire ─────────
  {
    const A = IDS.SCA;
    const items = [
      atk(A, IDS.SCA_CHOMP, "Swift Chomp", { a1: "MIG", a2: "DEX", check: 3, dmg: 25, el: "Physical" },
        P(`Always targets the creature with the lowest Hit Points. Deal ${K.physical}&nbsp;damage and inflict ${K.bleed}. If this defeats the target, this creature gains <strong>20</strong> ${K.shield}&nbsp;and acts again at once.`), {
          isReaction: true,
          reaction_config_table: {
            "0": { $deleted: false, reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_source_skill: "Swift Chomp", reaction_passive_mode: "force", reaction_effect_ref: "sc_bleed" },
            "1": { $deleted: false, reaction_trigger: "creature_defeated", reaction_source: "", reaction_passive_mode: "force", reaction_max_per_round: "1", condition_formula: "CAUSE_IS_SELF == 1 && SUBJECT_IS_SELF == 0", reaction_effect_ref: "sc_again" },
          },
          effect_table: {
            "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "sc_bleed", ae_template_ref: "Bleed", target_ref: "hit_action_targets", ae_duplicate_mode: "skip" },
            // Legacy "Fire Shield" (user 2026-11-12): Elemental Shields were cut to
            // plain "Shield"; Scaldra already has Fire IM, so it is an elementless 20.
            "1": { $deleted: false, effect_kind: "chain", effect_label: "sc_again", chain_steps: "sc_shield,sc_turn" },
            "2": { $deleted: false, effect_kind: "grant", effect_label: "sc_shield", grant_resource: "shield", grant_amount: "20", target_ref: "self" },
            "3": { $deleted: false, effect_kind: "modify_turns", effect_label: "sc_turn", target_ref: "self", turns_delta: "1", turns_floor: "0" },
          },
        }),
      // Unleash = activates once, automatically, at the start of the conflict
      // (Wandering Flame's Explosive Entrance pattern). A passive, not a Zero Power.
      passive(A, IDS.SCA_SHARK, "IT'S A SHARK!!!", ul(K.unleash) + P(`This creature attacks with Swift Chomp.`), {
        isReaction: true, ...NOPOLY,
        reaction_config_table: { "0": { $deleted: false, reaction_trigger: "conflict_start", reaction_source: "", reaction_passive_mode: "force", reaction_effect_ref: "shark_go" } },
        effect_table: { "0": { $deleted: false, effect_kind: "free_action", effect_label: "shark_go", action_ref: "Swift Chomp", max_mp_cost: "0" } },
      }),
      passive(A, IDS.SCA_WAVER, "Lava Waver", ul(trig(`this creature ends its turn`)) + P(`It slips under the lava and becomes ${K.hidden}.`), {
        isReaction: true,
        reaction_config_table: { "0": { $deleted: false, reaction_trigger: "turn_end", reaction_source: "", reaction_passive_mode: "force", condition_formula: "SUBJECT_IS_SELF == 1 && HAS_STATUS_CRISIS == 0", reaction_effect_ref: "wv_hide" } },
        effect_table: { "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "wv_hide", ae_template_ref: "Hidden", target_ref: "self", ae_duplicate_mode: "skip" } },
      }),
      passive(A, IDS.SCA_BLOOD, "Bloodlust", ul(trig(`this creature enters ${K.crisis}`)) + P(`It becomes ${K.berserk}&nbsp;and loses ${K.hidden}.`), {
        isReaction: true,
        reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_enter_crisis", reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: "bl_chain" } },
        effect_table: {
          "0": { $deleted: false, effect_kind: "chain", effect_label: "bl_chain", chain_steps: "bl_berserk,bl_unhide" },
          "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "bl_berserk", ae_template_ref: "Berserk", target_ref: "self", ae_duplicate_mode: "skip" },
          "2": { $deleted: false, effect_kind: "remove_ae", effect_label: "bl_unhide", ae_template_ref: "Hidden", include_persistent: true, count: "all", target_ref: "self" },
        },
      }),
    ];
    out.push({
      A, name: "Scaldra", art: BEST + "Scaldra.png", scale: 1.6, tags: ["lava"],
      props: {
        level: "30", npc_rank: "soldier", species: "BEAST", subtype_list: "AQUATIC", attribute: "FIRE", traits: "Beast, Aquatic, Volcanic, Predator",
        dex_base: "12", ins_base: "8", mig_base: "12", wlp_base: "6", def_mod: "+1", mdef_mod: "+5", defense: 13, magic_defense: 13,
        max_hp: "150", current_hp: "150", max_mp: "150", current_mp: "150", init: "6",
        affinity_2: "RS", affinity_5: "VU", affinity_6: "IM", affinity_7: "RS", affinity_9: "VU",
        condition_blind: "IM",
        study_text: "<p>A shark that lives around undersea volcanoes. It grows a hard, magma-like shell to survive the heat, and it swims through lava as easily as water.</p>",
      },
      items,
      pattern: pattern([["Swift Chomp", "always", 0, 100, 2, "lowest_hp"]]),
    });
  }
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────
const mode = process.argv[2] === "folder" ? "folder" : "actors";

if (mode === "folder") {
  run(async ({ changes }) => {
    if (await getByKey("folders", `!folders!${FOLDER_FORMS}`)) { console.log("folder already exists"); return; }
    const tpl = await getByKey("folders", `!folders!${FOLDER_TEMPLATE}`);
    if (!tpl) throw new Error("folder template missing");
    const f = JSON.parse(JSON.stringify(tpl));
    f._id = FOLDER_FORMS; f.name = "Polymorph Forms"; f.folder = FOLDER_MONSTER_ROOT; f.sort = 900000;
    if (f._stats) { f._stats.createdTime = null; f._stats.modifiedTime = null; }
    changes.push([`!folders!${FOLDER_FORMS}`, f, "NEW folder — The Legend of Dragonslayer / Monster / Polymorph Forms"]);
  }, "WWT polymorph forms — folder", "folders");
} else {
  run(async ({ changes }) => {
    if (!(await getByKey("folders", `!folders!${FOLDER_FORMS}`))) {
      if (process.argv.includes("--apply")) throw new Error("run the folder step first");
      console.log("(note: folder not created yet — run `folder --apply` before applying)");
    }
    const don = {
      actor: await getByKey("actors", `!actors!${D.DONOR_ACTOR}`),
      atk: await getByKey("actors", `!actors.items!${D.DONOR_ACTOR}.${D.DONOR_ATTACK}`),
      pas: await getByKey("actors", `!actors.items!${D.DONOR_ACTOR}.${D.DONOR_PASSIVE}`),
      spell: await getByKey("actors", `!actors.items!${D.DONOR_SPELL_ACTOR}.${D.DONOR_SPELL}`),
    };
    if (!don.actor || !don.atk || !don.pas || !don.spell) throw new Error("missing donor doc");
    for (const m of monsters(don)) {
      // --rebuild rewrites a built monster whole (the run keeps any authored
      // animation fields; backups are taken by run()).
      if (!process.argv.includes("--rebuild") && await getByKey("actors", `!actors!${m.A}`)) throw new Error(`${m.name} already built (${m.A}) — pass --rebuild`);
      const a = blankActor(don.actor, m.A, m.name, FOLDER_FORMS, m.art, m.scale);
      const p = a.system.props;
      Object.assign(p, {
        dex_current: Number(m.props.dex_base), ins_current: Number(m.props.ins_base),
        mig_current: Number(m.props.mig_base), wlp_current: Number(m.props.wlp_base),
        zenit_reward_min: String(Number(m.props.level) * 8), zenit_reward_max: String(Number(m.props.level) * 11),
      }, m.props, mirrors(m.A, m.items), { action_pattern_table: m.pattern });
      a.flags = a.flags ?? {};
      a.flags[NS] = { ...(a.flags[NS] ?? {}), polymorphTags: m.tags, wwtLegacySource: "fabula-ultima-2-archive (The Winterlands Witch Trials)" };
      a.items = m.items.map((i) => i._id);
      for (const it of m.items) {
        const aes = it._aes ?? [];
        delete it._aes;
        changes.push([`!actors.items!${m.A}.${it._id}`, it, `${m.name} / ${it.name} (${it.system.props.skill_type})`]);
        // Embedded AEs live at their own key; the item's effects[] lists their ids.
        for (const ae of aes) changes.push([`!actors.items.effects!${m.A}.${it._id}.${ae._id}`, ae, `${m.name} / ${it.name} / AE ${ae.name}`]);
      }
      changes.push([`!actors!${m.A}`, a, `NEW actor — ${m.name} (L${m.props.level} ${m.props.npc_rank}, ${m.props.species}${m.props.subtype_list ? "/" + m.props.subtype_list : ""}, tags: ${m.tags.join(",") || "-"})`]);
    }
  }, "WWT polymorph forms — six legacy monsters reconstructed");
}
