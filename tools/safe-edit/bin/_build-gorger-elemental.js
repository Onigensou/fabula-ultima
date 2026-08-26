// The ELEMENTAL GORGER CYCLE — six L15 soldiers on one chassis.
//
// Pyro / Cryo / Aero / Geo / Electro / Phobo. Aero and Geo already existed and
// are UPDATED in place (same ids); the other four are new.
//
// The whole design is one joke told properly: this is the Final Fantasy Bomb.
// It does not really fight you. It swells a little every turn, it swells more
// every time you feed it its own element, and on the third swell it pops. The
// threat is the CLOCK, not the monster — which is why the detonation is
// quadratic in Eaten and the monster itself has 30 HP and dies to anything.
//
//   Eaten 1 -> 5 damage   (you popped it on sight; it goes pfft)
//   Eaten 2 -> 20
//   Eaten 3 -> 45         (you ignored it for three rounds; that is on you)
//
// What Aero and Geo were before this: HP 10 not 30, IM to their element rather
// than AB, both VU bolt (Geo inherited Aero's copy-paste), Aero's prototype
// token pointing at Cryo's art and its study text calling it an Ice gorger, a
// sheet mirror row for a "Ventus Alta" item that no longer exists, Geo with no
// spell at all, and Puff Up on the retired active_effect_config_table — meaning
// it has never once fired in Battle Director.
//
// Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const {
  IDS, FOLDER_MONSTER, STONE, AFFINITY, CYCLE,
  DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE, DONOR_SPELL_ACTOR, DONOR_SPELL,
  L, bullets, trig, ICON, ART, eatenAE,
} = require("./_gorger-lib");
const { blankActor, run } = require("./_dragon-util");

// ── the detonation formula ──────────────────────────────────────────────────
// Quadratic in Eaten so the TIMER carries the whole threat, linear in level so
// the chassis re-scales for free if a deeper dungeon ever wants a higher-level
// Gorger — these are explicitly filler that can drop into any dungeon.
//
// Both identifiers are PAYLOAD-scoped and that is load-bearing: deal_damage
// evaluates its amount PER VICTIM, so a bare LEVEL / AE_CHARGES_EATEN would read
// each PC's level and each PC's stacks. TARGET_* reads payload.subjectActorUuid,
// which on creature_defeated is the dying Gorger — one number, same for every
// target. (Fire Slime's Flame Burst is the same pattern.)
//
// The max(...,15) floor is a safety net, not scaling: TARGET_AE_CHARGES_* has a
// subject-snapshot fallback for a lethal KO that already removed the token, but
// TARGET_LEVEL has none and returns 0 if the subject cannot resolve. Without the
// floor that failure mode is a silent 0-damage dud.
const BOOM_FORMULA =
  "max(TARGET_LEVEL, 15) * TARGET_AE_CHARGES_EATEN * TARGET_AE_CHARGES_EATEN / 3";

const STUDY = (g) =>
  `<p>${g.flavor[0].toUpperCase()}${g.flavor.slice(1)}. Gorgers do not hunt and they do not ` +
  `defend themselves; they <strong>eat</strong>, and they <strong>swell</strong>, and past a ` +
  `certain point they stop being a monster and start being an accident. Feeding it its own ` +
  `element only hurries that along. Anything that will put it down quickly is worth more than ` +
  `anything that will put it down well.</p>`;

const DESC = (g, el) => ({
  spell: `<p>The Gorger belches a gout of ${el}&nbsp;at up to three creatures.</p>`,
  bump: `<p>It throws its whole bloated weight at one creature. There is no technique in it.</p>`,
  puff:
    `<p>The Gorger swells. It gains <strong>1 Eaten</strong> at the start of each of its turns, ` +
    `and at <strong>3 Eaten</strong> it can no longer hold itself together — it drops to 0 HP.</p>`,
  consume:
    bullets(trig(`the <strong>${g.name}</strong> absorbs ${el}&nbsp;damage`)) +
    `<p>It drinks the blow down and puffs up on it, gaining <strong>1 Eaten</strong>.</p>`,
  boom:
    bullets(trig(`the <strong>${g.name}</strong> is reduced to 0 HP`)) +
    `<p>It goes off. Every enemy is caught in a burst of ${el}&nbsp;— the more it had ` +
    `<strong>Eaten</strong>, the worse this is, and by the third swell it is genuinely dangerous.</p>`,
});

