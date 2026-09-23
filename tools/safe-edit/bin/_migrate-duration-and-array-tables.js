#!/usr/bin/env node
"use strict";

// Two world-data migrations the Skill Forge surfaced, both approved 2026-09-23.
//
//   U11  duration "Instnataneous" -> "Instantaneous"        (10 documents)
//        `actionDurationRank()` matches on the WORDS in the string: `instant`
//        -> 0, `scene|rest|session` -> 2, anything else -> 1. The misspelling
//        contains no "instant", so all ten are ranked as LASTING INTO A LATER
//        TURN. Nothing errors; they just quietly mean something else.
//
//   Y2   effect_table stored as a JSON ARRAY -> CSB's row object  (3 documents)
//        Every other document in the world uses `{"0": {...}}`. CSB's own
//        `_createRow` does `tableProps[newIdx] = row`, i.e. it assumes the
//        object form, and the Skill Forge converts on save anyway. Doing it
//        deliberately gets it over with instead of burying it in an unrelated
//        diff later.
//
// 🚨 THE TRAP THIS SCRIPT IS WRITTEN AROUND (`reference_safe_edit_tool`):
//    a dotted patch path THROUGH AN ARRAY INDEX destroys the array, and
//    safe-edit still reports `warnings: []`. So Y2 never patches
//    `system.props.effect_table.0.x` — it writes the WHOLE rebuilt object in
//    one value. U11 is a scalar at a fixed path and is safe as a dotted patch.
//
//   node tools/safe-edit/bin/_migrate-duration-and-array-tables.js [--apply]
//
// Default is a DRY RUN.

const path = require("path");
const { execFileSync } = require("child_process");

const SAFE_EDIT = path.join(__dirname, "safe-edit.js");
const APPLY = process.argv.includes("--apply");

// ── U11 ─────────────────────────────────────────────────────────────────────
const BAD = "Instnataneous";
const GOOD = "Instantaneous";
const DURATION_DOCS = [
  ["Actor.2Tf75KJiBUQwWGiL.Item.qPZT2J8stNlVqvHM", "Mega-Remedy on Founding Festival Item Stall"],
  ["Actor.91Lceg0mRGyUmQBW.Item.gBOzgXK58WjRsCsL", "Mega-Remedy on Moses"],
  ["Actor.C7PsWytpMXK0PZSt.Item.bNkNrpohezxyBvm7", "Mega-Remedy on Commodities Shade"],
  ["Actor.dafTLBUscCDNgq8H.Item.peoXVGo2UIvAnZfE", "Mega-Remedy on Hina"],
  ["Actor.srAH3OHOoK0tvFih.Item.jfHjXIvIdtMlYDpi", "Mega-Remedy on Hako"],
  ["Actor.t6E3CQ0pGxwLgXrn.Item.tvHxQ2h9j1KuwlIO", "Remedy on EXFURSION Party"],
  ["Actor.uJFaNQCSvwwsr2AW.Item.qGDOMAtenjvpbAeC", "Mega-Remedy on Blanche"],
  ["Item.0gi0e6XOfjVr2S0d", "Mega-Remedy (world item)"],
  ["Item.U8LaWX8VcCxielEq", "Mega-Remedy (world item)"],
  ["Item.uFoFmcWMN4tVtaeA", "Remedy (world item)"],
];

// ── Y2 ──────────────────────────────────────────────────────────────────────
const ARRAY_DOCS = [
  ["Item.CmyctfYXyvsBmRuf", "Descabello"],
  ["Item.nqfB7DhbpF9HHRwm", "Tafallera"],
  ["Item.Ro1ZgoiWtBFyMQS7", "Capote"],
];

function se(args) {
  return execFileSync(process.execPath, [SAFE_EDIT, ...args], { encoding: "utf8" });
}
function getDoc(uuid) {
  return JSON.parse(se(["get", uuid]));
}

