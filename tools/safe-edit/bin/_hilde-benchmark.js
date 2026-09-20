// Hilde-Fafnir benchmark (2026-09-20) — "Culling the Weak". A DELTA on top of
// the 2026-08-29 build (_build-hilde-fafnir.js), not a rebuild: it loads her
// live docs and changes only what the benchmark changes, so the actor keeps its
// flags / ownership / prototypeToken (blankActor would reset them — see the
// Gorger audit trap). Design: modules/fabula-ultima-companion/docs/
// hilde-fafnir-boss-design.md. Every number here is a benchmark placeholder,
// to be tuned in fight simulation.
//
// Run AFTER _hilde-benchmark-aes.js (Culling). From tools/safe-edit; --apply.
//
//   Dragoon Lance   heavy → devastating (+70), vs MDEF, Execute (×2 vs Crisis)
//   Claw            NEW — devastating Physical (+70), vs DEF, Cripple (×2 vs non-Crisis)
//   Lance of Ruin   50 → 150 MP; no longer once per conflict (the AI's round
//                   schedule paces it — see the pattern table)
//   Reinslaughter   NEW Zero Power — Bolt, all enemies, +up to 400 by the victim's
//                   missing HP%, read redirect-aware (ORIGINAL_TARGET_*)
//   Contempt        NEW Zero Trigger — +1 ZP when an enemy enters Crisis or hits 0 HP
const { getByKey } = require("../lib/db");
const { IDS, DONOR_ACTOR, DONOR_PASSIVE, L, bullets, ICON } = require("./_fafnir-lib");
const { makeSkill, run } = require("./_fafnir-util");

const A = IDS.HF;
const ZP_NAME = "Zero Power: Reinslaughter";
const ZT_NAME = "Zero Trigger: Contempt";

const DESC = {
  lance: bullets(L.execute) +
    `<p>Deal <strong>devastating</strong> ${L.physical}&nbsp;damage to one creature.</p>`,
  claw: bullets(L.cripple) +
    `<p>Deal <strong>devastating</strong> ${L.physical}&nbsp;damage to one creature.</p>`,
  ruin:
    "<p>Hilde-Fafnir levels the Lance and the throne room agrees with it. " +
    "<strong>Every enemy is reduced to 1 Hit Point.</strong></p>",
  // Systemic voice: the sentence is the rule. The redirect line is there
  // because it is the one thing a player cannot infer — covering an ally
  // does not make the hit smaller.
  zp:
    `<p>Deal <strong>devastating</strong> ${L.bolt}&nbsp;damage to all enemies. ` +
    "Damage increases the lower the target's HP.</p>" +
    "<p>A creature that takes the hit in another's place takes it as that creature would have.</p>",
  zt:
    `<p>Whenever an enemy enters ${L.crisis} or is reduced to 0 HP, Hilde-Fafnir ` +
    "<strong>gains 1 Zero Power</strong>. Reinslaughter does not feed it.</p>",
};

// Execute / Cripple are DATA, not engine keywords: a force-mode
// creature_will_deal_damage reaction scoped to the skill by name, doubling the
// hit per victim on its Crisis state (pre-damage — a target this hit pushes into
// Crisis does not retroactively qualify). See reference_bd_card_fold_ondamage.
function doubleIfRows(skillName, label, conditionFormula) {
  return {
    reaction_config_table: {
      "0": { $deleted: false, reaction_trigger: "creature_will_deal_damage", reaction_source: "self",
             reaction_source_skill: skillName, condition_formula: conditionFormula,
             reaction_passive_mode: "force", reaction_effect_ref: label },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: label,
             damage_operation: "multiply", damage_amount: "2", damage_stage: "outgoing" },
    },
  };
}

