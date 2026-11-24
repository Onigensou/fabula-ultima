// node scripts/battle-director/resources-cap.test.mjs
import assert from "node:assert/strict";
import { capAwareNext, mayExceedMax } from "./resources.js";
const OV = { allowOverflow: true };
const old = (cur, delta, max) => (max != null ? Math.min(max, cur + delta) : cur + delta);

// Ordinary creature: byte-identical to the old Math.min(max, next), incl. cur > max.
for (const cur of [0, 50, 100, 128, 150, 454])
  for (const delta of [-200, -30, 0, 20, 50])
    for (const max of [128, 0, null])
      assert.equal(capAwareNext(cur, delta, max), old(cur, delta, max), `ordinary ${cur}/${delta}/${max}`);
assert.equal(capAwareNext(150, 0, 128), 128, "ordinary zero delta above max still trims (old)");
assert.equal(capAwareNext(454, -30, 128), 128, "ordinary loss above max trims (old)");
assert.equal(capAwareNext(454, 50, 128), 128, "ordinary heal above max trims (old)");
assert.equal(capAwareNext(100, 50, 128), 128);
assert.equal(capAwareNext(100, 20, 128), 120);
assert.equal(capAwareNext(100, -30, 128), 70);
assert.equal(capAwareNext(100, 50, null), 150, "no max");

// Soul Fragment: overflow kept on heal, loss from real current.
assert.equal(capAwareNext(454, 50, 128, OV), 454, "fragment heal keeps overflow");
assert.equal(capAwareNext(454, -30, 128, OV), 424, "fragment cost from real current");
assert.equal(capAwareNext(100, 50, 128, OV), 128, "fragment under max capped at max");
assert.equal(capAwareNext(128, 10, 128, OV), 128);
assert.equal(capAwareNext(100, 50, null, OV), 150);

// Refund path (skill-cost.settleCostDelta): same expression as the call site.
const refund = (cur, amt, maxProp, frag) => Math.min(frag ? Math.max(cur, maxProp) : maxProp, cur - amt);
assert.equal(refund(100, -50, 128, false), 128);
assert.equal(refund(454, -50, 128, false), 128, "ordinary refund above max trims (old)");
assert.equal(refund(454, -50, 128, true), 454, "fragment refund keeps overflow");

// Fragment test + clampVitalsToMax exemption key.
const frag = { flags: { "fabula-ultima-companion": { conflictObject: "soul-fragment" } } };
assert.equal(mayExceedMax(frag), true);
assert.equal(mayExceedMax({ flags: { "fabula-ultima-companion": { conflictObject: "lightning-crystal" } } }), false);
assert.equal(mayExceedMax({}), false);
assert.equal(mayExceedMax(null), false);
console.log("resources-cap: ok");
