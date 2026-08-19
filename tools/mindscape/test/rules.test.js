"use strict";
//
// Mindscape rules tests. Plain Node, no framework: `node test/rules.test.js`.
//
// These assert the SPEC's normative claims, especially the ones that are easy to
// get wrong by simplifying. A failure here means either rules.js drifted or the
// spec did — check the engine source cited in each case before "fixing" the test.

const assert = require("node:assert");
const R = require("../lib/rules");
const { Rng } = require("../lib/rng");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// A minimal target. Everything defaults to "no modifier" so each test isolates
// one axis.
function target(over = {}) {
  return {
    affinities: {}, efficiency: {}, classAffinity: {},
    damageReduction: { flat: 0, percent: 0 },
    damageTakenIncreased: {}, damageTakenMult: 1, conditions: [],
    ...over,
  };
}

console.log("\ndie ladder + statuses");
test("stepDie walks the ladder, not the number line", () => {
  assert.strictEqual(R.stepDie(8, -1), 6);
  assert.strictEqual(R.stepDie(8, +1), 10);
  assert.strictEqual(R.stepDie(12, +1), 14);
});
test("status steps stack on the same attribute", () => {
  // Dazed (-1 INS) + Enraged (-1 DEX, -1 INS) = INS -2 steps.
  const eff = R.effectiveAttributes(
    { dex: 10, ins: 12, mig: 8, wlp: 8 },
    { isDazed: true, isEnraged: true },
  );
  assert.strictEqual(eff.ins, 8, "INS should drop two steps from d12");
  assert.strictEqual(eff.dex, 8, "DEX should drop one step from d10");
  assert.strictEqual(eff.mig, 8, "MIG untouched");
});
test("status steps floor at d6", () => {
  const eff = R.effectiveAttributes({ dex: 6, ins: 6, mig: 6, wlp: 6 }, { isSlow: true });
  assert.strictEqual(eff.dex, 6, "a status must never take an attribute below d6");
});

console.log("\naccuracy check");
test("crit is equal faces >= 6, and auto-hits past any DL", () => {
  // Force 8,8 by seeking a seed — cheaper than mocking the Rng contract.
  let found = null;
  for (let s = 0; s < 5000 && !found; s++) {
    const r = new Rng(s);
    const c = R.accuracyCheck(r, { dieA: 8, dieB: 8, dl: 99 });
    if (c.a === c.b && c.a >= 6) found = c;
  }
  assert.ok(found, "expected to roll a double somewhere in 5000 seeds");
  assert.strictEqual(found.crit, true);
  assert.strictEqual(found.hit, true, "a crit auto-succeeds regardless of DL");
});
test("double 1 is a fumble and auto-fails past any DL", () => {
  let found = null;
  for (let s = 0; s < 20000 && !found; s++) {
    const r = new Rng(s);
    const c = R.accuracyCheck(r, { dieA: 6, dieB: 6, dl: 2 });
    if (c.a === 1 && c.b === 1) found = c;
  }
  assert.ok(found, "expected a double-1 somewhere in 20000 seeds");
  assert.strictEqual(found.fumble, true);
  assert.strictEqual(found.hit, false, "a fumble auto-fails even against DL 2");
});
test("equal faces below 6 are NOT a crit", () => {
  let found = null;
  for (let s = 0; s < 20000 && !found; s++) {
    const r = new Rng(s);
    const c = R.accuracyCheck(r, { dieA: 6, dieB: 6, dl: 1 });
    if (c.a === c.b && c.a < 6 && c.a > 1) found = c;
  }
  assert.ok(found);
  assert.strictEqual(found.crit, false, "double-4 is not a critical success");
});

console.log("\naffinity math");
test("RS rounds UP, not down", () => {
  // The single most likely silent drift: ceil(v/2), per snapshot.js:102.
  assert.strictEqual(R.applyAffinityToDamage(7, "RS"), 4, "ceil(7/2) = 4, not 3");
  assert.strictEqual(R.applyAffinityToDamage(9, "RS"), 5);
});
test("VU doubles, IM zeroes", () => {
  assert.strictEqual(R.applyAffinityToDamage(7, "VU"), 14);
  assert.strictEqual(R.applyAffinityToDamage(7, "IM"), 0);
});
test("status-forced VU overrides a resistant sheet", () => {
  const t = target({ affinities: { fire: "RS" }, conditions: ["Oil"] });
  assert.strictEqual(R.resolveAffinity(t, "fire"), "VU",
    "Oil forces fire VU even on a fire-resistant target");
});

