"use strict";
// Mindscape — weapon-read window + stance cycle tests. Plain node, no framework.
//
// Both mechanisms are pure by design precisely so they can be asserted without a
// battle: the LRU window is the one piece of Rakshasa's design whose behaviour is
// not obvious from reading it, and the stance cycle is the piece whose absence
// silently doubled a boss's output.

const assert = require("assert");
const RX = require("../lib/reactions");
const ST = require("../lib/stances");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// ── The curve ───────────────────────────────────────────────────────────────
const CURVE = [25, 40, 60, 80];
const W = 4;

t("a fresh read sits at the floor", () => {
  assert.strictEqual(RX.efficiencyForCounter(4, W, CURVE), 25);
});
t("efficiency climbs one step per other family shown", () => {
  assert.deepStrictEqual(
    [3, 2, 1].map((n) => RX.efficiencyForCounter(n, W, CURVE)),
    [40, 60, 80],
  );
});
t("a cleared counter is back to full", () => {
  assert.strictEqual(RX.efficiencyForCounter(0, W, CURVE), 100);
});
t("a counter past the end of the curve clamps instead of returning undefined", () => {
  // Guards the NaN-three-layers-down failure if a curve is ever shortened.
  assert.strictEqual(RX.efficiencyForCounter(9, W, [25]), 25);
});

// ── The window ──────────────────────────────────────────────────────────────
function fresh() { return { counters: {}, eff: {} }; }

t("the design's headline claim: four OTHER families fully reset the first", () => {
  const { counters, eff } = fresh();
  const opts = { window: W, curve: CURVE, evict: true };
  RX.applyWeaponRead(counters, eff, "bow", opts);
  assert.strictEqual(eff.bow, 25, "just used");
  for (const fam of ["dagger", "brawling", "arcane", "spear"]) {
    RX.applyWeaponRead(counters, eff, fam, opts);
  }
  assert.strictEqual(eff.bow, 100, "bow should be clear after four others");
});

t("THREE other families is not enough — this is the 4-PC party's ceiling", () => {
  // The whole tempo of the design: a four-person party fielding four distinct
  // families is permanently one slot short of a full reset.
  const { counters, eff } = fresh();
  const opts = { window: W, curve: CURVE, evict: true };
  RX.applyWeaponRead(counters, eff, "bow", opts);
  for (const fam of ["dagger", "brawling", "arcane"]) {
    RX.applyWeaponRead(counters, eff, fam, opts);
  }
  assert.strictEqual(eff.bow, 80);
});

t("TWO alternating families never climb past one step — the measured failure mode", () => {
  // Not a hypothetical: the live party fields exactly two modelled lanes (bow
  // and arcane). With only two, each lane is re-read every other swing, so it
  // oscillates between the floor and ONE step above it and never approaches
  // 100%. The window's remaining steps are unreachable — which is why the
  // window size is an inert dial against this party.
  const { counters, eff } = fresh();
  const opts = { window: W, curve: CURVE, evict: true };
  for (let i = 0; i < 8; i++) {
    RX.applyWeaponRead(counters, eff, i % 2 ? "arcane" : "bow", opts);
    for (const fam of ["bow", "arcane"]) {
      if (eff[fam] != null) assert.ok(eff[fam] <= CURVE[1], `${fam} reached ${eff[fam]}`);
    }
  }
});

t("re-reading the same family holds it at the floor", () => {
  const { counters, eff } = fresh();
  const opts = { window: W, curve: CURVE, evict: true };
  RX.applyWeaponRead(counters, eff, "bow", opts);
  RX.applyWeaponRead(counters, eff, "bow", opts);
  assert.strictEqual(eff.bow, 25);
});

t("evict:false freezes recovery — the Crisis passive", () => {
  const { counters, eff } = fresh();
  RX.applyWeaponRead(counters, eff, "bow", { window: W, curve: CURVE, evict: true });
  for (const fam of ["dagger", "brawling", "arcane", "spear"]) {
    RX.applyWeaponRead(counters, eff, fam, { window: W, curve: CURVE, evict: false });
  }
  assert.strictEqual(eff.bow, 25, "nothing recovers once eviction stops");
});

t("a blank family is a no-op, never a lane named \"\"", () => {
  const { counters, eff } = fresh();
  assert.strictEqual(RX.applyWeaponRead(counters, eff, "", { window: W, curve: CURVE }), null);
  assert.deepStrictEqual(counters, {});
});

