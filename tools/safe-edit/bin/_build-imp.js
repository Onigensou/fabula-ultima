// Imp — L50 soldier, Fafnir Castle (Demon, Dark). The disruptor.
// It barely does damage. What it does is take your gear off you and then stop
// you putting anything back on. Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.IM;

const STUDY =
  "<p>The palace quartermaster's ledgers run to nine volumes, of which four are entirely losses. " +
  "Breastplates, sabres, a ceremonial halberd, both of the late Steward's boots. " +
  "Nothing is ever <strong>found</strong>, and nothing is ever <strong>sold</strong>. " +
  "Whatever is taking it appears to simply want you not to have it.</p>";

// ── numbers ────────────────────────────────────────────────────────────────
// 110 HP is ~0.8 TP and sits right ON the party's ~110-130 spike ceiling: one
// good hit kills it. That is the deal being offered — the Imp is a pest you can
// delete the moment you connect, and DEF/MDEF 15/14 is what makes connecting
// the problem. Per the balance doc's chaff rule it is budgeted in the DENIAL
// currency and its damage stat is deliberately cheap.
//
// The contest bonus is 5 = floor(level/10), the NPC accuracy bonus. Both sides
// of a contest roll two attribute dice plus their bonus, so this is not a
// thumb on the scale, it is the Imp's half of a fair roll.
const CONTEST_BONUS = "5";

const DESC = {
  fork: `<p>Deal <strong>light</strong> ${L.physical}&nbsp;damage to one creature.</p>`,
  armor:
    `<p>The target rolls a <strong>【DEX】+【INS】</strong> Contest Check against the Imp — ` +
    `<strong>on a loss,</strong> their armor is taken. It leaves their inventory entirely, ` +
    `and comes back only when the battle ends.</p>`,
  weapon:
    `<p>The target rolls a <strong>【DEX】+【INS】</strong> Contest Check against the Imp — ` +
    `<strong>on a loss,</strong> the weapon they are holding is taken. It leaves their ` +
    `inventory entirely, and comes back only when the battle ends.</p>`,
  prank: `<p>Inflict ${L.disarmed} and ${L.confused} on one creature.</p>`,
};

