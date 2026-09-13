"use strict";
// Mindscape — the vanilla reference ladder (lib/reference-set.js). Plain node.
//
// Each reference item must change EXACTLY the number it names on its wearer, on a real
// archetype (built from a rulebook-shaped catalogue), and nothing else. The pricing
// helpers are pinned to the guide's own constants.

const assert = require("assert");
const RS = require("../lib/reference-set");
const A = require("../lib/archetype-party");
const B = require("../lib/baseline-gear");
const SW = require("../lib/loadout-swap");
const { WorldItems } = require("../lib/world-items");
const { buildNeutralEncounter } = require("../lib/neutral-encounter");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// ── Rulebook-shaped basic gear (same shape as archetype.test.js) ─────────────
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
  it(`s-${name}`, name, "f-bs", { item_type: "shield", isMartial: martial, item_def_bonus: String(def),
    item_mdef_bonus: String(mdef) }, SW.standardShieldEffects());
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
const party = () => A.buildArchetypeParty("standard", { level: 41, power: "table", k: 3.78, catalogue });
const member = (p, role) => p.find((m) => m.fromArchetype.role === role);
const entry = (effect, magnitude, slot) => ({ id: `${effect}-${magnitude}`, effect, magnitude, slot, wearer: "striker" });
const swap = (wearer, e) => SW.applySwaps(wearer, [{ slot: e.slot, source: RS.makeReferenceSource(wearer, e) }], { worldItems: world });

// ── Pricing constants ───────────────────────────────────────────────────────
t("BA and HP-per-BA follow guide Parts 3-4", () => {
  assert.strictEqual(RS.BA(30), 34);
  assert.ok(Math.abs(RS.BA(41) - 50.17) < 0.01, `BA(41) ${RS.BA(41)}`);
  assert.strictEqual(RS.hpPerBA(30), 60);
});
t("paper: +10 weapon damage at L41 = 10 x 0.49 / BA(41) ≈ 9.7%", () => {
  assert.ok(Math.abs(RS.paperValue(entry("weapon-damage", 10, "main"), 41, {}) - 9.74) < 0.05);
});
t("paper: +1 accuracy = 17% at any level", () => {
  assert.strictEqual(RS.paperValue(entry("weapon-accuracy", 1, "main"), 20, {}), 17);
});
t("paper: +2 DEF uses the wearer's DEF-aimed exposure", () => {
  const base = { defPerRound: { mean: 30 } };
  const expect = (100 * 2 * 0.175 * 30) / RS.hpPerBA(41);
  assert.ok(Math.abs(RS.paperValue(entry("defense", 2, "armor"), 41, base) - expect) < 1e-9);
});

// ── Items change exactly what they name ─────────────────────────────────────
t("weapon-damage +5: the Striker's Greatsword goes +10 -> +15, nothing else moves", () => {
  const p = party(), s = member(p, "striker");
  const before = { def: s.def, mdef: s.mdef, hp: s.hp.max, acc: s.weapon.checkBonus };
  swap(s, entry("weapon-damage", 5, "main"));
  assert.strictEqual(s.weapon.baseDamage, 15);
  assert.deepStrictEqual({ def: s.def, mdef: s.mdef, hp: s.hp.max, acc: s.weapon.checkBonus }, before);
});
t("weapon-accuracy +2: check bonus +1 -> +3, damage unchanged", () => {
  const p = party(), s = member(p, "striker");
  swap(s, entry("weapon-accuracy", 2, "main"));
  assert.strictEqual(s.weapon.checkBonus, 3);
  assert.strictEqual(s.weapon.baseDamage, 10);
});
t("defense +2 works on MARTIAL armor too (Tank's Brigadine)", () => {
  const p = party(), tank = member(p, "tank");
  const before = tank.def;
  swap(tank, { ...entry("defense", 2, "armor") });
  assert.strictEqual(tank.def, before + 2);
});
t("magic-defense +3 and max-hp +25 on the Caster's Sage Robe", () => {
  const p = party(), c = member(p, "caster");
  const { mdef, hp } = { mdef: c.mdef, hp: c.hp.max };
  swap(c, entry("magic-defense", 3, "armor"));
  assert.strictEqual(c.mdef, mdef + 3);
  const p2 = party(), c2 = member(p2, "caster");
  swap(c2, entry("max-hp", 25, "armor"));
  assert.strictEqual(c2.hp.max, hp + 25);
});
t("spell-damage +5 accessory: only spell damage moves", () => {
  const p = party(), c = member(p, "caster");
  const all = c.extraDamage.all;
  swap(c, entry("spell-damage", 5, "acc1"));
  assert.strictEqual(c.extraDamage.spell, 5);
  assert.strictEqual(c.extraDamage.all, all);
});
t("physical-resistance accessory: physical RS, other elements untouched", () => {
  const p = party(), tank = member(p, "tank");
  swap(tank, entry("physical-resistance", 1, "acc1"));
  assert.strictEqual(tank.affinities.physical, "RS");
  assert.strictEqual(tank.affinities.fire, "NE");
});

