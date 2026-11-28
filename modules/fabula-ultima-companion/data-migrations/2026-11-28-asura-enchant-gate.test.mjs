// Migration 2026-11-28-asura-enchant-gate: only the Fire/Bolt/Ice Enchant rows gain the
// grounded-enemy gate; Air rows and hand-edited rows stay.
//
//     node data-migrations/2026-11-28-asura-enchant-gate.test.mjs

import assert from "node:assert/strict";
import { enchantGatePatch } from "./2026-11-28-asura-enchant-gate.js";

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
}

const row = (name, cond, str) => ({ $deleted: false, action_pattern_name: name, action_pattern_condition: cond, action_pattern_string: str });
const table = () => ({
  "1": row("Sword Enchant - Fire", "self_lacks_status", "Fire Mark"),
  "2": row("Sword Enchant - Bolt", "self_lacks_status", "Bolt Mark"),
  "3": row("Sword Enchant - Ice", "self_lacks_status", "Ice Mark"),
  "4": row("Sword Enchant - Air", "self_lacks_status", "Air Mark"),
  "8": row("Sword Enchant - Air", "formula", "ENEMY_COUNT_FLYING > 0 && ENEMY_COUNT_GROUNDED == 0 && AE_COUNT_AIR_ASPECT == 0"),
});
const P = "system.props.action_pattern_table";

check("Fire/Bolt/Ice gated, Air rows untouched", () => {
  const p = enchantGatePatch(table());
  assert.equal(Object.keys(p).length, 6);
  assert.equal(p[`${P}.1.action_pattern_string`], "AE_COUNT_FIRE_MARK == 0 && ENEMY_COUNT_GROUNDED > 0");
  assert.equal(p[`${P}.3.action_pattern_condition`], "formula");
  assert.ok(!Object.keys(p).some((k) => k.includes(".4.") || k.includes(".8.")));
});
check("second run changes nothing (idempotent)", () => {
  const t = table();
  for (const [k, v] of Object.entries(enchantGatePatch(t))) { const [, , , r, f] = k.split("."); t[r][f] = v; }
  assert.deepEqual(enchantGatePatch(t), {});
});
check("a hand-edited row is left alone", () => {
  const t = table(); t["1"].action_pattern_condition = "always";
  assert.ok(!Object.keys(enchantGatePatch(t)).some((k) => k.includes(".1.")));
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