// The Strip chain, twice over — same shape, different slot and marker.
// Order matters: the contest has to resolve before anything reads its result,
// and the marker AE has to land on the SAME pool the theft did, or the chip and
// the missing gear disagree.
const stripChain = (tag, slot, marker) => ({
  "0": { $deleted: false, effect_kind: "chain", effect_label: `${tag}_go`,
         chain_steps: `${tag}_contest,${tag}_take,${tag}_mark` },
  "1": { $deleted: false, effect_kind: "contest_check", effect_label: `${tag}_contest`,
         target_ref: "action_targets",
         contest_attr1: "dex", contest_attr2: "ins", contest_bonus: CONTEST_BONUS,
         save_attr1: "dex", save_attr2: "ins",
         save_mode: "interactive", contest_max_rerolls: "5" },
  "2": { $deleted: false, effect_kind: "hide_item", effect_label: `${tag}_take`,
         target_ref: "contest_lost_targets", hide_item_slot: slot,
         hide_item_id: "", hide_item_name: "" },
  "3": { $deleted: false, effect_kind: "apply_ae", effect_label: `${tag}_mark`,
         ae_template_ref: marker, target_ref: "contest_lost_targets",
         ae_duplicate_mode: "replace" },
});

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Pitchfork — the fallback, and nothing more ──────────────────────────
  changes.push([ik(IDS.IM_FORK), skill(dAtk, IDS.IM_FORK, "Pitchfork", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    check_bonus: "5", damage_bonus: "15", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.fork,
  }), "NEW item — Pitchfork"]);

  // ── Strip Armor / Strip Weapon ──────────────────────────────────────────
  // Actives with NO accuracy roll of their own (isCheck false): the contest IS
  // the roll, and an accuracy check in front of it would make the target beat
  // two rolls to keep one item.
  //
  // `hide_item_slot` rather than a name or an id, because an attacker cannot
  // know what the victim is wearing. An empty slot is a no-op, not a failure —
  // the AI is what should be stopping the Imp from robbing a naked target, and
  // the pattern below does exactly that.
  changes.push([ik(IDS.IM_ARMOR), skill(dSpl, IDS.IM_ARMOR, "Strip Armor", ICON.defdown, {
    skill_type: "Active", skill_target: "One Enemy", skill_range: "Melee",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.armor,
    on_activate_effect_ref: "sa_go",
    effect_table: stripChain("sa", "armor", "Armor Stripped"),
  }), "NEW item — Strip Armor (DEX+INS contest; hide_item armor slot)"]);

  changes.push([ik(IDS.IM_WEAPON), skill(dSpl, IDS.IM_WEAPON, "Strip Weapon", ICON.atkdown, {
    skill_type: "Active", skill_target: "One Enemy", skill_range: "Melee",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.weapon,
    on_activate_effect_ref: "sw_go",
    effect_table: stripChain("sw", "weapon", "Weapon Stripped"),
  }), "NEW item — Strip Weapon (DEX+INS contest; hide_item weapon slot)"]);

  // ── Prank — the half of the gimmick that makes the theft stick ──────────
  // Disarmed is `disable_action: "Equipment"`: it blocks the Equipment action,
  // which is how a robbed PC would otherwise just put on the spare. That is why
  // the loop is strip-then-prank and not prank-then-strip. Confused is
  // `disable_action: "Objective"` and closes the other door.
  // No contest and no check — the statuses are the whole payload, and they only
  // matter on somebody already robbed.
  changes.push([ik(IDS.IM_PRANK), skill(dSpl, IDS.IM_PRANK, "Prank", ICON.dismantle, {
    skill_type: "Active", skill_target: "One Enemy", skill_range: "Melee",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.prank,
    on_activate_effect_ref: "pk_go",
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "pk_go",
             chain_steps: "pk_disarm,pk_confuse" },
      "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "pk_disarm",
             ae_template_ref: "Disarmed", target_ref: "action_targets",
             ae_duplicate_mode: "replace" },
      "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "pk_confuse",
             ae_template_ref: "Confused", target_ref: "action_targets",
             ae_duplicate_mode: "replace" },
    },
  }), "NEW item — Prank (Disarmed + Confused)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Imp", FOLDER_FAFNIR, ART.IM, SCALE.IM);
  const p = a.system.props;
  Object.assign(p, {
    level: "50", npc_rank: "soldier", species: "DEMON", subtype_list: "FIEND",
    attribute: "DARK",
    traits: "Gleeful, Light-Fingered, Never Fights Fair, Serves the Palace",
    dex_base: "10", ins_base: "10", mig_base: "6", wlp_base: "6",
    dex_current: 10, ins_current: 10, mig_current: 6, wlp_current: 6,
    // DEF 15 / MDEF 14 = the d10 dice + Improved Defenses. Deliberately the
    // highest soldier defences in the dungeon (Succubus is 12/14) and paid for
    // in HP. MDEF one under DEF on the user's call: it should be slightly
    // easier to burn down than to hit.
    def_mod: "+5", mdef_mod: "+4", defense: 15, magic_defense: 14,
    max_hp: "110", current_hp: "110", max_mp: "50", current_mp: "50",
    init: "12", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "90", zenit_reward_max: "130",
    study_text: STUDY,
    // Demon picks two resistances: Dark (what it is) and Fire (where it is
    // from). Light is the VU — the dungeon already puts Light on Death Gazer
    // and Succubus, and a third demon reading the same way is the point of a
    // demon-heavy castle rather than a spread problem.
    affinity_4: "RS", affinity_6: "RS", affinity_8: "VU",
    // Hard to frighten or provoke; a gleeful pest does not rattle. Everything
    // else — slow, dazed, weak, poisoned — is wide open, which is the payment
    // for defences this high.
    condition_shaken: "RS", condition_enraged: "RS",
    // Brawling 175 is the live counter for a party that has just had its
    // weapons taken, and it reads right besides: you catch a darting imp by
    // grabbing it. Heavy 60 is the mirror — a big slow swing never lands.
    brawling_ef: "175", heavy_ef: "60",
  });

  p.attack_list = {
    [IDS.IM_FORK]: { name: "Pitchfork", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IM_FORK}`,
                     active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "MIG",
                     attack_description: DESC.fork, roll: "" },
  };
  p.skill_active_list = {
    [IDS.IM_ARMOR]: { name: "Strip Armor", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IM_ARMOR}`,
                      active_target: "One Enemy", active_cost: "10 MP", active_duration: "Instantaneous",
                      active_description: DESC.armor, roll: "" },
    [IDS.IM_WEAPON]: { name: "Strip Weapon", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IM_WEAPON}`,
                       active_target: "One Enemy", active_cost: "10 MP", active_duration: "Instantaneous",
                       active_description: DESC.weapon, roll: "" },
    [IDS.IM_PRANK]: { name: "Prank", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.IM_PRANK}`,
                      active_target: "One Enemy", active_cost: "10 MP", active_duration: "Instantaneous",
                      active_description: DESC.prank, roll: "" },
  };

  // ── Action pattern — strip, strip, prank, poke ──────────────────────────
  // Priorities are spaced >=3 so exactly one row is live at a time and the
  // ladder runs in order. The gates are STATE the actions themselves set, never
  // a cooldown: `action_pattern_cooldown` is inert on a priority-exclusive row
  // (the graceful fallback fires it anyway), so a cooldown here would be a
  // decoration that silently does nothing.
  //
  // `enemy_lacks_status` + `status_avoid` are the pair that makes this work on
  // a party rather than on one PC:
  //   - the CONDITION asks "is anyone still un-robbed?" — note this is not the
  //     negation of enemy_has_status, which would go false the moment the first
  //     PC was stripped, i.e. exactly when there is most left to do.
  //   - the FOCUS then aims at somebody who is not, so two Imps in the same
  //     fight rob two different people instead of both mugging Blanche.
  // Prank inverts it with `status_focus`: it only matters on someone already
  // robbed, so that is who it goes to.
  //
  // Weapon before armor: the weapon is the bigger loss and the one Disarmed
  // then locks out.
  const row = (i, name, cond, str, prio, focus, focusStatus) => ({
    [i]: { $deleted: false, action_pattern_name: name, action_pattern_condition: cond,
           action_pattern_string: str, action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: String(prio), action_pattern_target_focus: focus,
           action_pattern_focus_status: focusStatus,
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  });
  p.action_pattern_table = {
    ...row("0", "Strip Weapon", "enemy_lacks_status", "Weapon Stripped", 10, "status_avoid", "Weapon Stripped"),
    ...row("1", "Strip Armor", "enemy_lacks_status", "Armor Stripped", 7, "status_avoid", "Armor Stripped"),
    ...row("2", "Prank", "enemy_has_status", "Weapon Stripped", 4, "status_focus", "Weapon Stripped"),
    ...row("3", "Pitchfork", "always", "", 1, "auto", ""),
  };

  a.items = [IDS.IM_FORK, IDS.IM_ARMOR, IDS.IM_WEAPON, IDS.IM_PRANK];
  changes.push([`!actors!${A}`, a, "NEW actor — Imp (L50 soldier, Demon/Fiend, Dark)"]);
}, "fafnir-castle: Imp");
