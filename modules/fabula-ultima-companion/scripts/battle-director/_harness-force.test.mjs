import assert from "node:assert/strict";
import { expandForceSemantics } from "./_harness-force.js";
const t = [{ defense: 10, magicDefense: 20 }, { defense: 14, magicDefense: 8 }];
const base = { dA: 12, dB: 12, fumbleThreshold: 1, checkBonus: 0, targetSnaps: t };
const sum = (f) => f.rA + f.rB;
// Spell vs DEF (vsMdef false) sizes to DEF even though kind is spell.
assert.ok(sum(expandForceSemantics({ hit: true }, { ...base, vsMdef: false })) >= 14);
// Attack vs MDEF sizes to MDEF: max 20 (hit), min 8 (miss).
assert.ok(sum(expandForceSemantics({ hit: true }, { ...base, vsMdef: true })) >= 20);
assert.ok(sum(expandForceSemantics({ miss: true }, { ...base, vsMdef: true })) < 8);
assert.ok(sum(expandForceSemantics({ miss: true }, { ...base, vsMdef: false })) < 10);
// blank -> kind fallback via legacy isSpell
assert.ok(sum(expandForceSemantics({ hit: true }, { ...base, isSpell: true })) >= 20);
assert.ok(sum(expandForceSemantics({ hit: true }, { ...base, isSpell: false })) >= 14);
// raw dice win
assert.deepEqual(expandForceSemantics({ rA: 3, rB: 4 }, { ...base, vsMdef: true }), { rA: 3, rB: 4 });
console.log("harness-force ok");
