"use strict";
//
// Mindscape — the vanilla equipment reference ladder (equipment guide Parts 8 and 10).
//
// Each reference item is the wearer's OWN basic item (or an empty accessory slot) plus a
// single effect. It is measured twice on the same archetype party, level, encounter and
// seed — without the item and with it — and the difference is priced in the guide's unit:
//
//   offense   % = extra damage per wearer ACTION / BA(L)
//   defense   % = damage prevented per ROUND across the WHOLE PARTY / HP-per-BA(L)
//               (the wearer-only figure is kept beside it)
//   max HP      reported as survival deltas only (the metric has no damage term)
//
//   BA(L)        = 34 x 1.036^(L - 30)            guide Part 3
//   HP-per-BA(L) = 60 x BA(L) / 34                guide Part 4 ("~60 HP = 1 BA at L30")
//
// Why party-wide for defence: a protector with more DEF stays healthier, so it steps in
// front of MORE hits. Its own damage taken can stay flat while the party takes less — the
// wearer-only number undercounts exactly the characters defence items are built for.
//
// SCOPES — what the items are measured against:
//   neutral        rulebook NPC encounters at chosen levels (the comparison BASE)
//   encounter set  real spawn groups from the world's Encounter tables, each at its own
//                  party level, with its dungeon's conflict event (the LIVE environment)
//
// Beside each measurement sits the guide's PAPER price for the same item. Defensive paper
// prices need the wearer's exposure (damage aimed at DEF/MDEF), taken from the baseline.

const fs = require("fs");
const path = require("path");
const { runBattle } = require("./engine");
const { Rng } = require("./rng");
const { currentSlotItems } = require("./loadout-swap");

const SPEC_FILE = path.join(__dirname, "..", "specs", "equipment", "reference-set.json");

const GUIDE = Object.freeze({
  hitRate: 0.49,           // Part 4 default target, DEF 13 (pre-P1 pricing, kept for the paper column)
  accuracyPerPoint: 0.17,  // +1 accuracy = +17% of affected damage at DEF 13 (pre-P2)
  defensePerPoint: 0.175,  // +1 DEF/MDEF = -15-20% of damage aimed at that defence (pre-P4)
  rsShare: 0.5,            // Resistance halves the damage it applies to
  actionsPerFight: 2.5,
});

const EFFECTS = Object.freeze(["weapon-damage", "weapon-accuracy", "spell-damage", "defense", "magic-defense", "max-hp", "physical-resistance"]);
const OFFENSE = new Set(["weapon-damage", "weapon-accuracy", "spell-damage"]);
const ROLES = ["striker", "caster", "tank", "support", "ranger"];

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

// ── Scopes ──────────────────────────────────────────────────────────────────
// Neutral rulebook encounters, one per level: the comparison base.
function neutralScopes(levels, { defense = null, kind = "normal" } = {}) {
  const { buildNeutralEncounter } = require("./neutral-encounter");
  return levels.map((level) => ({
    id: `L${level}${kind === "normal" ? "" : `-${kind}`}`, slopeKey: `L${level}`, group: `L${level}`,
    label: `rulebook ${kind} L${level}${defense != null ? ` (DEF/MDEF ${defense})` : ""}`,
    level, enemies: buildNeutralEncounter(kind, { level, defense }),
    conflictEvent: null, conflictEventName: null, unmodelled: [],
  }));
}

