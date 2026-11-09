// Deva — L40 elite, Humanoid, Valley of the Dragon story elite. Third of the
// Asura / Rakshasa trio: Asura reads elements, Rakshasa reads weapons, Deva
// reads Strike vs Magic (the CLASS of the check aimed at her: DEF or MDEF).
//
// Design + balance: memory project_deva_monster.md, the Deva Battle Sim and the
// design mockup artifacts (v4.5). Run from tools/safe-edit; --apply to write.
//
// THE ROUND CLOCK. The action pattern's `round` condition reads 0 inside a BD
// battle (BD creates no Foundry Combat), and the pattern has no formula
// condition. So the clock is a passive, Celestial Discipline: lifecycle rows
// (conflict_start / round_start, where ROUND is stamped) lay MARKER AEs, and
// every action is gated on a marker with `self_has_status`.
//   odd rounds  -> Guard Round + a random stance (Vajra DEF+2 / Maya MDEF+2) + Fist Ready
//   even rounds -> Strike Form or Magic Form by the larger stack, stacks reset,
//                  plus the form's Opener marker; on rounds 4, 8, 12 also
//                  Enlightenment Ready (her first action swaps the form).
// Offense order is a marker chain: Opener (area move) -> Fists marker -> the
// form's single-target move for the rest of the round.
//
// STACKS. +1 per attack AIMED at her, hit or miss, by the defence it checked:
// creature_targeted_by_action is the only trigger whose payload carries
// defenseResolved (ATTACK_VS_DEF / ATTACK_VS_MDEF); hit/miss payloads do not.
//
// ⚠ Every marker is lifetimeMode persistent_counter (or BD reaps it at her next
// activation) and every removal sets include_persistent, or it is a silent no-op.
const {
  DONOR_ACTOR, DONOR_ATTACK, DONOR_SPELL_ACTOR, DONOR_SPELL, DONOR_PASSIVE,
  link, L, bullets, trig, ICON,
} = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");
const { getByKey } = require("../lib/db");

const NS = "fabula-ultima-companion";
const FOLDER = "4gMC1IxdJlF59BSi";               // Current Dungeon, with Asura and Rakshasa
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/";
const ART = FORGE + "Deva/Deva_Standard.png";
const IDLE = FORGE + "Deva_Battle_Idle.webm";
const FURY_IDLE = FORGE + "Deva/Deva_Fury_Battle_Idle.webm";
const FOCUS_IDLE = FORGE + "Deva/Deva_Focus_Battle_Idle.webm";

const A = "amxILxU7mqQ0jKhZ";                     // the shell actor made with the sprites (v1.0.574)
const F = "MsFistSummon0001";                     // Missile Fist, the summoned actor
const IDS = {
  DISC: "DvDisciplineP001", VAJRA: "DvVajraFist00001", LANCE: "DvMudraLance0001",
  SLAP: "DvDoubleSlap0001", MFIST: "DvMissileFist001", SLAM: "DvGroundSlam0001",
  FURY: "DvFistsOfFury001", SURYA: "DvSuryaPalm00001", RAHU: "DvRahuEclipse001",
  FOCUS: "DvFistsOfFocus01", KALA: "DvKalaStrike0001", ENL: "DvEnlighten00001",
  F_HOVER: "MsFistHover00001", F_BOOM: "MsFistDetonate01", F_CLOCK: "MsFistFuseClock1", F_FUSE: "MsAeFuse00000001",
};
const ik = (a, i) => `!actors.items!${a}.${i}`;
const aek = (a, i, ae) => `!actors.items.effects!${a}.${i}.${ae}`;

// ── links ──────────────────────────────────────────────────────────────────
const LK = {
  light: link("Item.IQaK3IzvfFp4I1xB", "Light"),
  multi: link("JournalEntry.Gm3upxgpUVoLSK5u", "Multi (2)"),
  chain: link("JournalEntry.ChnStrikeKeyw0rd", "Chain (12)"),
  overflow: link("JournalEntry.NUaxIAIPUu5Qnk8l", "Overflow"),
  blind: link("JournalEntry.rBnvYhLfmrVZDdoW", "Blind"),
  curse: link("JournalEntry.V8mKI3BdXusfSBLq", "Curse"),
  provoked: link("JournalEntry.c4sYPClmvld4TEK8", "Provoked"),
};

