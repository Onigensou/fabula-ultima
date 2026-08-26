// Mist Dragon — L45 elite, Valley of the Dragon (Elemental/Dragon, Wind).
// A dragon-shaped fog. Its body is an illusion that shrugs off steel until the
// wind tears it open, and its repertoire is stolen: three Phantom Shift actions
// re-cast in Air, covering spike / spread / drain so it can fill whatever role
// the encounter is missing. Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_CURRENT_DUNGEON, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE, DONOR_SPELL_ACTOR, DONOR_SPELL, L, bullets, trig, ICON } = require("./_dragon-lib");
const { blankActor, run } = require("./_dragon-util");

const A = IDS.MIST;
const ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Mist%20Dragon_Standard.png";

const STUDY =
  "<p>Not a dragon so much as a dragon-shaped fog: steel goes clean through it, and every move " +
  "it makes it copied off something else on the field. The shape thins badly in a strong " +
  "<strong>wind</strong>.</p>";

const DESC = {
  claw: `<p>Deal ${L.air}&nbsp;damage to one creature.</p>`,
  breath: `<p>Deal <strong>heavy</strong> ${L.air}&nbsp;damage, with a <strong>50%</strong> chance to leave each creature ${L.blind}.</p>`,
  illusory: bullets(trig(`the Mist Dragon suffers ${L.air}&nbsp;damage`)) +
    `<p>Its body is a suggestion, not a thing — blades find nothing to bite. The wind scatters the shape until the <strong>end of the round</strong>, and it gathers again.</p>`,
  phantom: `<p>The mist has no moves of its own. It wears the shapes of whatever else walks the valley, and everything it borrows comes back through in ${L.air}.</p>`,
  psStrike: `<p>Deal <strong>heavy</strong> ${L.air}&nbsp;damage to one creature, with a <strong>40%</strong> chance to inflict ${L.blind}.</p>`,
  psSpines: bullets(`${L.multi}<strong>&nbsp;2</strong>`) +
    `<p>Deal <strong>light</strong> ${L.air}&nbsp;damage, with a <strong>50%</strong> chance to leave each creature ${L.blind}.</p>`,
  psStinger: `<p>Deal ${L.air}&nbsp;damage to one creature and drain a fifth of its Mind Points — the theft strikes harder against a full mind.</p>`,
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const dSpell = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dPas || !dSpell) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const aek = (item, ae) => `!actors.items.effects!${A}.${item}.${ae}`;

  const skill = (src, id, name, img, props) => {
    const d = JSON.parse(JSON.stringify(src));
    d._id = id; d.name = name; d.img = img; d.effects = [];
    d.folder = null; d.ownership = { default: 0 };
    for (const k of ["reaction_config_table", "effect_table", "optional_params", "active_effect_config_table"]) {
      d.system.props[k] = {};
    }
    Object.assign(d.system.props, {
      name, img, id: "${item.id}", uuid: `Actor.${A}.Item.${id}`,
      check_bonus: "8", level: "1", max_level: "1", class: "NPC",
      ae_chance_percent: "", ae_template_ref: "", on_activate_effect_ref: "",
    }, props);
    return d;
  };

  // The house idiom for an on-hit status rider: fire on the per-target
  // creature_deals_damage, scope it to this one skill by name, and let
  // ae_chance_percent roll per hit target. Proven on a 3-target attack
  // (Obsidrax's Venomstone Spines).
  const blindRider = (skillName, percent) => ({
    reaction_config_table: {
      "0": {
        reaction_trigger: "creature_deals_damage", reaction_source: "self",
        reaction_source_skill: skillName, reaction_passive_mode: "force",
        reaction_effect_ref: "blind_rider",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
    },
    effect_table: {
      "0": { effect_kind: "apply_ae", effect_label: "blind_rider", ae_template_ref: "Blind",
             target_ref: "hit_action_targets", ae_duplicate_mode: "skip", ae_chance_percent: String(percent) },
    },
  });

  // ── Mist Claw — bread and butter ────────────────────────────────────────
  changes.push([ik(IDS.MD_CLAW), skill(dAtk, IDS.MD_CLAW, "Mist Claw", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "WLP",
    damage_bonus: "18", type_damage: "Air", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.claw,
  }), "NEW item — Mist Claw"]);

  // ── Mist Breath — its own AoE. An NPC Spell must carry BOTH
  // isOffensiveSpell and isCheck or the attack picker never offers it.
  // 50 MP of a 100 max keeps the action-pattern gate on clean percentages
  // (100 / 50 / 0), so there is no dead band where the row passes but the
  // feasibility check fails.
  changes.push([ik(IDS.MD_BREATH), skill(dSpell, IDS.MD_BREATH, "Mist Breath", ICON.ospell, {
    skill_type: "Spell", skill_target: "Up to three creatures", skill_range: "Any",
    rolled_atr1: "WLP", rolled_atr2: "WLP",
    damage_bonus: "38", type_damage: "Air", defense_target_type: "mdef",
    isCheck: true, isOffensiveSpell: true, isReaction: false,
    cost: "50 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.breath,
    ...blindRider("Mist Breath", 50),
  }), "NEW item — Mist Breath (Air AoE, 50% Blind)"]);

  // ── Illusory Form — the mist body ───────────────────────────────────────
  // Physical Resistance lives on an AE rather than on the actor's affinity_1,
  // precisely so it can be STRIPPED. `aeAffinityFloor` is the house idiom (~14
  // effects use it) and preserves any native IM/AB. Air is this monster's VU,
  // so the element that answers it is also the element that opens it — the
  // same shape as the RAW Flying skill.
  const illusory = skill(dPas, IDS.MD_ILLUSORY, "Illusory Form", ICON.reaction, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    damage_bonus: "0", type_damage: "", check_bonus: "0", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.illusory,
    reaction_config_table: {
      "0": {
        reaction_trigger: "conflict_start", reaction_source: "",
        reaction_passive_mode: "force", reaction_effect_ref: "mist_gather",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
      // Re-gathers at the end of every round, so a strip lasts exactly the
      // rest of that round. ae_duplicate_mode "skip" makes this a no-op on a
      // round where nobody tore it open.
      "1": {
        reaction_trigger: "round_end", reaction_source: "",
        reaction_passive_mode: "force", reaction_effect_ref: "mist_gather",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
      // `creature_takes_damage` is dead on an item; the resource ledger is the
      // observer-aware trigger that carries `element`.
      "2": {
        reaction_trigger: "creature_lose_resource", reaction_resource_filter: "hp",
        reaction_source: "", reaction_cause_filter: "",
        reaction_passive_mode: "force",
        condition_formula: "SUBJECT_IS_SELF == 1 && TRIGGER_DAMAGE_IS_AIR == 1",
        reaction_effect_ref: "mist_scatter",
      },
    },
    effect_table: {
      "0": { effect_kind: "apply_ae", effect_label: "mist_gather", ae_template_ref: "Illusory Form",
             target_ref: "self", ae_duplicate_mode: "skip" },
      // include_persistent is mandatory against a persistent_counter AE, or
      // this removes nothing and never errors.
      "1": { effect_kind: "remove_ae", effect_label: "mist_scatter", ae_template_ref: "Illusory Form",
             include_persistent: true, count: "all", target_ref: "self" },
    },
  });
  illusory.effects = [IDS.MD_ILLUSORY_AE];
  changes.push([ik(IDS.MD_ILLUSORY), illusory, "NEW item — Illusory Form (RS Physical, stripped by Air)"]);

  changes.push([aek(IDS.MD_ILLUSORY, IDS.MD_ILLUSORY_AE), {
    _id: IDS.MD_ILLUSORY_AE, name: "Illusory Form",
    img: ICON.reaction, icon: ICON.reaction,
    transfer: false, disabled: false, statuses: [],
    // Bare prop name, mode 5 (OVERRIDE). affinity_1 = Physical.
    changes: [{ key: "affinity_1", mode: 5, priority: 3, value: 'aeAffinityFloor("RS")' }],
    description: "<p>The body is a suggestion. Blades find nothing to bite.</p>",
    duration: {}, origin: `Actor.${A}.Item.${IDS.MD_ILLUSORY}`,
    system: { tags: ["illusory-form"] },
    flags: { "fabula-ultima-companion": { crossScene: false, charges: 1, lifetimeMode: "persistent_counter" } },
  }, "NEW AE — Illusory Form (affinity_1 -> RS)"]);

  // ── Phantom Shift — the identity, always on, no trigger ─────────────────
  // Genuinely always-on, so it gets NO Trigger bullet — the keyword is only for
  // a passive that fires on a condition.
  changes.push([ik(IDS.MD_PHANTOM), skill(dPas, IDS.MD_PHANTOM, "Phantom Shift", ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    damage_bonus: "0", type_damage: "", check_bonus: "0", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.phantom,
  }), "NEW item — Phantom Shift (identity passive)"]);

  // ── The borrowed repertoire — spike / spread / drain ────────────────────
  changes.push([ik(IDS.MD_PS_STRIKE), skill(dAtk, IDS.MD_PS_STRIKE, "Phantom Shift: Thunder Strike", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    damage_bonus: "30", type_damage: "Air", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.psStrike,
    ...blindRider("Phantom Shift: Thunder Strike", 40),
  }), "NEW item — Phantom Shift: Thunder Strike"]);

  changes.push([ik(IDS.MD_PS_SPINES), skill(dAtk, IDS.MD_PS_SPINES, "Phantom Shift: Venomstone Spines", ICON.range, {
    skill_type: "Attack", skill_target: "Up to three creatures", skill_range: "Range",
    rolled_atr1: "INS", rolled_atr2: "MIG",
    damage_bonus: "14", type_damage: "Air", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "multi", description: DESC.psSpines,
    ...blindRider("Phantom Shift: Venomstone Spines", 50),
  }), "NEW item — Phantom Shift: Venomstone Spines"]);

  // Mana Ray's pattern verbatim, re-cast in Air. adjust_damage resolves against
  // the CASTER, so the victim's pool must be read through the payload-scoped
  // TARGET_* family; the burn is capped at what the victim actually holds.
  changes.push([ik(IDS.MD_PS_STINGER), skill(dAtk, IDS.MD_PS_STINGER, "Phantom Shift: Mana Stinger", ICON.range, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Range",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    damage_bonus: "20", type_damage: "Air", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.psStinger,
    reaction_config_table: {
      "0": {
        reaction_trigger: "creature_will_deal_damage", reaction_source: "self",
        reaction_source_skill: "Phantom Shift: Mana Stinger", reaction_passive_mode: "force",
        reaction_effect_ref: "stinger_bonus",
      },
      "1": {
        reaction_trigger: "creature_deals_damage", reaction_source: "self",
        reaction_source_skill: "Phantom Shift: Mana Stinger", reaction_passive_mode: "force",
        reaction_effect_ref: "stinger_burn",
      },
    },
    effect_table: {
      "0": { effect_kind: "adjust_damage", effect_label: "stinger_bonus",
             damage_operation: "add", damage_stage: "outgoing",
             damage_amount: "min(ceil(TARGET_MAX_MP * 0.2), TARGET_CURRENT_MP)" },
      "1": { effect_kind: "deal_damage", effect_label: "stinger_burn",
             damage_resource: "mp", damage_verbosity: "full", target_ref: "trigger_subject",
             damage_amount: "min(ceil(TARGET_MAX_MP * 0.2), TARGET_CURRENT_MP)" },
    },
  }), "NEW item — Phantom Shift: Mana Stinger"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Mist Dragon", FOLDER_CURRENT_DUNGEON, ART, 2.2);
  const p = a.system.props;
  Object.assign(p, {
    level: "45", npc_rank: "elite", species: "ELEMENTAL", subtype_list: "DRAGON",
    attribute: "WIND",
    traits: "Illusive, Elemental Creature, Mimicry, Territorial",
    dex_base: "10", ins_base: "10", mig_base: "12", wlp_base: "12",
    dex_current: 10, ins_current: 10, mig_current: 12, wlp_current: 12,
    def_mod: "+4", mdef_mod: "+3", defense: 14, magic_defense: 13,
    max_hp: "200", current_hp: "200", max_mp: "100", current_mp: "100",
    init: "10", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "400", zenit_reward_max: "550",
    study_text: STUDY,
    // affinity_1 (Physical) stays NA here on purpose — the Resistance is the
    // Illusory Form AE, so it can be torn off. Exactly one VU: Air.
    affinity_2: "VU",
    affinity_9: "IM",
    // Elemental house rule
    condition_poisoned: "IM", condition_envenomed: "IM", condition_zombie: "IM",
    // nothing to grab, nothing to petrify
    condition_grappled: "IM", condition_petrify: "IM",
    arcane_ef: "150", bow_ef: "75",
  });

  p.attack_list = {
    [IDS.MD_CLAW]: { name: "Mist Claw", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MD_CLAW}`,
                     active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "WLP",
                     attack_description: DESC.claw, roll: "" },
    [IDS.MD_PS_STRIKE]: { name: "Phantom Shift: Thunder Strike", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MD_PS_STRIKE}`,
                     active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "MIG",
                     attack_description: DESC.psStrike, roll: "" },
    [IDS.MD_PS_SPINES]: { name: "Phantom Shift: Venomstone Spines", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MD_PS_SPINES}`,
                     active_target: "Up to three creatures", attribute_die1: "INS", attribute_die2: "MIG",
                     attack_description: DESC.psSpines, roll: "" },
    [IDS.MD_PS_STINGER]: { name: "Phantom Shift: Mana Stinger", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MD_PS_STINGER}`,
                     active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "MIG",
                     attack_description: DESC.psStinger, roll: "" },
  };
  // Spells go in normal_spell_list even when offensive — there is no separate
  // NPC offensive list (that key is PC-only).
  p.normal_spell_list = {
    [IDS.MD_BREATH]: { name: "Mist Breath", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MD_BREATH}`,
                       cost: "50 MP", spell_target: "Up to three creatures", duration: "Instantaneous",
                       spell_description: DESC.breath, roll: "" },
  };
  p.skill_passive_list = {
    [IDS.MD_ILLUSORY]: { name: "Illusory Form", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MD_ILLUSORY}`,
                         passive_description: DESC.illusory, roll: "" },
    [IDS.MD_PHANTOM]: { name: "Phantom Shift", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MD_PHANTOM}`,
                        passive_description: DESC.phantom, roll: "" },
  };

  // Breath (8) sits INSIDE the window rather than above it, so an armed cast is
  // a 50/33/17 against the two nearest mimics instead of a guaranteed repeat —
  // an exclusive row could not be broken up by a cooldown anyway (cooldown is
  // evaluated after the priority window). Once MP is spent the mimic trio at
  // 7/6/5 takes over on the same 50/33/17 weights, and Mist Claw (2) is the
  // floor when all three random rolls miss (~9% of turns).
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Mist Breath", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "50", action_pattern_value_2: "100",
           action_pattern_priority: "8", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Phantom Shift: Thunder Strike", action_pattern_condition: "random",
           action_pattern_string: "", action_pattern_value_1: "55", action_pattern_value_2: "",
           action_pattern_priority: "7", action_pattern_target_focus: "lowest_hp",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Phantom Shift: Venomstone Spines", action_pattern_condition: "random",
           action_pattern_string: "", action_pattern_value_1: "55", action_pattern_value_2: "",
           action_pattern_priority: "6", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "3": { $deleted: false, action_pattern_name: "Phantom Shift: Mana Stinger", action_pattern_condition: "random",
           action_pattern_string: "", action_pattern_value_1: "55", action_pattern_value_2: "",
           action_pattern_priority: "5", action_pattern_target_focus: "highest_hp",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "4": { $deleted: false, action_pattern_name: "Mist Claw", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "2", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.MD_CLAW, IDS.MD_BREATH, IDS.MD_ILLUSORY, IDS.MD_PHANTOM,
             IDS.MD_PS_STRIKE, IDS.MD_PS_SPINES, IDS.MD_PS_STINGER];
  changes.push([`!actors!${A}`, a, "NEW actor — Mist Dragon (L45 elite, Elemental/Dragon, Wind)"]);
});