// ── Measuring ───────────────────────────────────────────────────────────────
t("runArm reports per-member samples; most-hit picks the member taking the most", () => {
  const p = party();
  const arm = RS.runArm(p, buildNeutralEncounter("normal", { level: 41 }), { runs: 30, seed: "ref-test" });
  for (const m of p) {
    const s = arm.members[m.name];
    assert.ok(s.perAction.n > 0 && s.takenPerRound.n === 30, m.name);
  }
  const hit = RS.pickWearer(p, { wearer: "most-hit" }, arm);
  const max = Math.max(...p.map((m) => arm.members[m.name].takenPerRound.mean));
  assert.strictEqual(arm.members[hit.name].takenPerRound.mean, max);
});
t("simValue: offense per action / BA, defense prevented per round / HP-per-BA, max-hp null", () => {
  const S = (mean) => ({ mean, se: 0 });
  const off = RS.simValue(entry("weapon-damage", 5, "main"), 30, { perAction: S(20) }, { perAction: S(23.4) });
  assert.ok(Math.abs(off.pct - 10) < 1e-9);
  const def = RS.simValue(entry("defense", 1, "armor"), 30, { takenPerRound: S(18) }, { takenPerRound: S(12) });
  assert.ok(Math.abs(def.pct - 10) < 1e-9);
  assert.strictEqual(RS.simValue(entry("max-hp", 10, "armor"), 30, {}, {}).pct, null);
});
t("simValue: with both arms, defence is priced PARTY-wide; the wearer figure is kept", () => {
  const S = (mean) => ({ mean, se: 0 });
  const arms = { baseline: { partyTakenPerRound: S(60) }, withItem: { partyTakenPerRound: S(51) } };
  const v = RS.simValue(entry("defense", 3, "armor"), 30, { takenPerRound: S(20) }, { takenPerRound: S(20) }, arms);
  assert.ok(Math.abs(v.pct - 15) < 1e-9, `party-wide ${v.pct}`);
  assert.ok(Math.abs(v.wearerPct) < 1e-9, `a protector's own intake can stay flat while the party takes less (${v.wearerPct})`);
});
t("runArm reports party-wide damage taken per round", () => {
  const p = party();
  const arm = RS.runArm(p, buildNeutralEncounter("normal", { level: 41 }), { runs: 20, seed: "ref-party" });
  const sum = p.reduce((s, m) => s + arm.members[m.name].takenPerRound.mean, 0);
  assert.ok(Math.abs(arm.partyTakenPerRound.mean - sum) < 1e-9, `${arm.partyTakenPerRound.mean} vs ${sum}`);
});
t("runArm splits fight length by outcome: won bands never exceed all-fight bands", () => {
  const p = party();
  const arm = RS.runArm(p, buildNeutralEncounter("normal", { level: 41 }), { runs: 40, seed: "ref-won" });
  for (const band of ["oneRound", "twoToThree", "fourPlus"]) {
    assert.ok(arm.wonBands[band] <= arm.bands[band], `${band}: won ${arm.wonBands[band]} > all ${arm.bands[band]}`);
  }
  const won = arm.wonBands.oneRound + arm.wonBands.twoToThree + arm.wonBands.fourPlus;
  // Overtime and inconclusive fights are neither won nor lost, so won <= not-defeated.
  assert.ok(won <= 100 * (1 - arm.defeatRate) + 3, `won ${won}% vs ${100 * (1 - arm.defeatRate)}% not defeated`);
  assert.ok(won > 0, "the L41 standard party wins some rulebook fights");
});
t("neutralScopes: one rulebook scope per level, sharing a slope key across encounter kinds", () => {
  const normal = RS.neutralScopes([20, 41], { defense: 13 });
  assert.deepStrictEqual(normal.map((s) => [s.id, s.slopeKey, s.level, s.enemies.length]), [["L20", "L20", 20, 4], ["L41", "L41", 41, 4]]);
  assert.ok(normal[1].enemies.every((e) => e.def === 13 && e.mdef === 13));
  const elites = RS.neutralScopes([41], { kind: "elite-pair" });
  assert.deepStrictEqual([elites[0].id, elites[0].slopeKey, elites[0].enemies.length], ["L41-elite-pair", "L41", 2]);
  assert.strictEqual(elites[0].conflictEvent, null);
});
t("runArm passes the scope's conflict event into every battle", () => {
  const { resolveEvent } = require("../lib/conflict-events");
  const p = party();
  const enemies = buildNeutralEncounter("normal", { level: 41 });
  const calm = RS.runArm(p, enemies, { runs: 20, seed: "ref-storm" });
  const storm = RS.runArm(p, enemies, { runs: 20, seed: "ref-storm", conflictEvent: resolveEvent("lightning-storm") });
  assert.notStrictEqual(storm.partyTakenPerRound.mean, calm.partyTakenPerRound.mean, "the storm should change what the party takes");
});
t("the ladder file loads and every effect is known", () => {
  const items = RS.loadReferenceSet();
  assert.strictEqual(items.length, 24);
  assert.deepStrictEqual([...new Set(items.map((i) => i.effect))].sort(), [...RS.EFFECTS].sort());
  assert.deepStrictEqual(items.filter((i) => i.wearer === "tank").map((i) => i.id), ["def-1-tank", "def-2-tank", "def-3-tank"]);
});
t("a role wearer picks that role, or nobody when the preset lacks it", () => {
  const p = party();
  assert.strictEqual(RS.pickWearer(p, { wearer: "tank" }, {}).name, "Tank");
  const dc = A.buildArchetypeParty("double-caster", { level: 41, power: "table", k: 3.54, catalogue });
  assert.strictEqual(RS.pickWearer(dc, { wearer: "tank" }, {}), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
