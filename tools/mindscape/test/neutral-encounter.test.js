"use strict";
// Mindscape — neutral sparring encounters (lib/neutral-encounter.js). Plain node.
//
// Goldens are the rulebook NPC table recorded in the "FU Core Math" project note:
// HP = 2 x level + 5 x MIG die (L40 d12 MIG = 140), accuracy floor(level/10),
// flat damage +0/+5/+10 at L1-19/20-39/40-59, attack HR+5, Breath HR+10 for 5 MP.

const assert = require("assert");
const N = require("../lib/neutral-encounter");
const { extractActions } = require("../lib/skills");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const brute = (level, opts = {}) => N.buildNeutralEncounter("normal", { level, ...opts })[0];
const adept = (level, opts = {}) => N.buildNeutralEncounter("normal", { level, ...opts })[2];

t("NPC die steps at 20, 40 and 60, max d12", () => {
  assert.deepStrictEqual(N.npcDice({ dex: 8, ins: 8, mig: 10, wlp: 6 }, ["mig", "dex", "ins"], 19), { dex: 8, ins: 8, mig: 10, wlp: 6 });
  assert.deepStrictEqual(N.npcDice({ dex: 8, ins: 8, mig: 10, wlp: 6 }, ["mig", "dex", "ins"], 41), { dex: 10, ins: 8, mig: 12, wlp: 6 });
  assert.deepStrictEqual(N.npcDice({ dex: 8, ins: 8, mig: 10, wlp: 6 }, ["mig", "dex", "ins"], 60), { dex: 10, ins: 10, mig: 12, wlp: 6 });
});
t("flat damage bonus by level (+0 / +5 / +10 / +15)", () => {
  assert.deepStrictEqual([10, 25, 45, 60].map(N.flatDamageBonus), [0, 5, 10, 15]);
});
t("L30 brute: HP 120 (2x30 + 5xd12), DEF 8, attack HR+10 at +3", () => {
  const b = brute(30);
  assert.strictEqual(b.hp.max, 120);
  assert.strictEqual(b.def, 8);
  const [blow] = extractActions(b).actions;
  assert.strictEqual(blow.damageBonus, 10);
  assert.strictEqual(blow.checkBonus, 3);
  assert.strictEqual(blow.defenseTarget, "def");
});
t("L41 brute: HP 142, DEF 10 (DEX stepped at 40), attack HR+15 at +4", () => {
  const b = brute(41);
  assert.strictEqual(b.hp.max, 142);
  assert.strictEqual(b.def, 10);
  assert.strictEqual(extractActions(b).actions[0].damageBonus, 15);
});
t("L41 adept: MDEF 12, MP 91, Breath HR+20 vs MDEF for 5 MP, plus a fallback strike", () => {
  const a = adept(41);
  assert.strictEqual(a.mdef, 12);
  assert.strictEqual(a.mp.max, 91);
  const acts = extractActions(a).actions;
  const breath = acts.find((x) => x.name === "Breath");
  assert.strictEqual(breath.damageBonus, 20);
  assert.strictEqual(breath.defenseTarget, "mdef");
  assert.deepStrictEqual(breath.cost, { resource: "mp", amount: 5, perTarget: false });
  assert.ok(acts.some((x) => x.name === "Staff Strike"));
});
t("neutral: no affinities and every weapon efficiency at 100", () => {
  for (const e of N.buildNeutralEncounter("normal", { level: 41 })) {
    assert.ok(Object.values(e.affinities).every((v) => v === "NE"), e.name);
    assert.ok(Object.values(e.efficiency).every((v) => v === 100), e.name);
    assert.ok(e.isNpc, `${e.name} must load as an NPC`);
  }
});
t("normal = four soldiers with unique names; elite-pair = two elites at double HP", () => {
  const normal = N.buildNeutralEncounter("normal", { level: 20 });
  assert.strictEqual(normal.length, 4);
  assert.strictEqual(new Set(normal.map((e) => e.name)).size, 4);
  const elites = N.buildNeutralEncounter("elite-pair", { level: 20 });
  assert.strictEqual(elites.length, 2);
  assert.strictEqual(elites[0].hp.max, 2 * normal[0].hp.max);
});
t("hpScale and damageScale move the rulebook numbers and are recorded", () => {
  const b = brute(41, { hpScale: 1.5, damageScale: 2 });
  assert.strictEqual(b.hp.max, Math.round(142 * 1.5));
  assert.ok(extractActions(b).actions[0].damageBonus > 15 * 2, "the whole expected hit doubles, not just the bonus");
  assert.deepStrictEqual([b.neutral.hpScale, b.neutral.damageScale], [1.5, 2]);
});
t("bad kind, level or scale is refused", () => {
  assert.throws(() => N.buildNeutralEncounter("swarm", { level: 20 }), /unknown neutral encounter/);
  assert.throws(() => N.buildNeutralEncounter("normal", { level: 70 }), /5-60/);
  assert.throws(() => N.buildNeutralEncounter("normal", { level: 20, hpScale: 0 }), /above 0/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
