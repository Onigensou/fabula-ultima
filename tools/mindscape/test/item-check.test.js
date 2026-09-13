"use strict";
// Mindscape — one designed item (lib/item-check.js) and the Encounter-table census
// (bin/encounter-census.js). Plain node.

const assert = require("assert");
const IC = require("../lib/item-check");
const RS = require("../lib/reference-set");
const B = require("../lib/baseline-gear");
const SW = require("../lib/loadout-swap");
const { WorldItems } = require("../lib/world-items");
const { censusOfRows, averageCensus, dieCeiling } = require("../bin/encounter-census");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// ── Pricing ─────────────────────────────────────────────────────────────────
const S = (mean) => ({ mean, se: 0 });
const member = (o) => ({ dealtPerRound: S(o.dealt), actionsPerRound: S(o.apr ?? 1), actionsPerFight: S(o.apf ?? 3),
  downShare: S(o.downShare ?? 0), downRate: o.down ?? 0, damagePerHit: 20 });
const arm = (m, o) => ({ members: { X: m }, partyTakenPerRound: S(o.taken), partyDealtPerRound: S(o.dealt), defeatRate: o.loss ?? 0,
  meanRounds: o.rounds ?? 3, wonBands: { oneRound: o.won1 ?? 0 } });

t("priceArms: offense per wearer action / BA, defense party-wide / HP-per-BA, summed", () => {
  const base = arm(member({ dealt: 34 }), { taken: 60, dealt: 100 });
  const item = arm(member({ dealt: 37.4 }), { taken: 54, dealt: 103.4 });
  const p = IC.priceArms(30, "X", base, item);
  assert.ok(Math.abs(p.offense - 10) < 1e-9, `offense ${p.offense}`);
  assert.ok(Math.abs(p.defense - 10) < 1e-9, `defense ${p.defense}`);
  assert.ok(Math.abs(p.value - 20) < 1e-9);
  assert.ok(Math.abs(p.partyOffense - 10) < 1e-9);
});
t("priceArms: an item that grants actions is credited through damage per round", () => {
  const base = arm(member({ dealt: 34, apr: 1 }), { taken: 60, dealt: 100 });
  const item = arm(member({ dealt: 68, apr: 2 }), { taken: 60, dealt: 134 });
  assert.ok(Math.abs(IC.priceArms(30, "X", base, item).offense - 100) < 1e-9, "one extra action per round = 1 BA = 100%");
});
t("priceArms: actions kept = fight share no longer spent knocked out; KO points from the wearer", () => {
  const base = arm(member({ dealt: 30, apf: 4, down: 0.5, downShare: 0.3 }), { taken: 60, dealt: 100 });
  const item = arm(member({ dealt: 30, apf: 3, down: 0.3, downShare: 0.05 }), { taken: 60, dealt: 100 });
  const p = IC.priceArms(30, "X", base, item);
  assert.ok(Math.abs(p.actionsKept - 25) < 1e-9);
  assert.ok(Math.abs(p.koPts + 20) < 1e-9);
});
t("summarize: the level check prefers house rows, falls back to the base, and says which", () => {
  const row = (kind, level, value) => ({ kind, group: `${kind}${level}`, level, value, offense: value, defense: 0, partyOffense: 0,
    actionsKept: 0, koPts: 0, lossPts: 0, rounds: { baseline: 3, withItem: 3 }, wonInOne: { baseline: 0, withItem: 0 } });
  const s = IC.summarize([row("house", 40, 12), row("house", 50, 6), row("base", 20, 14), row("base", 50, 4)], 10);
  assert.strictEqual(s.verdict.earlySource, "base");
  assert.strictEqual(s.verdict.earlyOk, false, "14% at L20 is over a 10% budget");
  assert.strictEqual(s.verdict.lateSource, "house");
  assert.strictEqual(s.verdict.lateOk, true, "6% at L50 is at least half of 10%");
  assert.ok(Math.abs(s.verdict.house - 9) < 1e-9);
});

