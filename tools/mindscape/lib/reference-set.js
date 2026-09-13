"use strict";
//
// Mindscape — the vanilla equipment reference ladder (equipment guide Part 8).
//
// Each reference item is the wearer's OWN basic item (or an empty accessory slot) plus a
// single effect. It is measured twice on the same archetype party, level, encounter and
// seed — without the item and with it — and the difference is priced in the guide's unit:
//
//   offense   % = extra damage per wearer ACTION / BA(L)
//   defense   % = damage prevented per ROUND / HP-per-BA(L)
//   max HP      reported as survival deltas only (the metric has no damage term)
//
//   BA(L)        = 34 x 1.036^(L - 30)            guide Part 3
//   HP-per-BA(L) = 60 x BA(L) / 34                guide Part 4 ("~60 HP = 1 BA at L30")
//
// Beside each measurement sits the guide's PAPER price for the same item, so the ladder
// answers "is the pricing table right?" row by row. Defensive paper prices need the
// wearer's exposure (how much damage aimed at DEF/MDEF they take), which the guide leaves
// open; it is taken from the baseline run and labelled as such.

const fs = require("fs");
const path = require("path");
const { runBattle } = require("./engine");
const { Rng } = require("./rng");
const { currentSlotItems } = require("./loadout-swap");

const SPEC_FILE = path.join(__dirname, "..", "specs", "equipment", "reference-set.json");

const GUIDE = Object.freeze({
  hitRate: 0.49,           // Part 4 default target, DEF 13
  accuracyPerPoint: 0.17,  // +1 accuracy = +17% of affected damage at DEF 13
  defensePerPoint: 0.175,  // +1 DEF/MDEF = -15-20% of damage aimed at that defence
  rsShare: 0.5,            // Resistance halves the damage it applies to
  actionsPerFight: 2.5,
});

const EFFECTS = Object.freeze(["weapon-damage", "weapon-accuracy", "spell-damage", "defense", "magic-defense", "max-hp", "physical-resistance"]);

function BA(level) { return 34 * Math.pow(1.036, level - 30); }
function hpPerBA(level) { return (60 * BA(level)) / 34; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function loadReferenceSet(file = SPEC_FILE) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const it of doc.items ?? []) {
    if (!EFFECTS.includes(it.effect)) throw new Error(`Mindscape: reference item "${it.id}" has unknown effect "${it.effect}"`);
    if (!(Number(it.magnitude) > 0)) throw new Error(`Mindscape: reference item "${it.id}" needs a magnitude above 0`);
  }
  return doc.items;
}

// ── The item ────────────────────────────────────────────────────────────────
function effectDoc(name, changes) {
  return { name, disabled: false, transfer: true, changes };
}

// -> a swap source for lib/loadout-swap.js applySwaps.
function makeReferenceSource(wearer, entry) {
  const n = Number(entry.magnitude);
  const slots = currentSlotItems(wearer);
  const derive = (base, patch) => {
    if (!base) throw new Error(`Mindscape: ${wearer.name} has nothing in ${entry.slot} to build reference item "${entry.id}" on`);
    const item = {
      id: `ref:${entry.id}`, name: `${base.name} [${entry.id}]`, type: base.type ?? "equippableItem",
      props: { ...clone(base.props), name: `${base.name} [${entry.id}]` },
      flags: {}, container: null, effects: clone(base.effects ?? []),
    };
    patch(item);
    return item;
  };
  const accessory = (changes) => ({
    id: `ref:${entry.id}`, name: `Reference ${entry.id}`, type: "equippableItem",
    props: { name: `Reference ${entry.id}`, item_type: "accessory" },
    flags: {}, container: null, effects: [effectDoc(`Reference ${entry.id}`, changes)],
  });

  let item;
  switch (entry.effect) {
    case "weapon-damage":
      item = derive(slots.main, (it) => { it.props.damage_bonus = String((Number(it.props.damage_bonus) || 0) + n); });
      break;
    case "weapon-accuracy":
      item = derive(slots.main, (it) => { it.props.check_bonus = String((Number(it.props.check_bonus) || 0) + n); });
      break;
    // Defence and HP ride on explicit effects, not on item_def_bonus: a martial armor
    // ignores its bonus fields (the world's own "Armor DEF" effect), so a prop delta
    // would do nothing on a Tank.
    case "defense":
      item = derive(slots.armor, (it) => it.effects.push(effectDoc(`Reference ${entry.id}`, [{ key: "bonus_defense", mode: 2, value: String(n), priority: 30 }])));
      break;
    case "magic-defense":
      item = derive(slots.armor, (it) => it.effects.push(effectDoc(`Reference ${entry.id}`, [{ key: "bonus_magic_defense", mode: 2, value: String(n), priority: 30 }])));
      break;
    case "max-hp":
      item = derive(slots.armor, (it) => it.effects.push(effectDoc(`Reference ${entry.id}`, [{ key: "system.props.max_hp", mode: 2, value: String(n), priority: 30 }])));
      break;
    case "spell-damage":
      item = accessory([{ key: "extra_damage_mod_spell", mode: 2, value: String(n), priority: 30 }]);
      break;
    case "physical-resistance":
      item = accessory([{ key: "affinity_1", mode: 5, value: "RS", priority: 30 }]);
      break;
    default:
      throw new Error(`Mindscape: unknown reference effect "${entry.effect}"`);
  }
  return { item, subItems: [], origin: `reference ladder "${entry.id}"`, warnings: [] };
}