// Real spawn groups from an encounter-set file (specs/encounters/*.json): the live
// environment. World monsters are loaded once, by exact name; a missing name refuses the
// whole set rather than quietly running a smaller fight. Each scope carries the passives
// the model does NOT simulate, so a reader can see what a result leaves out.
async function loadEncounterSet(file) {
  const { loadAll } = require("./load-actors");
  const { resolveEvent } = require("./conflict-events");
  const RX = require("./reactions");
  const { extractActions } = require("./skills");

  const abs = path.resolve(file);
  const doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  const all = await loadAll();
  const byName = new Map();
  for (const a of all) {
    if (!a.isNpc) continue;
    const k = String(a.name ?? "").trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, a);
  }
  const missing = [];
  const scopes = (doc.encounters ?? []).map((e) => {
    const enemies = e.enemies.map((n) => {
      const m = byName.get(String(n).trim().toLowerCase());
      if (!m) missing.push(`${e.id}: "${n}"`);
      return m;
    });
    if (!Number.isInteger(e.level) || e.level < 5 || e.level > 50) missing.push(`${e.id}: level ${e.level} is not 5-50`);
    const present = enemies.filter(Boolean);
    const unmodelled = [...new Set(present.flatMap((m) =>
      RX.undeclaredReactions(extractActions(m).passives).map((x) => `${m.name}: ${x}`)))];
    return {
      id: e.id, slopeKey: e.id, group: e.dungeon, label: `${e.dungeon} — ${e.enemies.join(", ")}`,
      level: e.level, enemies: present,
      conflictEvent: e.conflictEvent ? resolveEvent(e.conflictEvent) : null,
      conflictEventName: e.conflictEvent ?? null, unmodelled,
    };
  });
  if (missing.length) throw new Error(`Mindscape: encounter set ${abs} does not resolve:\n  · ${missing.join("\n  · ")}`);
  return scopes;
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

// One arm: per-member samples and party totals, one sample per run.
function runArm(party, enemies, { runs, seed, expectedRounds = 10, conflictEvent = null }) {
  const members = new Map(party.map((p) => [p.name, { perAction: [], takenPerRound: [], defPerRound: [], mdefPerRound: [], downs: 0,
    dealtPerRound: [], actionsPerRound: [], actionsPerFight: [], downShare: [], hitsTaken: 0, actionDamageTaken: 0 }]));
  const partyTaken = [];
  const partyDealt = [];
  const rounds = [];
  const wonRounds = [];
  let defeats = 0, hp = 0;
  for (let i = 0; i < runs; i++) {
    const r = runBattle({ party, enemies, rng: new Rng(`${seed}:${i}`), expectedRounds, conflictEvent });
    rounds.push(r.rounds);
    if (r.outcome === "victory") wonRounds.push(r.rounds);
    hp += r.partyHpRemaining ?? 0;
    if (r.outcome === "defeat" || r.outcome === "mutual-destruction") defeats++;
    let taken = 0, dealt = 0;
    for (const c of r.combatants ?? []) {
      const m = members.get(c.name);
      if (!m || c.side !== "party") continue;
      taken += c.damageTaken ?? 0;
      dealt += c.damageDealt ?? 0;
      const actions = (c.baseActionsTaken ?? 0) + (c.grantedActionsTaken ?? 0);
      if (actions > 0) m.perAction.push((c.damageDealt ?? 0) / actions);
      m.actionsPerFight.push(actions);
      if (r.rounds > 0) {
        m.takenPerRound.push((c.damageTaken ?? 0) / r.rounds);
        m.defPerRound.push((c.damageTakenBy?.def ?? 0) / r.rounds);
        m.mdefPerRound.push((c.damageTakenBy?.mdef ?? 0) / r.rounds);
        m.dealtPerRound.push((c.damageDealt ?? 0) / r.rounds);
        m.actionsPerRound.push(actions / r.rounds);
        // Share of the fight spent knocked out: rounds after the one it fell in. Unlike
        // actions per fight, it does not move just because the fight got shorter.
        m.downShare.push(c.downedOnRound ? Math.max(0, r.rounds - c.downedOnRound) / r.rounds : 0);
      }
      m.hitsTaken += c.hitsTaken ?? 0;
      m.actionDamageTaken += (c.damageTakenBy?.def ?? 0) + (c.damageTakenBy?.mdef ?? 0);
      if (!c.alive) m.downs++;
    }
    if (r.rounds > 0) { partyTaken.push(taken / r.rounds); partyDealt.push(dealt / r.rounds); }
  }
  const summary = {};
  for (const [name, m] of members) {
    summary[name] = {
      perAction: meanSe(m.perAction), takenPerRound: meanSe(m.takenPerRound),
      defPerRound: meanSe(m.defPerRound), mdefPerRound: meanSe(m.mdefPerRound),
      downRate: m.downs / runs,
      dealtPerRound: meanSe(m.dealtPerRound), actionsPerRound: meanSe(m.actionsPerRound),
      actionsPerFight: meanSe(m.actionsPerFight), downShare: meanSe(m.downShare),
      // Mean damage of one landed action hit — the unit max HP is priced against.
      damagePerHit: m.hitsTaken ? m.actionDamageTaken / m.hitsTaken : null,
    };
  }
  // Bands are shares of ALL fights. `bands` counts every outcome; `wonBands` only victories,
  // because "1 round = too easy" is about wins — a party wiped in one round is not easy.
  const bandsOf = (xs) => {
    const pct = (fn) => Math.round((xs.filter(fn).length / runs) * 100);
    return { oneRound: pct((x) => x <= 1), twoToThree: pct((x) => x >= 2 && x <= 3), fourPlus: pct((x) => x >= 4) };
  };
  return {
    members: summary, partyTakenPerRound: meanSe(partyTaken), partyDealtPerRound: meanSe(partyDealt),
    defeatRate: defeats / runs, partyHp: hp / runs,
    meanRounds: rounds.reduce((a, b) => a + b, 0) / runs,
    bands: bandsOf(rounds), wonBands: bandsOf(wonRounds),
  };
}

