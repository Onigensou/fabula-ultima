// Roo — L50 soldier, Undead/Spirit, Dark. Fafnir Castle roster.
// A Tonberry parody: it cannot be out-damaged conventionally, it walks at one
// named PC for three turns, and then it deletes them and leaves.
//
// Run from tools/safe-edit; --apply to write.
//
// The whole monster is one clock. Approach ticks on the Roo's own turn_start
// and is the ONLY thing that matters; Empty Stare and Karma are what it does
// with the turns while it closes. HP/DEF are sized so the party can win the
// race, not so they can ignore it.
const { getByKey } = require("../lib/db");
const {
  FOLDER_FAFNIR, DONOR_ACTOR, DONOR_SPELL_ACTOR, DONOR_SPELL, DONOR_PASSIVE,
  link, L, bullets, trig, ICON,
} = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");

const IDS = {
  ROO:          "VwClo606KbQSK6aQ",
  ROO_KNIFE:    "IqytDxaB5BGEtSZZ",
  ROO_STARE:    "pQ3rGV33hyQukJc2",
  ROO_KARMA:    "0HCvn5LC3qIdq3W3",
  ROO_APPROACH: "5nRPZWogdOXD6n2I",
  AE_APPROACH:  "Ak2LIIUCiOnuOXLJ",
  AE_MARKED:    "kvcIK8H8f8jmk4Mc",
  AE_MELEE:     "kQ3us61EvwZsbyQK",
  AE_DRAWN:     "puCRaonxslOGx71x",
};
const A = IDS.ROO;

// Wraith sprite (user-supplied). Note: no `_Standard` suffix, unlike the rest
// of the Bestiary library — do not "correct" it.
const ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Wraith.png";
// Deliberate band placement, NOT a tuned value — the Roo should read SMALL
// against the party's 1.44-1.56 human yardstick (Succubus 1.04 is the
// precedent for going under). Wants the live eyeball pass.
const SCALE = 0.95;

// Icons: reference_generic_action_icons. Chef's Knife is an Active, so it
// takes the Skill Template icon, not the Melee Attack one.
const SK = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/";
const ICON_ACTIVE = SK + "Epic%207/show%20-%202025-07-20T215350.578.png";

const ik = (i) => `!actors.items!${A}.${i}`;
const aek = (i, ae) => `!actors.items.effects!${A}.${i}.${ae}`;

const L_FRIGHT = link("JournalEntry.TOF8epes1eGHwx5J", "Frightened");
const L_CURSE = link("JournalEntry.V8mKI3BdXusfSBLq", "Curse");

// Descriptions — qualitative damage wording, keywords as a leading bullet
// list, never restating what the keyword link already says.
const DESC = {
  knife:
    "<p>The Roo raises a kitchen knife in both hands and buries it in you. " +
    `Deal <strong>devastating</strong>&nbsp;${L.dark}&nbsp;damage to one creature, ignoring ` +
    "its Resistances and Immunities. The Roo then walks away and is gone from the conflict.</p>",
  stare:
    `<p>The lantern turns toward you and does not blink. Inflicts ${L_FRIGHT}&nbsp;on one creature.</p>`,
  karma:
    "<p>A ledger of everything you have killed, read back to you. " +
    `Deal between <strong>1</strong> and <strong>100</strong>&nbsp;${L.dark}&nbsp;damage to one ` +
    `creature and inflict ${L_CURSE}&nbsp;on it.</p>`,
  approach:
    bullets(trig("the start of the <strong>Roo</strong>'s turn")) +
    "<p>The Roo chooses one creature and begins walking toward it. It does not hurry and it does " +
    "not stop. On the third step it arrives within reach, and draws the knife.</p>",
};

// Bestiary voice, one hint in the flavour, unlinked prose.
const STUDY =
  "<p>A small dead thing in a green robe, carrying a lantern and a kitchen knife. " +
  "It does not defend itself and it does not need to — steel and venom pass through it " +
  "like weather, and it is <strong>quicker than it looks</strong> to sidestep a blow.</p>" +
  "<p>It is not hunting the party. It is hunting <strong>one of them</strong>, and it has " +
  "already decided which. Everything else it does is filling the time until it arrives. " +
  "<strong>Whatever it is that finally burns away a grudge, it is not darkness.</strong></p>";