// ── End to end on a rulebook-shaped world ───────────────────────────────────
const folders = new Map([
  ["f-eq", { id: "f-eq", name: "⚔️ Equipments", parent: null }],
  ["f-bw", { id: "f-bw", name: "Basic Weapon", parent: "f-eq" }],
  ["f-ba", { id: "f-ba", name: "Basic Armor", parent: "f-eq" }],
  ["f-bs", { id: "f-bs", name: "Basic Shield", parent: "f-eq" }],
]);
const it = (id, name, folder, props, effects = []) =>
  ({ id, name, type: "equippableItem", folder, props: { name, ...props }, flags: {}, container: null, effects });
const weapon = (name, category, hands, a1, a2, dmg, chk, range = "Melee") =>
  it(`w-${name}`, name, "f-bw", { item_type: "weapon", category, hand_slots: hands, rolled_atr1: a1, rolled_atr2: a2,
    damage_bonus: String(dmg), check_bonus: String(chk), type_damage: "Physical", weapon_range: range });
const armor = (name, martial, baseDef, def, mdef) =>
  it(`a-${name}`, name, "f-ba", { item_type: "armor", isMartial: martial, item_baseDef: String(baseDef), item_baseMdef: "0",
    item_def_bonus: String(def), item_mdef_bonus: String(mdef) }, SW.standardArmorEffects());
const shield = (name, martial, def, mdef) =>
  it(`s-${name}`, name, "f-bs", { item_type: "shield", isMartial: martial, item_def_bonus: String(def), item_mdef_bonus: String(mdef) }, SW.standardShieldEffects());
const world = new WorldItems(new Map([
  weapon("Bronze Sword", "Sword", "One-handed", "DEX", "MIG", 6, 1),
  weapon("Greatsword", "Sword", "Two-handed", "DEX", "MIG", 10, 1),
  weapon("Shortbow", "Bow", "Two-handed", "DEX", "DEX", 8, 0, "Ranged"),
  weapon("Staff", "Arcane", "Two-handed", "WLP", "WLP", 6, 0),
  weapon("Tome", "Arcane", "Two-handed", "INS", "INS", 6, 0),
  armor("Sage Robe", false, 0, 1, 2), armor("Silk Shirt", false, 0, 0, 2), armor("Combat Tunic", false, 0, 1, 1),
  armor("Brigadine", true, 10, 0, 0),
  shield("Runic Shield", true, 2, 2),
].map((x) => [x.id, x])));
const catalogue = B.basicCatalogue(world, folders);

t("measureItem: a paper accessory on the Tank measures, and its unregistered passive is reported", () => {
  const charm = {
    name: "Test Charm",
    system: { props: { item_type: "accessory", item_rarity: "Common" } },
    effects: [{ name: "Test Charm DEF", changes: [{ key: "bonus_defense", mode: 2, value: "3", priority: 30 }] }],
    items: [{ name: "Test Charm Glow (Passive)", props: { skill_type: "Passive" } }],
  };
  const scopes = RS.neutralScopes([41], { defense: 13 }).map((s) => ({ ...s, kind: "base" }));
  const { rows, coverage } = IC.measureItem({ item: charm, slot: "acc1", wearer: "tank", scopes, presets: ["standard"],
    runs: 12, seed: "item-check-test", catalogue, worldItems: world });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].wearer, "Tank");
  assert.ok(Number.isFinite(rows[0].value) && Number.isFinite(rows[0].defense), JSON.stringify(rows[0]));
  assert.deepStrictEqual(coverage.unmodelledPassives, ["Test Charm Glow (Passive)"]);
});

t("measureItem: a weapon is measured against the basic weapon of ITS category, not the wearer's", () => {
  const bow = {
    name: "Test Longbow",
    system: { props: { item_type: "weapon", category: "Bow", hand_slots: "Two-handed", rolled_atr1: "DEX", rolled_atr2: "DEX",
      damage_bonus: "12", check_bonus: "0", type_damage: "Physical", weapon_range: "Ranged" } },
  };
  const scopes = RS.neutralScopes([30], { defense: 13 }).map((s) => ({ ...s, kind: "base" }));
  const { rows, coverage } = IC.measureItem({ item: bow, slot: "main", wearer: "striker", scopes, presets: ["standard"],
    runs: 8, seed: "item-check-chassis", catalogue, worldItems: world });
  assert.strictEqual(rows[0].chassis, "Shortbow", "the Striker's Greatsword is not the 0% for a bow");
  assert.ok(coverage.chassis.startsWith("Shortbow"));
});

