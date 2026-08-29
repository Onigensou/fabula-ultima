// Dire Orc — L50 soldier, Fafnir Castle (Monster / Demi-human, Earth).
// A midrange bruiser: fat enough to deliver its damage over three or four
// turns, and it hits harder the closer it gets to dying. Run from
// tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, bullets, trig, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.DO;

const STUDY =
  "<p>The palace guard were not recruited so much as <strong>grown</strong> — fed on whatever the lower halls " +
  "produced until the armour stopped fitting. They do not hold a line and they do not fall back. " +
  "Hurt one and it gets worse, which is the entire trick and it still works.</p>";

const DESC = {
  cleave: `<p>Deal ${L.physical}&nbsp;damage to one creature.</p>`,
  split:
    bullets(`${L.pierce}`) +
    `<p>Deal <strong>heavy</strong> ${L.physical}&nbsp;damage to one creature. Armour is not really the point.</p>`,
  howl:
    `<p>The Dire Orc bellows. All enemies are inflicted with ${L.shaken}.</p>`,
  fury:
    bullets(trig("the Dire Orc is at half Hit Points or below")) +
    `<p>Pain is the only instruction it has ever understood. Everything it does lands harder.</p>`,
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dPas || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Cleaver — bread and butter ──────────────────────────────────────────
  changes.push([ik(IDS.DO_CLEAVE), skill(dAtk, IDS.DO_CLEAVE, "Cleaver", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "DEX",
    check_bonus: "5", damage_bonus: "38", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.cleave,
  }), "NEW item — Cleaver"]);

  // ── Skull Splitter — the swing that punishes standing still ─────────────
  // Pierce does two things (only the first is documented in the journal):
  // a MISS still lands 50%, and the target's RS is downgraded to NE. The
  // second is what keeps a physical-resistant PC under real pressure.
  changes.push([ik(IDS.DO_SPLIT), skill(dAtk, IDS.DO_SPLIT, "Skull Splitter", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "MIG",
    check_bonus: "3", damage_bonus: "58", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "pierce", description: DESC.split,
  }), "NEW item — Skull Splitter (Pierce)"]);

  // ── War Howl — the "midrange" half of the bruiser ───────────────────────
  // An Active, not a Spell: no accuracy roll, the status just lands. Shaken
  // shrinks WLP, which is what the Succubus's Charm and the Death Gazer's
  // Gaze both roll against — the roster's debuffs stack on purpose.
  changes.push([ik(IDS.DO_HOWL), skill(dSpl, IDS.DO_HOWL, "War Howl", ICON.passive, {
    skill_type: "Active", skill_target: "All Enemies", skill_range: "Any",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "mdef",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "20 MP", duration: "3 Rounds", details_roller: "Show",
    action_keywords: "", description: DESC.howl,
    on_activate_effect_ref: "do_howl",
    effect_table: {
      "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "do_howl",
             ae_template_ref: "Shaken", target_ref: "action_targets",
             ae_duplicate_mode: "replace" },
    },
  }), "NEW item — War Howl (Shaken to all enemies)"]);

  // ── Brutish Fury — a Crisis Effect, the official NPC design tool ────────
  // Rides `creature_will_deal_damage` (pre-resolve, per-target, AFTER COMPUTE
  // locks rawDamage but BEFORE the card commits) so the bonus shows up in the
  // card's damage preview instead of surprising the player after the fact.
  // Same shape as Drakoza's Thrash, minus the `reaction_source_skill` filter —
  // omitting it is what makes this apply to the Orc's whole kit rather than to
  // one named attack.
  //
  // `adjust_damage`, NOT `add_damage`: that kind is RETIRED and fails twice
  // silently — the accumulator only matches adjust_damage/outgoing, and the
  // kind is absent from EFFECT_KIND_DISPATCH so the chain would abort on it.
  changes.push([ik(IDS.DO_FURY), skill(dPas, IDS.DO_FURY, "Brutish Fury", ICON.reaction, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.fury,
    reaction_config_table: {
      "0": { $deleted: false, reaction_trigger: "creature_will_deal_damage",
             reaction_source: "self", reaction_source_skill: "",
             reaction_passive_mode: "force",
             condition_formula: "CUR_HP * 2 <= MAX_HP",
             reaction_effect_ref: "do_rage",
             reaction_cause_filter: "", reaction_resource_filter: "" },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "do_rage",
             damage_operation: "add", damage_stage: "outgoing", damage_amount: "25" },
    },
  }), "NEW item — Brutish Fury (crisis: +25 outgoing)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Dire Orc", FOLDER_FAFNIR, ART.DO, SCALE.DO);
  const p = a.system.props;
  Object.assign(p, {
    level: "50", npc_rank: "soldier", species: "MONSTER", subtype_list: "DEMI-HUMAN",
    attribute: "EARTH",
    traits: "Belligerent, Overfed, Scarred Over, Obeys the Palace",
    dex_base: "8", ins_base: "6", mig_base: "12", wlp_base: "6",
    dex_current: 8, ins_current: 6, mig_current: 12, wlp_current: 6,
    def_mod: "+2", mdef_mod: "+0", defense: 10, magic_defense: 6,
    // 240 HP = ~1.5 TP. Well clear of the ~130 one-spike floor, which is the
    // point: a bruiser's damage stat is only worth paying for if it survives
    // long enough to spend it, and this one is meant to deliver over 3-4 turns.
    max_hp: "240", current_hp: "240", max_mp: "40", current_mp: "40",
    init: "7", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "100", zenit_reward_max: "140",
    study_text: STUDY,
    affinity_5: "RS", affinity_7: "VU",
    // A wall of meat with no mind to shake. Leaves slow/weak/poisoned/dazed
    // open — Slow is the clean answer to a bruiser that gets worse over time.
    condition_shaken: "IM", condition_enraged: "IM", condition_frightened: "IM",
    heavy_ef: "175", arcane_ef: "60",
  });

  p.attack_list = {
    [IDS.DO_CLEAVE]: { name: "Cleaver", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DO_CLEAVE}`,
                       active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "DEX",
                       attack_description: DESC.cleave, roll: "" },
    [IDS.DO_SPLIT]: { name: "Skull Splitter", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DO_SPLIT}`,
                      active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "MIG",
                      attack_description: DESC.split, roll: "" },
  };
  p.skill_active_list = {
    [IDS.DO_HOWL]: { name: "War Howl", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DO_HOWL}`,
                     active_target: "All Enemies", active_cost: "20 MP", active_duration: "3 Rounds",
                     active_description: DESC.howl, roll: "" },
  };
  p.skill_passive_list = {
    [IDS.DO_FURY]: { name: "Brutish Fury", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DO_FURY}`,
                     passive_description: DESC.fury, roll: "" },
  };

  // War Howl is the opener — MP 50-100 means it fires while the 40-point pool
  // is at least half full, which with a 20 MP cost is "twice, then never".
  // Skull Splitter at 5 excludes Cleaver at 2, so `random 45` reads as an exact
  // 45/55 rather than a weight-skewed split dragged around by anti-repeat.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "War Howl", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "50", action_pattern_value_2: "100",
           action_pattern_priority: "8", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "3", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Skull Splitter", action_pattern_condition: "random",
           action_pattern_string: "", action_pattern_value_1: "45", action_pattern_value_2: "",
           action_pattern_priority: "5", action_pattern_target_focus: "lowest_hp",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Cleaver", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "2", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.DO_CLEAVE, IDS.DO_SPLIT, IDS.DO_HOWL, IDS.DO_FURY];
  changes.push([`!actors!${A}`, a, "NEW actor — Dire Orc (L50 soldier, Monster/Demi-human, Earth)"]);
}, "fafnir-castle: Dire Orc");
