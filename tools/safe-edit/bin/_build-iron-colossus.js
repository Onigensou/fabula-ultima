// Iron Colossus — L52 elite, Fafnir Castle (Construct / Golem, Earth).
// The tank. It is deliberately OFF the Threat-Point curve for an Elite (~4.4 TP
// where an Elite is nominally 1.5) because it is budgeted in the other
// currency: a monster that eats party actions by existing. Gigas (800 HP at
// L45) is the shipped precedent for the archetype. Its DPS stat is cheap on
// purpose — per the balance doc, "never build a low-HP monster with a big
// damage number", and the inverse holds too: a wall does not also get to be a
// blender. Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, bullets, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.IC;

const STUDY =
  "<p>Palace ordnance, not palace guard. It was walled into the throne approach some centuries before " +
  "anyone currently alive, and it has been standing in the dark waiting for the door to open ever since. " +
  "There is a seam under the left pauldron where the lightning conduit was never finished.</p>";

const DESC = {
  fist: `<p>Deal ${L.physical}&nbsp;damage to one creature.</p>`,
  stomp:
    bullets(`${L.multi}<strong>&nbsp;3</strong>`) +
    `<p>Deal <strong>light</strong> ${L.earth}&nbsp;damage. The floor of the approach was not built for this.</p>`,
  quake:
    `<p>Deal <strong>light</strong> ${L.earth}&nbsp;damage to all enemies, and the ground stops cooperating.</p>`,
  plate:
    "<p>Centuries of palace armour, layered and re-layered. Every blow that reaches the Iron Colossus " +
    "arrives smaller than it left.</p>",
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dPas || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Siege Fist — bread and butter ───────────────────────────────────────
  changes.push([ik(IDS.IC_FIST), skill(dAtk, IDS.IC_FIST, "Siege Fist", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "MIG",
    check_bonus: "5", damage_bonus: "34", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.fist,
  }), "NEW item — Siege Fist"]);

  // ── Seismic Stomp — spread chip ─────────────────────────────────────────
  // "Up to three creatures" is the canonical multi-target wording; the target
  // planner reads the count straight out of it.
  changes.push([ik(IDS.IC_STOMP), skill(dAtk, IDS.IC_STOMP, "Seismic Stomp", ICON.melee, {
    skill_type: "Attack", skill_target: "Up to three creatures", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "DEX",
    check_bonus: "3", damage_bonus: "16", type_damage: "Earth", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "multi", description: DESC.stomp,
  }), "NEW item — Seismic Stomp (Multi 3)"]);

  // ── Grinding Quake — the room-wide beat ────────────────────────────────
  // An offensive Spell so it rolls against MDEF instead of DEF: the Colossus
  // has exactly one way to reach a PC who has invested in armour, and this is
  // it. An NPC Spell needs BOTH isOffensiveSpell and isCheck or the attack
  // picker will not offer it.
  changes.push([ik(IDS.IC_QUAKE), skill(dSpl, IDS.IC_QUAKE, "Grinding Quake", ICON.ospell, {
    skill_type: "Spell", skill_target: "All Enemies", skill_range: "Any",
    rolled_atr1: "MIG", rolled_atr2: "WLP",
    check_bonus: "4", damage_bonus: "20", type_damage: "Earth", defense_target_type: "mdef",
    isCheck: true, isOffensiveSpell: true, isReaction: false,
    cost: "30 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.quake,
  }), "NEW item — Grinding Quake (all enemies, Earth)"]);

  // ── Adamant Plating — display passive over a sheet-level rule ───────────
  // Backed by `damage_receiving_mod_all: 12` on the actor, which BD honours as
  // flat incoming reduction (skill-formulas.js addFlat "Reduction (All)") and
  // which three PCs already use. A reaction row would be a second, divergent
  // source of truth for the same number, so there isn't one.
  //
  // Note this is exactly what `crush` exists to beat — Hilde-Fafnir's Lance of
  // Ruin and the Death Gazer's Gaze both carry it, so neither is quietly
  // blunted by 12 points of plating if the Colossus is ever a target.
  changes.push([ik(IDS.IC_PLATE), skill(dPas, IDS.IC_PLATE, "Adamant Plating", ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.plate,
  }), "NEW item — Adamant Plating (passive)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Iron Colossus", FOLDER_FAFNIR, ART.IC, SCALE.IC);
  const p = a.system.props;
  Object.assign(p, {
    level: "52", npc_rank: "elite", species: "CONSTRUCT", subtype_list: "GOLEM",
    attribute: "EARTH",
    traits: "Tireless, Literal, Sealed In, Older Than the Dynasty",
    dex_base: "6", ins_base: "6", mig_base: "12", wlp_base: "8",
    dex_current: 6, ins_current: 6, mig_current: 12, wlp_current: 8,
    def_mod: "+8", mdef_mod: "+2", defense: 14, magic_defense: 8,
    max_hp: "700", current_hp: "700", max_mp: "60", current_mp: "60",
    // Low init is part of the design — the party gets to act into the wall
    // before the wall acts, so the round-one decision is theirs to make.
    init: "6", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "320", zenit_reward_max: "450",
    study_text: STUDY,
    // Construct species grants IM poison damage + poisoned and RS earth for
    // free; both are written explicitly rather than left to be inferred.
    // Bolt is the VU — the unfinished conduit in the study text is the tell.
    affinity_9: "IM", affinity_5: "RS", affinity_1: "RS", affinity_3: "VU",
    condition_poisoned: "IM", condition_envenomed: "IM", condition_zombie: "IM",
    // A machine feels no fear and cannot be reasoned with. Leaves slow/weak/
    // dazed open — Slow on a 6-init wall is genuinely strong, and should be.
    condition_shaken: "IM", condition_enraged: "IM", condition_frightened: "IM",
    condition_charm: "IM", condition_confused: "IM",
    heavy_ef: "150", dagger_ef: "50",
    // The Adamant Plating passive, as a rule rather than as prose.
    damage_receiving_mod_all: 12,
  });

  p.attack_list = {
    [IDS.IC_FIST]: { name: "Siege Fist", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IC_FIST}`,
                     active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "MIG",
                     attack_description: DESC.fist, roll: "" },
    [IDS.IC_STOMP]: { name: "Seismic Stomp", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IC_STOMP}`,
                      active_target: "Up to three creatures", attribute_die1: "MIG", attribute_die2: "DEX",
                      attack_description: DESC.stomp, roll: "" },
  };
  p.normal_spell_list = {
    [IDS.IC_QUAKE]: { name: "Grinding Quake", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IC_QUAKE}`,
                      cost: "30 MP", spell_target: "All Enemies", duration: "Instantaneous",
                      spell_description: DESC.quake, roll: "" },
  };
  p.skill_passive_list = {
    [IDS.IC_PLATE]: { name: "Adamant Plating", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IC_PLATE}`,
                      passive_description: DESC.plate, roll: "" },
  };

  // 60 MP pool, 30 per Quake — a clean multiple, so the percentages land on
  // 100/50/0 with no dead gap. `51-100` therefore means "twice, then done",
  // and the two windows below cover every state after that.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Grinding Quake", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "51", action_pattern_value_2: "100",
           action_pattern_priority: "9", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "2", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Seismic Stomp", action_pattern_condition: "random",
           action_pattern_string: "", action_pattern_value_1: "40", action_pattern_value_2: "",
           action_pattern_priority: "5", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Siege Fist", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "2", action_pattern_target_focus: "highest_hp",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.IC_FIST, IDS.IC_STOMP, IDS.IC_QUAKE, IDS.IC_PLATE];
  changes.push([`!actors!${A}`, a, "NEW actor — Iron Colossus (L52 elite, Construct/Golem, Earth)"]);
}, "fafnir-castle: Iron Colossus");
