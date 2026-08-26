// Drakoza — L43 soldier, Valley of the Dragon (Beast/Dragon, Dark).
// A midrange bruiser built around one question: can you put it down before it
// swings back? Every point of damage it takes is banked as Fury; Thrash spends
// the whole tally in one hit. Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { IDS, FOLDER_CURRENT_DUNGEON, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE, L, bullets, trig, ICON } = require("./_dragon-lib");
const { blankActor, run } = require("./_dragon-util");

const A = IDS.DRAKOZA;
// "Deakoza" is genuinely how the asset is named on the Forge (200/13608 bytes);
// "Drakoza.png" 404s. Do not "correct" this.
const ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Deakoza.png";

const STUDY =
  "<p>A runt of the dragon line, all temper and no cunning — but it <strong>remembers</strong> " +
  "every wound, and pays the whole tally back in a single swing. Hunters who take their time " +
  "with it tend not to come back.</p>";

const DESC = {
  claw: `<p>Deal ${L.physical}&nbsp;damage to one creature.</p>`,
  tail: bullets(`${L.multi}<strong>&nbsp;2</strong>`) +
        `<p>Deal <strong>light</strong> ${L.physical}&nbsp;damage.</p>`,
  thrash: bullets(trig("the Drakoza is holding <strong>Fury</strong>")) +
        `<p>It empties every wound it has taken into one swing — the more it has been hurt, the harder this lands — and its <strong>Fury</strong> is spent.</p>`,
  fury: `<p>Every point of damage the Drakoza suffers is banked as <strong>Fury</strong>. It does not flinch and it does not forget; the tally waits for <strong>Thrash</strong>.</p>`,
};

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  if (!donor || !dAtk || !dPas) throw new Error("missing donor doc");

  const ik = (id) => `!actors.items!${A}.${id}`;
  const aek = (item, ae) => `!actors.items.effects!${A}.${item}.${ae}`;

  // Clone-don't-construct: an item built from scratch misses template-stamped
  // props. Every inherited automation table is cleared before the override.
  const skill = (src, id, name, img, props) => {
    const d = JSON.parse(JSON.stringify(src));
    d._id = id; d.name = name; d.img = img; d.effects = [];
    d.folder = null; d.ownership = { default: 0 };
    for (const k of ["reaction_config_table", "effect_table", "optional_params", "active_effect_config_table"]) {
      d.system.props[k] = {};
    }
    Object.assign(d.system.props, {
      name, img, id: "${item.id}", uuid: `Actor.${A}.Item.${id}`,
      check_bonus: "7", level: "1", max_level: "1", class: "NPC",
      ae_chance_percent: "", ae_template_ref: "",
    }, props);
    return d;
  };

  // ── Dragon Claw — bread and butter ──────────────────────────────────────
  changes.push([ik(IDS.DK_CLAW), skill(dAtk, IDS.DK_CLAW, "Dragon Claw", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "DEX",
    damage_bonus: "20", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.claw,
  }), "NEW item — Dragon Claw"]);

  // ── Tail Swipe — spread chip ────────────────────────────────────────────
  changes.push([ik(IDS.DK_TAIL), skill(dAtk, IDS.DK_TAIL, "Tail Swipe", ICON.melee, {
    skill_type: "Attack", skill_target: "Up to three creatures", skill_range: "Melee",
    rolled_atr1: "DEX", rolled_atr2: "MIG",
    damage_bonus: "12", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "multi", description: DESC.tail,
  }), "NEW item — Tail Swipe"]);

  // ── Thrash — spends the whole Fury tally ────────────────────────────────
  // `reaction_source_skill` scopes the spend to THIS attack, so Claw and Tail
  // Swipe never leak the bank. `adjust_damage` (add/outgoing) is read at CONFIRM
  // by computeSenderDamageBonuses, so the card previews the real number; the
  // clear fires at RESOLVE, after the damage lands. `include_persistent` is
  // mandatory — Fury is a persistent_counter and the remove is a silent no-op
  // without it.
  //
  // ⚠ This row MUST NOT be `add_damage`. That kind is RETIRED (superseded by
  // adjust_damage, skill-effects.js:2278) and fails twice silently: the
  // accumulator matches only `adjust_damage` + stage "outgoing", AND the kind is
  // absent from EFFECT_KIND_DISPATCH so the CHAIN ABORTS on it and never reaches
  // thrash_spend — Fury would then never be consumed. Caught only by a live
  // fight (fixed in 6c0a657b); inspection cannot see it.
  changes.push([ik(IDS.DK_THRASH), skill(dAtk, IDS.DK_THRASH, "Thrash", ICON.melee, {
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "MIG",
    damage_bonus: "18", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.thrash,
    reaction_config_table: {
      "0": {
        reaction_trigger: "creature_will_deal_damage", reaction_source: "self",
        reaction_source_skill: "Thrash", reaction_passive_mode: "force",
        condition_formula: "AE_CHARGES_FURY > 0",
        reaction_effect_ref: "thrash_payback",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
    },
    effect_table: {
      "0": { effect_kind: "chain", effect_label: "thrash_payback", chain_steps: "thrash_bonus, thrash_spend" },
      "1": { effect_kind: "adjust_damage", effect_label: "thrash_bonus",
             damage_operation: "add", damage_stage: "outgoing",
             damage_amount: "ceil(AE_CHARGES_FURY * 0.5)" },
      "2": { effect_kind: "remove_ae", effect_label: "thrash_spend", ae_template_ref: "Fury",
             include_persistent: true, count: "all", target_ref: "self" },
    },
  }), "NEW item — Thrash (spends Fury)"]);

  // ── Drako Fury — banks damage taken ─────────────────────────────────────
  // `creature_takes_damage` is DEAD on an item (registered, but nothing
  // dispatches it to item-hosted reaction configs), so this rides the resource
  // ledger instead. `reaction_cause_filter` deliberately blank: a Burn tick is
  // still a wound it remembers. TRIGGER_AMOUNT is the size of the loss.
  const fury = skill(dPas, IDS.DK_FURY, "Drako Fury", ICON.reaction, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    damage_bonus: "0", type_damage: "", check_bonus: "0", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "-", details_roller: "Show",
    action_keywords: "", description: DESC.fury,
    reaction_config_table: {
      "0": {
        reaction_trigger: "creature_lose_resource", reaction_resource_filter: "hp",
        reaction_source: "", reaction_cause_filter: "",
        reaction_passive_mode: "force",
        condition_formula: "SUBJECT_IS_SELF == 1 && TRIGGER_AMOUNT > 0",
        reaction_effect_ref: "fury_bank",
      },
    },
    effect_table: {
      "0": { effect_kind: "apply_ae", effect_label: "fury_bank", ae_template_ref: "Fury",
             target_ref: "self", ae_duplicate_mode: "add_charges", ae_initial_charges: "TRIGGER_AMOUNT" },
    },
  });
  fury.effects = [IDS.DK_FURY_AE];
  changes.push([ik(IDS.DK_FURY), fury, "NEW item — Drako Fury (banks damage taken)"]);

  // The AE lives at its OWN key with the item holding a string[] of ids — an
  // inline `effects: [{...}]` object is dropped on load and every apply_ae
  // silently resolves to nothing. persistent_counter, or the counter is reaped
  // at Drakoza's own next turn start, before Thrash ever gets to spend it.
  changes.push([aek(IDS.DK_FURY, IDS.DK_FURY_AE), {
    _id: IDS.DK_FURY_AE, name: "Fury",
    img: ICON.reaction, icon: ICON.reaction,
    transfer: false, disabled: false, changes: [], statuses: [],
    description: "<p>Every wound, remembered. Thrash spends the whole tally.</p>",
    duration: {}, origin: `Actor.${A}.Item.${IDS.DK_FURY}`,
    system: { tags: ["fury"] },
    flags: { "fabula-ultima-companion": { crossScene: false, charges: 0, lifetimeMode: "persistent_counter" } },
  }, "NEW AE — Fury (persistent_counter, uncapped)"]);

  // ── Actor ───────────────────────────────────────────────────────────────
  const a = blankActor(donor, A, "Drakoza", FOLDER_CURRENT_DUNGEON, ART, 1.64);
  const p = a.system.props;
  Object.assign(p, {
    level: "43", npc_rank: "soldier", species: "BEAST", subtype_list: "DRAGON",
    attribute: "DARK",
    traits: "Spiteful, Territorial, Scarred Hide, Never Backs Down",
    dex_base: "8", ins_base: "8", mig_base: "12", wlp_base: "10",
    dex_current: 8, ins_current: 8, mig_current: 12, wlp_current: 10,
    // defense/magic_defense are DERIVED (DEX die + def_mod), but a clone carries
    // the DONOR's stored numbers to disk even though CSB recomputes them live —
    // so write the correct derived value rather than inheriting a wrong one.
    def_mod: "+3", mdef_mod: "+2", defense: 11, magic_defense: 10,
    // 140 HP ~= 4 party actions at the settled design point (PE 17% -> ~34
    // damage per action). The 4th usually kills it; a focused round-one spike
    // can end it on the 3rd. That gap is the fight.
    max_hp: "140", current_hp: "140", max_mp: "60", current_mp: "60",
    init: "8", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "180", zenit_reward_max: "260",
    study_text: STUDY,
    // exactly one VU, one RS. Light is deliberate: the party's bow already
    // switches to Light, so the martial holds the answer to a race-the-clock
    // monster.
    affinity_4: "RS",
    affinity_8: "VU",
    // past fear, past anger — leaves slow/dazed/weak/poisoned fully open
    condition_frightened: "IM", condition_enraged: "IM", condition_shaken: "IM",
    sword_ef: "150", arcane_ef: "75",
  });

  // CSB renders the sheet from these LIST props, not from the items. They hold
  // their own copy of the description, so both must be kept in sync.
  p.attack_list = {
    [IDS.DK_CLAW]: { name: "Dragon Claw", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DK_CLAW}`,
                     active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "DEX",
                     attack_description: DESC.claw, roll: "" },
    [IDS.DK_TAIL]: { name: "Tail Swipe", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DK_TAIL}`,
                     active_target: "Up to three creatures", attribute_die1: "DEX", attribute_die2: "MIG",
                     attack_description: DESC.tail, roll: "" },
    [IDS.DK_THRASH]: { name: "Thrash", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DK_THRASH}`,
                       active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "MIG",
                       attack_description: DESC.thrash, roll: "" },
  };
  p.skill_passive_list = {
    [IDS.DK_FURY]: { name: "Drako Fury", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.DK_FURY}`,
                     passive_description: DESC.fury, roll: "" },
  };

  // Priority is a weighted 2-gap window, not "highest wins": gap 0/1/2 -> weight
  // 3/2/1, gap >=3 excluded. Thrash at 10 is >=3 clear of everything, so it is
  // EXCLUSIVE once armed — and needs no cooldown (which would be inert on an
  // exclusive row anyway) because spending Fury drops the stack back under the
  // threshold by itself. Below it, Tail Swipe (5) likewise excludes Dragon Claw
  // (2), so `random 40` reads as an exact 40/60 instead of a weight-skewed split.
  p.action_pattern_table = {
    "0": { $deleted: false, action_pattern_name: "Thrash", action_pattern_condition: "effect_stacks",
           action_pattern_string: "Fury", action_pattern_value_1: "30", action_pattern_value_2: "",
           action_pattern_priority: "10", action_pattern_target_focus: "lowest_hp",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "1": { $deleted: false, action_pattern_name: "Tail Swipe", action_pattern_condition: "random",
           action_pattern_string: "", action_pattern_value_1: "40", action_pattern_value_2: "",
           action_pattern_priority: "5", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "2": { $deleted: false, action_pattern_name: "Dragon Claw", action_pattern_condition: "always",
           action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
           action_pattern_priority: "2", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [IDS.DK_CLAW, IDS.DK_TAIL, IDS.DK_THRASH, IDS.DK_FURY];
  changes.push([`!actors!${A}`, a, "NEW actor — Drakoza (L43 soldier, Beast/Dragon, Dark)"]);
});
