// Mana Gorger + Life Gorger — L15 soldiers, the THIEF half of the Gorger family.
//
// Both are formalizations, not new monsters: the actors predate Battle Director
// and carried ZERO automation (every reaction_config_table / effect_table empty,
// Puff Up still on the retired active_effect_config_table, spells still shaped as
// PC Elementalist facets). Ids are reused so anything already pointing at them
// keeps resolving.
//
// The design in one line: neither of these wants to fight you. Each eats one
// thing — your MP or half your HP — and then spends every remaining turn trying
// to leave. Kill it before it goes and it gives back what it took.
//
// Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const {
  IDS, FOLDER_MONSTER, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE,
  L, bullets, trig, ICON, ART, eatenAE,
} = require("./_gorger-lib");
const { blankActor, run } = require("./_dragon-util");

const STUDY = {
  mana:
    "<p>A drifting sac of stolen magic, and the reason apprentices are told to " +
    "count their reserves twice. It has no interest in hurting anyone — only in " +
    "<strong>drinking</strong> — and the moment it is full it wants nothing more than " +
    "to be somewhere else. Spellwork slides off the thing. The mages who deal with " +
    "them best have mostly given up casting and simply <strong>hit it with the staff</strong>.</p>",
  life:
    "<p>The Mana Gorger's greedier cousin. It takes one bite of whatever is living " +
    "and nearest, then bolts with its cheeks full. Its hide turns blades aside with " +
    "insulting ease, but nobody ever taught it to ward off a <strong>spell</strong>.</p>",
};

const DESC = {
  consumeMana:
    "<p>The Gorger latches on and drinks. Whatever magic the target was holding is " +
    "simply gone — their <strong>MP is reduced to 0</strong>.</p>",
  consumeLife:
    "<p>The Gorger takes a bite out of whatever is keeping the target upright, " +
    "halving their <strong>current HP</strong>.</p>",
  runAway:
    "<p>Cheeks full, the Gorger turns to leave. The party makes a <strong>DL 15</strong> " +
    "<strong>【DEX + INS】</strong> Group Check — on a failure it slips away and the " +
    "conflict carries on without it.</p>",
  manaResidue:
    bullets(trig("the <strong>Mana Gorger</strong> is reduced to 0 HP")) +
    "<p>If it had <strong>Eaten</strong>, everything it swallowed comes back out at once. " +
    "The creature that struck it down fully recovers <strong>MP</strong>.</p>",
  lifeResidue:
    bullets(trig("the <strong>Life Gorger</strong> is reduced to 0 HP")) +
    "<p>If it had <strong>Eaten</strong>, the stolen vitality snaps back to its owner. " +
    "The creature that struck it down fully recovers <strong>HP</strong>.</p>",
};

// ── the shared Run Away chain ───────────────────────────────────────────────
// `escape_party` is NOT listed in chain_steps: resolveTargetRef looks a
// targeting row up BY LABEL, so naming it in group_check's target_ref is what
// pulls it in. Listing it too would just resolve it twice (memoized, harmless)
// and reads as though the chain needed it.
//
// gc_timeout is set deliberately. This runs inside a combat turn, and CR's
// default (null) waits forever — one disconnected player would hang the fight.
function runAwayTables() {
  return {
    on_activate_effect_ref: "run_away",
    effect_table: {
      "0": { effect_label: "run_away", effect_kind: "chain",
             chain_steps: "escape_check, escape_flee" },
      "1": { effect_label: "escape_party", effect_kind: "targeting",
             candidate_source: "combat", category: "enemy",
             exclude_self: true, mode: "all" },
      "2": { effect_label: "escape_check", effect_kind: "group_check",
             target_ref: "escape_party",
             gc_attr1: "dex", gc_attr2: "ins", gc_dl: "15",
             gc_var: "escape", gc_mode: "designated",
             gc_helper_bonus: "1", gc_timeout: "60000", gc_on_error: "fail" },
      // VAR_ESCAPE is 1 when the leader PASSED (the party pinned it down) and 0
      // on a failure, so the flee is gated on == 0.
      "3": { effect_label: "escape_flee", effect_kind: "leave_combat",
             target_ref: "self", condition_formula: "VAR_ESCAPE == 0" },
    },
  };
}

