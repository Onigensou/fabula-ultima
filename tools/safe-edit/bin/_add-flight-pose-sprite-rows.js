#!/usr/bin/env node
// Add the Leap and Fly pose rows (sprite_leap, sprite_fly) to the "Sprite" table
// of the PC and NPC sheet templates AND of every actor built from them, and
// (optionally) point ⭐️ Fafnir's two rows at her pose redraws.
//
// Same approach as _add-battler-pose-sprite-rows.js, for the same reason: a
// template re-stamp prunes props and resets dropdowns, so this only inserts
// rows into the existing `sprite_table` component of each stored layout.
// The poses: leap = crouched to spring (a cinematic's take-off), fly = airborne
// (hover / climb / descent). Cinematics (oni.timeline) read the sheet field
// first and fall back to the shot's bundled art; battler-pose-rules knows both
// as held poses.
//
// Idempotent: a row whose key is already in the table is skipped; values are
// only written when --fafnir is passed. Game must be CLOSED (LevelDB lock).
//
//   node bin/_add-flight-pose-sprite-rows.js                   # dry run
//   node bin/_add-flight-pose-sprite-rows.js --apply           # rows
//   node bin/_add-flight-pose-sprite-rows.js --apply --fafnir  # rows + her values
"use strict";
const { openCollection } = require("../lib/db");

const TEMPLATE_IDS = new Set([
  "OmwL5UqoVwjshkJo", // _FabU Char Template v3.fire  (PCs)
  "yegF6R8aaymhrvCg", // _Fabula NPC template v.2      (monsters, NPCs)
]);

// Inserted after the Cast row (the last battler-pose row), in this order.
const AFTER_KEY = "sprite_cast";
const ROWS = [
  ["Leap", "sprite_leap"],
  ["Fly", "sprite_fly"],
];

const FAFNIR_ID = "P1uCkpNnxLRBNqZr";
const CAMP_VFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/VFX/";
const FAFNIR_VALUES = { sprite_leap: CAMP_VFX + "Fafnir_Crouch.png", sprite_fly: CAMP_VFX + "Fafnir_Air.png" };

const APPLY = process.argv.includes("--apply");
const FAFNIR = process.argv.includes("--fafnir");

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

function makeRow(sampleRow, label, key) {
  const [labelCell, fieldCell] = JSON.parse(JSON.stringify(sampleRow));
  labelCell.value = label;
  fieldCell.key = key;
  return [labelCell, fieldCell];
}

function patchTable(table) {
  const rows = table.contents;
  const sampleIdx = rows.findIndex((r) => Array.isArray(r) && r[1]?.key === "sprite_battle");
  if (sampleIdx < 0) return { added: [], reason: "no Battle row" };
  let afterIdx = rows.findIndex((r) => Array.isArray(r) && r[1]?.key === AFTER_KEY);
  if (afterIdx < 0) afterIdx = sampleIdx;
  const present = new Set(rows.flat().filter(Boolean).map((c) => c.key).filter(Boolean));
  const added = [];
  let at = afterIdx + 1;
  for (const [label, key] of ROWS) {
    if (present.has(key)) { at = rows.findIndex((r) => Array.isArray(r) && r[1]?.key === key) + 1; continue; }
    rows.splice(at, 0, makeRow(rows[sampleIdx], label, key));
    at++;
    added.push(key);
  }
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
    let valued = [];
    if (FAFNIR && v._id === FAFNIR_ID) {
      v.system.props = v.system.props || {};
      for (const [key, url] of Object.entries(FAFNIR_VALUES)) { if (v.system.props[key] !== url) { v.system.props[key] = url; valued.push(key); } }
    }
    if (!added.length && !valued.length) continue;
    bytes += JSON.stringify(v).length - before;
    updates.push([k, v, added, isTemplate, valued]);
  }
  console.log(`scanned ${scanned} actors; ${updates.length} to patch (${updates.filter((u) => u[3]).length} templates); ${skipped} without a table`);
  console.log(`payload added: ${(bytes / 1024).toFixed(1)} KB`);
  for (const [, v, added, isT, valued] of updates.slice(0, 8)) console.log(`  ${isT ? "[TEMPLATE] " : ""}${v.name}: +${added.join(", ")}${valued.length ? "  values: " + valued.join(", ") : ""}`);
  if (updates.length > 8) console.log(`  ... and ${updates.length - 8} more`);
  const faf = updates.find((u) => u[1]._id === FAFNIR_ID);
  if (faf) console.log(`  ⭐️ Fafnir: rows +${faf[2].join(", ") || "(present)"}; values ${faf[4].join(", ") || "(unchanged)"}`);
  if (APPLY) {
    for (const [k, v] of updates) await db.put(k, v);
    console.log(`APPLIED ${updates.length} actor(s).`);
  } else {
    console.log("dry run — pass --apply to write" + (FAFNIR ? " (with Fafnir's values)" : ""));
  }
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