// ── Measuring ───────────────────────────────────────────────────────────────
function meanSe(xs) {
  if (!xs.length) return { mean: null, se: null, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { mean, se: Math.sqrt(v / xs.length), n: xs.length };
}

// One arm: per-member samples, one per run.
function runArm(party, enemies, { runs, seed, expectedRounds = 10 }) {
  const members = new Map(party.map((p) => [p.name, { perAction: [], takenPerRound: [], defPerRound: [], mdefPerRound: [], downs: 0 }]));
  const rounds = [];
  let defeats = 0, hp = 0;
  for (let i = 0; i < runs; i++) {
    const r = runBattle({ party, enemies, rng: new Rng(`${seed}:${i}`), expectedRounds });
    rounds.push(r.rounds);
    hp += r.partyHpRemaining ?? 0;
    if (r.outcome === "defeat" || r.outcome === "mutual-destruction") defeats++;
    for (const c of r.combatants ?? []) {
      const m = members.get(c.name);
      if (!m) continue;
      const actions = (c.baseActionsTaken ?? 0) + (c.grantedActionsTaken ?? 0);
      if (actions > 0) m.perAction.push((c.damageDealt ?? 0) / actions);
      if (r.rounds > 0) {
        m.takenPerRound.push((c.damageTaken ?? 0) / r.rounds);
        m.defPerRound.push((c.damageTakenBy?.def ?? 0) / r.rounds);
        m.mdefPerRound.push((c.damageTakenBy?.mdef ?? 0) / r.rounds);
      }
      if (!c.alive) m.downs++;
    }
  }
  const summary = {};
  for (const [name, m] of members) {
    summary[name] = {
      perAction: meanSe(m.perAction), takenPerRound: meanSe(m.takenPerRound),
      defPerRound: meanSe(m.defPerRound), mdefPerRound: meanSe(m.mdefPerRound),
      downRate: m.downs / runs,
    };
  }
  const pct = (fn) => Math.round((rounds.filter(fn).length / runs) * 100);
  return {
    members: summary, defeatRate: defeats / runs, partyHp: hp / runs,
    meanRounds: rounds.reduce((a, b) => a + b, 0) / runs,
    bands: { oneRound: pct((x) => x <= 1), twoToThree: pct((x) => x >= 2 && x <= 3), fourPlus: pct((x) => x >= 4) },
  };
}

function pickWearer(party, entry, baseline) {
  if (entry.wearer === "striker" || entry.wearer === "caster") {
    return party.find((p) => p.fromArchetype?.role === entry.wearer) ?? null;
  }
  // A defensive item goes where the damage it can stop actually lands: +DEF on whoever
  // takes the most DEF-rolled damage, +MDEF on whoever takes the most MDEF-rolled damage.
  // A single "most hit" rule put +MDEF on a Tank that only ever took physical hits and
  // measured it at exactly zero.
  const metric = { "most-hit": "takenPerRound", "most-hit-def": "defPerRound", "most-hit-mdef": "mdefPerRound" }[entry.wearer];
  if (metric) {
    let best = null;
    for (const p of party) {
      const t = baseline.members[p.name]?.[metric].mean ?? -1;
      if (!best || t > best.t) best = { p, t };
    }
    return best?.p ?? null;
  }
  throw new Error(`Mindscape: unknown reference wearer "${entry.wearer}"`);
}

// Paper price (guide Part 4) in % of output, from the baseline's exposure where needed.
function paperValue(entry, level, base) {
  const n = Number(entry.magnitude);
  switch (entry.effect) {
    case "weapon-damage":
    case "spell-damage":
      return (100 * n * GUIDE.hitRate) / BA(level);
    case "weapon-accuracy":
      return 100 * n * GUIDE.accuracyPerPoint;
    case "defense":
      return (100 * n * GUIDE.defensePerPoint * (base.defPerRound.mean ?? 0)) / hpPerBA(level);
    case "magic-defense":
      return (100 * n * GUIDE.defensePerPoint * (base.mdefPerRound.mean ?? 0)) / hpPerBA(level);
    case "physical-resistance":
      // The neutral encounter's damage is all physical: full uptime.
      return (100 * GUIDE.rsShare * (base.takenPerRound.mean ?? 0)) / hpPerBA(level);
    case "max-hp":
      return (100 * n) / hpPerBA(level) / GUIDE.actionsPerFight;
    default:
      return null;
  }
}

// Sim price with a 95% interval, from two arms' per-run samples.
function simValue(entry, level, base, item) {
  const offense = entry.effect === "weapon-damage" || entry.effect === "weapon-accuracy" || entry.effect === "spell-damage";
  if (entry.effect === "max-hp") return { pct: null, ci95: null, vsOwn: null };
  const [b, i, unit] = offense
    ? [base.perAction, item.perAction, BA(level)]
    : [base.takenPerRound, item.takenPerRound, hpPerBA(level)];
  if (b.mean == null || i.mean == null) return { pct: null, ci95: null, vsOwn: null };
  const delta = offense ? i.mean - b.mean : b.mean - i.mean;
  const se = Math.sqrt((b.se ?? 0) ** 2 + (i.se ?? 0) ** 2);
  return {
    pct: (100 * delta) / unit,
    ci95: (100 * 1.96 * se) / unit,
    vsOwn: b.mean ? (100 * delta) / b.mean : null,
  };
}

module.exports = {
  GUIDE, EFFECTS, SPEC_FILE, BA, hpPerBA,
  loadReferenceSet, makeReferenceSource, runArm, pickWearer, paperValue, simValue, meanSe,
};
