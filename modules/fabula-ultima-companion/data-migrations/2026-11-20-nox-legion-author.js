/**
 * Migration: 2026-11-20-nox-legion-author  (Sealed Cavern / Nox Legion, first wiring pass)
 * ---------------------------------------------------------------------------
 * Seeds the six Nox Legion monsters (design page rev 38) into a world that
 * lacks them, plus what they need:
 *   1. Actors  Nox Ghoul, Nox Hound, Nox Priest (elite), Nox Wraith, Nox Viper,
 *      Nox Executioner (elite) — folder "The Legend of Dragonslayer / Monster /
 *      Sealed Cavern". Every actor and skill is CLONED from an in-world donor
 *      (toObject → strip ids → blank by rule → override), never built from
 *      scratch, so all template-stamped props come along.
 *   2. "Corroded" on the Debuff library (−2 DEF a stack, stack mode, uncleansable,
 *      lasts the battle, capped at 5 by the Viper's own gate), and the Zombie
 *      preset gains `species_override = UNDEAD` (and every applied copy with it).
 *   3. A Sealed-Cavern-only encounter table (13 rows, d100) + Enemies table, and
 *      Valley_Map010 (52LLgHZIyAXBrbMq) pointed at them — only while the scene
 *      still points at the shared Underground tables.
 *
 * SEED-ONLY (data-migration-runner.js convention): each piece is matched by the
 * flag `flags.fabula-ultima-companion.noxLegion = "<key>"` (Corroded by name on
 * the Debuff container) and left alone when it already exists, so a re-run never
 * duplicates and never overwrites hand edits.
 *
 * Field names for the 2026-11-20 engine work (Workers A/B): heal_ignore_undead,
 * target_sort, action_pattern_chance, ae_name_pool_alt / ae_pool_alt_condition,
 * reaction trigger soul_fragment_destroyed, conflict_event_action
 * consumeFragment (conflict_pick, VAR_CONSUMED_FRAGMENT_HP) / titheWound.
 */

export const key = "2026-11-20-nox-legion-author";
export const description = "Nox Legion: 6 Sealed Cavern monsters, Corroded, Zombie = Undead, Sealed Cavern encounter tables.";

const M = "fabula-ultima-companion";
const FLAG = "noxLegion";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const BEAST = FORGE + "Beastiary/";
const SK = FORGE + "Skill%20Icon/FFXIVIcons%20Battle(PvE)/";

// ── Donors (all in-world) ────────────────────────────────────────────────────
const SHELL_ACTOR = "fCxslZazJKtQWsKP";                         // Death Gazer: modern soldier shell
const DONOR = {
  melee:   { actor: "STmBv9N66tZxSNCx", item: "SZc2mYVhrmtOMSVm" }, // Hellhound / Bite
  active:  { actor: "STmBv9N66tZxSNCx", item: "0v5EYWSTa4pdAU8U" }, // Hellhound / Pounce (Active + check)
  passive: { actor: "706pcXzVf41lQNI2", item: "EoJQS2IrAOqNieL3" }, // Ice Ring / Danger Sensitivity
  ethereal:{ actor: "RSJgsnKyUcVICLpn", item: "WCLdX38KZdJiosAq" }, // Dark Soul / Ethereal (+ AE)
  spellAtk:{ actor: "bnem1vdA6Bv3mBVx", item: "Mn7LzSfHjvhcLBZs" }, // Succubus / Draining Kiss
  spellFx: { actor: "fCxslZazJKtQWsKP", item: "guM3PAJ3LLLcuBEA" }, // Death Gazer / Death Gaze (no check)
  finis:   { world: "cy3tl28b5vol182q" },                         // Fulgur Finis
  empty:   { world: "SUYqRKHBGXUhiOL1" },                         // (Empty) steal placeholder
};

const DEBUFF_CONTAINER = "XVOWOq9oUmEECGrU";
const CORRODED_AE_ID = "CorrodedAE000001";
const CORRODED_STATUS_ID = "CorrodedStatId01";

const MONSTER_FOLDER_PARENT = "Nd8LnosrPid1eX1r";   // The Legend of Dragonslayer / Monster
const ACTOR_FOLDER_NAME = "Sealed Cavern";

const CAVERN_SCENE = "52LLgHZIyAXBrbMq";
const UNDERGROUND_ENCOUNTER = "sULKvLErNMF8JtUr";
const UNDERGROUND_ENEMIES = "hBupoi4SsKj1GmDM";

// ── Description helpers (keyword-registry.js uuids) ──────────────────────────
const J = (id, label) => `<a class="content-link" data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry" data-tooltip="Journal Entry"><strong>${label}</strong></a>`;
const DT = (id, label) => `<a class="content-link" data-uuid="Item.${id}" data-id="${id}" data-type="Item" data-tooltip="Item"><strong>${label}</strong></a>`;
const KW = {
  multi: (n) => `${J("Gm3upxgpUVoLSK5u", "Multi")}<strong>&nbsp;${n}</strong>`,
  chain: (n) => `${J("ChnStrikeKeyw0rd", "Chain")}<strong>&nbsp;${n}</strong>`,
  overflow: J("NUaxIAIPUu5Qnk8l", "Overflow"),
  pierce: J("2hNU23YLpCcZCCmf", "Pierce"),
  trigger: J("P7eaFojxra2gTRTG", "Trigger"),
  cripple: J("qXBYN6c9FMZzmS2n", "Cripple"),
  execute: J("KHCaZjNmClkp7yfM", "Execute"),
  desperation: J("0XjR7LzG6oiU74Lj", "Desperation"),
};
const ST = {
  bleed: J("GePNxftPupElcCWp", "Bleed"),
  poisoned: J("JltwIqzHbBKhkD45", "Poisoned"),
  envenomed: J("XRlyg27yLgoQUOXZ", "Envenomed"),
  zombie: J("RZIAnKw95vY6yh2W", "Zombie"),
  armorBreak: J("ArmrBreakStatus1", "Armor Break"),
  blind: J("rBnvYhLfmrVZDdoW", "Blind"),
  crisis: J("GJevbCPM8cffm1QM", "Crisis"),
  grappled: J("FV8JefaHsehzgXR7", "Grappled"),
  strike: J("ZunRGiMDSgAapm5G", "Strike Damage"),
};
const EL = {
  physical: DT("XpKZuGo3VmT0TlTu", "Physical"),
  dark: DT("vKU8UYT6DBhgOjtE", "Dark"),
  light: DT("IQaK3IzvfFp4I1xB", "Light"),
  poison: DT("tDcCWc67Ary9nVxe", "Poison"),
};
const bullets = (...items) => `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ul>`;
const P = (...ps) => ps.map((p) => `<p>${p}</p>`).join("");

// ── Row builders (full key sets — guideline I2a) ─────────────────────────────
const rx = (o) => ({
  $deleted: false, condition_formula: "", reaction_source: "", reaction_source_skill: "",
  reaction_passive_mode: "force", reaction_effect_ref: "", reaction_trigger: "", ...o,
});
const fx = (o) => ({ $deleted: false, condition_formula: "", ...o });
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const ap = (name, condition, priority, o = {}) => ({
  $deleted: false, action_pattern_name: name, action_pattern_condition: condition,
  action_pattern_value_1: "0", action_pattern_value_2: "100", action_pattern_string: "",
  action_pattern_priority: String(priority), action_pattern_target_focus: "auto",
  action_pattern_focus_status: "", action_pattern_cooldown: "0", action_pattern_hp_reserve: "0",
  action_pattern_hp_ceiling: "0", action_pattern_chance: "", ...o,
});

