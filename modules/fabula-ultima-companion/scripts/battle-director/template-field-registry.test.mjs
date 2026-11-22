// ae_lifetime_mode column declaration: dropdown, engine modes only, no default.
import assert from "node:assert/strict";
import { EFFECT_TABLE_REQUIRED_COLUMNS as C } from "./template-field-registry.js";
const c = C.filter((x) => x.key === "ae_lifetime_mode");
assert.equal(c.length, 1, "declared exactly once");
assert.equal(c[0].type, "select");
assert.equal(c[0].defaultValue, "", "no stamped default");
assert.deepEqual(c[0].options.map((o) => o.key).sort(),
  ["", "applier_turn_end", "on_activation", "persistent_counter", "round_end", "target_turn_end", "target_turn_start"]);
assert.match(c[0].visibilityFormula, /apply_ae/);
console.log("template-field-registry ae_lifetime_mode: ok");
