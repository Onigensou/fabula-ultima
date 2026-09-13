"use strict";
// Mindscape — blank-slate archetype parties (lib/archetype-party.js). Plain node.
//
// The goldens are the RULEBOOK's own numbers:
//   Camilla (pp.161-165) — printed: 40 HP, 50 MP, Defense 11, Magic Defense 13.
//   p.169 tip — "d8 Dexterity wearing a brigandine and wielding a bronze shield will
//   have a Defense score of 12".
//   Classic Characters (pp.172-175) — the book prints builds, not totals; totals below
//   are the p.163-164 formulas applied by hand to the printed build.

const assert = require("assert");
const A = require("../lib/archetype-party");
const B = require("../lib/baseline-gear");
const SW = require("../lib/loadout-swap");
const { WorldItems } = require("../lib/world-items");
const { verifyLoadout } = require("../lib/loadout");
const { extractActions } = require("../lib/skills");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// ── A world holding the rulebook's basic gear (pp.166-169) ──────────────────
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
  it(`a-${name}`, name, "f-ba", { item_type: "armor", isMartial: martial, item_baseDef: String(baseDef),
    item_baseMdef: "0", item_def_bonus: String(def), item_mdef_bonus: String(mdef) }, SW.standardArmorEffects());
const shield = (name, martial, def, mdef) =>
  it(`s-${name}`, name, "f-bs", { item_type: "shield", isMartial: martial, item_def_bonus: String(def),
    item_mdef_bonus: String(mdef) }, SW.standardShieldEffects());

const world = new WorldItems(new Map([
  weapon("Rapier", "Sword", "One-handed", "DEX", "INS", 6, 1),
  weapon("Bronze Sword", "Sword", "One-handed", "DEX", "MIG", 6, 1),
  weapon("Greatsword", "Sword", "Two-handed", "DEX", "MIG", 10, 1),
  weapon("Shortbow", "Bow", "Two-handed", "DEX", "DEX", 8, 0, "Ranged"),
  weapon("Staff", "Arcane", "Two-handed", "WLP", "WLP", 6, 0),
  weapon("Tome", "Arcane", "Two-handed", "INS", "INS", 6, 0),
  armor("Travel Garb", false, 0, 1, 1),
  armor("Sage Robe", false, 0, 1, 2),
  armor("Silk Shirt", false, 0, 0, 2),
  armor("Combat Tunic", false, 0, 1, 1),
  armor("Brigadine", true, 10, 0, 0),
  shield("Runic Shield", true, 2, 2),
  shield("Bronze Shield", false, 2, 0),
].map((x) => [x.id, x])));
const catalogue = B.basicCatalogue(world, folders);

const build = (member, level = 5, extra = {}) => A.buildCharacter(member, { level, power: "raw", catalogue, ...extra });
const stats = (m) => ({ hp: m.hp.max, mp: m.mp.max, def: m.def, mdef: m.mdef });

// ── Rulebook goldens ────────────────────────────────────────────────────────
t("Camilla (pp.161-165, printed): 40 HP, 50 MP, DEF 11, MDEF 13", () => {
  const camilla = { label: "Camilla", dice: { dex: 8, ins: 10, mig: 6, wlp: 8 }, milestones: ["ins", "dex"],
    classes: [["Weaponmaster", "hp"], ["Orator", "mp"], ["Fury", "hp"], ["Rogue", "ip"], ["Wayfarer", "ip"]],
    gear: { main: "Rapier", off: "Runic Shield", armor: "Travel Garb" }, actions: [] };
  assert.deepStrictEqual(stats(build({ role: camilla })), { hp: 40, mp: 50, def: 11, mdef: 13 });
});
t("p.169 tip: d8 DEX + brigandine + bronze shield = Defense 12", () => {
  const knight = { label: "Knight", dice: { dex: 8, ins: 8, mig: 8, wlp: 8 }, milestones: ["mig", "dex"],
    classes: [["Guardian", "hp"], ["Weaponmaster", "hp"], ["Fury", "hp"], ["Wayfarer", "ip"], ["Rogue", "ip"]],
    gear: { main: "Bronze Sword", off: "Bronze Shield", armor: "Brigadine" }, actions: [] };
  assert.strictEqual(build({ role: knight }).def, 12);
});
t("Tank at L5 = Soldier (p.174): 65 HP, 45 MP, DEF 12, MDEF 8", () => {
  assert.deepStrictEqual(stats(build({ role: "tank" })), { hp: 65, mp: 45, def: 12, mdef: 8 });
});
t("Caster at L5 = Sage (p.174): 35 HP, 65 MP, DEF 7, MDEF 12", () => {
  assert.deepStrictEqual(stats(build({ role: "caster" })), { hp: 35, mp: 65, def: 7, mdef: 12 });
});
t("Support at L5 = Healer (p.172): 45 HP, 65 MP, DEF 7, MDEF 10", () => {
  assert.deepStrictEqual(stats(build({ role: "support" })), { hp: 45, mp: 65, def: 7, mdef: 10 });
});
t("Ranger at L5 = Ranger (p.174): 50 HP, 35 MP, DEF 10, MDEF 10", () => {
  assert.deepStrictEqual(stats(build({ role: "ranger" })), { hp: 50, mp: 35, def: 10, mdef: 10 });
});

