// Migration 2026-11-28-adaptive-defense-miss-source: only Adaptive Defense's miss row
// moves from reaction_source "self" to "enemy".
//
//     node data-migrations/2026-11-28-adaptive-defense-miss-source.test.mjs

import assert from "node:assert/strict";
import { missRowPatch } from "./2026-11-28-adaptive-defense-miss-source.js";

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
}

const authored = () => ({
  name: "Adaptive Defense",
  system: { props: { reaction_config_table: {
    "0": { $deleted: false, reaction_trigger: "creature_hit_by_action", reaction_source: "self", reaction_effect_ref: "ad_read" },
    "1": { $deleted: false, reaction_trigger: "creature_miss_action", reaction_source: "self", reaction_effect_ref: "ad_read" },
  } } },
});

check("the miss row becomes enemy; the hit row stays self", () => {
  assert.deepEqual(missRowPatch(authored()), { "system.props.reaction_config_table.1.reaction_source": "enemy" });
});
check("already fixed: nothing to change (idempotent)", () => {
  const it = authored();
  it.system.props.reaction_config_table["1"].reaction_source = "enemy";
  assert.equal(missRowPatch(it), null);
});
check("another item with a self miss row is left alone (Crysta's Deadly Shame = 'when I miss')", () => {
  const it = authored(); it.name = "Deadly Shame";
  assert.equal(missRowPatch(it), null);
});
check("a deleted row is skipped", () => {
  const it = authored();
  it.system.props.reaction_config_table["1"].$deleted = true;
  assert.equal(missRowPatch(it), null);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