console.log("\nincoming pipeline ORDER");
test("weapon efficiency applies BEFORE affinity", () => {
  // THE ordering trap. base 10, EF 150%, VU.
  //   correct  : ceil(10*1.5)=15 -> VU -> 30
  //   flattened: 10 * 1.5 * 2    -> 30       (agrees here)
  // so use a base where the intermediate ceil actually bites: base 5, EF 75%, VU.
  //   correct  : ceil(5*0.75)=4  -> VU -> 8
  //   flattened: ceil(5*0.75*2)  -> 8        (still agrees)
  // The two diverge when the ceil lands on a half: base 3, EF 50%, VU.
  //   correct  : ceil(3*0.5)=2   -> VU -> 4
  //   flattened: ceil(3*0.5*2)=3 -> 3
  const t = target({ affinities: { fire: "VU" }, efficiency: { sword: 50 } });
  const r = R.incomingDamage(t, { base: 3, element: "fire", weaponFamily: "sword" });
  assert.strictEqual(r.damage, 4,
    "EF must be applied and ceil'd BEFORE affinity doubles it (4, not 3)");
});
test("the additive element bump is scaled by VU", () => {
  // +5 fire on a VU target: (10 + 5) * 2 = 30, not 10*2 + 5 = 25.
  const t = target({ affinities: { fire: "VU" }, damageTakenIncreased: { fire: 5 } });
  const r = R.incomingDamage(t, { base: 10, element: "fire" });
  assert.strictEqual(r.damage, 30);
});
test("absorb reports a heal direction and skips the incoming multiplier", () => {
  const t = target({ affinities: { fire: "AB" }, damageTakenMult: 2 });
  const r = R.incomingDamage(t, { base: 10, element: "fire" });
  assert.strictEqual(r.affinity, "AB");
  assert.strictEqual(r.direction, "recover");
  assert.strictEqual(r.damage, 10, "the multiplier must not scale an absorb");
});

console.log("\nkeywords");
test("crush steps affinity down exactly one rung", () => {
  assert.strictEqual(R.crushAffinity("AB"), "IM");
  assert.strictEqual(R.crushAffinity("IM"), "RS");
  assert.strictEqual(R.crushAffinity("RS"), "NE");
});
test("crush into an immune target still lands as Immune, not full", () => {
  const t = target({ affinities: { ice: "IM" } });
  const r = R.incomingDamage(t, { base: 20, element: "ice", keywords: ["crush"] });
  assert.strictEqual(r.damage, 10, "IM -> RS = half, not full damage");
});
test("crush never creates vulnerability", () => {
  const t = target({ affinities: { ice: "VU" } });
  const r = R.incomingDamage(t, { base: 10, element: "ice", keywords: ["crush"] });
  assert.strictEqual(r.damage, 20, "VU is below the ladder and must be untouched");
});
test("ignore_resistance CLAMPS rather than steps", () => {
  const t = target({ affinities: { ice: "IM" } });
  // A clamp at rank 1 (RS) leaves IM untouched — ignoring Resistance says
  // nothing about Immunity. This is what distinguishes it from Crush.
  const r = R.incomingDamage(t, { base: 20, element: "ice", keywords: ["ignore_resistance"] });
  assert.strictEqual(r.damage, 0, "IM survives an ignore_resistance bypass");
  const r2 = R.incomingDamage(t, { base: 20, element: "ice", keywords: ["ignore_immunity"] });
  assert.strictEqual(r2.damage, 20, "ignore_immunity collapses IM to NE");
});
test("damage reduction is skipped by crush", () => {
  const t = target({ damageReduction: { flat: 5, percent: 0 } });
  assert.strictEqual(R.incomingDamage(t, { base: 20 }).damage, 15);
  assert.strictEqual(R.incomingDamage(t, { base: 20, keywords: ["crush"] }).damage, 20);
});

