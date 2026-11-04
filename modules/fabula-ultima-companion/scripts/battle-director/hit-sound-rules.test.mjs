// node scripts/battle-director/hit-sound-rules.test.mjs
// One impact sound per hit, never none (mockup v4, 2026-11-04).
import assert from "node:assert/strict";
import { lossSound, normalizeHitElement, ELEMENT_HIT_SFX, BASE_HIT_SFX, SUPER_SFX, RESIST_SFX, MP_SPEND_SFX } from "./hit-sound-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("unclaimed hit: BD's impact + the element's sound", () => {
  assert.deepEqual(lossSound({ element: "poison" }), { impact: true, sfx: ELEMENT_HIT_SFX.poison, vol: 0.5 });
  assert.equal(lossSound({ element: "fire" }).sfx, ELEMENT_HIT_SFX.fire);
});
t("unclaimed hit is NEVER silent: elementless / unknown keeps the old generic hit", () => {
  for (const el of ["elementless", "", null, "banana"]) {
    const s = lossSound({ element: el });
    assert.equal(s.impact, true);
    assert.equal(s.sfx, BASE_HIT_SFX);
  }
});
t("every FU element has a sound", () => {
  for (const el of ["physical", "fire", "ice", "bolt", "air", "earth", "dark", "light", "poison"]) assert.ok(lossSound({ element: el }).sfx);
});
t("aliases map to the FU element", () => {
  assert.equal(normalizeHitElement("Lightning"), "bolt");
  assert.equal(normalizeHitElement("wind"), "air");
  assert.equal(normalizeHitElement("BOLT"), "bolt");
});
t("unclaimed WEAK / RESIST replace the element sound", () => {
  assert.equal(lossSound({ element: "fire", affinity: "VU" }).sfx, SUPER_SFX);
  assert.equal(lossSound({ element: "fire", affinity: "RS" }).sfx, RESIST_SFX);
});
t("claimed hit: no impact burst, no hit sound", () => {
  assert.deepEqual(lossSound({ element: "fire", impactOwned: true }), { impact: false, sfx: null, vol: 0 });
});
t("claimed WEAK / RESIST: a quieter accent only", () => {
  assert.deepEqual(lossSound({ affinity: "VU", impactOwned: true }), { impact: false, sfx: SUPER_SFX, vol: 0.4 });
  assert.deepEqual(lossSound({ affinity: "rs", impactOwned: true }), { impact: false, sfx: RESIST_SFX, vol: 0.4 });
});
t("MP loss is unchanged by the rule", () => {
  assert.deepEqual(lossSound({ resource: "mp", impactOwned: true }), { impact: true, sfx: MP_SPEND_SFX, vol: 0.6 });
});
t("shield loss follows the HP rule", () => {
  assert.equal(lossSound({ resource: "shield", element: "ice" }).sfx, ELEMENT_HIT_SFX.ice);
  assert.equal(lossSound({ resource: "shield", impactOwned: true }).sfx, null);
});
console.log(`\n${n} passed`);
