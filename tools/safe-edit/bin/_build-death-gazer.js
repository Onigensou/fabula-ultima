// Death Gazer — L50 soldier, Fafnir Castle (Monster / Floating Eye, Dark).
// A gimmick spellcaster whose whole design is one question: can you close the
// distance and pop it before it looks at you? Run from tools/safe-edit;
// --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, bullets, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.DG;

const STUDY =
  "<p>It does not hunt, it does not feed, and it does not appear to want anything at all. " +
  "It simply <strong>opens</strong>, somewhere down a corridor you were sure was empty, and one of you " +
  "stops walking. The palace archivists recorded fourteen encounters and no wounds.</p>";

const DESC = {
  beam: `<p>Deal <strong>light</strong> ${L.dark}&nbsp;damage to one creature.</p>`,
  sear: `<p>Deal ${L.dark}&nbsp;damage to one creature.</p>`,
  // The rule is the whole card here, so it is stated plainly and the damage
  // scale does not apply — this is not damage, it is a threshold.
  gaze:
    `<p>The Death Gazer opens fully. The target rolls a <strong>DL13 【INS】+【WLP】</strong> check — ` +
    `<strong>on a failure, they are reduced to 0 Hit Points.</strong></p>`,
  unblink:
    "<p>The Death Gazer has no eyelid and nothing behind the eye to deceive. It cannot be blinded, " +
    "and darkness is no cover from it.</p>",
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dPas || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Eye Beam — bread and butter ─────────────────────────────────────────
  changes.push([ik(IDS.DG_BEAM), skill(dAtk, IDS.DG_BEAM, "Eye Beam", ICON.range, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Range",
    rolled_atr1: "INS", rolled_atr2: "WLP",
    check_bonus: "5", damage_bonus: "22", type_damage: "Dark", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.beam,
  }), "NEW item — Eye Beam"]);

  // ── Mind Sear — the filler cast, so the AI has something to spend MP on
  // between Gazes rather than idling at full pool.
  changes.push([ik(IDS.DG_SEAR), skill(dSpl, IDS.DG_SEAR, "Mind Sear", ICON.ospell, {
    skill_type: "Spell", skill_target: "One Enemy", skill_range: "Range",
    rolled_atr1: "INS", rolled_atr2: "WLP",
    check_bonus: "5", damage_bonus: "35", type_damage: "Dark", defense_target_type: "mdef",
    isCheck: true, isOffensiveSpell: true, isReaction: false,
    cost: "10 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.sear,
  }), "NEW item — Mind Sear"]);

  // ── Death Gaze — save-or-die ────────────────────────────────────────────
  // Modelled on Fafnir's Draconic Domination: a Spell with NO accuracy roll
  // (isCheck false), driven entirely by `on_activate_effect_ref`. The save IS
  // the interaction.
  //
  // "Reduced to 0 HP" cannot be a `set_resource` — that kind is RAISE-ONLY
  // (`Math.max(cur, value)`, skill-effects.js), so it would silently do
  // nothing. `deal_damage` for the target's whole current HP is the honest
  // expression and routes through applyDamageToTarget, so the defeat pipeline,
  // the HP bar and the damage VFX all behave normally.
  //   damage_ignore_affinity — a threshold effect is not Dark damage to be
  //                            resisted; RS/VU/IM must not scale it.
  //   damage_keywords "crush" — the only keyword the incoming ruleset reads:
  //                            "cannot be Reduced and ignores immunity", so DR
  //                            and a shield cannot leave the target on 3 HP.
  //   damage_cause "damage"   — it IS creature-inflicted, so it should trip
  //                            player-inflicted-damage reactions (the default
  //                            "hazard" would hide it from them).
  changes.push([ik(IDS.DG_GAZE), skill(dSpl, IDS.DG_GAZE, "Death Gaze", ICON.ospell, {
    skill_type: "Spell", skill_target: "One Enemy", skill_range: "Range",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "mdef",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "40 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.gaze,
    on_activate_effect_ref: "dg_gaze",
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "dg_gaze",
             chain_steps: "dg_save,dg_kill" },
      "1": { $deleted: false, effect_kind: "save_check", effect_label: "dg_save",
             target_ref: "action_targets", save_attr1: "ins", save_attr2: "wlp", save_dl: "13" },
      "2": { $deleted: false, effect_kind: "deal_damage", effect_label: "dg_kill",
             target_ref: "save_failed_targets", damage_amount: "CUR_HP",
             damage_element: "dark", damage_ignore_affinity: true,
             damage_keywords: "crush", damage_cause: "damage" },
    },
  }), "NEW item — Death Gaze (DL13 INS+WLP save or reduced to 0 HP)"]);

  // ── Unblinking — display passive, backed by the actor's condition props ──
  // Deliberately not automated: `condition_blind: IM` on the sheet already IS
  // the rule, and a reaction row would be a second, divergent source of truth.
  changes.push([ik(IDS.DG_UNBLINK), skill(dPas, IDS.DG_UNBLINK, "Unblinking", ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.unblink,
  }), "NEW item — Unblinking (passive)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Death Gazer", FOLDER_FAFNIR, ART.DG, SCALE.DG);
  const p = a.system.props;
  Object.assign(p, {
    level: "50", npc_rank: "soldier", species: "MONSTER", subtype_list: "ABERRATION",
    attribute: "DARK",
    traits: "Patient, Incurious, Never Blinks, Silent",
    dex_base: "8", ins_base: "12", mig_base: "6", wlp_base: "12",
    dex_current: 8, ins_current: 12, mig_current: 6, wlp_current: 12,
    // Derived from the dice + the mods. A clone carries the DONOR's stored
    // numbers to disk even though CSB recomputes them live, so write the
    // correct value rather than inheriting a wrong one.
    def_mod: "+0", mdef_mod: "+4", defense: 8, magic_defense: 16,
    // 150 HP is a bit over one party spike (~130). Deliberate: it survives a
    // focused round exactly once, which is the fight — the party either eats a
    // Gaze or spends a whole round making sure they don't.
    max_hp: "150", current_hp: "150", max_mp: "120", current_mp: "120",
    init: "10", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "90", zenit_reward_max: "130",
    study_text: STUDY,
    // Exactly one VU, and it is Light — the obvious answer to a floating eye,
    // and it keeps the "right answer" signal legible on a monster whose whole
    // threat is a timer.
    affinity_4: "RS", affinity_9: "RS", affinity_8: "VU",
    // Backs the Unblinking passive. Leaves slow/weak/enraged/poisoned open —
    // Slow in particular is the party's real counterplay to the Gaze cadence.
    condition_blind: "IM", condition_obscure: "IM",
    condition_dazed: "IM", condition_shaken: "IM",
    arcane_ef: "150", heavy_ef: "75",
  });

  // CSB renders the sheet from these LIST props, not from the items. They hold
  // their own copy of the description, so both must be kept in sync.
  p.attack_list = {
    [IDS.DG_BEAM]: { name: "Eye Beam", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DG_BEAM}`,
                     active_target: "One Creature", attribute_die1: "INS", attribute_die2: "WLP",
                     attack_description: DESC.beam, roll: "" },
  };
  // Spells go in normal_spell_list even when offensive — there is no separate
  // NPC offensive list (that key is PC-only).
  p.normal_spell_list = {
    [IDS.DG_SEAR]: { name: "Mind Sear", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DG_SEAR}`,
                     cost: "10 MP", spell_target: "One Enemy", duration: "Instantaneous",
                     spell_description: DESC.sear, roll: "" },
    [IDS.DG_GAZE]: { name: "Death Gaze", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DG_GAZE}`,
                     cost: "40 MP", spell_target: "One Enemy", duration: "Instantaneous",
                     spell_description: DESC.gaze, roll: "" },
  };
  p.skill_passive_list = {
    [IDS.DG_UNBLINK]: { name: "Unblinking", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DG_UNBLINK}`,
                        passive_description: DESC.unblink, roll: "" },
  };

  // Priority is a weighted 2-gap window, not "highest wins": gap 0/1/2 -> weight
  // 3/2/1, gap >=3 excluded.
  //
  // The Gaze is the tuning dial. Two independent brakes, both data:
  //   * `round` 2-99 — never a turn-one rocket-tag opener; the party gets a
  //     round to see the monster and decide.
  //   * cooldown 2 — Death Gaze is priority-EXCLUSIVE (>=3 clear of Mind Sear),
  //     and on an exclusive row the anti-repeat weighting cannot reach it, so
  //     the cooldown is the only thing that stops it firing every single turn.
  //     A hard block is what is wanted here anyway.
  // Mind Sear at 5 excludes Eye Beam at 2, so the MP-gated row reads cleanly:
  // cast while there is MP, swing when there is not.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Death Gaze", action_pattern_condition: "round",
           action_pattern_string: "", action_pattern_value_1: "2", action_pattern_value_2: "99",
           action_pattern_priority: "9", action_pattern_target_focus: "lowest_hp",
           action_pattern_cooldown: "2", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Mind Sear", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "34", action_pattern_value_2: "100",
           action_pattern_priority: "5", action_pattern_target_focus: "by_affinity",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Eye Beam", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "2", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.DG_BEAM, IDS.DG_SEAR, IDS.DG_GAZE, IDS.DG_UNBLINK];
  changes.push([`!actors!${A}`, a, "NEW actor — Death Gazer (L50 soldier, Monster/Aberration, Dark)"]);
}, "fafnir-castle: Death Gazer");