// ── action text: rule first, qualitative damage, keywords as a leading list ──
const DESC = {
  disc:
    "<p>On odd rounds Deva guards in one of two stances, drawn at random: <strong>Vajra</strong> " +
    "(higher Defense) or <strong>Maya</strong> (higher Magic Defense).</p>" +
    "<p>Every attack aimed at her, hit or miss, adds a <strong>Strike</strong> stack if it checked her " +
    "Defense or a <strong>Magic</strong> stack if it checked her Magic Defense. On even rounds she takes " +
    "the form the larger stack calls for, <strong>Fury</strong> or <strong>Focus</strong>, and the stacks reset.</p>" +
    `<p>She cannot be ${LK.provoked}.</p>`,
  vajra: `<p>A golden fist of energy forms at her side and drives into one enemy. Deal ${L.physical}&nbsp;damage to one creature. Only usable in Vajra Stance.</p>`,
  lance: `<p>A violet hand forms a mudra and a lance of light leaves the palm. Deal ${LK.light}&nbsp;damage to one creature. Only usable in Maya Stance.</p>`,
  slap: bullets(LK.multi) + `<p>She slaps the insolent aside. Deal ${L.physical}&nbsp;damage and inflict ${L.shaken}.</p>`,
  mfist:
    "<p>Two of her fists burn into being and hover over the field. Each one detonates on a random enemy " +
    "on its second turn, dealing <strong>heavy</strong>&nbsp;" + `${L.physical}&nbsp;damage, unless it is broken first.</p>` +
    "<p>Each fist breaks after taking damage three times.</p>",
  slam: bullets(LK.overflow) + `<p>She drives both fists into the ground. Deal ${L.earth}&nbsp;damage to all enemies and inflict ${L.slow}. Fury form.</p>`,
  fury: bullets(LK.chain) + `<p>A wall of fists slams across the whole field. Deal ${L.physical}&nbsp;damage to all enemies. Fury form.</p>`,
  surya: `<p>She plants a palm of blazing light on one enemy. Deal <strong>heavy</strong>&nbsp;${LK.light}&nbsp;damage and inflict ${LK.blind}. Fury form.</p>`,
  rahu:
    "<p>Rahu's black sun rises over the field and swallows the enemies' magic. Each enemy loses 40% of its " +
    `current MP, then takes ${L.dark}&nbsp;damage equal to 40% of the MP it lost. This cannot miss. Focus form.</p>`,
  focus: `<p>A wall of dark fists slams across the whole field. Deal <strong>light</strong>&nbsp;${L.dark}&nbsp;damage to all enemies; each one hit also loses MP equal to three times the damage it took. Focus form.</p>`,
  kala:
    `<p>She brings a blackened fist down on one enemy. Deal ${L.dark}&nbsp;damage, more the more MP the target is ` +
    `missing; if it hits, the target loses all its remaining MP and is inflicted with ${LK.curse}. Focus form.</p>`,
  enl:
    "<p>Deva sees through the enemies' plan and changes her form: Fury becomes Focus, or Focus becomes Fury. " +
    "She does this at the start of every second offensive round.</p>",
};
const STUDY =
  "A deva of the high places who chose to kneel to Fafnir, and has never once explained why. She fights " +
  "with fists of light that are not attached to anything, and she watches how you fight her before she " +
  "decides how to fight you. Hit her with steel and she answers with steel. Hit her with spells and she " +
  "takes the spells away.";

// ── AE templates ───────────────────────────────────────────────────────────
// hidden markers carry no icon on the token; stances, forms and stacks are visible.
function ae(item, id, name, { tags = [], hidden = false, changes = [], blurb = "", flags = {}, owner = A, icon = ICON.active } = {}) {
  return [aek(owner, item, id), {
    _id: id, name, img: icon, icon, transfer: false, disabled: false, changes, statuses: [],
    description: blurb ? `<p>${blurb}</p>` : "", duration: {}, origin: `Actor.${owner}.Item.${item}`,
    system: { tags },
    flags: { [NS]: { crossScene: false, charges: 1, lifetimeMode: "persistent_counter", ...(hidden ? { hidden: true } : {}), ...flags } },
  }, `NEW AE — ${name}`];
}
const FORM_STRIKE = { tags: ["deva_offense"], blurb: "Fury: her arms burn red.", flags: { poseArt: FURY_IDLE } };
const FORM_MAGIC = { tags: ["deva_offense"], blurb: "Focus: her arms burn blue.", flags: { poseArt: FOCUS_IDLE } };
const MARK = (tag) => ({ tags: [tag], hidden: true });

// ── row helpers ────────────────────────────────────────────────────────────
const put = (label, kind, extra) => ({ $deleted: false, effect_kind: kind, effect_label: label, ...extra });
const applyAe = (label, name, extra = {}) => put(label, "apply_ae", { ae_template_ref: name, target_ref: "self", ae_duplicate_mode: "replace", ...extra });
const removeAe = (label, name, extra = {}) => put(label, "remove_ae", { ae_template_ref: name, target_ref: "self", include_persistent: "true", count: "all", ...extra });
const removeTag = (label, tag) => put(label, "remove_ae", { filter_tag: tag, target_ref: "self", include_persistent: "true", count: "all" });
const chain = (label, steps) => put(label, "chain", { chain_steps: steps.join(",") });
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const react = (trigger, ref, extra = {}) => ({ $deleted: false, reaction_trigger: trigger, reaction_source: "self", reaction_isPassive: true,
  reaction_passive_mode: "force", reaction_effect_ref: ref, reaction_cause_filter: "", reaction_resource_filter: "", ...extra });