// A skill's rider on its own hit, fired per struck target (state-handlers emits one
// creature_deals_damage per target with subjectActorUuid = that target).
const onOwnHit = (skillName, ref, condition = "") =>
  rx({ reaction_trigger: "creature_deals_damage", reaction_source: "self", reaction_source_skill: skillName, reaction_effect_ref: ref, condition_formula: condition });

// ── The roster ───────────────────────────────────────────────────────────────
// dice D/I/M/W; def/mdef are the page's totals (mods derived from the dice).
// open = the two basic statuses left fully open (house rule); the other three
// non-Poisoned basics are RS. Poisoned is IM for every Undead.
const BASICS = ["slow", "dazed", "weak", "shaken", "enraged"];

const MONSTERS = [
  {
    key: "ghoul", name: "Nox Ghoul", art: "NoxGhoul", scale: 0.95,
    level: "45", rank: "soldier", activation: "1", subtype: "", attribute: "DARK",
    dice: { dex: 8, ins: 6, mig: 10, wlp: 8 }, hp: 150, mp: 85, def: 11, mdef: 9, init: 9,
    ef: { heavy_ef: "150", bow_ef: "75" }, open: ["slow", "dazed"],
    traits: "Undead, Legion Foot Soldier, Ravenous", zenit: ["40", "50"],
    study: "<p>A Legion foot soldier, rotting from the inside out. It sniffs out whoever has already given up part of their soul. Healing burns it, and it cannot stand <strong>light</strong>.</p>",
    skills: [
      { donor: "melee", list: "attack", props: {
          name: "Grave Claw", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "4", damage_bonus: "38", type_damage: "Physical", defense_target_type: "def",
          isCheck: true, isReaction: true,
          description: P(`Deal ${EL.physical}&nbsp;damage to one creature and inflict ${ST.bleed}.`),
          reaction_config_table: table([onOwnHit("Grave Claw", "gc_bleed")]),
          effect_table: table([fx({ effect_label: "gc_bleed", effect_kind: "apply_ae", ae_template_ref: "Bleed", ae_duplicate_mode: "skip", target_ref: "trigger_subject" })]),
        } },
      { donor: "melee", list: "attack", props: {
          name: "Poison Blade", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "4", damage_bonus: "45", type_damage: "Poison", defense_target_type: "def",
          isCheck: true, isReaction: true,
          description: P(`Deal <strong>devastating</strong> ${EL.poison}&nbsp;damage to one creature and inflict ${ST.poisoned}. A creature that is already Poisoned suffers ${ST.envenomed}&nbsp;instead.`),
          reaction_config_table: table([onOwnHit("Poison Blade", "pb_poison")]),
          effect_table: table([fx({ effect_label: "pb_poison", effect_kind: "apply_ae", ae_template_ref: "", ae_name_pool: "Poisoned",
            ae_name_pool_alt: "Envenomed", ae_pool_alt_condition: "TARGET_AE_COUNT_POISONED > 0", ae_duplicate_mode: "skip", target_ref: "trigger_subject" })]),
        } },
      { donor: "passive", list: "passive", props: {
          name: "Counter when enemy Healed", skill_type: "Passive", isReaction: true,
          description: bullets(`${KW.trigger}&nbsp;an enemy recovers Hit Points`)
            + P("This creature performs Grave Claw against that creature for free, treating its <strong>High Roll (HR)</strong> as 0. Once per round."),
          // Only a PLAYER being healed counts (SUBJECT_IS_ENEMY): a heal turned on a Nox
          // monster does not. A fragment's refund writes HP directly (no ledger event).
          reaction_config_table: table([rx({ reaction_trigger: "creature_gain_resource", reaction_resource_filter: "hp", reaction_source: "enemy",
            reaction_max_per_round: "1", condition_formula: "SUBJECT_IS_ENEMY == 1 && TRIGGER_AMOUNT > 0", reaction_effect_ref: "ch_counter" })]),
          effect_table: table([fx({ effect_label: "ch_counter", effect_kind: "free_action", action_ref: "Grave Claw", target_ref: "trigger_subject", free_hr_as_zero: true })]),
        } },
      { donor: "passive", list: "passive", props: {
          name: "Feast on the Torn", skill_type: "Passive", isReaction: true,
          description: P("This creature strikes harder against <strong>Soul-Torn</strong> creatures, and hunts them first."),
          reaction_config_table: table([rx({ reaction_trigger: "creature_will_deal_damage", reaction_source: "self", reaction_passive_mode: "on",
            condition_formula: "TRIGGER_IS_SELF == 1 && TARGET_AE_COUNT_SOUL_TORN > 0", reaction_effect_ref: "ft_bonus" })]),
          effect_table: table([fx({ effect_label: "ft_bonus", effect_kind: "adjust_damage", damage_operation: "add", damage_stage: "outgoing", damage_amount: "10" })]),
        } },
    ],
    ai: [
      ap("Poison Blade", "enemy_lacks_status", 8, { action_pattern_string: "Envenomed", action_pattern_target_focus: "status_avoid", action_pattern_focus_status: "Envenomed" }),
      ap("Grave Claw", "always", 4, { action_pattern_target_focus: "status_focus", action_pattern_focus_status: "Soul-Torn" }),
    ],
  },
  {
    key: "hound", name: "Nox Hound", art: "NoxHound", scale: 1.0,
    level: "44", rank: "soldier", activation: "1", subtype: "", attribute: "DARK",
    dice: { dex: 12, ins: 8, mig: 6, wlp: 6 }, hp: 120, mp: 74, def: 12, mdef: 8, init: 14,
    ef: { dagger_ef: "150", arcane_ef: "75" }, open: ["weak", "shaken"],
    traits: "Undead, Soul-Hound, Never Bites Twice", zenit: ["40", "50"],
    study: "<p>A soul-hound of the Legion that never stays on one victim. Every bite leaves a wound, and it goes for whoever is still unhurt. It shies from <strong>light</strong>.</p>",
    skills: [
      { donor: "melee", list: "attack", props: {
          name: "Rending Fangs", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "Up to two creatures",
          rolled_atr1: "DEX", rolled_atr2: "INS", check_bonus: "4", damage_bonus: "13", type_damage: "Physical", defense_target_type: "def",
          isCheck: true, action_keywords: "pierce, chain 2 pick",
          description: bullets(KW.pierce, `${KW.chain(2)}<strong>&nbsp;Pick</strong>`)
            + P(`Deal <strong>light</strong> ${EL.physical}&nbsp;damage to up to two creatures.`),
        } },
      { donor: "melee", list: "attack", props: {
          name: "Zombie Bite", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "DEX", rolled_atr2: "INS", check_bonus: "8", damage_bonus: "25", type_damage: "Poison", defense_target_type: "def",
          isCheck: true, isReaction: true, action_keywords: "pierce",
          description: bullets(KW.pierce)
            + P(`Deal ${EL.poison}&nbsp;damage to one creature. On a hit, it has a 90% chance to suffer ${ST.zombie}.`),
          // HIT_MARGIN >= 0 = a real hit; a Pierce miss (half damage) gives no Zombie.
          reaction_config_table: table([onOwnHit("Zombie Bite", "zb_zombie", "HIT_MARGIN >= 0")]),
          effect_table: table([fx({ effect_label: "zb_zombie", effect_kind: "apply_ae", ae_template_ref: "Zombie", ae_chance_percent: "90", ae_duplicate_mode: "skip", target_ref: "trigger_subject" })]),
        } },
      { donor: "passive", list: "passive", props: {
          name: "On the Hunt", skill_type: "Passive", isReaction: true,
          description: bullets(`${KW.trigger}&nbsp;an enemy enters ${ST.crisis}`)
            + P("This creature performs Rending Fangs against that creature for free, treating its <strong>High Roll (HR)</strong> as 0. Both bites land on that creature."),
          reaction_config_table: table([rx({ reaction_trigger: "creature_status_applied", reaction_source: "enemy", reaction_status_filter: "Crisis",
            reaction_passive_mode: "on", reaction_effect_ref: "oth_hunt" })]),
          effect_table: table([fx({ effect_label: "oth_hunt", effect_kind: "free_action", action_ref: "Rending Fangs", target_ref: "trigger_subject", free_hr_as_zero: true })]),
        } },
    ],
    ai: [
      // Fresh Scent ≈ highest_hp: under the Tithe every round starts at full HP, so the
      // untouched players are the ones still at 100%.
      ap("Rending Fangs", "always", 5, { action_pattern_target_focus: "highest_hp" }),
      ap("Zombie Bite", "enemy_lacks_status", 4, { action_pattern_string: "Zombie", action_pattern_target_focus: "status_avoid", action_pattern_focus_status: "Zombie" }),
    ],
  },
  {
    key: "priest", name: "Nox Priest", art: "NoxPriest", scale: 1.47,
    level: "46", rank: "elite", activation: "1", subtype: "", attribute: "DARK",
    dice: { dex: 6, ins: 10, mig: 6, wlp: 12 }, hp: 300, mp: 106, def: 9, mdef: 14, init: 12,
    ef: { spear_ef: "150", arcane_ef: "50" }, open: ["slow", "weak"],
    traits: "Undead, Soul Collector, Zealot", zenit: ["90", "110"],
    study: "<p>The Legion's soul collector. Every soul you set free feeds its spells; dry it out and it can only swing its tome. Undead to the bone, it fears <strong>light</strong>.</p>",
    skills: [
      { donor: "melee", list: "attack", props: {
          name: "Nox Tome", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "4", damage_bonus: "20", type_damage: "Physical", defense_target_type: "def",
          isCheck: true,
          description: P(`Deal <strong>light</strong> ${EL.physical}&nbsp;damage to one creature.`),
        } },
      { donor: "spellFx", list: "spell", props: {
          name: "Gravis", skill_type: "Spell", action_command: "spell", skill_range: "Range", skill_target: "All Enemies", cost: "30 MP",
          rolled_atr1: "-", rolled_atr2: "-", duration: "Instantaneous",
          description: P("Each enemy loses a quarter of its current Hit Points. This ignores Affinities, always hits, and can never knock anyone out."),
          on_activate_effect_ref: "gv_dmg",
          effect_table: table([fx({ effect_label: "gv_dmg", effect_kind: "deal_damage", damage_amount: "floor(CUR_HP * 0.25)", damage_cause: "damage",
            damage_element: "null", damage_ignore_affinity: true, damage_resource: "hp", target_ref: "action_targets" })]),
        } },
      { donor: "finis", list: "spell", props: {
          name: "Lux Finis", class: "NPC", skill_type: "Spell", action_command: "spell", skill_range: "Range", skill_target: "Up to three creatures", cost: "30 x T MP",
          rolled_atr1: "INS", rolled_atr2: "WLP", check_bonus: "8", damage_bonus: "62", type_damage: "light", defense_target_type: "mdef",
          isCheck: true, isOffensiveSpell: true, duration: "Instantaneous",
          description: P(`Deal <strong>heavy</strong> ${EL.light}&nbsp;damage to up to three creatures.`, `<strong>Opportunity:</strong> each creature hit suffers ${ST.blind}.`),
          on_activate_effect_ref: "lf_opportunity",
          effect_table: table([fx({ effect_label: "lf_opportunity", effect_kind: "apply_ae", ae_template_ref: "Blind", ae_duplicate_mode: "replace_per_caster",
            condition_formula: "CRIT == 1", target_ref: "hit_action_targets" })]),
        } },
      { donor: "spellFx", list: "spell", props: {
          name: "Zombie Plague", skill_type: "Spell", action_command: "spell", skill_range: "Range", skill_target: "All Enemies", cost: "30 MP",
          rolled_atr1: "-", rolled_atr2: "-", duration: "Instantaneous",
          description: P(`Every enemy performs a <strong>DL13 【MIG】+【WLP】</strong> Check. On a failure, it suffers ${ST.zombie}.`),
          on_activate_effect_ref: "zp_chain",
          effect_table: table([
            fx({ effect_label: "zp_chain", effect_kind: "chain", chain_steps: "zp_save,zp_zombie" }),
            fx({ effect_label: "zp_save", effect_kind: "save_check", save_attr1: "mig", save_attr2: "wlp", save_dl: "13", save_mode: "interactive", target_ref: "action_targets" }),
            fx({ effect_label: "zp_zombie", effect_kind: "apply_ae", ae_template_ref: "Zombie", ae_duplicate_mode: "replace", target_ref: "save_failed_targets" }),
          ]),
        } },
      { donor: "spellFx", list: "spell", props: {
          name: "Revive", skill_type: "Spell", action_command: "spell", skill_range: "Range", skill_target: "One Enemy", cost: "30 MP",
          rolled_atr1: "-", rolled_atr2: "-", duration: "Instantaneous",
          description: P(`Works like a Phoenix Feather on one enemy: an Undead or ${ST.zombie}&nbsp;creature is defeated at once. Any other creature is unaffected.`),
          on_activate_effect_ref: "rv_kill",
          // Per-victim resolver: HAS_STATUS_ZOMBIE / SPECIES_IS_UNDEAD read the TARGET, so a
          // Protect/Cover redirect onto a living, non-Undead ally deals 0 (the spell is wasted).
          effect_table: table([fx({ effect_label: "rv_kill", effect_kind: "deal_damage", damage_amount: "CUR_HP * max(HAS_STATUS_ZOMBIE, SPECIES_IS_UNDEAD)",
            damage_cause: "damage", damage_element: "null", damage_ignore_affinity: true, damage_keywords: "crush", damage_resource: "hp", target_ref: "action_targets" })]),
        } },
      { donor: "passive", list: "passive", props: {
          name: "Soul Siphon", skill_type: "Passive", isReaction: true,
          description: bullets(`${KW.trigger}&nbsp;a Soul Fragment is destroyed`) + P("This creature recovers <strong>30 MP</strong>."),
          reaction_config_table: table([rx({ reaction_trigger: "soul_fragment_destroyed", reaction_effect_ref: "ss_mp" })]),
          effect_table: table([fx({ effect_label: "ss_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: "30", target_ref: "self" })]),
        } },
    ],
    ai: [
      // ⚠ A cooldown only blocks when another row shares the priority window
      // (matchAndPickAction: "all blocked → ignore cooldown"), so every cooled row
      // keeps a partner within 2 priority. Measured live: Plague at 10 alone re-cast
      // every turn.
      ap("Revive", "enemy_has_status", 9, { action_pattern_string: "Zombie", action_pattern_target_focus: "status_focus", action_pattern_focus_status: "Zombie",
        action_pattern_cooldown: "99", action_pattern_chance: "33" }),
      // Zombie lasts 3 rounds: a 3-round cooldown stands in for "when nobody has Zombie".
      ap("Zombie Plague", "always", 8, { action_pattern_cooldown: "3" }),
      ap("Lux Finis", "enemy_has_status", 8, { action_pattern_string: "Zombie", action_pattern_target_focus: "status_focus", action_pattern_focus_status: "Zombie" }),
      ap("Gravis", "always", 7),
      ap("Nox Tome", "always", 2),
    ],
  },
  {
    key: "wraith", name: "Nox Wraith", art: "NoxWraith", scale: 1.0,
    level: "46", rank: "soldier", activation: "1", subtype: "SPIRIT", attribute: "DARK",
    dice: { dex: 8, ins: 10, mig: 6, wlp: 10 }, hp: 130, mp: 90, def: 9, mdef: 11, init: 11,
    ef: {}, open: ["dazed", "enraged"],
    traits: "Undead, Spirit, Nothing but a Mouth", zenit: ["45", "55"],
    study: "<p>A soul that became nothing but a mouth. Blades half pass through it, its touch tears the soul out early, and when cornered it eats a soul to keep going. <strong>Light</strong> burns it.</p>",
    skills: [
      { donor: "ethereal", list: "passive", keepEffects: true, aeFix: (ae) => {
          ae.changes = [{ key: `flags.${M}.affinity_class_strike`, mode: 5, priority: 20, value: "RS" }];
          ae.description = "<p>This creature <strong>resists</strong> <strong>Strike Damage</strong> (any damage that targets its <strong>Defense</strong>): it takes half. Magic damage (vs MDEF) affects it normally.</p>";
        }, props: {
          name: "Ethereal", skill_type: "Passive",
          description: P(`This creature has Resistance to ${ST.strike}.`),
        } },
      { donor: "melee", list: "attack", props: {
          name: "Soul Ripper", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "INS", rolled_atr2: "WLP", check_bonus: "4", damage_bonus: "43", type_damage: "Dark", defense_target_type: "mdef",
          isCheck: true, isReaction: true,
          description: P(`Deal ${EL.dark}&nbsp;damage to one creature. The wound is torn from its soul at once: its Max HP drops by that much, and the loss goes straight into its Soul Fragment.`),
          reaction_config_table: table([onOwnHit("Soul Ripper", "sr_tithe", "HP_DEALT > 0")]),
          effect_table: table([fx({ effect_label: "sr_tithe", effect_kind: "conflict_event_action", conflict_action: "titheWound", conflict_amount: "HP_DEALT", target_ref: "trigger_subject" })]),
        } },
      { donor: "active", list: "active", props: {
          name: "Devour Soul", skill_type: "Active", skill_range: "-", skill_target: "Self", cost: "-", duration: "Instantaneous",
          rolled_atr1: "-", rolled_atr2: "-", isCheck: false,
          description: bullets(KW.desperation)
            + P("This creature eats the largest Soul Fragment that has Called at least once. It recovers 30% of its Max HP (being Undead never turns this healing into damage) and takes another turn. Once per round."),
          on_activate_effect_ref: "dv_chain",
          effect_table: table([
            fx({ effect_label: "dv_chain", effect_kind: "chain", chain_steps: "dv_eat,dv_heal,dv_turn" }),
            fx({ effect_label: "dv_eat", effect_kind: "conflict_event_action", conflict_action: "consumeFragment", conflict_pick: "largest", target_ref: "self" }),
            fx({ effect_label: "dv_heal", effect_kind: "grant", grant_resource: "hp", grant_amount: "floor(MAX_HP * 0.3)", heal_ignore_undead: true,
              target_ref: "self", condition_formula: "VAR_CONSUMED_FRAGMENT_HP > 0" }),
            fx({ effect_label: "dv_turn", effect_kind: "modify_turns", turns_delta: "1", turns_floor: "0", target_ref: "self", condition_formula: "VAR_CONSUMED_FRAGMENT_HP > 0" }),
          ]),
        } },
    ],
    ai: [
      // Only in Crisis (hp_ceiling 50) and only while a fragment stands on its side.
      // Soul Ripper stays inside the window (gap 2) so the 1-round cooldown can bite
      // on the refunded turn ("once per round").
      ap("Devour Soul", "ally_has_status", 7, { action_pattern_string: "Soul Fragment", action_pattern_hp_ceiling: "50", action_pattern_cooldown: "1" }),
      ap("Soul Ripper", "always", 5),
    ],
  },
  {
    key: "viper", name: "Nox Viper", art: "NoxViper", scale: 1.41,
    level: "45", rank: "soldier", activation: "1", subtype: "", attribute: "POISON",
    dice: { dex: 12, ins: 8, mig: 10, wlp: 8 }, hp: 140, mp: 80, def: 11, mdef: 10, init: 15,
    ef: {}, open: ["shaken", "enraged"], grappleSkin: "tentacle_green",
    traits: "Undead, Venom-Serpent, Constrictor", zenit: ["45", "55"],
    study: "<p>A venom-serpent of the Legion. Its bile eats armour away for good, and whoever it coils gets bitten again and again. It recoils from <strong>light</strong>.</p>",
    skills: [
      { donor: "melee", list: "attack", props: {
          name: "Poison Fang", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "Up to two creatures",
          rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "4", damage_bonus: "35", type_damage: "Poison", defense_target_type: "def",
          isCheck: true, isReaction: true, action_keywords: "multi",
          description: bullets(KW.multi(2))
            + P(`Deal <strong>heavy</strong> ${EL.poison}&nbsp;damage. Each creature hit gains a stack of <strong>Corroded</strong> (−2 Defense a stack, up to 5, until the battle ends; it cannot be cleansed).`),
          reaction_config_table: table([onOwnHit("Poison Fang", "pf_corrode", "TARGET_AE_COUNT_CORRODED < 5")]),
          effect_table: table([fx({ effect_label: "pf_corrode", effect_kind: "apply_ae", ae_template_ref: "Corroded", ae_duplicate_mode: "stack", target_ref: "trigger_subject" })]),
        } },
      { donor: "melee", list: "attack", props: {
          name: "Coil", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "4", damage_bonus: "23", type_damage: "Physical", defense_target_type: "def",
          isCheck: true, isReaction: true,
          description: P(`Deal ${EL.physical}&nbsp;damage to one creature. On a hit, it becomes ${ST.grappled}.`),
          reaction_config_table: table([onOwnHit("Coil", "cl_grab")]),
          effect_table: table([fx({ effect_label: "cl_grab", effect_kind: "apply_ae", ae_template_ref: "Grappled", ae_duplicate_mode: "skip", target_ref: "trigger_subject" })]),
        } },
      { donor: "spellAtk", list: "spell", props: {
          name: "Bile Spew", skill_type: "Spell", action_command: "spell", skill_range: "Range", skill_target: "All Enemies", cost: "30 MP",
          rolled_atr1: "MIG", rolled_atr2: "WLP", check_bonus: "4", damage_bonus: "28", type_damage: "Poison", defense_target_type: "mdef",
          isCheck: true, isOffensiveSpell: true, isReaction: false, duration: "Instantaneous", action_keywords: "",
          description: bullets(KW.overflow)
            + P(`Deal ${EL.poison}&nbsp;damage to every enemy. Each creature hit performs a <strong>DL13 【MIG】+【WLP】</strong> Check. On a failure, it suffers ${ST.armorBreak}&nbsp;and ${ST.envenomed}.`),
          on_activate_effect_ref: "bs_chain",
          effect_table: table([
            fx({ effect_label: "bs_chain", effect_kind: "chain", chain_steps: "bs_save,bs_break,bs_venom" }),
            fx({ effect_label: "bs_save", effect_kind: "save_check", save_attr1: "mig", save_attr2: "wlp", save_dl: "13", save_mode: "interactive", target_ref: "hit_action_targets" }),
            fx({ effect_label: "bs_break", effect_kind: "apply_ae", ae_template_ref: "Armor Break", ae_duplicate_mode: "replace", target_ref: "save_failed_targets" }),
            fx({ effect_label: "bs_venom", effect_kind: "apply_ae", ae_template_ref: "Envenomed", ae_duplicate_mode: "replace", target_ref: "save_failed_targets" }),
          ]),
        } },
      { donor: "passive", list: "passive", props: {
          name: "Feeding Coil", skill_type: "Passive", isReaction: true,
          description: bullets(`${KW.trigger}&nbsp;this creature, or the creature it holds, starts its turn while it is Grappling`)
            + P("This creature performs Poison Fang against the held creature for free. That Fang hits automatically and strikes only the held creature."),
          reaction_config_table: table([
            // Its own turn.
            rx({ reaction_trigger: "turn_start", condition_formula: "SUBJECT_IS_SELF == 1 && AE_COUNT_GRAPPLING > 0", reaction_effect_ref: "fc_own" }),
            // The held creature's turn (its DC 10 break check runs from the Grappled status).
            rx({ reaction_trigger: "turn_start", condition_formula: "SUBJECT_IS_ENEMY == 1 && TARGET_AE_COUNT_GRAPPLED > 0 && AE_COUNT_GRAPPLING > 0", reaction_effect_ref: "fc_victim" }),
          ]),
          effect_table: table([
            fx({ effect_label: "fc_own", effect_kind: "chain", chain_steps: "fc_held,fc_bite" }),
            fx({ effect_label: "fc_held", effect_kind: "targeting", candidate_source: "combat", category: "enemy", exclude_self: true, mode: "all", allow_empty: true,
              target_filter: "HAS_STATUS_GRAPPLED == 1" }),
            fx({ effect_label: "fc_bite", effect_kind: "free_action", action_ref: "Poison Fang", target_ref: "fc_held", check_bonus_formula: "99" }),
            fx({ effect_label: "fc_victim", effect_kind: "free_action", action_ref: "Poison Fang", target_ref: "trigger_subject", check_bonus_formula: "99" }),
          ]),
        } },
    ],
    ai: [
      // "When fewer than half the party is Envenomed" ≈ someone lacks it + a 2-round cooldown.
      // Rows kept within 2 priority so Bile Spew's cooldown can block (see the Priest).
      ap("Bile Spew", "enemy_lacks_status", 8, { action_pattern_string: "Envenomed", action_pattern_cooldown: "2" }),
      ap("Coil", "self_lacks_status", 7, { action_pattern_string: "Grappling" }),
      ap("Poison Fang", "always", 6, { action_pattern_target_focus: "status_avoid", action_pattern_focus_status: "Grappled" }),
    ],
  },
  {
    key: "executioner", name: "Nox Executioner", art: "NoxExecutioner", scale: 2.24,
    level: "48", rank: "elite", activation: "1", subtype: "SPIRIT", attribute: "DARK",
    dice: { dex: 10, ins: 8, mig: 12, wlp: 10 }, hp: 320, mp: 100, def: 15, mdef: 13, init: 10,
    ef: {}, open: ["slow", "shaken"],
    traits: "Undead, Spirit, Headsman of the Legion", zenit: ["90", "110"],
    study: "<p>The Legion's headsman. One blade for the healthy, one for the dying, and at every round's end it takes the head of whoever is left too close to death. Its bone shield turns half the blows aside, but <strong>light</strong> still finds it.</p>",
    skills: [
      { donor: "melee", list: "attack", props: {
          name: "Nox Guillotine", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "DEX", rolled_atr2: "MIG", check_bonus: "4", damage_bonus: "37", type_damage: "Physical", defense_target_type: "def",
          isCheck: true, action_keywords: "cripple",
          description: bullets(KW.cripple) + P(`Deal <strong>devastating</strong> ${EL.physical}&nbsp;damage to one creature.`),
        } },
      { donor: "melee", list: "attack", props: {
          name: "Nox Gibbet", skill_type: "Attack", action_command: "attack", skill_range: "Melee", skill_target: "One Creature",
          rolled_atr1: "MIG", rolled_atr2: "WLP", check_bonus: "4", damage_bonus: "37", type_damage: "Physical", defense_target_type: "mdef",
          isCheck: true, action_keywords: "execute",
          description: bullets(KW.execute) + P(`Deal <strong>devastating</strong> ${EL.physical}&nbsp;damage to one creature. This attack targets Magic Defense.`),
        } },
      { donor: "active", list: "active", props: {
          name: "Soul Sever", skill_type: "Active", skill_range: "Range", skill_target: "All Enemies", cost: "30 MP", duration: "Instantaneous",
          rolled_atr1: "MIG", rolled_atr2: "WLP", check_bonus: "4", defense_target_type: "mdef", isCheck: true, action_keywords: "",
          description: bullets(KW.overflow)
            + P(`This creature eats the largest Soul Fragment that has Called at least once. Every enemy hit takes ${EL.poison}&nbsp;damage equal to that fragment's current Hit Points. The fragment is eaten even if this misses.`),
          on_activate_effect_ref: "sv_chain",
          effect_table: table([
            fx({ effect_label: "sv_chain", effect_kind: "chain", chain_steps: "sv_eat,sv_blast" }),
            fx({ effect_label: "sv_eat", effect_kind: "conflict_event_action", conflict_action: "consumeFragment", conflict_pick: "largest", target_ref: "self" }),
            fx({ effect_label: "sv_blast", effect_kind: "deal_damage", damage_amount: "VAR_CONSUMED_FRAGMENT_HP", damage_cause: "damage", damage_element: "poison",
              damage_resource: "hp", target_ref: "hit_action_targets", condition_formula: "VAR_CONSUMED_FRAGMENT_HP > 0" }),
          ]),
        } },
      { donor: "passive", list: "passive", props: {
          name: "Parry", skill_type: "Passive", isReaction: true,
          description: bullets(`${KW.trigger}&nbsp;an action targets this creature and its Accuracy Check result is an even number`)
            + P("This creature takes half damage from that action. A critical success is never parried, and damage without a Check never is."),
          reaction_config_table: table([rx({ reaction_trigger: "creature_targeted_by_action", reaction_source: "self", reaction_action_intent: "harmful",
            reaction_passive_mode: "on", condition_formula: "ATTACK_CHECK_RESULT > 0 && ATTACK_CHECK_RESULT % 2 == 0 && ATTACK_IS_CRIT == 0", reaction_effect_ref: "py_half" })]),
          effect_table: table([fx({ effect_label: "py_half", effect_kind: "adjust_damage", damage_operation: "multiply", damage_stage: "incoming", damage_amount: "0.5", damage_round: "down" })]),
        } },
      { donor: "passive", list: "passive", beheadingMark: true, props: {
          name: "Beheading", skill_type: "Passive", isReaction: true,
          description: bullets(`${KW.trigger}&nbsp;the end of each round`)
            + P("A creature whose HP falls below <strong>15%</strong> of its maximum is marked at once. At the end of the round, before the Soul Tithe, this creature beheads the marked creature with the lowest HP: it is knocked out, and its Soul Fragment goes with it. Once per round. The marks fade if this creature falls."),
          // Pass 1 measures the line against MAX_HP (no "starting HP" word yet; Soul-Torn shrinks it).
          reaction_config_table: table([
            rx({ reaction_trigger: "creature_lose_resource", reaction_resource_filter: "hp", reaction_effect_ref: "bh_mark",
              condition_formula: "SUBJECT_IS_ENEMY == 1 && TARGET_CURRENT_HP > 0 && TARGET_CURRENT_HP < floor(TARGET_MAX_HP * 0.15) && TARGET_AE_COUNT_BEHEADING == 0" }),
            rx({ reaction_trigger: "creature_gain_resource", reaction_resource_filter: "hp", reaction_effect_ref: "bh_clear_one",
              condition_formula: "SUBJECT_IS_ENEMY == 1 && TARGET_AE_COUNT_BEHEADING > 0 && TARGET_CURRENT_HP >= floor(TARGET_MAX_HP * 0.15)" }),
            rx({ reaction_trigger: "round_end", reaction_max_per_round: "1", reaction_effect_ref: "bh_round" }),
            rx({ reaction_trigger: "creature_defeated", reaction_source: "self", reaction_effect_ref: "bh_fade" }),
          ]),
          effect_table: table([
            fx({ effect_label: "bh_mark", effect_kind: "apply_ae", ae_template_ref: "Beheading", ae_duplicate_mode: "skip", target_ref: "trigger_subject" }),
            fx({ effect_label: "bh_clear_one", effect_kind: "remove_ae", ae_template_ref: "Beheading", include_persistent: true, count: "all", target_ref: "trigger_subject" }),
            fx({ effect_label: "bh_round", effect_kind: "chain", chain_steps: "bh_pick,bh_eat,bh_kill,bh_unmark" }),
            fx({ effect_label: "bh_pick", effect_kind: "targeting", candidate_source: "combat", category: "enemy", exclude_self: true, mode: "exact", count: "1",
              target_sort: "lowest_hp", allow_empty: false, target_filter: "AE_COUNT_BEHEADING > 0 && CUR_HP > 0 && CUR_HP < floor(MAX_HP * 0.15)" }),
            fx({ effect_label: "bh_eat", effect_kind: "conflict_event_action", conflict_action: "consumeFragment", conflict_pick: "trigger_subject_owner", target_ref: "bh_pick" }),
            fx({ effect_label: "bh_kill", effect_kind: "deal_damage", damage_amount: "CUR_HP", damage_cause: "damage", damage_element: "null",
              damage_ignore_affinity: true, damage_keywords: "crush", damage_resource: "hp", target_ref: "bh_pick" }),
            fx({ effect_label: "bh_unmark", effect_kind: "remove_ae", ae_template_ref: "Beheading", include_persistent: true, count: "all", target_ref: "bh_pick" }),
            fx({ effect_label: "bh_fade", effect_kind: "chain", chain_steps: "bh_marked,bh_clear_all" }),
            fx({ effect_label: "bh_marked", effect_kind: "targeting", candidate_source: "combat", category: "enemy", exclude_self: true, mode: "all", allow_empty: true,
              target_filter: "AE_COUNT_BEHEADING > 0" }),
            fx({ effect_label: "bh_clear_all", effect_kind: "remove_ae", ae_template_ref: "Beheading", include_persistent: true, count: "all", target_ref: "bh_marked" }),
          ]),
        } },
    ],
    ai: [
      ap("Soul Sever", "ally_has_status", 9, { action_pattern_string: "Soul Fragment" }),
      ap("Nox Guillotine", "always", 5, { action_pattern_target_focus: "highest_hp" }),
      ap("Nox Gibbet", "always", 5, { action_pattern_target_focus: "lowest_hp" }),
    ],
  },
];

// The Executioner's warning mark, embedded on Beheading (apply_ae resolves the
// carrier's own effects first). Not a debuff: no cleanse takes it; it lasts until
// the HP rises over the line, the round-end beheading, or the Executioner's fall.
const BEHEADING_MARK = {
  name: "Beheading",
  img: SK + "BLU/level_5_death.png",
  transfer: false, disabled: false, changes: [],
  statuses: ["BeheadMarkStat01"],
  duration: { rounds: null, turns: null, seconds: null },
  description: "<p>Below 15% of its maximum HP. At the end of the round the Nox Executioner beheads the marked creature with the lowest HP.</p>",
  system: { tags: ["beheading"] },
  flags: { [M]: { lifetimeMode: "persistent_counter", conflictScoped: true, uncleansable: true, crossScene: false } },
};

const CORRODED = {
  _id: CORRODED_AE_ID,
  name: "Corroded",
  img: SK + "14_SMN/bio.png",
  transfer: false, disabled: false,
  changes: [{ key: "bonus_defense", mode: 2, priority: 20, value: "-2" }],
  statuses: [CORRODED_STATUS_ID],
  duration: { rounds: null, turns: null, seconds: null },
  description: "<p>Venom eats the armour: <strong>−2 Defense</strong> for each stack, up to 5 stacks. Lasts until the battle ends and cannot be cleansed.</p>",
  system: { tags: ["debuff", "corroded"] },
  flags: {
    [M]: { lifetimeMode: "persistent_counter", conflictScoped: true, uncleansable: true, crossScene: false },
    // Same shape as the hub's Armor Break (ArmrBreakAE00001): CSB keeps the fixed id
    // only with these, and Convenient Effects resolves the status through them.
    "custom-system-builder": {
      isFromTemplate: false, isPredefined: true, originalId: CORRODED_AE_ID, originalParentId: DEBUFF_CONTAINER,
      originalUuid: `Item.${DEBUFF_CONTAINER}.ActiveEffect.${CORRODED_AE_ID}`,
    },
    "dfreds-convenient-effects": { ceEffectId: "ce-corroded", isBackup: false, isConvenient: true, isDynamic: false, isTemporary: false, isViewable: true },
    statuscounter: { config: { multiplyEffect: true, type: "default" }, value: 1, visible: false },
  },
};

// d100 rows from the encounter page (scratchpad enc/page/encounters.html `const G`).
const ENCOUNTERS = [
  [[1, 15], "Nox Ghoul, Nox Ghoul, Nox Hound, Nox Hound"],
  [[16, 27], "Nox Hound, Nox Viper, Nox Hound"],
  [[28, 39], "Nox Ghoul, Nox Wraith, Nox Ghoul"],
  [[40, 49], "Nox Ghoul, Nox Viper, Nox Ghoul"],
  [[50, 59], "Nox Hound, Nox Wraith, Nox Ghoul"],
  [[60, 69], "Nox Hound, Nox Priest, Nox Hound"],
  [[70, 77], "Nox Ghoul, Nox Priest, Nox Hound"],
  [[78, 83], "Nox Hound, Nox Executioner, Nox Hound"],
  [[84, 88], "Nox Ghoul, Nox Executioner, Nox Ghoul"],
  [[89, 92], "Obsidrax, Nox Viper, Obsidrax"],
  [[93, 95], "Nox Hound, Kurona, Kurona, Nox Hound"],
  [[96, 98], "Nox Ghoul, Roo, Nox Ghoul"],
  [[99, 100], "Carlbero"],
];
const GUESTS = ["Kurona", "Obsidrax", "Roo", "Carlbero"];

// ── Helpers ──────────────────────────────────────────────────────────────────
const byFlag = (coll, k) => coll.find((d) => d.getFlag?.(M, FLAG) === k || d.flags?.[M]?.[FLAG] === k) ?? null;
// def_mod / mdef_mod: "+N" adds to the die; a value WITHOUT "+" is an absolute
// DEF (template formula `def_mod.includes('+') ? die + mod : mod`, charList "+0-9"),
// so a negative modifier is written as the absolute total instead.
const modOrAbsolute = (total, die) => (total - die >= 0 ? `+${total - die}` : String(total));

function donorDoc(ref) {
  const it = ref.world ? game.items.get(ref.world) : game.actors.get(ref.actor)?.items?.get(ref.item);
  if (!it) throw new Error(`donor missing: ${JSON.stringify(ref)}`);
  return it;
}

// Clone a donor skill, blank its behaviour, then lay the authored props over it.
function buildItem(spec) {
  const d = donorDoc(DONOR[spec.donor]).toObject();
  delete d._id; delete d.folder; delete d.sort; delete d._stats;
  // Fresh flags: a donor's migrator backups / draft markers / old CSB version must
  // not ride along (the Fulgur Finis world item carries all three).
  d.flags = {
    "custom-system-builder": { version: game.actors.get(SHELL_ACTOR)?.flags?.["custom-system-builder"]?.version ?? "4.8.5" },
    [M]: { [FLAG]: spec.props.name },
  };
  // A world-library donor can sit inside a container item (Fulgur Finis does):
  // `system.container` would hide the clone from the sheet's itemContainer lists
  // and gate it as a gear _skill.
  delete d.system.container;
  const p = d.system.props;
  delete p.uuid; delete p.id;
  for (const k of ["optional_params", "active_effect_config_table", "reaction_config_table", "effect_table"]) p[k] = {};
  Object.assign(p, {
    class: "NPC", level: "1", max_level: "1", details_roller: "Show",
    on_activate_effect_ref: "", pre_activate_effect_ref: "", post_damage_effect_ref: "",
    action_keywords: "", check_bonus: "0", damage_bonus: "0", type_damage: "",
    isReaction: false, isCheck: false, isOffensiveSpell: false, cost: "-", duration: "-",
  });
  if (spec.props.skill_type === "Passive") Object.assign(p, { skill_target: "-", skill_range: "-", rolled_atr1: "-", rolled_atr2: "-", action_command: "" });
  Object.assign(p, spec.props);
  if (Object.keys(p.reaction_config_table ?? {}).length) p.isReaction = true;
  d.name = spec.props.name;
  if (!spec.keepEffects) d.effects = [];
  else if (spec.aeFix) for (const ae of d.effects ?? []) { delete ae._id; spec.aeFix(ae); }
  if (spec.beheadingMark) d.effects = [foundry.utils.deepClone(BEHEADING_MARK)];
  return d;
}

// Blank a donor actor's props by RULE (reference_monster_actor_setup), then author.
function buildActor(mon, folderId) {
  const shell = game.actors.get(SHELL_ACTOR);
  if (!shell) throw new Error(`shell donor ${SHELL_ACTOR} missing`);
  const d = shell.toObject();
  const keepId = Object.prototype.hasOwnProperty.call(d.system.props, "id");
  delete d._id; delete d._stats; delete d.sort;
  d.items = []; d.effects = [];
  d.name = mon.name; d.folder = folderId;
  const fu = d.flags?.[M] ?? {};
  d.flags = {
    "custom-system-builder": { version: d.flags?.["custom-system-builder"]?.version ?? "4.8.5" },
    [M]: { layoutRef: fu.layoutRef, spriteShadow: true, [FLAG]: mon.key, ...(mon.grappleSkin ? { grappleSkin: mon.grappleSkin } : {}) },
  };
  const p = d.system.props;
  delete p.uuid; delete p.id;
  for (const [k, v] of Object.entries(p)) {
    if (/^condition_/.test(k)) p[k] = "NA";
    else if (/^affinity_[1-9]$/.test(k)) p[k] = "NA";
    else if (/_ef$/.test(k)) p[k] = "100";
    else if (/^(extra_damage_mod_|damage_receiving_mod_|check_mod_)/.test(k)) p[k] = 0;
    else if (typeof v === "boolean") p[k] = false;
    else if (v && typeof v === "object") p[k] = {};
  }
  const art = (s) => `${BEAST}${mon.art}_${s}`;
  const png = art("Standard.png");
  Object.assign(p, {
    name: mon.name, level: mon.level, species: "UNDEAD", subtype_list: mon.subtype, attribute: mon.attribute,
    npc_rank: mon.rank, activation: mon.activation, traits: mon.traits,
    zenit_reward_min: mon.zenit[0], zenit_reward_max: mon.zenit[1],
    dex_base: String(mon.dice.dex), ins_base: String(mon.dice.ins), mig_base: String(mon.dice.mig), wlp_base: String(mon.dice.wlp),
    dex_current: mon.dice.dex, ins_current: mon.dice.ins, mig_current: mon.dice.mig, wlp_current: mon.dice.wlp,
    max_hp: String(mon.hp), current_hp: String(mon.hp), max_mp: String(mon.mp), current_mp: String(mon.mp), init: String(mon.init),
    def_mod: modOrAbsolute(mon.def, mon.dice.dex), mdef_mod: modOrAbsolute(mon.mdef, mon.dice.ins), defense: mon.def, magic_defense: mon.mdef,
    // Undead species row: VU Light, IM Dark + Poison, IM Poisoned.
    affinity_4: "IM", affinity_8: "VU", affinity_9: "IM", condition_poisoned: "IM",
    study_text: mon.study, tactic_notes: "",
    img: png, sprite_standard: png, sprite_battle: art("Battle_Idle.webm"),
    cut_in_critical: png, cut_in_fumble: png, cut_in_zero_power: png,
    battle_facing_direction: "left", default_facing_direction: "right",
    override_all_damage_type: "None", override_attack_damage_type: "None", override_damage_type: "None", override_spell_damage_type: "None",
    critical_damage_multiplier: 1, minimum_critical_dice: 6, enmity: 100, shield_type: "PHYSICAL", shield_value: "0",
    ...mon.ef,
  });
  for (const s of BASICS) if (!mon.open.includes(s)) p[`condition_${s}`] = "RS";
  d.img = png;
  const tok = d.prototypeToken;
  tok.name = mon.name; tok.width = 1; tok.height = 1; tok.actorLink = false; tok.disposition = -1;
  tok.texture = { ...(tok.texture ?? {}), src: png, scaleX: -mon.scale, scaleY: mon.scale };
  return { data: d, keepId };
}

const LIST_OF = { attack: "attack_list", spell: "normal_spell_list", active: "skill_active_list", passive: "skill_passive_list" };

function mirrorRow(list, item) {
  const p = item.system.props;
  const base = { name: item.name, id: "${item.id}", uuid: item.uuid, roll: "" };
  if (list === "attack") return { ...base, active_target: p.skill_target, attribute_die1: p.rolled_atr1, attribute_die2: p.rolled_atr2, attack_description: p.description };
  if (list === "spell") return { ...base, cost: p.cost, spell_target: p.skill_target, duration: p.duration, spell_description: p.description };
  if (list === "active") return { ...base, active_target: p.skill_target, active_cost: p.cost, active_duration: p.duration, active_description: p.description };
  return { ...base, passive_description: p.description };
}

async function ensureActorFolder(log) {
  let f = game.folders.find((x) => x.type === "Actor" && x.name === ACTOR_FOLDER_NAME && (x.folder?.id ?? x.folder ?? null) === MONSTER_FOLDER_PARENT);
  if (f) return f;
  const parent = game.folders.get(MONSTER_FOLDER_PARENT) ? MONSTER_FOLDER_PARENT : null;
  f = await Folder.create({ name: ACTOR_FOLDER_NAME, type: "Actor", folder: parent, sorting: "a" });
  log?.(`created actor folder "${ACTOR_FOLDER_NAME}" (${f.id})`);
  return f;
}

async function authorMonster(mon, folderId, out) {
  const existing = byFlag(game.actors, mon.key) ?? game.actors.find((a) => a.name === mon.name && a.type !== "_template");
  if (existing) { out.push(`${mon.name}: already in the world (${existing.id}), left as is`); return existing; }

  const { data, keepId } = buildActor(mon, folderId);
  const actor = await Actor.create(data);
  const emptyItem = (() => {
    const e = donorDoc(DONOR.empty).toObject();
    delete e._id; delete e.folder; delete e.sort; delete e._stats;
    return e;
  })();
  const itemData = mon.skills.map(buildItem);
  const made = await actor.createEmbeddedDocuments("Item", [...itemData, emptyItem]);

  // Mirrors keyed by item id; match by NAME (createEmbeddedDocuments may reorder).
  const lists = { attack_list: {}, normal_spell_list: {}, skill_active_list: {}, skill_passive_list: {} };
  for (const spec of mon.skills) {
    const it = made.find((i) => i.name === spec.props.name);
    if (it) lists[LIST_OF[spec.list]][it.id] = mirrorRow(spec.list, it);
  }
  const empty = made.find((i) => i.name === "(Empty)");
  const upd = {
    "system.props.action_pattern_table": table(mon.ai),
    "system.props.steal_percentage_table": { 0: { $deleted: false, loot_id: "(Empty)", loot_percentage: "100" } },
    "system.props.stealable_loot": empty ? { [empty.id]: { name: "(Empty)", id: "${item.id}", uuid: empty.uuid, loot_description: empty.system?.props?.description ?? "", roll: "" } } : {},
  };
  for (const [k, v] of Object.entries(lists)) upd[`system.props.${k}`] = v;
  if (keepId) { upd["system.props.id"] = actor.id; upd["system.props.uuid"] = actor.uuid; }
  // Re-stamp the derived DEF/MDEF (a clone carries the donor's on disk).
  upd["system.props.defense"] = mon.def;
  upd["system.props.magic_defense"] = mon.mdef;
  await actor.update(upd);
  out.push(`${mon.name}: created ${actor.id} with ${made.length} items`);
  return actor;
}

async function authorCorroded(out) {
  const box = game.items.get(DEBUFF_CONTAINER);
  if (!box) { out.push("Corroded: Debuff library missing, skipped"); return; }
  if (box.effects.find((e) => e.name === "Corroded")) { out.push("Corroded: already on the Debuff library"); return; }
  // The fixed id is what csb-extra-status-effects.js links the status to. Measured
  // in the sandbox: without the custom-system-builder originalId flags (CORRODED
  // above) CSB re-creates the effect under a random id.
  await ActiveEffect.implementation.create(foundry.utils.deepClone(CORRODED), { parent: box, keepId: true });
  out.push("Corroded: added to the Debuff library");
}

async function patchZombie(out, log) {
  const { authorCommonAe } = await import("./_common-ae-author.js");
  const box = game.items.get(DEBUFF_CONTAINER);
  const z = box?.effects?.find((e) => e.name === "Zombie");
  if (!z) { out.push("Zombie: preset missing, skipped"); return; }
  const OVERRIDE = { key: `flags.${M}.species_override`, mode: 5, priority: 20, value: "UNDEAD" };
  const changes = [...(z.changes ?? []).filter((c) => c.key !== OVERRIDE.key).map((c) => ({ ...c })), OVERRIDE];
  const r = await authorCommonAe(game, { name: "Zombie", container: "Debuff", patch: { changes } }, log);
  out.push(`Zombie: species_override UNDEAD (masters ${r.masters}, copies ${r.actorCopies + r.itemCopies + r.tokenCopies}, already ${r.skipped})`);
}

async function authorTables(out) {
  const encDonor = game.tables.get(UNDERGROUND_ENCOUNTER);
  const enDonor = game.tables.get(UNDERGROUND_ENEMIES);
  let enc = byFlag(game.tables, "encounter");
  if (!enc && encDonor) {
    const d = encDonor.toObject();
    delete d._id; delete d._stats; delete d.sort;
    const img = d.img;
    Object.assign(d, { name: "Valley of the Dragon Sealed Cavern - Encounter", formula: "1d100", description: "Sealed Cavern (Valley_Map010) only: the Nox Legion and its guests." });
    d.flags = { ...(d.flags ?? {}), [M]: { [FLAG]: "encounter" } };
    d.results = ENCOUNTERS.map(([range, text]) => ({ type: "text", text, img, range, weight: range[1] - range[0] + 1, drawn: false, documentId: null, flags: {} }));
    enc = await RollTable.create(d);
    out.push(`encounter table: created ${enc.id}`);
  } else out.push(enc ? `encounter table: already ${enc.id}` : "encounter table: Underground donor missing");

  let en = byFlag(game.tables, "enemies");
  if (!en && enDonor) {
    const d = enDonor.toObject();
    delete d._id; delete d._stats; delete d.sort;
    const names = [...MONSTERS.map((m) => m.name), ...GUESTS];
    const rows = names.map((n) => game.actors.find((a) => a.name === n && a.type !== "_template")).filter(Boolean);
    Object.assign(d, { name: "Valley of the Dragon Sealed Cavern - Enemies", formula: `1d${rows.length}` });
    d.flags = { ...(d.flags ?? {}), [M]: { [FLAG]: "enemies" } };
    d.results = rows.map((a, i) => ({ type: "document", documentCollection: "Actor", documentId: a.id, text: a.name, img: a.img, range: [i + 1, i + 1], weight: 1, drawn: false, flags: {} }));
    en = await RollTable.create(d);
    out.push(`enemies table: created ${en.id} (${rows.length} rows)`);
  } else out.push(en ? `enemies table: already ${en.id}` : "enemies table: Underground donor missing");
  return { enc, en };
}

async function pointScene({ enc, en }, out) {
  const scene = game.scenes.get(CAVERN_SCENE);
  if (!scene) { out.push("Sealed Cavern scene: not in this world"); return; }
  const od = scene.flags?.[M]?.oniDungeon ?? {};
  const upd = {};
  if (enc && od.encounterTable === `RollTable.${UNDERGROUND_ENCOUNTER}`) upd[`flags.${M}.oniDungeon.encounterTable`] = enc.uuid;
  if (en && od.enemiesTable === `RollTable.${UNDERGROUND_ENEMIES}`) upd[`flags.${M}.oniDungeon.enemiesTable`] = en.uuid;
  if (!Object.keys(upd).length) { out.push("Sealed Cavern scene: not on the Underground tables, left as is"); return; }
  const said = Object.values(upd).join(" / ");
  await scene.update(upd);
  out.push(`Sealed Cavern scene: now rolls on ${said}`);
}

export async function migrate(game, log) {
  const out = [];
  await authorCorroded(out);
  await patchZombie(out, log);
  const folder = await ensureActorFolder(log);
  for (const mon of MONSTERS) {
    try { await authorMonster(mon, folder?.id ?? null, out); }
    catch (e) { out.push(`${mon.name}: FAILED ${e?.message ?? e}`); throw e; }
  }
  const tables = await authorTables(out);
  await pointScene(tables, out);
  log?.(out.join(" | "));
  return { applied: true, summary: out.join("; ") };
}
