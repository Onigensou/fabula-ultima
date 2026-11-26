// node modules/fabula-ultima-companion/scripts/shared/stat-rules.test.mjs
import assert from "node:assert/strict";
import { effectiveReductionPct, outgoingPct, additiveMultiply } from "./stat-rules.js";

// Rule 3 — damage-reduction curve: exact to 30%, then bends, never 100%, never curves a vulnerability.
const curve = { 0: 0, 10: 10, 25: 25, 30: 30, 35: 34, 40: 38, 60: 51, 100: 65, 150: 74, 200: 79, 1000: 95, "-20": -20 };
for (const [raw, want] of Object.entries(curve)) assert.equal(effectiveReductionPct(Number(raw)), want, `curve(${raw})`);
assert.ok(effectiveReductionPct(1e9) < 100, "never reaches 100%");

// Rule 2 — Damage % adds All + range + spell + element; ignores keys that don't match the hit.
const props = {
  damage_outgoing_percentage_all: 10, damage_outgoing_percentage_melee: 5, damage_outgoing_percentage_ranged: 7,
  damage_outgoing_percentage_spell: "4", damage_outgoing_percentage_fire: "3%", damage_outgoing_percentage_ice: 100,
};
assert.equal(outgoingPct(props, { range: "melee", element: "fire" }), 18);
assert.equal(outgoingPct(props, { range: "ranged", element: "physical" }), 17);
assert.equal(outgoingPct(props, { isSpell: true, element: "Fire" }), 17);
assert.equal(outgoingPct(null), 0);

// Rule 1 — Max HP %: ×1.10 then ×1.05 on base 96 = floor(96 × 1.15) = 110 (compounding would give 110.88 → 110,
// so use a base where they differ: 200 → add 230, compound 231).
const actor = {};
const k = "system.props.max_hp";
let v = additiveMultiply(actor, k, 200, 1.10);
assert.equal(v, 220);
v = additiveMultiply(actor, k, v, 1.05);
assert.equal(v, 230, "adds, doesn't compound (compound would be 231)");
// A fresh prepare pass: CSB recomputes the base, so the incoming value differs from what we wrote → reset.
v = additiveMultiply(actor, k, 200, 1.10);
assert.equal(v, 220, "new pass starts from the new base, not the old sum");
// Single source = Foundry's own result (Mukuta ×1.12 on 1550).
assert.equal(additiveMultiply({}, k, 1550, 1.12), Math.floor(1550 * 1.12));
// An unequipped formula (×1) changes nothing.
assert.equal(additiveMultiply({}, k, 128, 1), 128);

console.log("stat-rules: all checks passed");
