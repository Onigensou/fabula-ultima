// Carlbero — L50 ELITE, Fafnir Castle (Plant / Malboro parody). SOLO ONLY.
//
// Four activations on an elite chassis, Asura-style: the rank is elite but the
// action economy is a champion's, which is why it never appears alongside
// anything else. Its identity is the MP loop — Stinky Breath is a 50-of-80 spike
// that has to be re-earned by grabbing a PC and draining them, so the fight has
// a clock the party can read and interfere with (kill the grapple, starve the
// breath).
//
// Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK,
        DONOR_SPELL_ACTOR, DONOR_SPELL, L, bullets, ICON, ART, SCALE } = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const A = IDS.CB;

const STUDY =
  "<p>Growers in the lower terraces still plant it deliberately. Nothing else keeps the vermin down so " +
  "thoroughly, and it will not move from where it is rooted — a perfectly safe arrangement, provided " +
  "nobody walks the row downwind of it. The <strong>terraces below the palace</strong> have not been " +
  "harvested in eleven years.</p>";

// Damage wording is QUALITATIVE (never the math). Numbers that are NOT damage —
// the DL, the MP figures — stay, because those are readable clocks.
const DESC = {
  slap:
    bullets(`${L.multi}<strong>&nbsp;3</strong>`) +
    `<p>Deal <strong>heavy</strong> ${L.physical}&nbsp;damage to the target.</p>`,
  grab:
    `<p>Deal <strong>heavy</strong> ${L.physical}&nbsp;damage to one creature. The target rolls a ` +
    `<strong>DL13 【DEX】+【MIG】</strong> check — <strong>on a failure,</strong> they suffer ` +
    `${L.grappled}.</p>`,
  sap:
    `<p>Deal <strong>heavy</strong> ${L.dark}&nbsp;damage to a ${L.grappled}&nbsp;creature and drain ` +
    `<strong>10 MP</strong> from them, which Carlbero takes for itself.</p>`,
  breath:
    `<p>Every enemy rolls a <strong>DL16 【INS】+【WLP】</strong> check and takes ${L.poison}&nbsp;damage. ` +
    `<strong>The lower they roll, the more the rot takes hold</strong> — a poor result leaves them ` +
    `weakened, a bad one costs them what they can do, and the worst of them start to come apart.</p>`,
};

// ── Stinky Breath: the tier table ──────────────────────────────────────────
// Six CUMULATIVE buckets on the save's roll TOTAL (save_check's `save_tiers`).
// A target sits in every tier its total falls at or below, so one row per tier
// lands one status per tier — 16+ walks away clean, 6 or less eats all six.
//
// Pools escalate in KIND, not just count:
//   Basic  — shrinks a die (the six official FU statuses)
//   Denial — takes away an action COMMAND. All five members are `disable_action`
//            changes and between them they cover every command exactly once, so
//            two no-repeat draws always leave a PC three of their five, plus
//            Guard and Inventory. The move can never fully lock anyone out; that
//            falls out of the pool, not a special case.
//   Rot    — attacks RECOVERY: Burn ticks HP, Cursed ticks MP, Bleed halves
//            incoming healing, Wither blocks mana gain, Envenomed punishes
//            acting, Blind degrades every accuracy roll.
//
// `ae_pool_skip_existing` is mandatory here: six draws from three pools WITH
// replacement collide constantly, and a collision reads at the table as "the
// status did nothing". Without it this move silently under-delivers.
const POOL = {
  basic:  "Slow, Dazed, Weak, Shaken, Poisoned, Enraged",
  denial: "Frightened, Paralyzed, Silence, Disarmed, Confused",
  rot:    "Burn, Blind, Envenomed, Cursed, Bleed, Wither",
};
// Tier rows: [tier target_ref, pool, duration override].
// Disarmed, Confused, Blind and Wither carry no native charges (scene-long by
// default), so every Denial and Rot row pins an explicit 2-turn duration rather
// than leaving four of the eleven members permanent. The Basic pool's six all
// have native 3-turn charges and are left alone.
const TIERS = [
  ["save_tier_1", POOL.basic,  ""],
  ["save_tier_2", POOL.basic,  ""],
  ["save_tier_3", POOL.denial, "2"],
  ["save_tier_4", POOL.denial, "2"],
  ["save_tier_5", POOL.rot,    "2"],
  ["save_tier_6", POOL.rot,    "2"],
];