const pat = (name, condition, string, priority, extra = {}) => ({ $deleted: false, action_pattern_name: name, action_pattern_condition: condition,
  action_pattern_string: string, action_pattern_value_1: "0", action_pattern_value_2: "100", action_pattern_priority: String(priority),
  action_pattern_target_focus: "auto", action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0", ...extra });

// Strike if its stack is larger; a tie goes to the form NOT taken last time (the first tie, 0/0, is Strike).
const PICK_STRIKE = "(AE_CHARGES_STRIKE_STACK > AE_CHARGES_MAGIC_STACK || (AE_CHARGES_STRIKE_STACK == AE_CHARGES_MAGIC_STACK && AE_COUNT_LAST_FORM_STRIKE == 0))";
const EVEN_FRESH = "ROUND % 2 == 0 && AE_COUNT_STRIKE_FORM + AE_COUNT_MAGIC_FORM == 0";
const ODD_FRESH = "(ROUND % 2 == 1 || ROUND == 0) && AE_COUNT_GUARD_ROUND == 0";

run(async ({ changes }) => {
  const shell = await getByKey("actors", `!actors!${A}`);
  const donorActor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const donorAttack = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const donorPassive = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const donorSpell = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!shell || !donorActor || !donorAttack || !donorPassive || !donorSpell) throw new Error("shell or donor documents missing");
  const skill = (owner, src, id, name, img, props) => makeSkill(src, owner, id, name, img, props);
  const attack = (id, name, props) => skill(A, donorAttack, id, name, ICON.melee, {
    skill_type: "Attack", class: "NPC", check_bonus: "4", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false, details_roller: "Show",
    duration: "Instantaneous", cost: "-", skill_range: "Melee", ...props,
  });
  const active = (owner, id, name, img, props) => skill(owner, donorSpell, id, name, img, {
    skill_type: "Active", skill_target: "Self", skill_range: "-", rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false, cost: "-", duration: "Instantaneous",
    details_roller: "Show", action_keywords: "", ...props,
  });
  // an on-hit rider: for Attack actions creature_deals_damage fires once per STRUCK
  // target (hit or pierce), aimed at that target only. No HP_DEALT gate: the
  // per-target Attack payload carries no finalValue, so HP_DEALT reads 0 there
  // and a gate on it blocks every rider (found live 2026-11-09).
  const rider = (skillName, ref) => react("creature_deals_damage", ref, { reaction_source_skill: skillName });

  // ── Celestial Discipline: the round clock, the stacks, Provoked immunity ──
  const D = IDS.DISC;
  const disc = skill(A, donorPassive, D, "Celestial Discipline", ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-", rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "Scene", details_roller: "Show", action_keywords: "", description: DESC.disc,
    reaction_config_table: table([
      react("creature_targeted_by_action", "st_strike", { condition_formula: "SUBJECT_IS_SELF == 1 && ATTACK_VS_DEF == 1" }),
      react("creature_targeted_by_action", "st_magic", { condition_formula: "SUBJECT_IS_SELF == 1 && ATTACK_VS_MDEF == 1" }),
      // round 1 is laid by conflict_start (ROUND may read 0 there) or round_start, whichever comes first
      react("conflict_start", "guard", { reaction_source: "", condition_formula: ODD_FRESH }),
      react("round_start", "guard", { reaction_source: "", condition_formula: ODD_FRESH }),
      react("round_start", "to_strike", { reaction_source: "", condition_formula: `${EVEN_FRESH} && ${PICK_STRIKE}` }),
      react("round_start", "to_magic", { reaction_source: "", condition_formula: `${EVEN_FRESH} && !${PICK_STRIKE}` }),
      // every Provoke variant is its own AE name ("Provoked (Thread the Horns)"…), so
      // no status filter; the removal names them all (live 2026-11-09)
      react("creature_status_applied", "no_provoke"),
    ]),
    effect_table: table([
      applyAe("st_strike", "Strike Stack", { ae_duplicate_mode: "add_charges", ae_initial_charges: "1" }),
      applyAe("st_magic", "Magic Stack", { ae_duplicate_mode: "add_charges", ae_initial_charges: "1" }),
      chain("guard", ["g_clear_off", "g_clear_st", "g_mark", "g_stance", "g_fist"]),
      removeTag("g_clear_off", "deva_offense"),
      removeTag("g_clear_st", "deva_guard"),
      applyAe("g_mark", "Guard Round"),
      // a fresh draw each Guard round, WITH replacement: the same stance can come up again
      put("g_stance", "apply_ae", { ae_name_pool: "Vajra Stance,Maya Stance", target_ref: "self", ae_duplicate_mode: "replace" }),
      applyAe("g_fist", "Fist Ready"),
      chain("to_strike", ["o_clear", "s_form", "s_open", "s_mem", "o_reset", "o_enl"]),
      chain("to_magic", ["o_clear", "m_form", "m_open", "m_mem", "o_reset", "o_enl"]),
      removeTag("o_clear", "deva_guard"),
      applyAe("s_form", "Strike Form"), applyAe("s_open", "Strike Opener"), applyAe("s_mem", "Last Form Strike", { ae_duplicate_mode: "skip" }),
      applyAe("m_form", "Magic Form"), applyAe("m_open", "Magic Opener"), removeAe("m_mem", "Last Form Strike"),
      removeTag("o_reset", "deva_stack"),
      applyAe("o_enl", "Enlightenment Ready", { condition_formula: "ROUND % 4 == 0" }),
      removeAe("no_provoke", "Provoked,Provoked (Thread the Horns),Provoked (Capote),Provoked (Peacock Dance)"),
    ]),
  });
  disc.effects = [];
  const discAes = [
    ae(D, "DvAeGuardRound01", "Guard Round", MARK("deva_guard")),
    ae(D, "DvAeVajraStance1", "Vajra Stance", { tags: ["deva_guard"], blurb: "A gold rim of light. Her Defense is higher.", changes: [{ key: "defense", mode: 2, value: "2", priority: 20 }] }),
    ae(D, "DvAeMayaStance01", "Maya Stance", { tags: ["deva_guard"], blurb: "A violet rim of light. Her Magic Defense is higher.", changes: [{ key: "magic_defense", mode: 2, value: "2", priority: 20 }] }),
    ae(D, "DvAeFistReady001", "Fist Ready", MARK("deva_guard")),
    ae(D, "DvAeStrikeForm01", "Strike Form", FORM_STRIKE),
    ae(D, "DvAeMagicForm001", "Magic Form", FORM_MAGIC),
    ae(D, "DvAeStrikeOpen01", "Strike Opener", MARK("deva_offense")),
    ae(D, "DvAeMagicOpen001", "Magic Opener", MARK("deva_offense")),
    ae(D, "DvAeEnlReady0001", "Enlightenment Ready", MARK("deva_offense")),
    ae(D, "DvAeStrikeStack1", "Strike Stack", { tags: ["deva_stack"], blurb: "Attacks aimed at her Defense." }),
    ae(D, "DvAeMagicStack01", "Magic Stack", { tags: ["deva_stack"], blurb: "Attacks aimed at her Magic Defense." }),
    ae(D, "DvAeLastStrike01", "Last Form Strike", MARK("deva_memory")),
  ];
  disc.effects = discAes.map((c) => c[1]._id);
  changes.push([ik(A, D), disc, "NEW item — Celestial Discipline (round clock, stacks, Provoked immunity)"]);
  changes.push(...discAes);

  // ── Guard round ────────────────────────────────────────────────────────
  changes.push([ik(A, IDS.VAJRA), attack(IDS.VAJRA, "Vajra Fist", {
    skill_target: "One Creature", rolled_atr1: "MIG", rolled_atr2: "DEX", damage_bonus: "38", type_damage: "Physical",
    action_keywords: "", description: DESC.vajra,
  }), "NEW item — Vajra Fist (Vajra Stance, Physical vs DEF)"]);
  changes.push([ik(A, IDS.LANCE), attack(IDS.LANCE, "Mudra Lance", {
    skill_target: "One Creature", skill_range: "Range", rolled_atr1: "INS", rolled_atr2: "DEX", damage_bonus: "38", type_damage: "Light",
    defense_target_type: "mdef", action_keywords: "", description: DESC.lance,
  }), "NEW item — Mudra Lance (Maya Stance, Light vs MDEF)"]);
  changes.push([ik(A, IDS.SLAP), attack(IDS.SLAP, "Double Slap", {
    skill_target: "Up to two creatures", rolled_atr1: "DEX", rolled_atr2: "MIG", damage_bonus: "25", type_damage: "Physical",
    action_keywords: "multi", description: DESC.slap, isReaction: true,
    reaction_config_table: table([rider("Double Slap", "sl_shaken")]),
    effect_table: table([applyAe("sl_shaken", "Shaken", { target_ref: "trigger_subject" })]),
  }), "NEW item — Double Slap (up to two, Shaken)"]);
  const mfist = active(A, IDS.MFIST, "Missile Fist", ICON.active, {
    description: DESC.mfist, on_activate_effect_ref: "mf_chain",
    effect_table: table([
      chain("mf_chain", ["mf_spend", "mf_summon"]),
      removeAe("mf_spend", "Fist Ready"),
      put("mf_summon", "summon", { summon_actor: `Actor.${F}`, summon_count: "2", summon_max: "2", summon_act_this_round: false }),
    ]),
  });
  changes.push([ik(A, IDS.MFIST), mfist, "NEW item — Missile Fist (summons 2 fists, once per Guard round)"]);

  // ── Offense: Fury (Strike Form) ────────────────────────────────────────
  const slam = attack(IDS.SLAM, "Ground Slam", {
    skill_target: "All Enemies", rolled_atr1: "MIG", rolled_atr2: "DEX", damage_bonus: "30", type_damage: "Earth",
    action_keywords: "overflow", description: DESC.slam, isReaction: true, on_activate_effect_ref: "gs_next",
    reaction_config_table: table([rider("Ground Slam", "gs_slow")]),
    effect_table: table([
      applyAe("gs_slow", "Slow", { target_ref: "trigger_subject" }),
      chain("gs_next", ["gs_spend", "gs_fists"]),
      removeAe("gs_spend", "Strike Opener"),
      applyAe("gs_fists", "Strike Fists"),
    ]),
  });
  slam.effects = ["DvAeStrikeFists1"];
  changes.push([ik(A, IDS.SLAM), slam, "NEW item — Ground Slam (Fury opener, all, Earth, Slow)"]);
  changes.push(ae(IDS.SLAM, "DvAeStrikeFists1", "Strike Fists", MARK("deva_offense")));
  changes.push([ik(A, IDS.FURY), attack(IDS.FURY, "Fists of Fury", {
    skill_target: "All Enemies", rolled_atr1: "MIG", rolled_atr2: "DEX", damage_bonus: "28", type_damage: "Physical",
    action_keywords: "chain 12", description: DESC.fury, on_activate_effect_ref: "ff_spend",
    effect_table: table([removeAe("ff_spend", "Strike Fists")]),
  }), "NEW item — Fists of Fury (all enemies, one roll each, chain 12 ticks)"]);
  changes.push([ik(A, IDS.SURYA), attack(IDS.SURYA, "Surya Palm", {
    skill_target: "One Creature", rolled_atr1: "MIG", rolled_atr2: "DEX", damage_bonus: "62", type_damage: "Light",
    action_keywords: "", description: DESC.surya, isReaction: true,
    reaction_config_table: table([rider("Surya Palm", "sp_blind")]),
    effect_table: table([applyAe("sp_blind", "Blind", { target_ref: "trigger_subject" })]),
  }), "NEW item — Surya Palm (Fury single target, heavy Light, Blind)"]);

  // ── Offense: Focus (Magic Form) ────────────────────────────────────────
  // deal_damage evaluates its amount per target with the VICTIM as the resolver's
  // actor, so CUR_MP is each enemy's own MP. HP first, while CUR_MP is still whole.
  const rahu = active(A, IDS.RAHU, "Rahu's Eclipse", ICON.ospell, {
    skill_target: "All Enemies", skill_range: "Any", description: DESC.rahu, on_activate_effect_ref: "re_chain",
    effect_table: table([
      chain("re_chain", ["re_hp", "re_mp", "re_spend", "re_fists"]),
      put("re_hp", "deal_damage", { damage_amount: "floor(floor(CUR_MP * 0.4) * 0.4)", damage_element: "dark", damage_cause: "damage", target_ref: "action_targets" }),
      put("re_mp", "deal_damage", { damage_amount: "floor(CUR_MP * 0.4)", damage_resource: "mp", damage_element: "dark", damage_cause: "damage", target_ref: "action_targets" }),
      removeAe("re_spend", "Magic Opener"),
      applyAe("re_fists", "Magic Fists"),
    ]),
  });
  rahu.effects = ["DvAeMagicFists01"];
  changes.push([ik(A, IDS.RAHU), rahu, "NEW item — Rahu's Eclipse (Focus opener, all, MP 40% then Dark)"]);
  changes.push(ae(IDS.RAHU, "DvAeMagicFists01", "Magic Fists", MARK("deva_offense")));
  // No `chain` keyword here: its MP rider fires per landed strike and whether
  // HP_DEALT is the tick or the total there is unverified. Ticks can be visual.
  changes.push([ik(A, IDS.FOCUS), attack(IDS.FOCUS, "Fists of Focus", {
    skill_target: "All Enemies", rolled_atr1: "MIG", rolled_atr2: "DEX", damage_bonus: "12", type_damage: "Dark",
    action_keywords: "", description: DESC.focus, isReaction: true, on_activate_effect_ref: "fo_spend",
    reaction_config_table: table([rider("Fists of Focus", "fo_drain")]),
    effect_table: table([
      removeAe("fo_spend", "Magic Fists"),
      // the per-target payload has the roll's HR but no damage value, so 3x the
      // unmodified hit (HR + 12); affinities and Guard are not reflected
      put("fo_drain", "deal_damage", { damage_amount: "3 * (HR + 12)", damage_resource: "mp", damage_element: "dark", damage_cause: "damage", target_ref: "trigger_subject" }),
    ]),
  }), "NEW item — Fists of Focus (all enemies, Dark, MP loss = 3x damage)"]);
  changes.push([ik(A, IDS.KALA), attack(IDS.KALA, "Kala Strike", {
    skill_target: "One Creature", rolled_atr1: "INS", rolled_atr2: "DEX", damage_bonus: "25", type_damage: "Dark",
    defense_target_type: "mdef", action_keywords: "", description: DESC.kala, isReaction: true,
    reaction_config_table: table([
      react("creature_will_deal_damage", "ks_bonus", { reaction_source_skill: "Kala Strike" }),
      rider("Kala Strike", "ks_wipe"),
    ]),
    effect_table: table([
      put("ks_bonus", "adjust_damage", { damage_operation: "add", damage_amount: "floor((TARGET_MAX_MP - TARGET_CURRENT_MP) * 0.3)", damage_stage: "outgoing" }),
      chain("ks_wipe", ["ks_mp", "ks_curse"]),
      put("ks_mp", "deal_damage", { damage_amount: "CUR_MP", damage_resource: "mp", damage_element: "dark", damage_cause: "damage", target_ref: "trigger_subject" }),
      applyAe("ks_curse", "Cursed", { target_ref: "trigger_subject" }),
    ]),
  }), "NEW item — Kala Strike (Focus single target, missing-MP bonus, MP to 0, Curse)"]);

  // ── Enlightenment: rounds 4, 8, 12, her first action: swap the form ─────
  // Two-phase so no step reads a form another step just wrote: note which way
  // to go, clear the offense markers, then lay the new form from the note.
  const E = IDS.ENL;
  const enl = active(A, E, "Enlightenment", ICON.spell, {
    description: DESC.enl, on_activate_effect_ref: "en_chain",
    effect_table: table([
      chain("en_chain", ["en_ready", "en_pm", "en_ps", "en_clear", "en_m1", "en_m2", "en_s1", "en_s2", "en_done"]),
      removeAe("en_ready", "Enlightenment Ready"),
      applyAe("en_pm", "Swap To Magic", { condition_formula: "AE_COUNT_STRIKE_FORM > 0" }),
      applyAe("en_ps", "Swap To Strike", { condition_formula: "AE_COUNT_MAGIC_FORM > 0" }),
      removeTag("en_clear", "deva_offense"),
      applyAe("en_m1", "Magic Form", { condition_formula: "AE_COUNT_SWAP_TO_MAGIC > 0" }),
      applyAe("en_m2", "Magic Opener", { condition_formula: "AE_COUNT_SWAP_TO_MAGIC > 0" }),
      applyAe("en_s1", "Strike Form", { condition_formula: "AE_COUNT_SWAP_TO_STRIKE > 0" }),
      applyAe("en_s2", "Strike Opener", { condition_formula: "AE_COUNT_SWAP_TO_STRIKE > 0" }),
      removeTag("en_done", "deva_swap"),
    ]),
  });
  const enlAes = [
    ae(E, "DvAeEnStrikeFrm1", "Strike Form", FORM_STRIKE), ae(E, "DvAeEnMagicFrm01", "Magic Form", FORM_MAGIC),
    ae(E, "DvAeEnStrikeOpn1", "Strike Opener", MARK("deva_offense")), ae(E, "DvAeEnMagicOpn01", "Magic Opener", MARK("deva_offense")),
    ae(E, "DvAeSwapToMagic1", "Swap To Magic", MARK("deva_swap")), ae(E, "DvAeSwapToStrik1", "Swap To Strike", MARK("deva_swap")),
  ];
  enl.effects = enlAes.map((c) => c[1]._id);
  changes.push([ik(A, E), enl, "NEW item — Enlightenment (rounds 4/8/12: Fury <-> Focus)"]);
  changes.push(...enlAes);

  // ── Deva actor: rebuilt over the shell, keeping its sprite wiring ──────
  const a = JSON.parse(JSON.stringify(shell));
  const p = a.system.props;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (/^condition_/.test(k)) { p[k] = "NA"; continue; }
    if (/^affinity_[1-9]$/.test(k)) { p[k] = "NA"; continue; }
    if (/_ef$/.test(k)) { p[k] = "100"; continue; }
    if (/^(extra_damage_mod_|damage_receiving_mod_|check_mod_)/.test(k)) { p[k] = 0; continue; }
    if (typeof v === "boolean") { p[k] = false; continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) { p[k] = {}; continue; }
  }
  Object.assign(p, {
    name: "Deva", id: A, img: ART, sprite_standard: ART, sprite_battle: IDLE,
    cut_in_critical: ART, cut_in_fumble: ART, cut_in_zero_power: ART,
    level: "40", species: "Humanoid", npc_rank: "elite", activation: "4", subtype_list: "", attribute: "",
    traits: "Arrogant · Devoted to Fafnir · Respects strength · Reads how you fight",
    dex_base: "10", ins_base: "10", mig_base: "10", wlp_base: "8",
    def_mod: "+2", mdef_mod: "+2", defense: 12, magic_defense: 12,
    max_hp: "1000", current_hp: "1000", max_mp: "100", current_mp: "100",
    init: "12", max_zero: "6", ultima_points: "3", zenit_reward_min: "1400", zenit_reward_max: "1400",
    study_text: STUDY,
    // the rule for every solo elite (Charm), plus the design's own three; Provoked is the passive's job
    condition_charm: "IM", condition_frightened: "IM", condition_fatigue: "IM",
  });
  if ("uuid" in p) p.uuid = `Actor.${A}`;
  a.img = ART;
  a.items = Object.values(IDS).filter((id) => id.startsWith("Dv"));

  const entry = (id, extra) => ({ id: "${item.id}", uuid: `Actor.${A}.Item.${id}`, roll: "", ...extra });
  p.attack_list = {
    [IDS.VAJRA]: entry(IDS.VAJRA, { name: "Vajra Fist", active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.vajra }),
    [IDS.LANCE]: entry(IDS.LANCE, { name: "Mudra Lance", active_target: "One Creature", attribute_die1: "INS", attribute_die2: "DEX", attack_description: DESC.lance }),
    [IDS.SLAP]: entry(IDS.SLAP, { name: "Double Slap", active_target: "Up to two creatures", attribute_die1: "DEX", attribute_die2: "MIG", attack_description: DESC.slap }),
    [IDS.SLAM]: entry(IDS.SLAM, { name: "Ground Slam", active_target: "All Enemies", attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.slam }),
    [IDS.FURY]: entry(IDS.FURY, { name: "Fists of Fury", active_target: "All Enemies", attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.fury }),
    [IDS.SURYA]: entry(IDS.SURYA, { name: "Surya Palm", active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.surya }),
    [IDS.FOCUS]: entry(IDS.FOCUS, { name: "Fists of Focus", active_target: "All Enemies", attribute_die1: "MIG", attribute_die2: "DEX", attack_description: DESC.focus }),
    [IDS.KALA]: entry(IDS.KALA, { name: "Kala Strike", active_target: "One Creature", attribute_die1: "INS", attribute_die2: "DEX", attack_description: DESC.kala }),
  };
  p.skill_active_list = {
    [IDS.MFIST]: entry(IDS.MFIST, { name: "Missile Fist", active_target: "Self", active_cost: "-", active_duration: "Instantaneous", active_description: DESC.mfist }),
    [IDS.RAHU]: entry(IDS.RAHU, { name: "Rahu's Eclipse", active_target: "All Enemies", active_cost: "-", active_duration: "Instantaneous", active_description: DESC.rahu }),
    [IDS.ENL]: entry(IDS.ENL, { name: "Enlightenment", active_target: "Self", active_cost: "-", active_duration: "Instantaneous", active_description: DESC.enl }),
  };
  p.skill_passive_list = { [IDS.DISC]: entry(IDS.DISC, { name: "Celestial Discipline", passive_description: DESC.disc }) };
  p.normal_spell_list = {};

  // ── Enemy AI: one marker per step; priority gaps of >= 3 make each step exclusive ──
  p.action_pattern_table = table([
    pat("Enlightenment", "self_has_status", "Enlightenment Ready", 14),
    pat("Missile Fist", "self_has_status", "Fist Ready", 12),
    pat("Ground Slam", "self_has_status", "Strike Opener", 11),
    pat("Rahu's Eclipse", "self_has_status", "Magic Opener", 11),
    pat("Fists of Fury", "self_has_status", "Strike Fists", 11),
    pat("Fists of Focus", "self_has_status", "Magic Fists", 11),
    pat("Surya Palm", "self_has_status", "Strike Form", 6),
    pat("Kala Strike", "self_has_status", "Magic Form", 6),
    pat("Double Slap", "self_has_status", "Guard Round", 6),
    pat("Vajra Fist", "self_has_status", "Vajra Stance", 6),
    pat("Mudra Lance", "self_has_status", "Maya Stance", 6),
  ]);
  for (const bad of ["Asura", "0AwQ7wEDz4ISA9mA"]) if (JSON.stringify(a).includes(bad)) throw new Error(`"${bad}" survives in Deva`);
  changes.push([`!actors!${A}`, a, "Deva actor — L40 elite Humanoid, 1000 HP, 4 activations, kit + AI"]);

  // ── Missile Fist: the summoned actor ───────────────────────────────────
  const fist = blankActor(donorActor, F, "Missile Fist", FOLDER, ICON.melee, 1);
  const fp = fist.system.props;
  for (const k of Object.keys(fp)) if (/^condition_/.test(k)) fp[k] = "IM";
  Object.assign(fp, {
    level: "40", species: "Construct", npc_rank: "soldier", activation: "1",
    traits: "One of Deva's fists, loosed", dex_base: "10", ins_base: "10", mig_base: "6", wlp_base: "6",
    def_mod: "+3", mdef_mod: "+3", defense: 13, magic_defense: 13,
    max_hp: "3", current_hp: "3", max_mp: "0", current_mp: "0", init: "6",
    zenit_reward_min: "0", zenit_reward_max: "0",
    study_text: "A fist of light that has left its owner. It counts down, and then it finds someone.",
  });
  const fdesc = {
    clock: bullets(trig("this fist takes damage")) + "<p>It takes 1 damage, whatever hit it. It breaks after three hits.</p>",
    hover: "<p>The fist hangs in the air and counts down.</p>",
    boom: `<p>The fist rockets into a random enemy and explodes. Deal <strong>heavy</strong>&nbsp;${L.physical}&nbsp;damage. This cannot miss. The fist is destroyed.</p>`,
  };
  const clock = skill(F, donorPassive, IDS.F_CLOCK, "Fuse", ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-", rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "Scene", details_roller: "Show", action_keywords: "", description: fdesc.clock,
    reaction_config_table: table([
      react("turn_start", "fu_tick"),
      react("creature_takes_damage", "fu_cap"),
    ]),
    effect_table: table([
      applyAe("fu_tick", "Fuse", { ae_duplicate_mode: "add_charges", ae_initial_charges: "1" }),
      put("fu_cap", "adjust_damage", { damage_stage: "incoming", damage_operation: "cap", damage_amount: "1" }),
    ]),
  });
  clock.effects = [IDS.F_FUSE];
  const hover = active(F, IDS.F_HOVER, "Hover", ICON.active, { description: fdesc.hover });
  const boom = active(F, IDS.F_BOOM, "Detonate", ICON.active, {
    description: fdesc.boom, on_activate_effect_ref: "fd_chain",
    effect_table: table([
      chain("fd_chain", ["fd_hit", "fd_die"]),
      put("fd_victim", "targeting", { candidate_source: "combat", category: "enemy", exclude_self: true, mode: "random", count: 1 }),
      put("fd_hit", "deal_damage", { damage_amount: "60", damage_element: "physical", damage_cause: "damage", target_ref: "fd_victim" }),
      put("fd_die", "destroy_summon", { target_ref: "self" }),
    ]),
  });
  changes.push([ik(F, IDS.F_CLOCK), clock, "NEW item — Missile Fist: Fuse (turn clock + 1-damage cap)"]);
  changes.push(ae(IDS.F_CLOCK, IDS.F_FUSE, "Fuse", { tags: ["deva_fuse"], blurb: "Counting down.", owner: F }));
  changes.push([ik(F, IDS.F_HOVER), hover, "NEW item — Missile Fist: Hover"]);
  changes.push([ik(F, IDS.F_BOOM), boom, "NEW item — Missile Fist: Detonate (60, random enemy, no roll)"]);
  fist.items = [IDS.F_CLOCK, IDS.F_HOVER, IDS.F_BOOM];
  fp.skill_active_list = {
    [IDS.F_HOVER]: { name: "Hover", id: "${item.id}", uuid: `Actor.${F}.Item.${IDS.F_HOVER}`, active_target: "Self", active_cost: "-", active_duration: "Instantaneous", active_description: fdesc.hover, roll: "" },
    [IDS.F_BOOM]: { name: "Detonate", id: "${item.id}", uuid: `Actor.${F}.Item.${IDS.F_BOOM}`, active_target: "Self", active_cost: "-", active_duration: "Instantaneous", active_description: fdesc.boom, roll: "" },
  };
  fp.skill_passive_list = { [IDS.F_CLOCK]: { name: "Fuse", id: "${item.id}", uuid: `Actor.${F}.Item.${IDS.F_CLOCK}`, passive_description: fdesc.clock, roll: "" } };
  // turn 1 (Fuse 1): hover; turn 2 (Fuse 2): detonate
  fp.action_pattern_table = table([
    pat("Detonate", "effect_stacks", "Fuse", 9, { action_pattern_value_1: "2", action_pattern_value_2: "0" }),
    pat("Hover", "always", "", 2),
  ]);
  changes.push([`!actors!${F}`, fist, "NEW actor — Missile Fist (summon, DEF/MDEF 13, 3 HP, 1-damage cap)"]);
}, "valley-of-the-dragon: Deva");