run(async ({ changes }) => {
  const donor = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const dAtk  = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const dPas  = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const dSpl  = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donor || !dAtk || !dPas || !dSpl) throw new Error("missing donor doc");

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
      on_activate_effect_ref: "",
    }, props);
    return d;
  };

  for (const g of CYCLE) {
    const A   = IDS[g.key] ?? IDS[`${g.key}_ACTOR`];
    const ik  = (id) => `!actors.items!${A}.${id}`;
    const aek = (item, ae) => `!actors.items.effects!${A}.${item}.${ae}`;
    const id  = (suffix) => IDS[`${g.key}_${suffix}`];
    const el  = L[g.element];
    const D   = DESC(g, el);
    const Cap = g.element[0].toUpperCase() + g.element.slice(1);

    // ── the elemental spell ────────────────────────────────────────────────
    // Cloned from the party's own basic spell, then reshaped for NPC use. An
    // NPC Spell needs BOTH isOffensiveSpell and isCheck or the attack picker
    // will never offer it — which is exactly why Aero's Ventus (a verbatim
    // Elementalist facet copy) has never been castable.
    const spellSrcDoc = g.spellSrcActor
      ? await getByKey("actors", `!actors.items!${g.spellSrcActor}.${g.spellSrc}`)
      : await getByKey("items", `!items!${g.spellSrc}`);
    if (!spellSrcDoc) throw new Error(`missing spell source for ${g.name} (${g.spell})`);

    changes.push([ik(id("SPELL")), skill(A, dSpl, id("SPELL"), g.spell, spellSrcDoc.img ?? ICON.ospell, {
      skill_type: "Spell", skill_target: "Up to three creatures", skill_range: "Range",
      rolled_atr1: "INS", rolled_atr2: "WLP", defense_target_type: "mdef",
      // Normalised to 15 across the cycle. The world Ventus is an outlier at 25
      // and Aero inherited it, which made one Gorger quietly hit 67% harder.
      damage_bonus: "15", type_damage: Cap,
      isCheck: true, isOffensiveSpell: true, isReaction: false,
      cost: "10 x T MP", duration: "Instantaneous", description: D.spell,
    }), `${g.name} — ${g.spell} (NPC-shaped)`]);

    // ── Bump ───────────────────────────────────────────────────────────────
    // New. The cycle previously had NO fallback action, so a Gorger that ran
    // out of MP had nothing it could legally do.
    changes.push([ik(id("BUMP")), skill(A, dAtk, id("BUMP"), "Bump", ICON.melee, {
      skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
      rolled_atr1: "DEX", rolled_atr2: "MIG", defense_target_type: "def",
      damage_bonus: "5", type_damage: "Physical",
      isCheck: true, isOffensiveSpell: false, isReaction: false,
      cost: "-", duration: "Instantaneous", description: D.bump,
    }), `${g.name} — Bump (MP-out fallback)`]);

    // ── Puff Up ────────────────────────────────────────────────────────────
    // Was an ACTIVE skill the AI had to choose, wired through the retired
    // active_effect_config_table (so: never fired). Now a passive on the
    // Gorger's own turn_start, which is what makes the clock inevitable.
    //
    // The pop uses consume_resource with consume_can_defeat — a plain HP debit
    // writes the bar down silently and never knocks the creature out, so the
    // detonation would never fire. CUR_HP resolves against the REACTOR here,
    // which is correct: the target IS self.
    const puff = skill(A, dPas, id("PUFF"), "Puff Up", ICON.puffup, {
      skill_type: "Passive", skill_target: "-", skill_range: "-",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      check_bonus: "0",
      isCheck: false, isOffensiveSpell: false, isReaction: true,
      cost: "-", duration: "-", description: D.puff,
      reaction_config_table: {
        "0": {
          reaction_trigger: "turn_start", reaction_source: "self",
          reaction_passive_mode: "force", reaction_effect_ref: "puff_chain",
          condition_formula: "", reaction_cause_filter: "", reaction_resource_filter: "",
        },
      },
      effect_table: {
        "0": { effect_label: "puff_chain", effect_kind: "chain",
               chain_steps: "puff_swell, puff_pop" },
        "1": { effect_label: "puff_swell", effect_kind: "apply_ae",
               ae_template_ref: "Eaten", target_ref: "self",
               ae_duplicate_mode: "add_charges" },
        "2": { effect_label: "puff_pop", effect_kind: "consume_resource",
               consume_resource: "hp", consume_amount: "CUR_HP",
               target_ref: "self", on_empty: "drain", consume_can_defeat: true,
               condition_formula: "AE_CHARGES_EATEN >= 3" },
      },
    });
    puff.effects = [id("EATEN")];
    changes.push([ik(id("PUFF")), puff, `${g.name} — Puff Up (now a turn_start passive)`]);

    changes.push([aek(id("PUFF"), id("EATEN")),
      eatenAE(id("EATEN"), A, id("PUFF"), "It is getting bigger. At three, it stops being a monster."),
      `${g.name} — Eaten AE (persistent_counter)`]);

    // ── Consume <Element> ──────────────────────────────────────────────────
    // ⚠ `creature_absorbs_damage` is DEAD in Battle Director. It is declared in
    // reaction-triggers.config, but the ONLY emitter is the legacy
    // macros/Action Pipeline/Create Damage Card.js — the BD damage path never
    // fires it. Same class of trap as creature_takes_damage on an item.
    //
    // In BD an ABSORB resolves as an HP GAIN carrying the true element, so this
    // rides creature_gain_resource instead. state-handlers.js:855 documents
    // exactly this and names Lightning Prism's Overcharge as the reference —
    // which is the row shape copied here.
    changes.push([ik(id("CONSUME")), skill(A, dPas, id("CONSUME"), `Consume ${Cap}`, ICON.passive, {
      skill_type: "Passive", skill_target: "-", skill_range: "-",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      check_bonus: "0",
      isCheck: false, isOffensiveSpell: false, isReaction: true,
      cost: "-", duration: "-", description: D.consume,
      reaction_config_table: {
        "0": {
          reaction_trigger: "creature_gain_resource",
          reaction_resource_filter: "hp", reaction_cause_filter: "damage",
          reaction_source: "", reaction_passive_mode: "force",
          condition_formula: `SUBJECT_IS_SELF == 1 && TRIGGER_DAMAGE_IS_${g.element.toUpperCase()} == 1`,
          reaction_effect_ref: "absorb_feed",
        },
      },
      effect_table: {
        "0": { effect_label: "absorb_feed", effect_kind: "apply_ae",
               ae_template_ref: "Eaten", target_ref: "self",
               ae_duplicate_mode: "add_charges" },
      },
    }), `${g.name} — Consume ${Cap} (absorb -> +1 Eaten)`]);

    // ── <Element> Explosion ────────────────────────────────────────────────
    // on-DEATH is creature_defeated + reaction_source "self". defeat-reactor
    // emits it INLINE, before the token is removed, so a self-targeted death
    // burst still has a subject to read.
    //
    // The damage is elemental and deliberately does NOT ignore affinity — a
    // party that resists the element should feel that. The rider is a plain
    // library status (nothing invented); Aero's Obscure replaces the old
    // "-X Ranged accuracy" line, which was never implemented anywhere.
    changes.push([ik(id("BOOM")), skill(A, dPas, id("BOOM"), `${g.name.split(" ")[0]} Explosion`, ICON.reaction, {
      skill_type: "Passive", skill_target: "-", skill_range: "-",
      rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
      check_bonus: "0",
      isCheck: false, isOffensiveSpell: false, isReaction: true,
      cost: "-", duration: "-", description: D.boom,
      reaction_config_table: {
        "0": {
          reaction_trigger: "creature_defeated", reaction_source: "self",
          reaction_passive_mode: "force", reaction_effect_ref: "boom_chain",
          condition_formula: "", reaction_cause_filter: "", reaction_resource_filter: "",
        },
      },
      effect_table: {
        "0": { effect_label: "boom_chain", effect_kind: "chain",
               chain_steps: "boom_damage, boom_rider" },
        "1": { effect_label: "boom_targets", effect_kind: "targeting",
               candidate_source: "combat", category: "enemy",
               exclude_self: true, mode: "all" },
        "2": { effect_label: "boom_damage", effect_kind: "deal_damage",
               target_ref: "boom_targets", damage_element: g.element,
               damage_amount: BOOM_FORMULA, damage_cause: "damage" },
        "3": { effect_label: "boom_rider", effect_kind: "apply_ae",
               ae_template_ref: g.rider, target_ref: "boom_targets",
               ae_duplicate_mode: "stack" },
      },
    }), `${g.name} — ${g.name.split(" ")[0]} Explosion (${g.rider} rider)`]);

    // ── loot ───────────────────────────────────────────────────────────────
    const stoneId = STONE[g.element];
    let lootId = null;
    if (stoneId) {
      lootId = id("LOOT");
      const stone = await getByKey("items", `!items!${stoneId}`);
      if (!stone) throw new Error(`missing stone item for ${g.name}`);
      const loot = JSON.parse(JSON.stringify(stone));
      loot._id = lootId; loot.folder = null; loot.ownership = { default: 0 };
      loot.system.props = loot.system.props ?? {};
      loot.system.props.id = "${item.id}";
      loot.system.props.uuid = `Actor.${A}.Item.${lootId}`;
      changes.push([ik(lootId), loot, `${g.name} — ${stone.name}`]);
    }

    // ── actor ──────────────────────────────────────────────────────────────
    const a = blankActor(donor, A, g.name, FOLDER_MONSTER, ART + g.art, 1.0);
    const p = a.system.props;
    Object.assign(p, {
      level: "15", npc_rank: "soldier", species: "ELEMENTAL", subtype_list: "GORGER",
      gorger: true, attribute: g.attribute,
      traits: `Gorger, Elemental Creature, ${g.align}, Volatile`,
      // High evasion on BOTH tracks — a Gorger is annoying to hit and trivial to
      // kill, which is what makes ignoring it a real temptation.
      dex_base: "8", ins_base: "8", mig_base: "6", wlp_base: "8",
      dex_current: 8, ins_current: 8, mig_current: 6, wlp_current: 8,
      // A clone carries the DONOR's stored derived numbers to disk even though
      // CSB recomputes them live, so write the correct value rather than inherit.
      def_mod: "+7", mdef_mod: "+7", defense: 15, magic_defense: 15,
      max_hp: "30", current_hp: "30", max_mp: "60", current_mp: "60",
      init: "8",
      max_zero: "0", zero_power_value: "0", ultima_point: "0", activation: "1",
      zenit_reward_min: "20", zenit_reward_max: "25",
      study_text: STUDY(g),
      // Elemental species house rule.
      condition_poisoned: "IM", condition_envenomed: "IM", condition_zombie: "IM",
      // It has no mind to frighten and no temper to lose. Slow / Weak / Dazed
      // stay fully open — Slow especially, since delaying the clock is the
      // party's clean answer to a monster that is only dangerous on a timer.
      condition_frightened: "IM", condition_enraged: "IM", condition_shaken: "IM",
    });
    // ABSORBS its own element, VULNERABLE to its opposite. Both Aero and Geo
    // were previously IM (not AB) and both were VU bolt — Geo had inherited
    // Aero's value wholesale.
    p[`affinity_${AFFINITY[g.element]}`] = "AB";
    p[`affinity_${AFFINITY[g.vu]}`] = "VU";

    p.normal_spell_list = {
      [id("SPELL")]: { name: g.spell, id: "${item.id}", uuid: `Actor.${A}.Item.${id("SPELL")}`,
                       cost: "10 x T MP", spell_target: "Up to three creatures",
                       duration: "Instantaneous", spell_description: D.spell, roll: "" },
    };
    p.attack_list = {
      [id("BUMP")]: { name: "Bump", id: "${item.id}", uuid: `Actor.${A}.Item.${id("BUMP")}`,
                      active_target: "One Creature", attribute_die1: "DEX", attribute_die2: "MIG",
                      attack_description: D.bump, roll: "" },
    };
    p.skill_passive_list = {
      [id("PUFF")]:    { name: "Puff Up", id: "${item.id}", uuid: `Actor.${A}.Item.${id("PUFF")}`,
                         passive_description: D.puff, roll: "" },
      [id("CONSUME")]: { name: `Consume ${Cap}`, id: "${item.id}", uuid: `Actor.${A}.Item.${id("CONSUME")}`,
                         passive_description: D.consume, roll: "" },
      [id("BOOM")]:    { name: `${g.name.split(" ")[0]} Explosion`, id: "${item.id}",
                         uuid: `Actor.${A}.Item.${id("BOOM")}`,
                         passive_description: D.boom, roll: "" },
    };
    if (lootId) {
      const stoneName = (await getByKey("items", `!items!${stoneId}`)).name;
      p.stealable_loot = {
        [lootId]: { name: stoneName, id: "${item.id}", uuid: `Actor.${A}.Item.${lootId}`,
                    loot_description: "", roll: "" },
      };
      p.steal_percentage_table = {
        "0": { $deleted: false, steal_item_name: stoneName, steal_item_percentage: "100" },
      };
    }

    // Two rows, 3 apart, so the spell is EXCLUSIVE while it can be paid for and
    // Bump only appears once the feasibility check drops the spell for lack of
    // MP. The Gorger never chooses to detonate — Puff Up does that to it.
    p.action_pattern_table = {
      "0": { $deleted: false, action_pattern_name: g.spell, action_pattern_condition: "always",
             action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
             action_pattern_priority: "5", action_pattern_target_focus: "by_affinity",
             action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
      "1": { $deleted: false, action_pattern_name: "Bump", action_pattern_condition: "always",
             action_pattern_string: "", action_pattern_value_1: "0", action_pattern_value_2: "100",
             action_pattern_priority: "2", action_pattern_target_focus: "auto",
             action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    };

    a.items = [id("SPELL"), id("BUMP"), id("PUFF"), id("CONSUME"), id("BOOM"), ...(lootId ? [lootId] : [])];
    changes.push([`!actors!${A}`, a, `${g.name} — L15 soldier, AB ${g.element} / VU ${g.vu}`]);
  }
}, "gorger-family");