let changed = 0;
let skipped = 0;
const problems = [];

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — duration spelling + array-shaped tables\n`);

// ── U11 ─────────────────────────────────────────────────────────────────────
console.log(`[U11] duration "${BAD}" -> "${GOOD}"`);
for (const [uuid, label] of DURATION_DOCS) {
  let doc;
  try { doc = getDoc(uuid); } catch (e) {
    problems.push(`${label}: cannot read (${e.message.split("\n")[0]})`);
    continue;
  }
  const cur = doc?.system?.props?.duration;
  if (cur === GOOD) { console.log(`      already correct  ${label}`); skipped += 1; continue; }
  if (cur !== BAD) {
    // NAMED, not silently skipped: a document that does not hold what this
    // migration was written for is a sign the list is stale, not a no-op.
    problems.push(`${label}: expected "${BAD}", found ${JSON.stringify(cur)}`);
    continue;
  }
  const args = ["patch", uuid, "--patch", JSON.stringify({ "system.props.duration": GOOD }),
    "--note", "U11 duration spelling"];
  if (!APPLY) args.push("--dry-run");
  se(args);
  console.log(`      ${APPLY ? "written" : "would write"}   ${label}`);
  changed += 1;
}

// ── Y2 ──────────────────────────────────────────────────────────────────────
console.log(`\n[Y2] effect_table: JSON array -> CSB row object`);
for (const [uuid, label] of ARRAY_DOCS) {
  let doc;
  try { doc = getDoc(uuid); } catch (e) {
    problems.push(`${label}: cannot read (${e.message.split("\n")[0]})`);
    continue;
  }
  const table = doc?.system?.props?.effect_table;
  if (!Array.isArray(table)) {
    if (table && typeof table === "object") { console.log(`      already an object  ${label}`); skipped += 1; }
    else problems.push(`${label}: effect_table is ${typeof table}, neither array nor object`);
    continue;
  }
  // Rebuild with the keys CSB itself would use: dense, zero-based, in order.
  const rebuilt = {};
  table.forEach((row, i) => { rebuilt[String(i)] = row; });

  // Sanity BEFORE writing: same row count, and every row identical.
  const same = table.length === Object.keys(rebuilt).length &&
    table.every((row, i) => JSON.stringify(row) === JSON.stringify(rebuilt[String(i)]));
  if (!same) { problems.push(`${label}: rebuild is not row-identical — refusing`); continue; }

  // 🚨 THE WHOLE OBJECT, in one value. Never a dotted path through an index.
  //
  // `--allow-system-key-removal` is needed, and it is NOT a shrug. safe-edit's
  // `flatten()` treats an ARRAY AS A LEAF, so while the table is an array the
  // only key it knows is `props.effect_table`; once it is an object that leaf
  // stops existing and every row key appears instead. The guard therefore
  // reports a removal that is an artifact of its own traversal. The real
  // protection is the row-identity assertion above, plus the read-back below.
  const args = ["patch", uuid, "--patch", JSON.stringify({ "system.props.effect_table": rebuilt }),
    "--allow-system-key-removal",
    "--note", "Y2 array-shaped effect_table -> row object"];
  if (!APPLY) args.push("--dry-run");
  se(args);

  if (APPLY) {
    // Read it back from disk and compare ROW BY ROW. Overriding a safety check
    // and then trusting the write is how the override becomes the bug.
    const after = getDoc(uuid)?.system?.props?.effect_table;
    const ok = after && !Array.isArray(after) &&
      Object.keys(after).length === table.length &&
      table.every((row, i) => JSON.stringify(after[String(i)]) === JSON.stringify(row));
    if (!ok) {
      problems.push(`${label}: READ-BACK MISMATCH after write \u2014 roll back with ` +
        `\`node tools/safe-edit/bin/safe-edit.js log\` + \`rollback <id>\``);
      continue;
    }
    console.log(`      written + verified   ${label}  (${table.length} row(s))`);
    changed += 1;
    continue;
  }
  console.log(`      would write   ${label}  (${table.length} row(s))`);
  changed += 1;
}

console.log(`\n${APPLY ? "applied" : "would change"}: ${changed}   already correct: ${skipped}`);
if (problems.length) {
  console.log(`\nNOT TOUCHED (${problems.length}) — each needs a look, none were guessed at:`);
  for (const p of problems) console.log(`   ${p}`);
}
process.exit(problems.length ? 1 : 0);
