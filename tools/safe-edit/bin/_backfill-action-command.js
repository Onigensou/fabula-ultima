#!/usr/bin/env node
"use strict";

// Step 2 of the action-command migration path
// (`docs/action-command-taxonomy-proposal.md`).
//
// `skill_type` carries two axes at once — the player's COMMAND (Attack / Skill
// / Spell / Item) and the CATEGORY (Active / Passive) — and three of its values
// are commands wearing the wrong field. Those are mechanical:
//
//     skill_type "Attack" -> action_command "attack"
//     skill_type "Item"   -> action_command "item"
//     skill_type "Spell"  -> action_command "spell"
//
// ADDITIVE AT EVERY STEP. `skill_type` is NOT touched, renamed or narrowed: it
// is read in 14+ engine files and keeps its meaning as the Active/Passive axis.
// Nothing here deletes anything, so the whole pass is reversible from the
// safe-edit journal.
//
// 🚨 WHAT THIS DELIBERATELY DOES NOT DO
//    `Active` (722 documents) and `Other` (90) are NOT backfilled. "Active"
//    means only "a performable something" — the command behind it is mostly
//    `skill`, some `spell`, a few Common actions, and guessing would write 722
//    confident wrong answers into content. That is step 3, it is a content
//    pass, and `ACTION_COMMAND_MISSING` now makes it self-checking.
//
//   node tools/safe-edit/bin/_backfill-action-command.js [--apply]
//
// Default is a DRY RUN.

const fs = require("fs");
const path = require("path");
const { getDoc, safeEdit } = require("../lib/edit.js");

const APPLY = process.argv.includes("--apply");
const EXPORT = path.join(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "_authored-export");
const SKILL_TEMPLATE = "j0F5Msw5RZ8aIB3j";

// The turn menu's own vocabulary (`turn-ui.js:30-40`), lowercased. Not invented
// here: the menu is what answers "which blade offers this".
const MAP = { Attack: "attack", Item: "item", Spell: "spell" };

// ── collect the targets from the export (fast, game-closed, no DB reads) ────
const targets = [];
function walk(doc, uuid) {
  const props = doc?.system?.props;
  if (props && doc.system.template === SKILL_TEMPLATE) {
    const type = String(props.skill_type ?? "").trim();
    const want = MAP[type];
    const have = String(props.action_command ?? "").trim();
    if (want && !have) targets.push({ uuid, name: doc.name, type, want });
  }
  for (const it of doc?.items ?? []) walk(it, `${uuid}.Item.${it._id}`);
}
function scan(dir, kind) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) { scan(fp, f); continue; }
    if (!f.endsWith(".json")) continue;
    let d; try { d = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { continue; }
    walk(d, `${kind === "actors" ? "Actor" : "Item"}.${d._id}`);
  }
}
scan(EXPORT, null);

const byType = {};
for (const t of targets) byType[t.type] = (byType[t.type] ?? 0) + 1;

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — action_command backfill from skill_type\n`);
console.log(`  targets: ${targets.length}`);
for (const [k, v] of Object.entries(byType)) console.log(`     ${String(v).padStart(4)}  ${k} -> ${MAP[k]}`);
if (!targets.length) { console.log("\nnothing to do."); process.exit(0); }

if (!APPLY) {
  console.log(`\nfirst 8:`);
  for (const t of targets.slice(0, 8)) console.log(`     ${t.name}  (${t.type} -> ${t.want})  ${t.uuid}`);
  console.log(`\nre-run with --apply to write.`);
  process.exit(0);
}

// ── apply ───────────────────────────────────────────────────────────────────
(async () => {
  let ok = 0;
  const problems = [];
  for (const t of targets) {
    try {
      // Re-read each document and re-check the precondition against the LIVE
      // store rather than trusting the export snapshot. The export is a
      // companion, not the source of truth, and a stale one would let this
      // overwrite a command somebody set in between.
      const live = await getDoc(t.uuid);
      if (!live) { problems.push(`${t.name}: gone from the store`); continue; }
      const have = String(live.system?.props?.action_command ?? "").trim();
      if (have) { problems.push(`${t.name}: already set to "${have}" — left alone`); continue; }
      const type = String(live.system?.props?.skill_type ?? "").trim();
      if (MAP[type] !== t.want) { problems.push(`${t.name}: skill_type is now "${type}" — left alone`); continue; }

      await safeEdit({
        uuid: t.uuid,
        patch: { "system.props.action_command": t.want },
        note: `action-command backfill: ${type} -> ${t.want}`,
      });
      ok += 1;
      if (ok % 100 === 0) console.log(`     …${ok}/${targets.length}`);
    } catch (e) {
      problems.push(`${t.name}: ${String(e.message).split("\n")[0]}`);
    }
  }
  console.log(`\nwritten: ${ok} / ${targets.length}`);
  if (problems.length) {
    console.log(`\nNOT WRITTEN (${problems.length}):`);
    for (const p of problems.slice(0, 20)) console.log(`   ${p}`);
    if (problems.length > 20) console.log(`   … ${problems.length - 20} more`);
  }
  process.exit(problems.length ? 1 : 0);
})();
