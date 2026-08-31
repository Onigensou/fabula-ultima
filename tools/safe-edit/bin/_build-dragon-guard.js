// Dragon Guard — L50 soldier, Fafnir Castle (Humanoid / Dragon, Fire).
// The castle's line soldier: no gimmick, real offence, real defence, and enough
// HP to actually get its second turn. Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.DGD;

const STUDY =
  "<p>They hold the halls in pairs and they do not chase. Ask one a question and it will answer you, " +
  "politely, without moving. The scale plate is grown rather than forged and it is thickest across the " +
  "chest and shoulders, which is where a swordsman aims. " +
  "The <strong>gaps</strong> are at the joints, and they are narrow.</p>";

// ── numbers ────────────────────────────────────────────────────────────────
// 250 HP is ~1.85 TP — a round and a half to two rounds of full party focus,
// as specced — and comfortably clear of the ~110-130 spike ceiling, so it is
// out of one-shot range and its damage budget is one it will actually spend.
// It sits next to Dire Orc (240) as the castle's other line soldier.
//
// Saber's HR+25 is base 5 + Improved Damage twice + the L40-59 flat +10, which
// averages ~33 — about a third of an average PC's HP, the official calibration
// for "a hit from this should hurt".
//
// MP 30 with a 30 MP breath is deliberate and is the whole of its resource
// game: the Dragon Guard breathes ONCE, ever, or spends the same pool on three
// Suppressing Sweeps. The pattern below makes it hold the breath for a target
// worth spending it on.