// ── the shared Residue chain ────────────────────────────────────────────────
// on-DEATH must be `creature_defeated` with reaction_source "self".
// `creature_lose_resource` + CUR_HP<=0 does NOT work for a self on-death burst:
// the builtin defeat removal runs first and collectReactors skips the defeated
// subject. defeat-reactor emits creature_defeated INLINE, before removal.
//
// `cause_actor` is the creature that KILLED it (payload.causeTokenUuid), which
// is a different thing from trigger_actor — on this trigger the subject is the
// dying Gorger itself.
//
// set_resource is raise-only, which is exactly right for a full restore and
// exactly wrong for the drain on the Consume skills (they use deal_damage).
function residueTables(resource) {
  return {
    reaction_config_table: {
      "0": {
        reaction_trigger: "creature_defeated",
        reaction_source: "self",
        reaction_passive_mode: "force",
        condition_formula: "AE_CHARGES_EATEN >= 1",
        reaction_effect_ref: "residue_give",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
    },
    effect_table: {
      "0": { effect_label: "residue_give", effect_kind: "set_resource",
             grant_resource: resource, grant_amount: resource === "mp" ? "MAX_MP" : "MAX_HP",
             target_ref: "cause_actor" },
    },
  };
}

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk  = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas  = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  if (!donor || !dAtk || !dPas) throw new Error("missing donor doc");

  // The loot items are carried forward verbatim — they are ordinary consumables
  // and there is nothing about them this rebuild should change.
  const manaLoot = await getByKey("actors", `!actors.items!${IDS.MANA}.${IDS.MG_LOOT}`);
  const lifeLoot = await getByKey("actors", `!actors.items!${IDS.LIFE}.${IDS.LG_LOOT}`);
  if (!manaLoot || !lifeLoot) throw new Error("missing loot item — refusing to drop it");

  const skill = (actorId, src, id, name, img, props) => {
    const d = JSON.parse(JSON.stringify(src));
    d._id = id; d.name = name; d.img = img; d.effects = [];
    d.folder = null; d.ownership = { default: 0 };
    for (const k of ["reaction_config_table", "effect_table", "optional_params", "active_effect_config_table"]) {
      d.system.props[k] = {};
    }
    Object.assign(d.system.props, {
      name, img, id: "${item.id}", uuid: `Actor.${actorId}.Item.${id}`,
      level: "1", max_level: "1", class: "NPC",
      check_bonus: "1", damage_bonus: "0", type_damage: "",
      ae_chance_percent: "", ae_template_ref: "",
      details_roller: "Show", action_keywords: "",
      isFacet: false, isHeroic: false, isZeroPower: false,
    }, props);
    return d;
  };

  // ── shared prop block ─────────────────────────────────────────────────────
  // "Very high" here means ~18, which is the top of the whole bestiary (the
  // campaign's current ceiling is Fafnir/Malflorus at 16-18). "Moderately high"
  // is ~13. The pair is the same monster with the two numbers swapped, so the
  // party's answer to one is the wrong answer to the other.
  const common = {
    level: "15", npc_rank: "soldier", species: "ELEMENTAL", subtype_list: "GORGER",
    gorger: true,
    max_hp: "30", current_hp: "30", max_mp: "200", current_mp: "200",
    // Fast on purpose: eat-then-run only reads as a heist if it moves first.
    // 12 is joint-4th in the bestiary and top of the soldier band.
    init: "12",
    zenit_reward_min: "5", zenit_reward_max: "10",
    // The donor is an Ampere (max_zero "6"). Filler chaff has no Zero Power and
    // no Ultima Points; blankActor only neutralises booleans/objects/affinities,
    // so a plain numeric string like this rides along unless it is overridden.
    max_zero: "0", zero_power_value: "0", ultima_point: "0", activation: "1",
    // Elemental species house rule.
    condition_poisoned: "IM", condition_envenomed: "IM", condition_zombie: "IM",
    // Mindless and fearless. Slow and Weak are left fully OPEN — Slow in
    // particular is the party's lever against a monster whose whole plan is to
    // leave, so it must not be closed off.
    condition_frightened: "IM", condition_enraged: "IM",
    condition_shaken: "IM", condition_dazed: "IM",
    // 125% arcane / 75% everything else. NOTE this only touches WEAPON attacks:
    // damage-ruleset treats EF as inert for spells, so arcane_ef is the staff or
    // tome swung as a club, not the casting. On the Mana Gorger that is the
    // whole puzzle (MDEF 18 walls off spells, so the mage hits it instead); on
    // the Life Gorger it is near-decorative, kept for family symmetry.
    arcane_ef: "125",
    bow_ef: "75", brawling_ef: "75", dagger_ef: "75", firearm_ef: "75",
    flail_ef: "75", heavy_ef: "75", spear_ef: "75", sword_ef: "75", thrown_ef: "75",
  };

  // ══ MANA GORGER ══════════════════════════════════════════════════════════
  {
    const A = IDS.MANA;
    const ik = (id) => `!actors.items!${A}.${id}`;

    // Consume Mana — deal_damage on the MP route. This is NOT consume_resource:
    // that kind evaluates its amount ONCE against the REACTOR (describeConsumeResource
    // builds the resolver from ctx.reactorActor), so `CUR_MP` there would read the
    // GORGER's pool. deal_damage's amount is evaluated PER VICTIM, so CUR_MP is the
    // target's. damage_resource "mp" clamps at 0 and skips affinity/shield/crisis.
    const consume = skill(A, dAtk, IDS.MG_CONSUME, "Consume Mana", ICON.consume, {
      skill_type: "Active", skill_target: "One Creature", skill_range: "Range",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      isCheck: false, isOffensiveSpell: false, isReaction: false,
      cost: "-", duration: "Instantaneous", description: DESC.consumeMana,
      on_activate_effect_ref: "consume_chain",
      effect_table: {
        "0": { effect_label: "consume_chain", effect_kind: "chain",
               chain_steps: "consume_drain, consume_feed" },
        "1": { effect_label: "consume_drain", effect_kind: "deal_damage",
               target_ref: "action_targets",
               damage_resource: "mp", damage_amount: "CUR_MP",
               damage_element: "elementless", damage_ignore_affinity: true,
               damage_cause: "damage" },
        "2": { effect_label: "consume_feed", effect_kind: "apply_ae",
               ae_template_ref: "Eaten", target_ref: "self",
               ae_duplicate_mode: "skip" },
      },
    });
    consume.effects = [IDS.MG_EATEN_AE];
    changes.push([ik(IDS.MG_CONSUME), consume, "Consume Mana — drains MP to 0, then feeds"]);

    changes.push([`!actors.items.effects!${A}.${IDS.MG_CONSUME}.${IDS.MG_EATEN_AE}`,
      eatenAE(IDS.MG_EATEN_AE, A, IDS.MG_CONSUME, "It has fed. Now it only wants to leave."),
      "AE — Eaten (persistent_counter)"]);

    changes.push([ik(IDS.MG_RUN), skill(A, dAtk, IDS.MG_RUN, "Run Away", ICON.run, {
      skill_type: "Active", skill_target: "Self", skill_range: "Any",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      isCheck: false, isOffensiveSpell: false, isReaction: false,
      cost: "-", duration: "Instantaneous", description: DESC.runAway,
      ...runAwayTables(),
    }), "Run Away — DL 15 DEX+INS Group Check or it leaves (was 'Flee')"]);

    changes.push([ik(IDS.MG_RESIDUE), skill(A, dPas, IDS.MG_RESIDUE, "Mana Residue", ICON.residue, {
      skill_type: "Passive", skill_target: "-", skill_range: "-",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      check_bonus: "0",
      isCheck: false, isOffensiveSpell: false, isReaction: true,
      cost: "-", duration: "-", description: DESC.manaResidue,
      ...residueTables("mp"),
    }), "Mana Residue — killer regains all MP if it had Eaten"]);

    changes.push([ik(IDS.MG_LOOT), manaLoot, "Mega-Elixir — carried forward unchanged"]);

    const a = blankActor(donor, A, "Mana Gorger", FOLDER_MONSTER, ART + "Mana%20Eater.png", 1.0);
    Object.assign(a.system.props, common, {
      attribute: "DARK",
      traits: "Gorger, Elemental Creature, Dark-Align, Cowardly",
      dex_base: "8", ins_base: "10", mig_base: "6", wlp_base: "8",
      dex_current: 8, ins_current: 10, mig_current: 6, wlp_current: 8,
      // A clone carries the DONOR's stored defense/magic_defense to disk even
      // though CSB recomputes them live — so write the correct derived value.
      def_mod: "+5", mdef_mod: "+8", defense: 13, magic_defense: 18,
      affinity_4: "RS",   // dark
      affinity_8: "VU",   // light
      study_text: STUDY.mana,
    });
    const p = a.system.props;
    p.skill_active_list = {
      [IDS.MG_CONSUME]: { name: "Consume Mana", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MG_CONSUME}`,
                          active_target: "One Creature", active_cost: "-", active_duration: "Instantaneous",
                          active_description: DESC.consumeMana, roll: "" },
      [IDS.MG_RUN]:     { name: "Run Away", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MG_RUN}`,
                          active_target: "Self", active_cost: "-", active_duration: "Instantaneous",
                          active_description: DESC.runAway, roll: "" },
    };
    p.skill_passive_list = {
      [IDS.MG_RESIDUE]: { name: "Mana Residue", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MG_RESIDUE}`,
                          passive_description: DESC.manaResidue, roll: "" },
    };
    p.stealable_loot = {
      [IDS.MG_LOOT]: { name: "Mega-Elixir", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.MG_LOOT}`,
                       loot_description: "", roll: "" },
    };
    p.steal_percentage_table = {
      "0": { $deleted: false, steal_item_name: "Mega-Elixir", steal_item_percentage: "100" },
    };
    // Priorities 3+ apart so exactly ONE row survives the weighted window:
    // gap 0/1/2 -> weight 3/2/1, gap >=3 excluded. Once it has Eaten, Run Away
    // is the only candidate and it commits to leaving instead of alternating.
    p.action_pattern_table = {
      "0": { $deleted: false, action_pattern_name: "Run Away", action_pattern_condition: "self_has_status",
             action_pattern_string: "Eaten", action_pattern_value_1: "0", action_pattern_value_2: "100",
             action_pattern_priority: "8", action_pattern_target_focus: "auto",
             action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
      "1": { $deleted: false, action_pattern_name: "Consume Mana", action_pattern_condition: "self_lacks_status",
             action_pattern_string: "Eaten", action_pattern_value_1: "0", action_pattern_value_2: "100",
             action_pattern_priority: "5", action_pattern_target_focus: "auto",
             action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    };
    a.items = [IDS.MG_CONSUME, IDS.MG_RUN, IDS.MG_RESIDUE, IDS.MG_LOOT];
    changes.push([`!actors!${A}`, a, "Mana Gorger — L15 soldier, DEF 13 / MDEF 18"]);
  }

  // ══ LIFE GORGER ══════════════════════════════════════════════════════════
  {
    const A = IDS.LIFE;
    const ik = (id) => `!actors.items!${A}.${id}`;

    // Same deal_damage reasoning as Consume Mana, on the HP route. Affinity is
    // ignored so "half your health" means half regardless of resistances, and
    // ceil() honours the round-up. At 1 HP that rounds to 1 and can finish a
    // creature off, which is the intended edge of "round up".
    const consume = skill(A, dAtk, IDS.LG_CONSUME, "Consume Life", ICON.consume, {
      skill_type: "Active", skill_target: "One Creature", skill_range: "Range",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      isCheck: false, isOffensiveSpell: false, isReaction: false,
      cost: "-", duration: "Instantaneous", description: DESC.consumeLife,
      on_activate_effect_ref: "consume_chain",
      effect_table: {
        "0": { effect_label: "consume_chain", effect_kind: "chain",
               chain_steps: "consume_bite, consume_feed" },
        "1": { effect_label: "consume_bite", effect_kind: "deal_damage",
               target_ref: "action_targets",
               damage_resource: "hp", damage_amount: "ceil(CUR_HP * 0.5)",
               damage_element: "elementless", damage_ignore_affinity: true,
               damage_cause: "damage" },
        "2": { effect_label: "consume_feed", effect_kind: "apply_ae",
               ae_template_ref: "Eaten", target_ref: "self",
               ae_duplicate_mode: "skip" },
      },
    });
    consume.effects = [IDS.LG_EATEN_AE];
    changes.push([ik(IDS.LG_CONSUME), consume, "Consume Life — halves current HP, then feeds"]);

    changes.push([`!actors.items.effects!${A}.${IDS.LG_CONSUME}.${IDS.LG_EATEN_AE}`,
      eatenAE(IDS.LG_EATEN_AE, A, IDS.LG_CONSUME, "It has fed. Now it only wants to leave."),
      "AE — Eaten (persistent_counter)"]);

    changes.push([ik(IDS.LG_RUN), skill(A, dAtk, IDS.LG_RUN, "Run Away", ICON.run, {
      skill_type: "Active", skill_target: "Self", skill_range: "Any",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      isCheck: false, isOffensiveSpell: false, isReaction: false,
      cost: "-", duration: "Instantaneous", description: DESC.runAway,
      ...runAwayTables(),
    }), "Run Away — DL 15 DEX+INS Group Check or it leaves (was 'Flee')"]);

    changes.push([ik(IDS.LG_RESIDUE), skill(A, dPas, IDS.LG_RESIDUE, "Life Residue", ICON.heal, {
      skill_type: "Passive", skill_target: "-", skill_range: "-",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      check_bonus: "0",
      isCheck: false, isOffensiveSpell: false, isReaction: true,
      cost: "-", duration: "-", description: DESC.lifeResidue,
      ...residueTables("hp"),
    }), "Life Residue — killer regains all HP if it had Eaten"]);

    changes.push([ik(IDS.LG_LOOT), lifeLoot, "Mega-Remedy — carried forward unchanged"]);

    const a = blankActor(donor, A, "Life Gorger", FOLDER_MONSTER, ART + "Life%20Eater.png", 1.0);
    Object.assign(a.system.props, common, {
      attribute: "LIGHT",
      traits: "Gorger, Elemental Creature, Light-Align, Cowardly",
      // The Mana Gorger with DEF and MDEF swapped.
      dex_base: "10", ins_base: "8", mig_base: "6", wlp_base: "8",
      dex_current: 10, ins_current: 8, mig_current: 6, wlp_current: 8,
      def_mod: "+8", mdef_mod: "+5", defense: 18, magic_defense: 13,
      affinity_8: "RS",   // light
      affinity_4: "VU",   // dark
      study_text: STUDY.life,
    });
    const p = a.system.props;
    p.skill_active_list = {
      [IDS.LG_CONSUME]: { name: "Consume Life", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.LG_CONSUME}`,
                          active_target: "One Creature", active_cost: "-", active_duration: "Instantaneous",
                          active_description: DESC.consumeLife, roll: "" },
      [IDS.LG_RUN]:     { name: "Run Away", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.LG_RUN}`,
                          active_target: "Self", active_cost: "-", active_duration: "Instantaneous",
                          active_description: DESC.runAway, roll: "" },
    };
    p.skill_passive_list = {
      [IDS.LG_RESIDUE]: { name: "Life Residue", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.LG_RESIDUE}`,
                          passive_description: DESC.lifeResidue, roll: "" },
    };
    p.stealable_loot = {
      [IDS.LG_LOOT]: { name: "Mega-Remedy", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.LG_LOOT}`,
                       loot_description: "", roll: "" },
    };
    p.steal_percentage_table = {
      "0": { $deleted: false, steal_item_name: "Mega-Remedy", steal_item_percentage: "100" },
    };
    p.action_pattern_table = {
      "0": { $deleted: false, action_pattern_name: "Run Away", action_pattern_condition: "self_has_status",
             action_pattern_string: "Eaten", action_pattern_value_1: "0", action_pattern_value_2: "100",
             action_pattern_priority: "8", action_pattern_target_focus: "auto",
             action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
      "1": { $deleted: false, action_pattern_name: "Consume Life", action_pattern_condition: "self_lacks_status",
             action_pattern_string: "Eaten", action_pattern_value_1: "0", action_pattern_value_2: "100",
             action_pattern_priority: "5", action_pattern_target_focus: "highest_hp",
             action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    };
    a.items = [IDS.LG_CONSUME, IDS.LG_RUN, IDS.LG_RESIDUE, IDS.LG_LOOT];
    changes.push([`!actors!${A}`, a, "Life Gorger — L15 soldier, DEF 18 / MDEF 13"]);
  }
}, "gorger-family");
