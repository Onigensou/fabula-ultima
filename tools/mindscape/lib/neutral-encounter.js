"use strict";
//
// Mindscape — neutral sparring encounters at any level:  --neutral-encounter <kind>
//
// WHY THIS EXISTS
// Archetype parties (lib/archetype-party.js) can be built at any level; a world monster
// exists at one level and carries one element theme. Balancing gear against Inferex +
// Centuaros measured a FIRE fight the real party happens to be geared for. This builds
// enemies that fight back and favour nothing: no affinities, all weapon efficiency 100,
// half physical attacks against DEF and half spells against MDEF.
//
// THE RULES IT FOLLOWS — official NPC construction (core rulebook; project note
// "Monster Design Rules", Parts 1-2):
//   array Standard d10/d8/d8/d6; +1 die step at level 20, 40 and 60 (max d12)
//   HP = 2 x level + 5 x MIG die        MP = level + 5 x WLP die
//   DEF = DEX die                       MDEF = INS die
//   accuracy / magic bonus = floor(level / 10)
//   basic attack HR + 5; flat damage bonus +0 / +5 / +10 / +15 at L1-19 / 20-39 / 40-59 / 60
//   spell "Breath" HR + 10 for 5 MP (the book's NPC spell list)
//   Elite: HP x 2, one turn per round, +1 skill (not modelled)
//   Encounter budget: soldiers = party size for a normal fight
//
// This table is deliberately over-tuned against the rulebook (fight-length targets and
// HP tables in docs/monster-balance-design.md are larger). `hpScale` and `damageScale`
// move a rulebook encounter toward that; the defaults are the rulebook. Every scale used
// is printed with the result.

const { toCombatModel } = require("./load-actors");

const DIE_STEPS = [6, 8, 10, 12];

function stepUp(die) { return DIE_STEPS[Math.min(DIE_STEPS.indexOf(die) + 1, DIE_STEPS.length - 1)]; }

function npcDice(base, order, level) {
  const out = { ...base };
  [20, 40, 60].forEach((m, i) => {
    if (level < m) return;
    const target = [order[i % order.length], ...order].find((k) => out[k] < 12);
    if (target) out[target] = stepUp(out[target]);
  });
  return out;
}

function flatDamageBonus(level) {
  return level >= 60 ? 15 : level >= 40 ? 10 : level >= 20 ? 5 : 0;
}

const TEMPLATES = Object.freeze({
  brute: {
    label: "Sparring Brute",
    dice: { dex: 8, ins: 8, mig: 10, wlp: 6 },   // Standard array, might first
    order: ["mig", "dex", "ins"],
    actions: (lv, acc, dmg) => [{
      name: "Heavy Blow",
      props: { skill_type: "Attack", skill_target: "One Creature", cost: "-", rolled_atr1: "MIG", rolled_atr2: "DEX",
        check_bonus: String(acc), damage_bonus: String(5 + dmg), type_damage: "Physical", defense_target_type: "def" },
    }],
  },
  caster: {
    label: "Sparring Adept",
    dice: { dex: 8, ins: 10, mig: 6, wlp: 8 },    // Standard array, insight first
    order: ["ins", "wlp", "dex"],
    actions: (lv, acc, dmg) => [
      {
        name: "Breath",
        props: { skill_type: "Spell", skill_target: "One Creature", cost: "5 MP", rolled_atr1: "INS", rolled_atr2: "WLP",
          check_bonus: String(acc), damage_bonus: String(10 + dmg), type_damage: "Physical", defense_target_type: "mdef" },
      },
      {
        name: "Staff Strike",
        props: { skill_type: "Attack", skill_target: "One Creature", cost: "-", rolled_atr1: "DEX", rolled_atr2: "INS",
          check_bonus: String(acc), damage_bonus: String(5 + dmg), type_damage: "Physical", defense_target_type: "def" },
      },
    ],
  },
});

// kind -> roster of { template, rank }. "normal" is the rulebook's normal fight for a
// party of four (four soldiers); "elite-pair" spends the same budget on two elites.
const KINDS = Object.freeze({
  normal: [{ t: "brute", rank: "soldier" }, { t: "brute", rank: "soldier" }, { t: "caster", rank: "soldier" }, { t: "caster", rank: "soldier" }],
  "elite-pair": [{ t: "brute", rank: "elite" }, { t: "caster", rank: "elite" }],
});

function buildNeutralEncounter(kind, { level, hpScale = 1, damageScale = 1 } = {}) {
  const roster = KINDS[kind];
  if (!roster) throw new Error(`Mindscape: unknown neutral encounter "${kind}" (kinds: ${Object.keys(KINDS).join(", ")})`);
  if (!Number.isInteger(level) || level < 5 || level > 60) throw new Error(`Mindscape: neutral encounter level must be 5-60 (got ${level})`);
  if (!(hpScale > 0) || !(damageScale > 0)) throw new Error("Mindscape: hpScale and damageScale must be above 0");

  const counts = {};
  return roster.map(({ t, rank }, i) => {
    const tpl = TEMPLATES[t];
    const dice = npcDice(tpl.dice, tpl.order, level);
    const hp = Math.round((2 * level + 5 * dice.mig) * (rank === "elite" ? 2 : 1) * hpScale);
    const mp = level + 5 * dice.wlp;
    const acc = Math.floor(level / 10);
    const dmgBonus = flatDamageBonus(level);
    counts[t] = (counts[t] ?? 0) + 1;
    const name = `${tpl.label}${rank === "elite" ? " (Elite)" : ""} ${String.fromCharCode(64 + counts[t])}`;

    const actions = tpl.actions(level, acc, dmgBonus).map((a, j) => {
      const base = Number(a.props.damage_bonus);
      // damageScale multiplies the WHOLE expected hit (HR + bonus), expressed as a bonus.
      const avgHr = (dice[a.props.rolled_atr1.toLowerCase()] + dice[a.props.rolled_atr2.toLowerCase()]) / 3;
      const scaled = damageScale === 1 ? base : Math.round((avgHr + base) * damageScale - avgHr);
      return { id: `neutral-${i}-${j}`, name: a.name, type: "equippableItem", props: { ...a.props, damage_bonus: String(scaled) } };
    });

    const model = toCombatModel({
      _id: `neutral-${kind}-${i}`, name, items: [],
      system: { props: {
        level: String(level), npc_rank: rank, species: "Monster", activation: "1",
        max_hp: String(hp), current_hp: String(hp), max_mp: String(mp), current_mp: String(mp),
        dex_base: String(dice.dex), ins_base: String(dice.ins), mig_base: String(dice.mig), wlp_base: String(dice.wlp),
        defense: String(dice.dex), magic_defense: String(dice.ins),
      } },
    });
    model.items = actions;
    model.fromSpec = `neutral encounter "${kind}" (rulebook NPC formula, hp x${hpScale}, damage x${damageScale})`;
    model.neutral = { kind, rank, template: t, dice, hp, hpScale, damageScale };
    return model;
  });
}

module.exports = { KINDS, TEMPLATES, npcDice, flatDamageBonus, buildNeutralEncounter };
