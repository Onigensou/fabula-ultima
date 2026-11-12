// node scripts/dungeon-pathing-system/dp-heal-rules.test.mjs
// Dungeon Healing tile rules (2026-11-12).
import assert from "node:assert/strict";
import { healAmount, describeHeal, HEAL_MIN } from "./dp-heal-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("35% of max HP, rounded down: the slot-1 party at Lv 45", () => {
  // Hina 157, Keren 85, Blanche 174, Zarg 145
  assert.deepEqual([157, 85, 174, 145].map(healAmount), [54, 29, 60, 50]);
});
t("never below the floor; bad input is the floor, never NaN", () => {
  assert.equal(healAmount(20), HEAL_MIN);
  assert.equal(healAmount("x"), HEAL_MIN);
  assert.equal(healAmount(-5), HEAL_MIN);
});
t("one heal from low HP never fills the bar", () => {
  for (const max of [40, 85, 157, 174, 300]) {
    const r = describeHeal(1, max);
    assert.ok(r.after < max, `max ${max}`);
  }
});
t("capped at max HP; FULL when it reaches it", () => {
  assert.deepEqual(describeHeal(140, 157), { before: 140, after: 157, max: 157, gain: 17, ko: false, full: true, cleared: false });
  const atMax = describeHeal(174, 174);
  assert.equal(atMax.gain, 0);
  assert.equal(atMax.full, true);
});
t("a member at 0 HP is skipped", () => {
  const r = describeHeal(0, 85);
  assert.equal(r.ko, true);
  assert.equal(r.gain, 0);
  assert.equal(r.after, 0);
});
t("Crisis cleared when the heal crosses half", () => {
  assert.equal(describeHeal(60, 157).cleared, true);   // 60 → 114
  assert.equal(describeHeal(9, 85).cleared, false);    // 9 → 38
  assert.equal(describeHeal(100, 157).cleared, false); // already above half
});
t("a dry-run record wins over the local estimate (healing modifiers)", () => {
  const r = describeHeal(60, 157, { hp: { from: 60, to: 125 } });
  assert.equal(r.after, 125);
  assert.equal(r.gain, 65);
  // a record can't push it past max or below the start
  assert.equal(describeHeal(60, 157, { hp: { from: 60, to: 999 } }).after, 157);
  assert.equal(describeHeal(60, 157, { hp: { from: 60, to: 10 } }).after, 60);
});

console.log(`dp-heal-rules: ${n} passed`);
