// Succubus — L50 soldier, Fafnir Castle (Demon / Seductress, Dark).
// The debuffer. Its damage is nearly irrelevant; what it does is take a PC's
// turn away and point it at the party. Run from tools/safe-edit; --apply to
// write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, bullets, trig, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.SU;

const STUDY =
  "<p>Court records from the last three reigns list the same lady-in-waiting, and every portrait of her " +
  "was painted from a different description. She has never once been seen to strike anybody. " +
  "The <strong>casualty figures</strong> from the palace halls are nonetheless entirely her work.</p>";

const DESC = {
  rake: `<p>Deal <strong>light</strong> ${L.dark}&nbsp;damage to one creature.</p>`,
  charm:
    `<p>The target rolls a <strong>DL15 【INS】+【WLP】</strong> check — <strong>on a failure,</strong> ` +
    `they suffer ${L.charm}.</p>`,
  kiss:
    `<p>Deal ${L.dark}&nbsp;damage to one creature. The Succubus takes back half of everything it costs them.</p>`,
  tempt:
    bullets(trig("a creature is Charmed by the Succubus")) +
    "<p>During their turn, they must spend their action to perform a harmful action against an ally.</p>",
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dPas || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Rake — bread and butter, deliberately weak ──────────────────────────
  changes.push([ik(IDS.SU_RAKE), skill(dAtk, IDS.SU_RAKE, "Rake", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "WLP",
    check_bonus: "5", damage_bonus: "18", type_damage: "Dark", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.rake,
  }), "NEW item — Rake"]);

  // ── Charm — the whole monster ───────────────────────────────────────────
  // Structurally identical to Fafnir's Draconic Domination (the shipped
  // implementation of this exact rule), with the user's DL and attributes:
  // a Spell with NO accuracy roll, driven by `on_activate_effect_ref`.
  //
  // Two AEs land together, and the split matters:
  //   "Charmed"           — the UNIVERSAL status AE (statuses ["fud-charmed"]).
  //                         Keeping it universal is what makes player
  //                         `condition_charm` IM/RS gear and ordinary cures
  //                         work against this monster; a bespoke facsimile
  //                         would silently bypass all of it.
  //   "Deadly Temptation" — the rider that does the compelling. Flagged
  //                         riderOf: "Charmed", so curing the Charm takes the
  //                         compulsion with it and there is no orphan left
  //                         driving a PC into their own party.
  changes.push([ik(IDS.SU_CHARM), skill(dSpl, IDS.SU_CHARM, "Charm", ICON.charm, {
    skill_type: "Spell", skill_target: "One Enemy", skill_range: "Range",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "mdef",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "3 Rounds", details_roller: "Show",
    action_keywords: "", description: DESC.charm,
    on_activate_effect_ref: "sc_charm",
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "sc_charm",
             chain_steps: "sc_save,sc_hold,sc_tempt" },
      "1": { $deleted: false, effect_kind: "save_check", effect_label: "sc_save",
             target_ref: "action_targets", save_attr1: "ins", save_attr2: "wlp", save_dl: "15" },
      "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "sc_hold",
             ae_template_ref: "Charmed", target_ref: "save_failed_targets",
             ae_duplicate_mode: "replace" },
      "3": { $deleted: false, effect_kind: "apply_ae", effect_label: "sc_tempt",
             ae_template_ref: "Deadly Temptation", target_ref: "save_failed_targets",
             ae_duplicate_mode: "replace" },
    },
  }), "NEW item — Charm (DL15 INS+WLP save; Charmed + Deadly Temptation)"]);

  // ── Draining Kiss — life theft ─────────────────────────────────────────
  // The heal rides `creature_deals_damage`, the POST-resolve attacker-side
  // hook that exists for exactly this ("Drain-Spirit-style grants that fire
  // after damage commits", director-triggers.js). It has to be post-resolve:
  // HP_DEALT is not known at the pre-resolve `creature_will_deal_damage`
  // stage, so the same row wired there would heal 0.
  // `reaction_source_skill` scopes the drain to THIS spell, so Rake never
  // leaks a heal.
  //
  // `isReaction: true` even though this is an offensive Spell, not a reaction:
  // the flag means "this item carries reaction rows", and the legacy collector
  // (reaction-triggerCore.js:1002) hard-skips any item without it, so the drain
  // would silently never fire. 77 of the world's 85 non-Passive items with
  // reaction rows set it; Mana Ray's Volt Stinger is the exact precedent
  // (an Active on `creature_deals_damage`). Caught by api.lint.runReactionLint
  // (REACTION_FLAG_MISSING), not by inspection.
  changes.push([ik(IDS.SU_KISS), skill(dSpl, IDS.SU_KISS, "Draining Kiss", ICON.ospell, {
    skill_type: "Spell", skill_target: "One Enemy", skill_range: "Melee",
    rolled_atr1: "INS", rolled_atr2: "WLP",
    check_bonus: "5", damage_bonus: "32", type_damage: "Dark", defense_target_type: "mdef",
    isCheck: true, isOffensiveSpell: true, isReaction: true,
    cost: "20 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.kiss,
    reaction_config_table: {
      "0": { $deleted: false, reaction_trigger: "creature_deals_damage",
             reaction_source: "self", reaction_source_skill: "Draining Kiss",
             reaction_passive_mode: "force",
             condition_formula: "HP_DEALT > 0",
             reaction_effect_ref: "sk_drain",
             reaction_cause_filter: "", reaction_resource_filter: "" },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "grant", effect_label: "sk_drain",
             grant_resource: "hp", grant_amount: "ceil(HP_DEALT * 0.5)", target_ref: "self" },
    },
  }), "NEW item — Draining Kiss (heals half of HP dealt)"]);

  // ── Deadly Temptation — display passive over the rider AE ───────────────
  // The rules text the players read. The AE of the same name in the shared
  // Debuff container is what the engine actually runs; this item deliberately
  // carries NO automation so there is one source of truth for the compulsion.
  changes.push([ik(IDS.SU_TEMPT), skill(dPas, IDS.SU_TEMPT, "Deadly Temptation", ICON.charm, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.tempt,
  }), "NEW item — Deadly Temptation (passive)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Succubus", FOLDER_FAFNIR, ART.SU, SCALE.SU);
  const p = a.system.props;
  Object.assign(p, {
    level: "50", npc_rank: "soldier", species: "DEMON", subtype_list: "FIEND",
    attribute: "DARK",
    traits: "Patient, Vain, Collects Favours, Never Strikes First",
    dex_base: "10", ins_base: "10", mig_base: "6", wlp_base: "12",
    dex_current: 10, ins_current: 10, mig_current: 6, wlp_current: 12,
    def_mod: "+2", mdef_mod: "+4", defense: 12, magic_defense: 14,
    // 180 HP ~= 1.1 TP. It is meant to be killable in a focused round — the
    // counterplay to a save-or-lose-your-turn monster is that it dies if you
    // agree to spend the turn.
    max_hp: "180", current_hp: "180", max_mp: "140", current_mp: "140",
    init: "11", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "110", zenit_reward_max: "150",
    study_text: STUDY,
    // Demon species picks two resistances. Light is the VU.
    affinity_4: "RS", affinity_7: "RS", affinity_8: "VU",
    // Immune to what it deals in, and nothing else. Leaves slow/weak/dazed/
    // poisoned/shaken open — a wide-open debuff surface is the payment for a
    // monster that debuffs this hard.
    condition_charm: "IM", condition_confused: "IM", condition_enraged: "IM",
    arcane_ef: "150", heavy_ef: "60",
  });

  p.attack_list = {
    [IDS.SU_RAKE]: { name: "Rake", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.SU_RAKE}`,
                     active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "WLP",
                     attack_description: DESC.rake, roll: "" },
  };
  p.normal_spell_list = {
    [IDS.SU_CHARM]: { name: "Charm", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.SU_CHARM}`,
                      cost: "10 MP", spell_target: "One Enemy", duration: "3 Rounds",
                      spell_description: DESC.charm, roll: "" },
    [IDS.SU_KISS]: { name: "Draining Kiss", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.SU_KISS}`,
                     cost: "20 MP", spell_target: "One Enemy", duration: "Instantaneous",
                     spell_description: DESC.kiss, roll: "" },
  };
  p.skill_passive_list = {
    [IDS.SU_TEMPT]: { name: "Deadly Temptation", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.SU_TEMPT}`,
                      passive_description: DESC.tempt, roll: "" },
  };

  // Charm is priority-EXCLUSIVE (>=3 clear of everything), so it fires every
  // turn it is legal, and the cooldown is what paces it — on an exclusive row
  // the anti-repeat weighting can never reach it, so a cooldown is the ONLY
  // brake available. 2 turns means the party gets a turn between compulsions
  // to cure or to kill.
  // `creature_has_status` + string "Charmed" also stops it re-casting on a
  // party that already has someone under it.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Charm", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "8", action_pattern_value_2: "100",
           action_pattern_priority: "9", action_pattern_target_focus: "highest_hp",
           action_pattern_cooldown: "2", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Draining Kiss", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "15", action_pattern_value_2: "100",
           action_pattern_priority: "5", action_pattern_target_focus: "by_affinity",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Rake", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "2", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.SU_RAKE, IDS.SU_CHARM, IDS.SU_KISS, IDS.SU_TEMPT];
  changes.push([`!actors!${A}`, a, "NEW actor — Succubus (L50 soldier, Demon/Fiend, Dark)"]);
}, "fafnir-castle: Succubus");