run(async ({ changes }) => {
  const donorActor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  if (!donorActor) throw new Error("missing donor actor (Ampere)");
  const dSpl = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!dSpl) throw new Error("missing donor spell (Fulgur Finis)");
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  if (!dPas) throw new Error("missing donor passive (Volt Counter)");

  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Chef's Knife — an Active, NOT an Attack ─────────────────────────────
  // `kind === "Attack"` forces canMiss=true in freezeActionResult regardless of
  // isCheck (snapshot.js), so an unmissable Attack is not expressible today.
  // War Howl is the precedent for the shape used instead: a check-less skill
  // driven entirely by on_activate_effect_ref.
  //
  // `damage_cause: "damage"` is NOT optional. deal_damage defaults it to
  // "hazard", and a hazard is invisible to every PC reaction filtered on
  // creature-inflicted damage — counters and survival passives. On the one hit
  // in the fight that actually kills someone, that default would silently rob
  // the party of their last answer.
  //
  // `ignore_immunity` is the exact keyword for "ignores Resistances and
  // Immunities": bypassAffinity CLAMPS every rung up to IM down to NE, where
  // `crush` would only step down one and leave an Immune target Resistant.
  const knife = skill(dSpl, IDS.ROO_KNIFE, "Chef's Knife", ICON_ACTIVE, {
    skill_type: "Active", skill_target: "One Random Creature", skill_range: "Melee",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.knife,
    on_activate_effect_ref: "ck_knife",
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "ck_knife",
             chain_steps: "ck_cut, ck_mark" },
      "1": { $deleted: false, effect_kind: "deal_damage", effect_label: "ck_cut",
             damage_amount: "9999", damage_element: "dark",
             damage_keywords: "ignore_immunity", damage_cause: "damage",
             target_ref: "action_targets" },
      "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "ck_mark",
             ae_template_ref: "Knife Drawn", target_ref: "self",
             ae_duplicate_mode: "replace" },
      // Inert directive row, referenced by nothing: resolveActionTargets reads
      // it to narrow the "One Random Creature" roulette to the max-scorer(s)
      // BEFORE the cursor runs, so the knife lands on the creature the Roo has
      // spent three turns walking toward instead of a random body.
      "3": { $deleted: false, effect_kind: "targeting", effect_label: "ck_focus",
             action_pool_focus: true, focus_max_formula: "AE_CHARGES_MARKED" },
      "4": { $deleted: false, effect_kind: "chain", effect_label: "ck_leave",
             chain_steps: "ck_escaped, ck_vanish" },
      // ORDER IS LOAD-BEARING — this row must precede ck_vanish. A solo Roo
      // that knifes and runs empties the enemy side; without the marker,
      // detectOutcome reports "victory" and hands out full EXP/Zenit for a
      // fight the party did not win. ALLY_COUNT excludes self, so == 0 means
      // "I am the last enemy standing"; in a group the fight simply continues
      // and the override is correctly never stamped.
      "5": { $deleted: false, effect_kind: "set_battle_outcome", effect_label: "ck_escaped",
             outcome_value: "escaped", condition_formula: "ALLY_COUNT == 0" },
      "6": { $deleted: false, effect_kind: "leave_combat", effect_label: "ck_vanish",
             target_ref: "self" },
    },
    // The vanish. It cannot live on on_activate_effect_ref — that fire-point
    // runs BEFORE damage applies, so the Roo would leave before the knife
    // landed. turn_end fires after the action has fully resolved.
    // set_battle_outcome is authored BEFORE leave_combat because
    // removeCombatant calls checkSideWipe synchronously; an emptied enemy side
    // otherwise falls through detectOutcome to a full-reward "victory".
    reaction_config_table: {
      "0": {
        $deleted: false,
        reaction_trigger: "turn_end", reaction_source: "self",
        reaction_isPassive: true, reaction_passive_mode: "force",
        condition_formula: "AE_COUNT_KNIFE_DRAWN > 0",
        reaction_effect_ref: "ck_leave",
      },
    },
  });
  // The item holds a string[] of AE ids and each AE lives at its own key. An
  // inline `effects: [{...}]` object is DROPPED on load and every apply_ae
  // against it silently resolves to nothing.
  knife.effects = [IDS.AE_DRAWN];
  changes.push([ik(IDS.ROO_KNIFE), knife,
    "NEW item — Chef's Knife (Active, auto-hit 9999 Dark, ignore_immunity)"]);

  changes.push([aek(IDS.ROO_KNIFE, IDS.AE_DRAWN), {
    _id: IDS.AE_DRAWN, name: "Knife Drawn",
    img: ICON_ACTIVE, icon: ICON_ACTIVE,
    transfer: false, disabled: false, changes: [], statuses: [],
    description: "<p>The blade is out. There is nothing left here for it.</p>",
    duration: {}, origin: `Actor.${A}.Item.${IDS.ROO_KNIFE}`,
    system: { tags: ["roo_marker"] },
    flags: { "fabula-ultima-companion": { crossScene: false, charges: 1, lifetimeMode: "persistent_counter" } },
  }, "NEW AE — Knife Drawn (arms the turn_end vanish)"]);

  // ── Empty Stare ────────────────────────────────────────────────────────
  // Succubus Charm shape: a Spell with NO accuracy roll. Deliberately not a
  // save_check — that path routes through ONI.CheckRequester in interactive
  // mode and cannot be verified solo-GM.
  changes.push([ik(IDS.ROO_STARE), skill(dSpl, IDS.ROO_STARE, "Empty Stare", ICON.ospell, {
    skill_type: "Spell", skill_target: "One Creature", skill_range: "Range",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "mdef",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "3 Rounds", details_roller: "Show",
    action_keywords: "", description: DESC.stare,
    on_activate_effect_ref: "es_fear",
    effect_table: {
      "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "es_fear",
             ae_template_ref: "Frightened", target_ref: "action_targets",
             ae_duplicate_mode: "replace" },
    },
  }), "NEW item — Empty Stare (Frightened, no roll)"]);

  // ── Karma ──────────────────────────────────────────────────────────────
  // roll_dice rather than the randint() formula helper: it routes through the
  // shared ONI.Dice primitive, so the d100 is a real visible roll and the
  // harness can inject a deterministic value.
  changes.push([ik(IDS.ROO_KARMA), skill(dSpl, IDS.ROO_KARMA, "Karma", ICON.ospell, {
    skill_type: "Spell", skill_target: "One Creature", skill_range: "Range",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "mdef",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.karma,
    on_activate_effect_ref: "ka_karma",
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "ka_karma",
             chain_steps: "ka_roll, ka_hit, ka_curse" },
      "1": { $deleted: false, effect_kind: "roll_dice", effect_label: "ka_roll",
             dice_count: "1", dice_faces: "100", prompt_var: "karma" },
      "2": { $deleted: false, effect_kind: "deal_damage", effect_label: "ka_hit",
             damage_amount: "VAR_KARMA", damage_element: "dark",
             damage_cause: "damage", target_ref: "action_targets" },
      // The container AE is named "Cursed", not "Curse" — the journal TERM is
      // "Curse", the effect is "Cursed". ae_template_ref matches the AE.
      "3": { $deleted: false, effect_kind: "apply_ae", effect_label: "ka_curse",
             ae_template_ref: "Cursed", target_ref: "action_targets",
             ae_duplicate_mode: "replace" },
    },
  }), "NEW item — Karma (1-100 Dark + Cursed)"]);

  // ── Approach (signature passive) ───────────────────────────────────────
  // Two turn_start rows, authored MUTUALLY EXCLUSIVE on the charge count so
  // ordering can never matter (the Asura read-after-write bug; Skizzik's
  // Static Buildup is the fixed precedent). Exactly one fires per turn:
  //   charges 0 -> 1, 1 -> 2   (row A, still closing)
  //   charges 2 -> 3           (row B, arrives + In Melee Range)
  //
  // The mark is the FIRST step of both chains, carrying its own
  // condition_formula, rather than a third reaction row — a separate row would
  // reintroduce exactly the ordering race the two-row split exists to avoid.
  // COMBAT_MAX_AE_CHARGES_MARKED == 0 means "nobody on the field is marked",
  // so it self-heals if the marked PC dies or leaves.
  const approach = skill(dPas, IDS.ROO_APPROACH, "Approach", ICON.reaction, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.approach,
    reaction_config_table: {
      "0": {
        $deleted: false,
        reaction_trigger: "turn_start", reaction_source: "self",
        reaction_isPassive: true, reaction_passive_mode: "force",
        condition_formula: "AE_CHARGES_APPROACH < 2",
        reaction_effect_ref: "ap_step",
      },
      "1": {
        $deleted: false,
        reaction_trigger: "turn_start", reaction_source: "self",
        reaction_isPassive: true, reaction_passive_mode: "force",
        condition_formula: "AE_CHARGES_APPROACH >= 2",
        reaction_effect_ref: "ap_arrive",
      },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "ap_step",
             chain_steps: "ap_mark, ap_tick, ap_slide" },
      "1": { $deleted: false, effect_kind: "chain", effect_label: "ap_arrive",
             chain_steps: "ap_mark, ap_tick, ap_melee, ap_slide" },
      // The victim pool: any enemy, one at random, only when nobody is marked.
      "2": { $deleted: false, effect_kind: "targeting", effect_label: "ap_victim",
             candidate_source: "combat", category: "enemy",
             exclude_self: true, mode: "random", count: 1 },
      "3": { $deleted: false, effect_kind: "apply_ae", effect_label: "ap_mark",
             ae_template_ref: "Marked", target_ref: "ap_victim",
             ae_duplicate_mode: "replace",
             condition_formula: "COMBAT_MAX_AE_CHARGES_MARKED == 0" },
      "4": { $deleted: false, effect_kind: "apply_ae", effect_label: "ap_tick",
             ae_template_ref: "Approach", target_ref: "self",
             ae_duplicate_mode: "add_charges", ae_initial_charges: "1" },
      "5": { $deleted: false, effect_kind: "apply_ae", effect_label: "ap_melee",
             ae_template_ref: "In Melee Range", target_ref: "self",
             ae_duplicate_mode: "replace" },
      // The slide. play_animation bridges a passive into the cinematic system;
      // the script on THIS item does the token move and draws the tether.
      // Targeted at the marked creature so the animation knows who to walk at.
      "6": { $deleted: false, effect_kind: "play_animation", effect_label: "ap_slide",
             action_ref: "Approach", target_ref: "ap_target" },
      "7": { $deleted: false, effect_kind: "targeting", effect_label: "ap_target",
             candidate_source: "combat", category: "enemy", exclude_self: true,
             mode: "all", target_filter: "AE_CHARGES_MARKED > 0" },
    },
  });
  approach.effects = [IDS.AE_APPROACH, IDS.AE_MARKED, IDS.AE_MELEE];
  changes.push([ik(IDS.ROO_APPROACH), approach,
    "NEW item — Approach (turn_start clock + token slide)"]);

  // Three markers, embedded on Approach so `ae_template_ref` finds them on the
  // item before it falls through to the world container.
  // persistent_counter on all three: an ordinary AE is reaped at the applier's
  // next turn start, which is exactly when Approach needs to read it back.
  const mk = (id, name, img, tag, charges, desc) => [
    aek(IDS.ROO_APPROACH, id),
    {
      _id: id, name, img, icon: img,
      transfer: false, disabled: false, changes: [], statuses: [],
      description: desc, duration: {},
      origin: `Actor.${A}.Item.${IDS.ROO_APPROACH}`,
      system: { tags: [tag] },
      flags: { "fabula-ultima-companion": { crossScene: false, charges, chargesMax: 3, lifetimeMode: "persistent_counter" } },
    },
    `NEW AE — ${name}`,
  ];

  changes.push(mk(IDS.AE_APPROACH, "Approach", ICON.reaction, "roo_clock", 0,
    "<p>How many steps it has taken. On the third, it is close enough.</p>"));
  changes.push(mk(IDS.AE_MARKED, "Marked", ICON.reaction, "roo_mark", 1,
    "<p>The Roo has chosen you. It is not looking at anyone else.</p>"));
  changes.push(mk(IDS.AE_MELEE, "In Melee Range", ICON_ACTIVE, "roo_marker", 1,
    "<p>It has arrived.</p>"));

  // ── Actor ──────────────────────────────────────────────────────────────
  const a = blankActor(donorActor, A, "Roo", FOLDER_FAFNIR, ART, SCALE);
  const p = a.system.props;
  Object.assign(p, {
    level: "50", npc_rank: "soldier", species: "UNDEAD", subtype_list: "SPIRIT",
    attribute: "DARK",
    traits: "Silent, Patient, Bears a Grudge, Never Hurries",
    dex_base: "10", ins_base: "10", mig_base: "6", wlp_base: "10",
    dex_current: 10, ins_current: 10, mig_current: 6, wlp_current: 10,
    // Highly evasive in BOTH, per spec. This is well above the 12-15 band the
    // design rules give a hard-encounter normal, and it is deliberate: evasion
    // is the gimmick. Measured against the L41 party it means Zarg hits 54%,
    // Hina's magic 70%, Keren 23%, Blanche 23%.
    // Derived = DEX/INS die + mod; written explicitly because a clone carries
    // the DONOR's stored numbers to disk even though CSB recomputes them live.
    def_mod: "+6", mdef_mod: "+6", defense: 16, magic_defense: 16,
    // 255 HP = TP 0.75 (three party actions) x BaselineDPR 105 x M(PE 0.75).
    // Also ~2 spikes, which clears the one-shot floor that any monster
    // designed to survive >=2 turns has to clear — and the Roo needs three.
    max_hp: "255", current_hp: "255", max_mp: "50", current_mp: "50",
    init: "10", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "1100", zenit_reward_max: "1100",
    study_text: STUDY,
    // physical IM + poison IM + dark RS + light VU. The physical Immunity
    // breaks the standing "never Immune to Physical" rule on purpose — it is
    // the Tonberry premise. Zarg keeps a Light mode on his bow so he is not
    // locked out; Blanche is, and that is the cost.
    affinity_1: "IM", affinity_9: "IM", affinity_4: "RS", affinity_8: "VU",
    // Undead species rules. Slow is deliberately left OPEN — delaying the
    // Approach clock is the tactical answer and must stay available.
    condition_poisoned: "IM", condition_envenomed: "IM", condition_zombie: "IM",
    condition_curse: "IM",
    bow_ef: "150", dagger_ef: "75",
  });

  p.skill_active_list = {
    [IDS.ROO_KNIFE]: {
      name: "Chef's Knife", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.ROO_KNIFE}`,
      active_target: "One Random Creature", active_cost: "-", active_duration: "Instantaneous",
      active_description: DESC.knife, roll: "",
    },
  };
  p.normal_spell_list = {
    [IDS.ROO_STARE]: {
      name: "Empty Stare", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.ROO_STARE}`,
      cost: "10 MP", spell_target: "One Creature", duration: "3 Rounds",
      spell_description: DESC.stare, roll: "",
    },
    [IDS.ROO_KARMA]: {
      name: "Karma", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.ROO_KARMA}`,
      cost: "10 MP", spell_target: "One Creature", duration: "Instantaneous",
      spell_description: DESC.karma, roll: "",
    },
  };
  p.skill_passive_list = {
    [IDS.ROO_APPROACH]: {
      name: "Approach", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.ROO_APPROACH}`,
      passive_description: DESC.approach, roll: "",
    },
  };

  // Priorities >=3 apart so exactly ONE candidate survives the weighted window
  // once the clock is full: gap 0/1/2 -> weight 3/2/1, gap >=3 excluded. The
  // Roo must not roll a spell on the turn the fight is supposed to pivot.
  // Empty Stare and Karma sit level at 5 = a 50/50, with applyAntiRepeat's
  // x0.3 producing pleasant alternation between them.
  // A cooldown could not do this job: action_pattern_cooldown is inert on a
  // priority-exclusive row.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Chef's Knife", action_pattern_condition: "self_has_status",
           action_pattern_string: "In Melee Range", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "9", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Empty Stare", action_pattern_condition: "self_lacks_status",
           action_pattern_string: "In Melee Range", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "5", action_pattern_target_focus: "by_affinity",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Karma", action_pattern_condition: "self_lacks_status",
           action_pattern_string: "In Melee Range", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "5", action_pattern_target_focus: "by_affinity",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.ROO_KNIFE, IDS.ROO_STARE, IDS.ROO_KARMA, IDS.ROO_APPROACH];
  changes.push([`!actors!${A}`, a, "NEW actor — Roo (L50 soldier, Undead/Spirit, Dark)"]);
}, "fafnir-castle: Roo");