const breathEffectTable = () => {
  const t = {
    "0": { $deleted: false, effect_kind: "chain", effect_label: "cb_breath",
           chain_steps: ["cb_save", "cb_dmg", ...TIERS.map((_, i) => `cb_t${i + 1}`)].join(",") },
    // Silent vs interactive: interactive opens a roll panel on each PC's own
    // client, which is where the Fabula Point invoke lives — spending one to
    // climb a tier is the best moment this move has. It also HANGS with the
    // players offline, which is why the tier logic is verified on silent first.
    "1": { $deleted: false, effect_kind: "save_check", effect_label: "cb_save",
           target_ref: "action_targets",
           save_attr1: "ins", save_attr2: "wlp", save_dl: "16",
           save_mode: "interactive", save_tiers: "16,14,12,10,8,6" },
    // Damage lands on EVERY target, pass or fail — the save sizes the rot, it
    // does not dodge the cloud.
    "2": { $deleted: false, effect_kind: "deal_damage", effect_label: "cb_dmg",
           target_ref: "action_targets", damage_resource: "hp",
           damage_element: "poison", damage_amount: "20", damage_cause: "damage" },
  };
  TIERS.forEach(([ref, pool, dur], i) => {
    t[String(i + 3)] = {
      $deleted: false, effect_kind: "apply_ae", effect_label: `cb_t${i + 1}`,
      target_ref: ref, ae_name_pool: pool, ae_pool_skip_existing: "1",
      ae_duplicate_mode: "replace", ae_duration_rounds: dur,
    };
  });
  return t;
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dSpl) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Tentacle Slap — Multi 3 ─────────────────────────────────────────────
  // "Up to four creatures" is Multi 3 spelled the way the engine reads it (the
  // `multi` keyword itself is registry/tooltip only — nothing branches on it).
  // Both parsers handle the word form: actionReader-parseTargetRule's up-to
  // regex and target-survey's extractTargetCountFromText.
  changes.push([ik(IDS.CB_SLAP), skill(dAtk, IDS.CB_SLAP, "Tentacle Slap", ICON.melee, {
    skill_type: "Attack", skill_target: "Up to four creatures", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    check_bonus: "5", damage_bonus: "40", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "multi", description: DESC.slap,
  }), "NEW item — Tentacle Slap (Multi 3, heavy Physical)"]);

  // ── Tentacle Grab — the setup ───────────────────────────────────────────
  // Grappled is CODE-BACKED (grappled.js): applying it auto-applies the
  // reciprocal "Grappling" to Carlbero, which is what gates this action's own
  // pattern row, and it drops itself the moment the victim breaks free. So the
  // "don't re-grab while I already hold someone" brake needs no marker AE and
  // no cooldown — the engine maintains it.
  // It also drags the shared-space rule in: while Carlbero holds a PC, a
  // third-party effect aimed at Carlbero splashes that PC too. Attacking the
  // monster hurts your own grappled ally, which is a real cost the party has to
  // weigh, and exactly the right texture for this monster.
  changes.push([ik(IDS.CB_GRAB), skill(dAtk, IDS.CB_GRAB, "Tentacle Grab", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    check_bonus: "5", damage_bonus: "35", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.grab,
    on_activate_effect_ref: "cb_grab",
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "cb_grab",
             chain_steps: "cb_gsave,cb_ghold" },
      "1": { $deleted: false, effect_kind: "save_check", effect_label: "cb_gsave",
             target_ref: "action_targets", save_attr1: "dex", save_attr2: "mig",
             save_dl: "13", save_mode: "interactive" },
      "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "cb_ghold",
             ae_template_ref: "Grappled", target_ref: "save_failed_targets",
             ae_duplicate_mode: "skip" },
    },
  }), "NEW item — Tentacle Grab (DL13 DEX+MIG save; Grappled)"]);

  // ── Mind Sap — the refuel ───────────────────────────────────────────────
  // Drains 10, not 25, on purpose: Stinky Breath leaves 30 of 80 MP, so TWO
  // Saps put it back over the 50 it needs. At 25 a single Sap re-arms the
  // breath and it fires every round, which is not the "cast it, then work for
  // the next one" loop this monster is built around.
  //
  // The drain is one grant row per side: MP off the victim, the same MP onto
  // Carlbero. Post-resolve (`creature_deals_damage`) so the hit has committed,
  // and `reaction_source_skill` scopes it to this action so nothing else leaks
  // a drain. isReaction:true because the item carries reaction rows at all —
  // without it the collector hard-skips them and the drain silently never runs.
  changes.push([ik(IDS.CB_SAP), skill(dSpl, IDS.CB_SAP, "Mind Sap", ICON.ospell, {
    skill_type: "Active", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "INS", rolled_atr2: "WLP",
    check_bonus: "5", damage_bonus: "50", type_damage: "Dark", defense_target_type: "mdef",
    isCheck: true, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.sap,
    reaction_config_table: {
      "0": { $deleted: false, reaction_trigger: "creature_deals_damage",
             reaction_source: "self", reaction_source_skill: "Mind Sap",
             reaction_passive_mode: "force",
             condition_formula: "HP_DEALT > 0",
             reaction_effect_ref: "cb_sap",
             reaction_cause_filter: "", reaction_resource_filter: "" },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "cb_sap",
             chain_steps: "cb_sap_take,cb_sap_gain" },
      // The take is deal_damage on the MP resource, not a negative grant: that
      // is the house idiom for MP burn (Cursed's tick uses it), it clamps at 0
      // and it fires the -N MP loss VFX the players need to see.
      "1": { $deleted: false, effect_kind: "deal_damage", effect_label: "cb_sap_take",
             target_ref: "hit_action_targets", damage_resource: "mp",
             damage_element: "dark", damage_amount: "10", damage_cause: "damage" },
      "2": { $deleted: false, effect_kind: "grant", effect_label: "cb_sap_gain",
             grant_resource: "mp", grant_amount: "10", target_ref: "self" },
    },
  }), "NEW item — Mind Sap (heavy Dark on a Grappled target; drains 10 MP to self)"]);

  // ── Stinky Breath — the signature ───────────────────────────────────────
  changes.push([ik(IDS.CB_BREATH), skill(dSpl, IDS.CB_BREATH, "Stinky Breath", ICON.ospell, {
    skill_type: "Spell", skill_target: "All Enemies", skill_range: "Range",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "mdef",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "50 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.breath,
    on_activate_effect_ref: "cb_breath",
    effect_table: breathEffectTable(),
  }), "NEW item — Stinky Breath (50 MP; DL16 INS+WLP, six cumulative debuff tiers)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Carlbero", FOLDER_FAFNIR, ART.CB, SCALE.CB);
  const p = a.system.props;
  Object.assign(p, {
    level: "50", npc_rank: "elite", species: "PLANT", subtype_list: "ABERRATION",
    attribute: "POISON",
    traits: "Rooted, Patient, Ravenous, Never Retreats",
    dex_base: "8", ins_base: "10", mig_base: "12", wlp_base: "10",
    dex_current: 8, ins_current: 10, mig_current: 12, wlp_current: 10,
    def_mod: "+3", mdef_mod: "+4", defense: 11, magic_defense: 14,
    // 640 HP: 3.5 rounds against a solo target (Spread 1.00, ~230 effective DPR
    // measured off Asura's 900/4-rounds at this party tier) = ~805, less ~172
    // for the action-denial economy — the debuffs take party actions away, and
    // per the balance doc an economy factor is paid out of HP, never out of PE.
    // Well clear of the ~130 one-shot floor, so all four activations deliver.
    max_hp: "640", current_hp: "640", max_mp: "80", current_mp: "80",
    // Elite rank, CHAMPION action economy. The whole build is sized around this
    // number; changing it changes every damage figure downstream.
    activation: "4",
    init: "11", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "900", zenit_reward_max: "1200",
    study_text: STUDY,
    // Plant species must take a VU from air/bolt/fire/ice. Fire is the classic
    // answer to a Malboro and the party can manufacture it through Zarg's
    // infusions, so the "right answer" is reachable without being native.
    // Poison and Dark are the RS pair — it deals in both.
    affinity_6: "VU", affinity_9: "RS", affinity_4: "RS",
    // Plant is innately immune to dazed/shaken/enraged; poisoned + envenomed on
    // top because it IS the poison. That leaves SLOW and WEAK fully open, which
    // is the house rule's two-open-basics quota exactly.
    condition_dazed: "IM", condition_shaken: "IM", condition_enraged: "IM",
    condition_poisoned: "IM", condition_envenomed: "IM",
    // Bow rewarded, brawling punished — walking into arm's reach of the mouth
    // is the wrong idea, and saying so in the EF table is cheaper than a rule.
    bow_ef: "150", brawling_ef: "75",
  });

  const U = (id) => `Actor.${A}.Item.${id}`;
  p.attack_list = {
    [IDS.CB_SLAP]: { name: "Tentacle Slap", id: "${item.id}", uuid: U(IDS.CB_SLAP),
                     active_target: "Up to four creatures", attribute_die1: "DEX", attribute_die2: "MIG",
                     attack_description: DESC.slap, roll: "" },
    [IDS.CB_GRAB]: { name: "Tentacle Grab", id: "${item.id}", uuid: U(IDS.CB_GRAB),
                     active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "MIG",
                     attack_description: DESC.grab, roll: "" },
  };
  p.skill_active_list = {
    [IDS.CB_SAP]: { name: "Mind Sap", id: "${item.id}", uuid: U(IDS.CB_SAP),
                    active_target: "One Creature", active_cost: "-", active_duration: "Instantaneous",
                    active_description: DESC.sap, roll: "" },
  };
  p.normal_spell_list = {
    [IDS.CB_BREATH]: { name: "Stinky Breath", id: "${item.id}", uuid: U(IDS.CB_BREATH),
                       cost: "50 MP", spell_target: "All Enemies", duration: "Instantaneous",
                       spell_description: DESC.breath, roll: "" },
  };

  // ── AI pattern ──────────────────────────────────────────────────────────
  // Stinky Breath sits 4 clear of everything, so it is EXCLUSIVE the moment it
  // is affordable — the fight should always pivot on it rather than roll a
  // basic attack that turn. Its gate is a PERCENT RANGE, not a threshold:
  // 50 MP of 80 is 62.5%, and the reader takes ceil(cur/max*100), so 63-100 is
  // "can afford one cast" and 50-100 would fire it at 40 MP and fail the cost
  // check.
  //
  // The other three sit one apart (6/5/4) so they COMPETE rather than dominate
  // — weights 3/2/1 among whichever are legal, with anti-repeat nudging it off
  // whatever it did last turn. Spacing them 3 apart instead would make Mind Sap
  // exclusive whenever anything was grappled, and the monster would chain-drain
  // one PC for the whole fight and never swing the Multi 3.
  //
  // Mind Sap's `status_focus:Grappled` narrows its pick to the held victim;
  // `enemy_has_status` keeps the row from coming up at all when nobody is held.
  // Grab's `self_lacks_status: Grappling` reads the reciprocal AE the engine
  // maintains, so it re-grabs exactly when the last grapple has ended.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Stinky Breath", action_pattern_condition: "mp",
           action_pattern_string: "", action_pattern_value_1: "63", action_pattern_value_2: "100",
           action_pattern_priority: "10", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Mind Sap", action_pattern_condition: "enemy_has_status",
           action_pattern_string: "Grappled", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "6", action_pattern_target_focus: "status_focus:Grappled",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Tentacle Grab", action_pattern_condition: "self_lacks_status",
           action_pattern_string: "Grappling", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "5", action_pattern_target_focus: "lowest_hp",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "3": { $deleted: false, action_pattern_name: "Tentacle Slap", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "4", action_pattern_target_focus: "by_affinity",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.CB_SLAP, IDS.CB_GRAB, IDS.CB_SAP, IDS.CB_BREATH];
  changes.push([`!actors!${A}`, a, "NEW actor — Carlbero (L50 elite, Plant, 4 activations, solo)"]);
}, "fafnir-castle: Carlbero");
