// Hilde-Fafnir — filler rework (2026-09-20, second benchmark pass). A DELTA on
// the live docs; never re-run _build-hilde-fafnir.js on this actor.
// Run AFTER _migrate-execute-cripple-keyword.js. From tools/safe-edit; --apply.
//
//   Dragoon Lance -> Impalement     renamed (it read as a twin of Lance of Ruin),
//                                   devastating Physical vs MDEF unchanged, and
//                                   Execute now comes from the KEYWORD (BD
//                                   43d5f077) instead of a name-scoped rider.
//   Claw          -> Scorched Claw  heavy FIRE vs DEF; Cripple dropped for a
//                                   flat +25% of the target's max HP, so it
//                                   stays relevant at any level and bites the
//                                   big HP pools hardest.
//   AI            Scorched Claw is the sole always-on filler; Impalement sits
//                 ONE priority above it (weights 3 vs 2 = ~60/40 when a Crisis
//                 target exists); Wyrmbreath drops 6 -> 5 so the picker's
//                 2-priority window still reaches the Claw (at 6 it pushed the
//                 Claw out of the window entirely whenever it was available).
const { getByKey } = require("../lib/db");
const { IDS, L, bullets } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const A = IDS.HF;
const LANCE_NAME = "Impalement";
const CLAW_NAME = "Scorched Claw";
const ZP_NAME = "Zero Power: Reinslaughter";
const CLAW_MAXHP_PCT = 0.25;

const DESC = {
  // The keyword link is what the card promotes into the ◆ badge; the
  // `action_keywords` prop is what the ENGINE reads. Both, deliberately.
  lance: bullets(L.execute) +
    `<p>Deal <strong>devastating</strong> ${L.physical}&nbsp;damage to one creature.</p>`,
  claw:
    `<p>Deal <strong>heavy</strong> ${L.fire}&nbsp;damage to one creature. ` +
    "Damage increases with the target's maximum Hit Points.</p>",
};

run(async ({ changes }) => {
  const ik = (id) => `!actors.items!${A}.${id}`;
  const actor = await getByKey("actors", `!actors!${A}`);
  const lance = await getByKey("actors", ik(IDS.HF_LANCE));
  const claw = await getByKey("actors", ik(IDS.HF_CLAW));
  if (!actor || !lance || !claw) throw new Error("missing Hilde-Fafnir doc");

  // ── Impalement ──────────────────────────────────────────────────────────
  // The rider is retired, not re-scoped: `execute` in action_keywords now
  // carries the rule, so the rename can never silently disable it again.
  lance.name = LANCE_NAME;
  const lp = lance.system.props;
  lp.name = LANCE_NAME;
  lp.action_keywords = "execute";
  lp.description = DESC.lance;
  for (const row of Object.values(lp.reaction_config_table ?? {})) {
    if (row && !row.$deleted) row.$deleted = true;
  }
  for (const row of Object.values(lp.effect_table ?? {})) {
    if (row && !row.$deleted && String(row.effect_label ?? "") === "dl_execute") row.$deleted = true;
  }
  changes.push([ik(IDS.HF_LANCE), lance, `Dragoon Lance -> ${LANCE_NAME}; Execute via keyword, rider retired`]);

  // ── Scorched Claw ───────────────────────────────────────────────────────
  // Cripple's flat ×2 is replaced by a max-HP rider — the same shape Meteor
  // Impact uses (TARGET_MAX_HP, evaluated per victim in the outgoing pass, so
  // it reads the TARGET's sheet and not the caster's). Unconditional: it is her
  // only always-on filler, and the percentage is the point.
  claw.name = CLAW_NAME;
  const cp = claw.system.props;
  cp.name = CLAW_NAME;
  cp.type_damage = "Fire";
  cp.damage_bonus = "52";
  cp.action_keywords = "";
  cp.description = DESC.claw;
  cp.isReaction = true;   // the rider below is dead without it
  cp.reaction_config_table = {
    "0": { $deleted: false, reaction_trigger: "creature_will_deal_damage", reaction_source: "self",
           reaction_source_skill: CLAW_NAME, reaction_passive_mode: "force",
           reaction_effect_ref: "sc_maxhp" },
  };
  cp.effect_table = {
    "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "sc_maxhp",
           damage_operation: "add", damage_stage: "outgoing",
           damage_amount: `floor(TARGET_MAX_HP * ${CLAW_MAXHP_PCT})` },
  };
  changes.push([ik(IDS.HF_CLAW), claw, `Claw -> ${CLAW_NAME}; heavy Fire + ${CLAW_MAXHP_PCT * 100}% max HP, Cripple dropped`]);

  // ── Actor: sheet lists + AI ─────────────────────────────────────────────
  const p = actor.system.props;
  const row = (id, name, extra) => ({ name, id: "${item.id}", uuid: `Actor.${A}.Item.${id}`, roll: "", ...extra });
  p.attack_list = { ...(p.attack_list ?? {}),
    [IDS.HF_LANCE]: row(IDS.HF_LANCE, LANCE_NAME, { active_target: "One Creature",
      attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.lance }),
    [IDS.HF_CLAW]: row(IDS.HF_CLAW, CLAW_NAME, { active_target: "One Creature",
      attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.claw }),
  };

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
      action_pattern_priority: "5", action_pattern_cooldown: "1" }),
    "3": pat(LANCE_NAME, "enemy_has_status", { action_pattern_string: "Crisis",
      action_pattern_priority: "4",
      action_pattern_target_focus: "status_focus", action_pattern_focus_status: "Crisis" }),
    // Spread, per the user: the percentage is the threat, not the target choice.
    "4": pat(CLAW_NAME, "always", { action_pattern_priority: "3" }),
  };
  changes.push([`!actors!${A}`, actor, "actor — attack list renamed, AI ladder 20/12/5/4/3"]);
}, "hilde-fafnir: Impalement + Scorched Claw rework", "actors");