// ── Census ──────────────────────────────────────────────────────────────────
const mon = (species, rank = "soldier") => ({ name: species, level: 30, rank, species, turns: 1 });
t("dieCeiling reads NdM and refuses anything else", () => {
  assert.strictEqual(dieCeiling("1d22"), 22);
  assert.strictEqual(dieCeiling("2d6"), 12);
  assert.strictEqual(dieCeiling(""), null);
});
t("censusOfRows: counts, extra targets, species by enemy share; bosses and low rows excluded", () => {
  const rows = [
    { weight: 1, level: 30, boss: false, monsters: [mon("BEAST"), mon("BEAST"), mon("BEAST")] },
    { weight: 1, level: 30, boss: false, monsters: [mon("ELEMENTAL", "elite")] },
    { weight: 2, level: 50, boss: true, monsters: [mon("DEMON", "elite")] },
    { weight: 2, level: 10, boss: false, monsters: [mon("HUMANOID"), mon("HUMANOID")] },
  ];
  const c = censusOfRows(rows, { minLevel: 20 });
  assert.deepStrictEqual(c.counts, { 3: 0.5, 1: 0.5 });
  assert.strictEqual(c.extraTargets[2], 0.5);
  assert.strictEqual(c.extraTargets[3], 1);
  assert.deepStrictEqual(c.species, { BEAST: 0.5, ELEMENTAL: 0.5 });
  assert.strictEqual(c.eliteShare, 0.5);
  assert.strictEqual(c.meanEnemies, 2);
  const all = censusOfRows(rows);
  assert.ok(Math.abs(all.counts[2] - 0.5) < 1e-9, "the low row weighs 2 of the 4 non-boss weight");
});
t("averageCensus weighs each table equally and skips empty ones", () => {
  const a = { weight: 1, counts: { 1: 1 }, extraTargets: { 2: 0 }, species: { X: 1 }, speciesPresent: { X: 1 }, eliteShare: 1, meanEnemies: 1 };
  const b = { weight: 1, counts: { 3: 1 }, extraTargets: { 2: 1 }, species: { Y: 1 }, speciesPresent: { Y: 1 }, eliteShare: 0, meanEnemies: 3 };
  const empty = { weight: 0, counts: {}, extraTargets: {}, species: {}, speciesPresent: {}, eliteShare: 0, meanEnemies: 0 };
  const c = averageCensus([a, b, empty]);
  assert.strictEqual(c.tables, 2);
  assert.deepStrictEqual(c.counts, { 1: 0.5, 3: 0.5 });
  assert.strictEqual(c.meanEnemies, 2);
});

// ── Spread test ─────────────────────────────────────────────────────────────
const { fitLine, spreadEfficiency } = require("../bin/spread-test");
t("fitLine recovers a straight line", () => {
  const { a, b } = fitLine([0, 10, 20], [5, 7, 9]);
  assert.ok(Math.abs(a - 5) < 1e-9 && Math.abs(b - 0.2) < 1e-9);
});
t("spreadEfficiency: spread damage that ends fights like half its damage total reads 0.5", () => {
  // Flat: +1 dealt and -0.1 rounds per point. Multi deals +20 (X_damage 20) but only shortens
  // fights by 1 round (X_rounds 10).
  const flat = [0, 10, 20].map((x) => ({ x, dealt: 30 + x, rounds: 5 - 0.1 * x, taken: 60 - x }));
  const e = spreadEfficiency(flat, { dealt: 50, rounds: 4, taken: 40 });
  assert.ok(Math.abs(e.xDamage - 20) < 1e-9);
  assert.ok(Math.abs(e.roundsEfficiency - 0.5) < 1e-9, `${e.roundsEfficiency}`);
  assert.ok(Math.abs(e.takenEfficiency - 1) < 1e-9);
  assert.strictEqual(e.extrapolated, false);
});
t("spreadEfficiency: a flat line that does not move gives no ratio", () => {
  const flat = [0, 10].map((x) => ({ x, dealt: 30 + x, rounds: 3, taken: 60 }));
  const e = spreadEfficiency(flat, { dealt: 40, rounds: 3, taken: 60 });
  assert.strictEqual(e.roundsEfficiency, null);
  assert.strictEqual(e.takenEfficiency, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
