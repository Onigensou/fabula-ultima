#!/usr/bin/env node
// Add the battler-pose sprite rows (Walk, Hurt, KO, Crisis, Guard, Attack, Cast)
// to the "Sprite" table of the PC and NPC sheet templates AND of every actor
// built from them.
//
// Why not a template re-stamp: CSB's reloadTemplate prunes every prop the
// template does not declare and can reset dropdowns, and PC actors carry
// per-instance layout a re-stamp would damage (see WORLD-EXPORT.md). This
// script only inserts rows into the existing `sprite_table` component of each
// stored layout; nothing else on the actor changes.
//
// Idempotent: a row whose key is already in the table is skipped.
// Game must be CLOSED (LevelDB lock).
//
//   node bin/_add-battler-pose-sprite-rows.js            # dry run
//   node bin/_add-battler-pose-sprite-rows.js --apply    # write
"use strict";
const { openCollection } = require("../lib/db");

const TEMPLATE_IDS = new Set([
  "OmwL5UqoVwjshkJo", // _FabU Char Template v3.fire  (PCs)
  "yegF6R8aaymhrvCg", // _Fabula NPC template v.2      (monsters, NPCs)
]);

// Inserted after the Battle row, in this order.
const ROWS = [
  ["Walk", "sprite_walk"],
  ["Hurt", "sprite_hurt"],
  ["KO", "sprite_ko"],
  ["Crisis", "sprite_crisis"],
  ["Guard", "sprite_guard"],
  ["Attack", "sprite_attack"],
  ["Cast", "sprite_cast"],
];

const APPLY = process.argv.includes("--apply");

function findComponent(node, key) {
  if (Array.isArray(node)) {
    for (const x of node) { const r = findComponent(x, key); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") {
    if (node.key === key) return node;
    for (const k of Object.keys(node)) { const r = findComponent(node[k], key); if (r) return r; }
  }
  return null;
}

// Build a row by cloning the table's own Battle row, so the cells carry
// exactly the shape CSB wrote for the existing rows.
function makeRow(battleRow, label, key) {
  const [labelCell, fieldCell] = JSON.parse(JSON.stringify(battleRow));
  labelCell.value = label;
  fieldCell.key = key;
  return [labelCell, fieldCell];
}

function patchTable(table) {
  const rows = table.contents;
  const battleIdx = rows.findIndex((r) => Array.isArray(r) && r[1]?.key === "sprite_battle");
  if (battleIdx < 0) return { added: [], reason: "no Battle row" };
  const present = new Set(rows.flat().filter(Boolean).map((c) => c.key).filter(Boolean));
  const added = [];
  let at = battleIdx + 1;
  for (const [label, key] of ROWS) {
    if (present.has(key)) { at = rows.findIndex((r) => Array.isArray(r) && r[1]?.key === key) + 1; continue; }
    rows.splice(at, 0, makeRow(rows[battleIdx], label, key));
    at++;
    added.push(key);
  }
  // `rows` counts real rows; CSB keeps a trailing [null, null] editing row
  // outside that count.
  table.rows = rows.filter((r) => Array.isArray(r) && r.some(Boolean)).length;
  return { added };
}

(async () => {
  const db = await openCollection("actors");
  const updates = [];
  let scanned = 0, skipped = 0, bytes = 0;
  for await (const [k, v] of db.iterator()) {
    if (!k.startsWith("!actors!")) continue;
    scanned++;
    const isTemplate = TEMPLATE_IDS.has(v._id);
    if (!isTemplate && !TEMPLATE_IDS.has(v.system?.template)) continue;
    const table = findComponent(v.system?.body, "sprite_table");
    if (!table) { skipped++; continue; }
    const before = JSON.stringify(v).length;
    const { added, reason } = patchTable(table);
    if (reason) { console.log(`  skip ${v.name}: ${reason}`); skipped++; continue; }
    if (!added.length) continue;
    bytes += JSON.stringify(v).length - before;
    updates.push([k, v, added, isTemplate]);
  }
  console.log(`scanned ${scanned} actors; ${updates.length} to patch (${updates.filter((u) => u[3]).length} templates); ${skipped} without a table`);
  console.log(`payload added: ${(bytes / 1024).toFixed(1)} KB`);
  for (const [, v, added, isT] of updates.slice(0, 8)) console.log(`  ${isT ? "[TEMPLATE] " : ""}${v.name}: +${added.join(", ")}`);
  if (updates.length > 8) console.log(`  ... and ${updates.length - 8} more`);
  if (APPLY) {
    for (const [k, v] of updates) await db.put(k, v);
    console.log(`APPLIED ${updates.length} actor(s).`);
  } else {
    console.log("dry run — pass --apply to write");
  }
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