function pickWearer(party, entry, baseline) {
  // A role name (striker, caster, tank, support, ranger): the preset's first member of it.
  if (ROLES.includes(entry.wearer)) {
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

// Paper price (guide Part 4, pre-correction) in % of output, from the baseline's exposure
// where needed. Kept as the reference column the corrections were measured against.
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
      return (100 * GUIDE.rsShare * (base.takenPerRound.mean ?? 0)) / hpPerBA(level);
    case "max-hp":
      return (100 * n) / hpPerBA(level) / GUIDE.actionsPerFight;
    default:
      return null;
  }
}

function priced(b, i, unit, sign) {
  if (b?.mean == null || i?.mean == null) return { pct: null, ci95: null };
  const se = Math.sqrt((b.se ?? 0) ** 2 + (i.se ?? 0) ** 2);
  return { pct: (100 * sign * (i.mean - b.mean)) / unit, ci95: (100 * 1.96 * se) / unit };
}

// Sim price with a 95% interval. `base`/`item` are the WEARER's member stats; `arms` (the
// two whole arms) makes defence party-wide. Without `arms`, defence falls back to the
// wearer — kept for callers that only have member stats.
function simValue(entry, level, base, item, arms = null) {
  if (entry.effect === "max-hp") return { pct: null, ci95: null, vsOwn: null, wearerPct: null };
  if (OFFENSE.has(entry.effect)) {
    const p = priced(base.perAction, item.perAction, BA(level), +1);
    return { ...p, vsOwn: base.perAction?.mean ? (100 * (item.perAction.mean - base.perAction.mean)) / base.perAction.mean : null, wearerPct: p.pct };
  }
  const wearer = priced(base.takenPerRound, item.takenPerRound, hpPerBA(level), -1);
  if (!arms) return { ...wearer, vsOwn: null, wearerPct: wearer.pct };
  const partyWide = priced(arms.baseline.partyTakenPerRound, arms.withItem.partyTakenPerRound, hpPerBA(level), -1);
  return { ...partyWide, vsOwn: null, wearerPct: wearer.pct };
}

module.exports = {
  GUIDE, EFFECTS, SPEC_FILE, BA, hpPerBA,
  loadReferenceSet, neutralScopes, loadEncounterSet,
  makeReferenceSource, runArm, pickWearer, paperValue, simValue, meanSe,
};
