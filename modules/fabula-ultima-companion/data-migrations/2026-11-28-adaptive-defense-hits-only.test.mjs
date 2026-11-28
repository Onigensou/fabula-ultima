// Migration 2026-11-28-adaptive-defense-hits-only: Adaptive Defense loses its miss row,
// keeps its hit row, and its trigger text says "hit".
//
//     node data-migrations/2026-11-28-adaptive-defense-hits-only.test.mjs

import assert from "node:assert/strict";
import { hitsOnlyPatch } from "./2026-11-28-adaptive-defense-hits-only.js";

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
}

const DESC = "<ul><li>When the Rakshasa is attacked with a weapon</li></ul><p>Lower the efficiency …</p>";
const authored = () => ({
  name: "Adaptive Defense",
  system: { props: { description: DESC, reaction_config_table: {
    "0": { $deleted: false, reaction_trigger: "creature_hit_by_action", reaction_source: "self", reaction_effect_ref: "ad_read" },
    "1": { $deleted: false, reaction_trigger: "creature_miss_action", reaction_source: "self", reaction_effect_ref: "ad_read" },
  } } },
});

check("the miss row is removed, the hit row stays, the text says hit", () => {
  assert.deepEqual(hitsOnlyPatch(authored()), {
    "system.props.reaction_config_table.-=1": null,
    "system.props.description": "<ul><li>When the Rakshasa is hit by an attack or a spell</li></ul><p>Lower the efficiency …</p>",
  });
});
check("a miss row already moved to enemy is removed too", () => {
  const it = authored();
  it.system.props.reaction_config_table["1"].reaction_source = "enemy";
  assert.equal(hitsOnlyPatch(it)["system.props.reaction_config_table.-=1"], null);
});
check("already migrated: nothing to change (idempotent)", () => {
  const it = authored();
  delete it.system.props.reaction_config_table["1"];
  it.system.props.description = DESC.replace("is attacked with a weapon", "is hit by an attack or a spell");
  assert.equal(hitsOnlyPatch(it), null);
});
check("another item with a miss row is left alone (Crysta's Deadly Shame = 'when I miss')", () => {
  const it = authored(); it.name = "Deadly Shame";
  assert.equal(hitsOnlyPatch(it), null);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