// ── Registry wiring ─────────────────────────────────────────────────────────
t("Adaptive Defense fails CLOSED with no weapon family", () => {
  const entry = RX.REACTION_REGISTRY["Adaptive Defense"];
  assert.strictEqual(entry.gate({ weaponFamily: null }), false);
  assert.strictEqual(entry.gate({ weaponFamily: "bow" }), true);
});

t("Execute fires only on a Crisis victim, Cripple only on a healthy one", () => {
  const ex = RX.REACTION_REGISTRY["Execute"], cr = RX.REACTION_REGISTRY["Cripple"];
  assert.strictEqual(ex.gate({ sourceAction: "Execute", victimInCrisis: true }), true);
  assert.strictEqual(ex.gate({ sourceAction: "Execute", victimInCrisis: false }), false);
  assert.strictEqual(cr.gate({ sourceAction: "Cripple", victimInCrisis: false }), true);
  assert.strictEqual(cr.gate({ sourceAction: "Cripple", victimInCrisis: true }), false);
});

t("the keyword pair is mutually exclusive — never both on one victim", () => {
  const ex = RX.REACTION_REGISTRY["Execute"], cr = RX.REACTION_REGISTRY["Cripple"];
  for (const inCrisis of [true, false]) {
    const both = ex.gate({ sourceAction: "Execute", victimInCrisis: inCrisis })
              && cr.gate({ sourceAction: "Execute", victimInCrisis: inCrisis });
    assert.strictEqual(both, false);
  }
});

t("a keyword reaction is scoped to its own skill", () => {
  // Without the sourceAction gate every attack the monster made would double.
  const ex = RX.REACTION_REGISTRY["Execute"];
  assert.strictEqual(ex.gate({ sourceAction: "Chakram", victimInCrisis: true }), false);
});

// ── Spec-driven tuning ──────────────────────────────────────────────────────
t("mindscape_* props retune the registry without a source edit", () => {
  const [r] = RX.declaredReactions([{
    name: "Adaptive Defense",
    props: { mindscape_read_window: "2", mindscape_read_curve: "60, 80" },
  }]);
  assert.strictEqual(r.effect.window, 2);
  assert.deepStrictEqual(r.effect.curve, [60, 80]);
});

t("an untuned entry keeps the registry's own numbers", () => {
  const [r] = RX.declaredReactions([{ name: "Adaptive Defense", props: {} }]);
  assert.strictEqual(r.effect.window, 4);
  assert.deepStrictEqual(r.effect.curve, [25, 40, 60, 80]);
});

// ── Stances ─────────────────────────────────────────────────────────────────
const armAct = { name: "Form Shift", stanceGrants: ["Sword", "Bow", "Throwing", "Flail"] };
const swordAct = { name: "Execute", stanceRequires: "Sword" };
const plainAct = { name: "Devour" };

t("unarmed, only the arming action is legal", () => {
  const actor = { stance: null, stanceCycle: true };
  assert.strictEqual(ST.isLegal(armAct, actor), true);
  assert.strictEqual(ST.isLegal(swordAct, actor), false);
});

t("armed, the matching strike is legal and re-arming is not", () => {
  const actor = { stance: "Sword", stanceCycle: true };
  assert.strictEqual(ST.isLegal(swordAct, actor), true);
  assert.strictEqual(ST.isLegal(armAct, actor), false);
});

t("a stance monster cannot escape the cycle through an unstanced action", () => {
  // Without this the arming cost is free and the cadence collapses back to 2x
  // output — the exact error the stance layer exists to prevent.
  assert.strictEqual(ST.isLegal(plainAct, { stance: null, stanceCycle: true }), false);
  assert.strictEqual(ST.isLegal(plainAct, { stance: null, stanceCycle: false }), true);
});

t("arming never redraws the stance already held (ae_pool_skip_existing)", () => {
  const rng = { pick: (arr) => arr[0] };
  const actor = { stance: "Sword" };
  assert.strictEqual(ST.arm(actor, armAct, rng), "Bow");
});

t("a strike consumes the stance that permitted it", () => {
  const actor = { stance: "Sword" };
  ST.consume(actor, swordAct);
  assert.strictEqual(actor.stance, null);
});

t("hasStanceCycle is derived, so a spec cannot forget to opt in", () => {
  assert.strictEqual(ST.hasStanceCycle([plainAct]), false);
  assert.strictEqual(ST.hasStanceCycle([plainAct, swordAct]), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
