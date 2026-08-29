// Hilde-Fafnir — L55 champion, Fafnir Castle. The final boss: Fafnir wearing
// Princess Hilde. Run from tools/safe-edit; --apply to write.
//
// Champion economy per the design rules: HP x N, MP x2, +N skills, N turns per
// round, +N initiative, where N is the number of soldiers replaced. At party
// L45-50 that is 4 turns a round. Sized one step above the world's current
// ceiling (the Valley's own Fafnir: L50, 1824 HP, 400 MP).
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, bullets, trig, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.HF;

const STUDY =
  "<p>She is still in there. That is the difficult part, and the palace has arranged the whole approach " +
  "so that you will be certain of it by the time you arrive. It speaks with her voice, it remembers " +
  "your name, and it has been waiting at the end of this hallway for longer than the hallway has existed.</p>";

const DESC = {
  lance: `<p>Deal <strong>heavy</strong> ${L.physical}&nbsp;damage to one creature.</p>`,
  breath: `<p>Deal <strong>heavy</strong> ${L.dark}&nbsp;damage to all enemies.</p>`,
  // The rule is the card. No damage adjective — this is not damage, it is a
  // floor, and the number is the whole point.
  ruin:
    "<p>Hilde-Fafnir levels the Lance and the throne room agrees with it. " +
    "<strong>Every enemy is reduced to 1 Hit Point.</strong></p>" +
    "<p>It can only be thrown once.</p>",
  crown:
    "<p>There is nothing left in Hilde-Fafnir to sway, frighten or talk down. Whatever was negotiable " +
    "about the Princess is not answering.</p>",
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dPas || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Dragoon Lance — bread and butter ────────────────────────────────────
  changes.push([ik(IDS.HF_LANCE), skill(dAtk, IDS.HF_LANCE, "Dragoon Lance", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "DEX",
    check_bonus: "8", damage_bonus: "52", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.lance,
  }), "NEW item — Dragoon Lance"]);

  // ── Wyrmbreath — the room-wide beat ─────────────────────────────────────
  changes.push([ik(IDS.HF_BREATH), skill(dSpl, IDS.HF_BREATH, "Wyrmbreath", ICON.ospell, {
    skill_type: "Spell", skill_target: "All Enemies", skill_range: "Any",
    rolled_atr1: "INS", rolled_atr2: "WLP",
    check_bonus: "8", damage_bonus: "44", type_damage: "Dark", defense_target_type: "mdef",
    isCheck: true, isOffensiveSpell: true, isReaction: false,
    cost: "40 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.breath,
  }), "NEW item — Wyrmbreath (all enemies, Dark)"]);

  // ── Lance of Ruin — reduce all enemy HP to 1 ────────────────────────────
  // An Active, so there is no accuracy roll to dodge and no MDEF to hide
  // behind: it simply happens.
  //
  // `set_resource` cannot express this — that kind is RAISE-ONLY
  // (`Math.max(cur, value)`), so it would silently do nothing. `deal_damage`
  // for `CUR_HP - 1` is the honest expression and floors itself: a PC already
  // on 1 HP computes 0 and `deal_damage` skips amounts <= 0, so this never
  // kills anybody, exactly as specced.
  //   damage_ignore_affinity — a threshold is not Dark damage to be resisted.
  //   damage_keywords "crush" — "cannot be Reduced and ignores immunity", so
  //                             no DR, shield or Mercy leaves a PC on 40 HP.
  //
  // Once per conflict, and NOT via `action_pattern_cooldown`: the row has to
  // be priority-exclusive to be reliable, and a cooldown is inert on an
  // exclusive row. Instead the chain stamps a persistent "Lance Spent" AE on
  // the boss and the pattern gates on `self_lacks_status`, which is a real
  // hard lock for the rest of the fight.
  changes.push([ik(IDS.HF_RUIN), skill(dSpl, IDS.HF_RUIN, "Lance of Ruin", ICON.ospell, {
    skill_type: "Active", skill_target: "All Enemies", skill_range: "Any",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "50 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.ruin,
    on_activate_effect_ref: "lr_lance",
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "lr_lance",
             chain_steps: "lr_ruin,lr_spend" },
      "1": { $deleted: false, effect_kind: "deal_damage", effect_label: "lr_ruin",
             target_ref: "action_targets", damage_amount: "CUR_HP - 1",
             damage_element: "dark", damage_ignore_affinity: true,
             damage_keywords: "crush", damage_cause: "damage" },
      "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "lr_spend",
             ae_template_ref: "Lance Spent", target_ref: "self",
             ae_duplicate_mode: "replace" },
    },
  }), "NEW item — Lance of Ruin (all enemies to 1 HP, once per conflict)"]);

  // ── Crown of the Sleeping Dragon — display passive ──────────────────────
  // Backed by the actor's condition props. No automation: the sheet IS the
  // rule, and a reaction row would be a second source of truth for it.
  changes.push([ik(IDS.HF_CROWN), skill(dPas, IDS.HF_CROWN, "Crown of the Sleeping Dragon", ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.crown,
  }), "NEW item — Crown of the Sleeping Dragon (passive)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "⭐️ Hilde-Fafnir", FOLDER_FAFNIR, ART.HF, SCALE.HF);
  const p = a.system.props;
  Object.assign(p, {
    level: "55", npc_rank: "champion",
    // MONSTER rather than HUMANOID: it matches the Valley's own Fafnir, and
    // HUMANOID would hand it the free Use Equipment skill, which is not what
    // this creature is. The humanity is in the subtype and the fiction.
    species: "MONSTER", subtype_list: "HUMANOID, DRAGON",
    attribute: "DARK",
    traits: "Regal, Possessive, Remembers Your Name, Will Not Let Go",
    dex_base: "12", ins_base: "12", mig_base: "12", wlp_base: "12",
    dex_current: 12, ins_current: 12, mig_current: 12, wlp_current: 12,
    def_mod: "+6", mdef_mod: "+6", defense: 18, magic_defense: 18,
    max_hp: "2400", current_hp: "2400", max_mp: "500", current_mp: "500",
    init: "16", max_zero: "6", ultima_points: "5",
    zenit_reward_min: "6000", zenit_reward_max: "6000",
    study_text: STUDY,
    // No VU. The "exactly one VU" rule is a soldier/elite legibility rule —
    // it exists so a normal monster broadcasts its right answer. A final boss
    // is not supposed to have one.
    affinity_4: "RS", affinity_6: "RS",
    // Backs the Crown passive.
    condition_charm: "IM", condition_confused: "IM", condition_berserk: "IM",
    condition_frightened: "IM", condition_shaken: "IM", condition_enraged: "IM",
    condition_zombie: "IM", condition_petrify: "IM",
    spear_ef: "150", dagger_ef: "60",
  });

  p.attack_list = {
    [IDS.HF_LANCE]: { name: "Dragoon Lance", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.HF_LANCE}`,
                      active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "DEX",
                      attack_description: DESC.lance, roll: "" },
  };
  p.normal_spell_list = {
    [IDS.HF_BREATH]: { name: "Wyrmbreath", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.HF_BREATH}`,
                       cost: "40 MP", spell_target: "All Enemies", duration: "Instantaneous",
                       spell_description: DESC.breath, roll: "" },
  };
  p.skill_active_list = {
    [IDS.HF_RUIN]: { name: "Lance of Ruin", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.HF_RUIN}`,
                     active_target: "All Enemies", active_cost: "50 MP", active_duration: "Instantaneous",
                     active_description: DESC.ruin, roll: "" },
  };
  p.skill_passive_list = {
    [IDS.HF_CROWN]: { name: "Crown of the Sleeping Dragon", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.HF_CROWN}`,
                      passive_description: DESC.crown, roll: "" },
  };

  // Lance of Ruin sits at 12, at least 3 clear of everything, so once its gate
  // opens it is the ONLY candidate that round — no weighted window, no chance
  // of the boss rolling a plain attack on the turn the fight is supposed to
  // pivot. `self_lacks_status: Lance Spent` opens the gate exactly once; the
  // chain closes it permanently.
  //
  // `hp_ceiling: 60` is the second half of the gate — the row is blocked while
  // the boss is above 60% HP (the mirror of hp_reserve; Geist's Shadow Wall is
  // the precedent). So the Lance lands when the party has already ground it
  // down and committed resources, not on turn one against four full PCs, where
  // "everyone to 1 HP" would read as a free heal for the healer instead of as
  // the moment the fight turns.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Lance of Ruin", action_pattern_condition: "self_lacks_status",
           action_pattern_string: "Lance Spent", action_pattern_value_1: "", action_pattern_value_2: "",
           action_pattern_priority: "12", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "60" },
    "1": { $deleted: false, action_pattern_name: "Wyrmbreath", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "20", action_pattern_value_2: "100",
           action_pattern_priority: "6", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "1", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Dragoon Lance", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "3", action_pattern_target_focus: "lowest_hp",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.HF_LANCE, IDS.HF_BREATH, IDS.HF_RUIN, IDS.HF_CROWN];
  changes.push([`!actors!${A}`, a, "NEW actor — ⭐️ Hilde-Fafnir (L55 champion, final boss)"]);
}, "fafnir-castle: Hilde-Fafnir");
