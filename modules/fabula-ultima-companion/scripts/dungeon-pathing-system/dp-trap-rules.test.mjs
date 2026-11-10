// node scripts/dungeon-pathing-system/dp-trap-rules.test.mjs
// Dungeon trap rules — Formula A (approved 2026-11-10).
import assert from "node:assert/strict";
import { trapBase, normalizeTier, partyLevel, describeHit, hpBand, TRAP_HP_FLOOR } from "./dp-trap-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("Minor base = 5 + floor(L/4): the approved table", () => {
  assert.deepEqual([5, 10, 20, 30, 40, 45, 50].map((L) => trapBase(L)), [6, 7, 10, 12, 15, 16, 17]);
});
t("Heavy = floor(Minor × 1.5); unknown tier falls back to Minor", () => {
  assert.equal(trapBase(45, "heavy"), 24);
  assert.equal(trapBase(50, "heavy"), 25);
  assert.equal(trapBase(45, "HEAVY "), 24);
  assert.equal(trapBase(45, "bogus"), 16);
  assert.equal(normalizeTier(undefined), "minor");
});
t("bad level input is level 0, never NaN", () => {
  assert.equal(trapBase("x"), 5);
  assert.equal(trapBase(-3), 5);
});
t("party level = highest member; nothing usable = 5", () => {
  assert.equal(partyLevel([45, "45", 44]), 45);
  assert.equal(partyLevel([0, null, "a"]), 5);
  assert.equal(partyLevel(), 5);
});

const rec = (from, to, finalValue, { aff = null, flat = 0, sh = [0, 0] } = {}) => ({
  finalValue, affinity: aff, preAffinityBreakdown: [{ step: 3, sub: flat }],
  hp: { from, to }, shield: { from: sh[0], to: sh[1] },
});

t("Hina full HP: 16 − 5 DR = 11", () => {
  const r = describeHit(rec(157, 146, 11, { flat: 5 }), 157);
  assert.deepEqual([r.shown, r.dr, r.resisted, r.held, r.crisisCross], [11, 5, false, false, false]);
});
t("Blanche resists: shows the halved amount and the Resist tag", () => {
  const r = describeHit(rec(174, 170, 4, { aff: "RS", flat: 8 }), 174);
  assert.deepEqual([r.shown, r.dr, r.resisted], [4, 8, true]);
});
t("held at 1 when the hit would have gone through", () => {
  const r = describeHit(rec(9, TRAP_HP_FLOOR, 11, { flat: 5 }), 85);
  assert.deepEqual([r.shown, r.held, r.after], [8, true, 1]);
});
t("exactly to 1 is not 'held' (it did not need the floor)", () => {
  assert.equal(describeHit(rec(12, 1, 11), 85).held, false);
});
t("crossing half max is Crisis; already below is not a new Crisis", () => {
  assert.equal(describeHit(rec(80, 64, 16), 145).crisisCross, true);
  assert.equal(describeHit(rec(60, 49, 11), 157).crisisCross, false);
});
t("a member at 0 HP stays at 0 and is not 'held'", () => {
  const r = describeHit(rec(0, 0, 16), 145);
  assert.deepEqual([r.shown, r.held], [0, false]);
});
t("shield soaks first: held reads the HP part only", () => {
  const r = describeHit(rec(5, 1, 16, { sh: [10, 0] }), 100);
  assert.equal(r.held, true); // 16 − 10 shield = 6 HP loss > 5 HP
  assert.equal(describeHit(rec(10, 4, 16, { sh: [10, 0] }), 100).held, false);
});
t("immune flag", () => assert.equal(describeHit(rec(50, 50, 0, { aff: "IM" }), 100).immune, true));
t("HP bands match the battle bar: >50% ok, >25% crisis, else low", () => {
  assert.deepEqual([hpBand(51, 100), hpBand(50, 100), hpBand(26, 100), hpBand(25, 100), hpBand(0, 0)], ["ok", "crisis", "crisis", "low", "low"]);
});

console.log(`dp-trap-rules: ${n} passed`);