console.log("\nprojection (spec D2)");
test("expectedHighRoll is the exact mean of max(dA,dB)", () => {
  // 2d6: E[max] = 161/36
  assert.ok(Math.abs(R.expectedHighRoll(6, 6) - 161 / 36) < 1e-9);
  // Asymmetric dice must not be approximated with the equal-dice formula.
  assert.ok(R.expectedHighRoll(6, 12) > R.expectedHighRoll(6, 6));
});
test("projection is average-based, so it never over-promises", () => {
  const t = target({ affinities: { ice: "VU" } });
  const proj = R.projectDamage(t, { dieA: 8, dieB: 10, damageBonus: 10, element: "ice" });
  const maxRoll = R.incomingDamage(t, { base: R.outgoingDamage({ hr: 10, damageBonus: 10 }), element: "ice" });
  assert.ok(proj.damage < maxRoll.damage,
    "the finisher rule must project the average, not the best case");
});

console.log("\ndeterminism");
test("same seed reproduces the same sequence", () => {
  const a = new Rng("asura-run-3"); const b = new Rng("asura-run-3");
  const seqA = Array.from({ length: 50 }, () => a.die(12));
  const seqB = Array.from({ length: 50 }, () => b.die(12));
  assert.deepStrictEqual(seqA, seqB);
});
test("different seeds diverge", () => {
  const a = new Rng("run-1"); const b = new Rng("run-2");
  const seqA = Array.from({ length: 50 }, () => a.die(12));
  const seqB = Array.from({ length: 50 }, () => b.die(12));
  assert.notDeepStrictEqual(seqA, seqB);
});
test("die faces are uniform enough for statistics", () => {
  const r = new Rng(12345);
  const counts = new Array(13).fill(0);
  const N = 120000;
  for (let i = 0; i < N; i++) counts[r.die(12)]++;
  const expect = N / 12;
  for (let f = 1; f <= 12; f++) {
    const dev = Math.abs(counts[f] - expect) / expect;
    assert.ok(dev < 0.05, `face ${f} deviates ${(dev * 100).toFixed(1)}% from uniform`);
  }
});

console.log("\nformula evaluation");
const F = require("../lib/formula");
const L41 = { level: 41 };

test("plain numbers pass through", () => {
  assert.deepStrictEqual(F.evaluate("25", L41), { ok: true, value: 25 });
  assert.strictEqual(F.evaluate("", L41).value, 0);
});
test("the (CHAR_LEVEL>=N)*M idiom resolves", () => {
  // Create Phantasm: Strike at L41 = 12 + 4 + 2 = 18. This shipped as 0.
  assert.strictEqual(F.evaluate("12 + (CHAR_LEVEL >= 20) * 4 + (CHAR_LEVEL >= 40) * 2", L41).value, 18);
  assert.strictEqual(F.evaluate("10 + (CHAR_LEVEL>=20)*10 + (CHAR_LEVEL>=40)*10", L41).value, 30);
});
test("floor() resolves", () => {
  assert.strictEqual(F.evaluate("30 + floor(CHAR_LEVEL/2)", L41).value, 50);
});
test("level gates actually gate", () => {
  const low = { level: 10 };
  assert.strictEqual(F.evaluate("10 + (CHAR_LEVEL>=20)*5 + (CHAR_LEVEL>=40)*5", low).value, 10);
});
test("runtime state is REFUSED, never defaulted", () => {
  const r = F.evaluate("(OWN_SUMMON_COUNT * 20) + 20", L41);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /OWN_SUMMON_COUNT/);
  assert.strictEqual(r.value, undefined, "a refused formula must not carry a value");
});
test("an unknown identifier refuses rather than evaluating to NaN or 0", () => {
  assert.strictEqual(F.evaluate("SOME_NEW_VAR + 5", L41).ok, false);
});
test("non-arithmetic input is rejected before evaluation", () => {
  assert.strictEqual(F.evaluate("process.exit(1)", L41).ok, false);
  assert.strictEqual(F.evaluate("'a'+'b'", L41).ok, false);
});
test("SL use is flagged approximate rather than hidden", () => {
  const r = F.evaluate("SL * 5", L41);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.approximate, true, "an SL assumption must surface, not hide");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}\n`);