// ── Class levels (p.160, p.227) ─────────────────────────────────────────────
t("allocation: 3+2 at L5, masters in order, never >10 in a class or >3 unmastered", () => {
  const cls = A.ROLES.tank.classes;
  const lv = (L) => A.allocateClassLevels(cls, L).map((c) => c.level);
  assert.deepStrictEqual(lv(5), [3, 2, 0, 0, 0]);
  assert.deepStrictEqual(lv(20), [10, 10, 0, 0, 0]);
  assert.deepStrictEqual(lv(41), [10, 10, 10, 10, 1]);
  assert.deepStrictEqual(lv(50), [10, 10, 10, 10, 10]);
  for (let L = 5; L <= 50; L++) {
    const levels = lv(L);
    assert.strictEqual(levels.reduce((a, b) => a + b, 0), L, `L${L} sum`);
    assert.ok(levels.every((x) => x <= 10), `L${L} class cap`);
    assert.ok(levels.filter((x) => x > 0 && x < 10).length <= 3, `L${L} unmastered`);
    assert.ok(levels.filter((x) => x > 0).length >= 2, `L${L} at least two classes`);
  }
});
t("allocation refuses levels outside 5-50", () => {
  assert.throws(() => A.allocateClassLevels(A.ROLES.tank.classes, 4), /5-50/);
  assert.throws(() => A.allocateClassLevels(A.ROLES.tank.classes, 51), /5-50/);
});

// ── Milestones (p.227) ──────────────────────────────────────────────────────
t("milestones: one die step at 20 and at 40, in role order", () => {
  assert.deepStrictEqual(A.applyMilestones(A.ROLES.tank.dice, A.ROLES.tank.milestones, 19), A.ROLES.tank.dice);
  assert.deepStrictEqual(A.applyMilestones(A.ROLES.tank.dice, A.ROLES.tank.milestones, 20), { dex: 8, ins: 6, mig: 12, wlp: 8 });
  assert.deepStrictEqual(A.applyMilestones(A.ROLES.tank.dice, A.ROLES.tank.milestones, 41), { dex: 10, ins: 6, mig: 12, wlp: 8 });
});
t("milestones: a step that would pass d12 goes to the next attribute, never lost", () => {
  const out = A.applyMilestones({ dex: 6, ins: 10, mig: 8, wlp: 8 }, ["ins", "ins"], 40);
  assert.strictEqual(out.ins, 12);
  assert.strictEqual(Object.values(out).reduce((a, b) => a + b, 0), 32 + 4, "two steps of +2 applied");
});
t("L41 Tank: HP = 41 + 5 x d12 MIG + 5 x four HP classes = 121", () => {
  assert.strictEqual(build({ role: "tank" }, 41).hp.max, 121);
});

// ── Power modes ─────────────────────────────────────────────────────────────
t("raw mode has no skill layer", () => {
  const m = build({ role: "striker" }, 41);
  assert.strictEqual(m.checkMods.all, 0);
  assert.strictEqual(m.extraDamage.all, 0);
});
t("table mode: +floor(L/10) to all checks, +round(k x L/10) damage", () => {
  const m = build({ role: "striker" }, 41, { power: "table", k: 2 });
  assert.strictEqual(m.checkMods.all, 4);
  assert.strictEqual(m.extraDamage.all, 8);
  assert.deepStrictEqual(m.fromArchetype.layer, { accuracy: 4, damage: 8 });
});
t("table mode without a calibrated k is refused", () => {
  assert.throws(() => A.buildCharacter({ role: "striker" }, { level: 41, power: "table", k: null, catalogue }), /calibrated/);
});

// ── Kit and integration ─────────────────────────────────────────────────────
t("generic kits: caster casts vs MDEF, support heals, tank protects, striker swings", () => {
  const caster = extractActions(build({ role: "caster" }, 41));
  assert.deepStrictEqual(caster.actions.map((a) => [a.name, a.defenseTarget, a.target.count]),
    [["Fire Strike", "mdef", 1], ["Fire Burst", "mdef", 3]]);
  assert.deepStrictEqual(extractActions(build({ role: "support" }, 41)).utility.map((u) => u.name), ["Heal"]);
  assert.deepStrictEqual(extractActions(build({ role: "tank" }, 41)).utility.map((u) => u.name), ["Protect"]);
  const striker = build({ role: "striker" }, 41);
  assert.strictEqual(extractActions(striker).actions.length, 0);
  assert.strictEqual(striker.weapon.name, "Greatsword");
  assert.strictEqual(striker.weapon.checkBonus, 1);
});
t("an archetype passes the loadout round-trip gate, so --equip works on it", () => {
  const m = build({ role: "tank" }, 30);
  assert.ok(verifyLoadout(m).ok, JSON.stringify(verifyLoadout(m).mismatches));
  SW.applySwaps(m, [{ slot: "armor", source: SW.resolveSource("item:Travel Garb", { worldItems: world }) }], { worldItems: world });
  assert.strictEqual(m.def, 8 + 1 + 2, "L30 tank: DEX d8 + Travel Garb +1 + Runic Shield +2 (Brigadine's 10 gone)");
});
t("presets: four members, unique names, overrides applied", () => {
  for (const name of Object.keys(A.PRESETS)) {
    const party = A.buildArchetypeParty(name, { level: 41, power: "raw", catalogue });
    assert.strictEqual(party.length, 4, name);
  }
  const dc = A.buildArchetypeParty("double-caster", { level: 20, power: "raw", catalogue });
  assert.deepStrictEqual(dc.map((p) => p.name), ["Striker", "Caster", "Caster II", "Support"]);
  assert.strictEqual(dc[2].fromArchetype.element, "ice");
  const phys = A.buildArchetypeParty("physical", { level: 20, power: "raw", catalogue });
  assert.strictEqual(extractActions(phys[3]).actions.length, 0, "physical preset's support only heals");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