run(async ({ changes }) => {
  const actorKey = `!actors!${A}`;
  const ik = (id) => `!actors.items!${A}.${id}`;
  const actor = await getByKey("actors", actorKey);
  const lance = await getByKey("actors", ik(IDS.HF_LANCE));
  const ruin = await getByKey("actors", ik(IDS.HF_RUIN));
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  if (!actor || !lance || !ruin || !dPas) throw new Error("missing Hilde-Fafnir doc or donor");
  for (const id of [IDS.HF_CLAW, IDS.HF_ZP, IDS.HF_ZT]) {
    if (await getByKey("actors", ik(id))) console.log(`  note: ${id} already exists — rewriting it`);
  }

  // ── Dragoon Lance — devastating, vs MDEF, Execute ────────────────────────
  // Edited in place (not re-cloned) so anything else on the doc survives.
  const lanceP = lance.system.props;
  Object.assign(lanceP, {
    damage_bonus: "70", defense_target_type: "mdef",
    isReaction: true,   // the Execute row is dead without it (REACTION_FLAG_MISSING)
    description: DESC.lance,
    ...doubleIfRows("Dragoon Lance", "dl_execute", "TARGET_AE_COUNT_CRISIS > 0"),
  });
  changes.push([ik(IDS.HF_LANCE), lance, "Dragoon Lance — devastating +70, vs MDEF, Execute"]);

  // ── Claw — the Cripple half of the loop ──────────────────────────────────
  // Cloned from Dragoon Lance so the Attack scaffold matches exactly.
  const claw = makeSkill(lance, A, IDS.HF_CLAW, "Claw", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "DEX",
    check_bonus: "8", damage_bonus: "70", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.claw,
  });
  Object.assign(claw.system.props, doubleIfRows("Claw", "claw_cripple", "TARGET_AE_COUNT_CRISIS == 0"));
  changes.push([ik(IDS.HF_CLAW), claw, "NEW item — Claw (devastating, vs DEF, Cripple)"]);

  // ── Lance of Ruin — 150 MP, periodic ─────────────────────────────────────
  // The Lance Spent stamp is retired: the AI row now paces it on a round
  // schedule, and a stamp nothing reads would only confuse the next audit.
  // Row kept as $deleted (BD skips it everywhere) rather than dropped, so the
  // effect_table keys stay stable.
  const ruinP = ruin.system.props;
  ruinP.cost = "150 MP";
  ruinP.description = DESC.ruin;
  const lr = Object.values(ruinP.effect_table ?? {});
  const chain = lr.find((r) => r?.effect_label === "lr_lance");
  const spend = lr.find((r) => r?.effect_label === "lr_spend");
  if (!chain || !spend) throw new Error("Lance of Ruin effect_table not in the expected shape");
  chain.chain_steps = "lr_ruin";
  spend.$deleted = true;
  changes.push([ik(IDS.HF_RUIN), ruin, "Lance of Ruin — 150 MP, Lance Spent stamp retired"]);

  // ── Zero Power: Reinslaughter ────────────────────────────────────────────
  // An Active like every shipped Zero Power (Meteor Impact): no accuracy roll.
  // Base 60 at full HP; the fold adds up to +400 at 1 HP, so the top of the
  // curve clears any PC's max HP even through Bolt RS. ORIGINAL_TARGET_* reads
  // the ally a Protect / Prophetic Defender slot was aimed at, so the defender
  // takes the 1-HP hit. Culling (on activate) mutes Contempt for this action.
  const zp = makeSkill(ruin, A, IDS.HF_ZP, ZP_NAME, ICON.zeropower, {
    skill_type: "Active", skill_target: "All Enemies", skill_range: "Range",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "60", type_damage: "Bolt", defense_target_type: "mdef",
    isCheck: false, isOffensiveSpell: false, isReaction: true, isZeroPower: true,
    cost: "6 Zero Power", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.zp,
    on_activate_effect_ref: "rs_mark",
  });
  Object.assign(zp.system.props, {
    reaction_config_table: {
      "0": { $deleted: false, reaction_trigger: "creature_will_deal_damage", reaction_source: "self",
             reaction_source_skill: ZP_NAME, reaction_passive_mode: "force",
             reaction_effect_ref: "rs_curve" },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "rs_curve",
             damage_operation: "add", damage_stage: "outgoing",
             damage_amount: "floor(400 * (1 - ORIGINAL_TARGET_CURRENT_HP / ORIGINAL_TARGET_MAX_HP))" },
      "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "rs_mark",
             ae_template_ref: "Culling", target_ref: "self",
             ae_duplicate_mode: "replace", ae_duration_rounds: "1" },
    },
  });
  changes.push([ik(IDS.HF_ZP), zp, "NEW item — Zero Power: Reinslaughter"]);

  // ── Zero Trigger: Contempt ───────────────────────────────────────────────
  // Two observer-aware rows (Hellhound's On the Hunt / Keren's Birth of the
  // Cruel shapes). A one-shot from above half HP fires BOTH events — the
  // crisis reactor applies Crisis even at 0 HP — so the Crisis row only counts
  // a victim still standing, and the KO row counts the rest: one hit, one ZP.
  const zt = makeSkill(dPas, A, IDS.HF_ZT, ZT_NAME, ICON.zerotrig, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.zt,
  });
  Object.assign(zt.system.props, {
    reaction_config_table: {
      "0": { $deleted: false, reaction_trigger: "creature_status_applied", reaction_status_filter: "Crisis",
             reaction_source: "enemy", reaction_passive_mode: "force",
             condition_formula: "TARGET_CURRENT_HP > 0 && AE_COUNT_CULLING == 0",
             reaction_effect_ref: "ct_gain" },
      "1": { $deleted: false, reaction_trigger: "creature_defeated",
             reaction_source: "enemy", reaction_passive_mode: "force",
             condition_formula: "AE_COUNT_CULLING == 0",
             reaction_effect_ref: "ct_gain" },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "grant", effect_label: "ct_gain",
             grant_resource: "zero_power", grant_amount: "1", target_ref: "self" },
    },
  });
  changes.push([ik(IDS.HF_ZT), zt, "NEW item — Zero Trigger: Contempt"]);

  // ── Actor: item list, sheet lists, AI ────────────────────────────────────
  const p = actor.system.props;
  const items = Array.isArray(actor.items) ? [...actor.items] : [];
  for (const id of [IDS.HF_CLAW, IDS.HF_ZP, IDS.HF_ZT]) if (!items.includes(id)) items.push(id);
  actor.items = items;

  const row = (id, name, extra) => ({ name, id: "${item.id}", uuid: `Actor.${A}.Item.${id}`, roll: "", ...extra });
  p.attack_list = { ...(p.attack_list ?? {}),
    [IDS.HF_LANCE]: row(IDS.HF_LANCE, "Dragoon Lance", { active_target: "One Creature",
      attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.lance }),
    [IDS.HF_CLAW]: row(IDS.HF_CLAW, "Claw", { active_target: "One Creature",
      attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.claw }),
  };
  p.skill_active_list = { ...(p.skill_active_list ?? {}),
    [IDS.HF_RUIN]: row(IDS.HF_RUIN, "Lance of Ruin", { active_target: "All Enemies",
      active_cost: "150 MP", active_duration: "Instantaneous", active_description: DESC.ruin }),
    [IDS.HF_ZP]: row(IDS.HF_ZP, ZP_NAME, { active_target: "All Enemies",
      active_cost: "6 Zero Power", active_duration: "Instantaneous", active_description: DESC.zp }),
  };
  p.skill_passive_list = { ...(p.skill_passive_list ?? {}),
    [IDS.HF_ZT]: row(IDS.HF_ZT, ZT_NAME, { passive_description: DESC.zt }),
  };

  // Priority ladder, top first. Reinslaughter fires the moment the gauge is
  // full. Lance of Ruin runs on the round schedule 2, 5, 8, … (`round` is
  // A + B·X: value_1 = 2, value_2 = 3), still only below 60% HP, and the MP
  // feasibility check skips it under 150 MP — a missed slot waits for the next
  // one. Wyrmbreath is unchanged. The two fillers share priority 3 and split
  // the field by Crisis: Dragoon Lance only while someone is in Crisis and aims
  // at them; Claw only while someone is out of it and aims at them. Between
  // them one filler is always legal.
  const pat = (name, condition, extra) => ({
    $deleted: false, action_pattern_name: name, action_pattern_condition: condition,
    action_pattern_string: "", action_pattern_value_1: "", action_pattern_value_2: "",
    action_pattern_priority: "3", action_pattern_target_focus: "auto", action_pattern_focus_status: "",
    action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0",
    ...extra,
  });
  p.action_pattern_table = {
    "0": pat(ZP_NAME, "zero_power", { action_pattern_value_1: "100", action_pattern_value_2: "100",
      action_pattern_priority: "20" }),
    "1": pat("Lance of Ruin", "round", { action_pattern_value_1: "2", action_pattern_value_2: "3",
      action_pattern_priority: "12", action_pattern_hp_ceiling: "60" }),
    "2": pat("Wyrmbreath", "mp", { action_pattern_value_1: "20", action_pattern_value_2: "100",
      action_pattern_priority: "6", action_pattern_cooldown: "1" }),
    "3": pat("Dragoon Lance", "enemy_has_status", { action_pattern_string: "Crisis",
      action_pattern_target_focus: "status_focus", action_pattern_focus_status: "Crisis" }),
    "4": pat("Claw", "enemy_lacks_status", { action_pattern_string: "Crisis",
      action_pattern_target_focus: "status_avoid", action_pattern_focus_status: "Crisis" }),
  };
  changes.push([actorKey, actor, `actor — items ${items.length}, sheet lists, 5-row AI table`]);
}, "hilde-fafnir benchmark: kit", "actors");