const DESC = {
  saber: `<p>Deal <strong>heavy</strong> ${L.physical}&nbsp;damage to one creature.</p>`,
  breath: `<p>Deal <strong>heavy</strong> ${L.fire}&nbsp;damage to all enemies.</p>`,
  sweep: `<p>Deal ${L.physical}&nbsp;damage to up to two creatures, and inflict ${L.slow} on them.</p>`,
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Saber ───────────────────────────────────────────────────────────────
  changes.push([ik(IDS.DGD_SABER), skill(dAtk, IDS.DGD_SABER, "Saber", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    check_bonus: "5", damage_bonus: "25", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.saber,
  }), "NEW item — Saber"]);

  // ── Flame Breath ────────────────────────────────────────────────────────
  // HR+20 to everyone lands ~28 a head, ~112 across four — a real swing of the
  // fight, and it can only ever happen once because it costs the entire pool.
  changes.push([ik(IDS.DGD_BREATH), skill(dSpl, IDS.DGD_BREATH, "Flame Breath", ICON.ospell, {
    skill_type: "Spell", skill_target: "All Enemies", skill_range: "Range",
    rolled_atr1: "MIG", rolled_atr2: "WLP",
    check_bonus: "5", damage_bonus: "20", type_damage: "Fire", defense_target_type: "mdef",
    isCheck: true, isOffensiveSpell: true, isReaction: false,
    cost: "30 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.breath,
  }), "NEW item — Flame Breath (all enemies, Fire)"]);

  // ── Suppressing Sweep — PLACEHOLDER ─────────────────────────────────────
  // ⚠ The user's concept for this third action is not settled; this is a
  // deliberate stand-in, not a design. It was chosen to be easy to throw away:
  // ordinary damage plus one status, no new engine surface, nothing else in the
  // kit depends on it. What it buys in the meantime is a mid-cost option so the
  // 30 MP pool is a real choice (three of these, or one breath) instead of a
  // switch, and a second target so the Guard is not purely single-target while
  // it holds the breath.
  //
  // Replace freely — the only wiring to update is the one action-pattern row.
  changes.push([ik(IDS.DGD_SWEEP), skill(dAtk, IDS.DGD_SWEEP, "Suppressing Sweep", ICON.melee, {
    skill_type: "Active", skill_target: "Up to 2 Creature", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    check_bonus: "5", damage_bonus: "15", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.sweep,
    on_activate_effect_ref: "ss_slow",
    effect_table: {
      "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "ss_slow",
             ae_template_ref: "Slow", target_ref: "hit_action_targets",
             ae_duplicate_mode: "replace" },
    },
  }), "NEW item — Suppressing Sweep (PLACEHOLDER: 2 targets + Slow)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Dragon Guard", FOLDER_FAFNIR, ART.DGD, SCALE.DGD);
  const p = a.system.props;
  Object.assign(p, {
    level: "50", npc_rank: "soldier", species: "HUMANOID", subtype_list: "DRAGON",
    attribute: "FIRE",
    traits: "Disciplined, Proud of the Uniform, Hates Deserters, Sworn to the Palace",
    dex_base: "10", ins_base: "8", mig_base: "10", wlp_base: "6",
    dex_current: 10, ins_current: 8, mig_current: 10, wlp_current: 6,
    // Moderate on both, and moderate on purpose: this is the monster the party
    // is supposed to be able to hit while the Imp is the one they cannot.
    def_mod: "+2", mdef_mod: "+2", defense: 12, magic_defense: 10,
    max_hp: "250", current_hp: "250", max_mp: "30", current_mp: "30",
    init: "9", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "110", zenit_reward_max: "150",
    study_text: STUDY,
    // Ice is the VU — the legible answer to a fire dragon, and it gives the
    // party's ice a job in a dungeon whose other four monsters answer to Light,
    // Bolt and Ice. RS Fire (what it breathes) and RS Poison (scaled).
    affinity_6: "RS", affinity_7: "VU", affinity_9: "RS",
    // Immune to its own element's status, resistant to poison to match the
    // affinity. Shaken / dazed / weak / slow / enraged all left open: a
    // disciplined soldier should still be rattleable and taunt-able, and this
    // monster has no gimmick to protect.
    condition_burn: "IM", condition_poisoned: "RS",
    // Bow 175 is the gaps between the scale plates — a precise shot finds them,
    // and it is the one high-EF slot in this dungeon that is live for the
    // current party. Sword 60 is the mirror, and it is a nice joke that the
    // Guard's own weapon is the worst answer to it.
    bow_ef: "175", sword_ef: "60",
  });

  p.attack_list = {
    [IDS.DGD_SABER]: { name: "Saber", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DGD_SABER}`,
                       active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "MIG",
                       attack_description: DESC.saber, roll: "" },
  };
  p.normal_spell_list = {
    [IDS.DGD_BREATH]: { name: "Flame Breath", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DGD_BREATH}`,
                        cost: "30 MP", spell_target: "All Enemies", duration: "Instantaneous",
                        spell_description: DESC.breath, roll: "" },
  };
  p.skill_active_list = {
    [IDS.DGD_SWEEP]: { name: "Suppressing Sweep", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DGD_SWEEP}`,
                       active_target: "Up to 2 Creature", active_cost: "10 MP",
                       active_duration: "Instantaneous", active_description: DESC.sweep, roll: "" },
  };

  // ── Action pattern ──────────────────────────────────────────────────────
  // MP 30 against a 30 MP breath means the pool IS the once-per-fight brake, so
  // no row here needs a cooldown; what the pattern decides is only WHEN to
  // spend it, and on whom. Feasibility retires the Breath row by itself the
  // moment the pool is empty.
  //
  // Round 1 is deliberately NOT excluded. The fight is meant to last a round
  // and a half to two, so a soldier that must survive to round 2 to use its
  // signature move is a soldier whose signature move often never happens. The
  // gate is enemy_count instead: breathe at a crowd, not at a straggler.
  //
  // Sweep therefore only appears once the Breath is off the table (1-2 enemies
  // left). Below three targets the AoE is not worth the whole pool, and 10 MP
  // for two hits and a Slow is. Sweep and Saber sit inside 2 priority of each
  // other so the weighted pick and the anti-repeat de-weight stay live — the
  // Guard should mix rather than alternate mechanically. Breath is 4 clear, so
  // it takes the turn outright when its gate opens.
  //
  // ⚠ Sweep is reachable but uncommon in a 4-PC fight, which is the correct
  // weight for a placeholder. When the real third action lands, this row is the
  // only wiring that needs revisiting.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Flame Breath", action_pattern_condition: "enemy_count",
           action_pattern_string: "", action_pattern_value_1: "3", action_pattern_value_2: "9",
           action_pattern_priority: "9", action_pattern_target_focus: "auto",
           action_pattern_focus_status: "",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Suppressing Sweep", action_pattern_condition: "enemy_count",
           action_pattern_string: "", action_pattern_value_1: "1", action_pattern_value_2: "2",
           action_pattern_priority: "5", action_pattern_target_focus: "auto",
           action_pattern_focus_status: "",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Saber", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "4", action_pattern_target_focus: "squishy",
           action_pattern_focus_status: "",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.DGD_SABER, IDS.DGD_BREATH, IDS.DGD_SWEEP];
  changes.push([`!actors!${A}`, a, "NEW actor — Dragon Guard (L50 soldier, Humanoid/Dragon, Fire)"]);
}, "fafnir-castle: Dragon Guard");
