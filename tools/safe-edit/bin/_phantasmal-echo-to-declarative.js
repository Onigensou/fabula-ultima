#!/usr/bin/env node
"use strict";

// Rewrites Phantasmal Echo's reaction config to use the new declarative
// filters (reaction_subject_kind + reaction_ownership) and clears the old
// custom_logic_action gate. The skill body (MP restore) is untouched.
//
// Before:
//   reaction_config_table.0.reaction_source: "ally"
//   custom_logic_action:    <3950-char gate JS converted to HTML>
//
// After:
//   reaction_config_table.0.reaction_source:       "all"
//   reaction_config_table.0.reaction_subject_kind: "isPhantasm"
//   reaction_config_table.0.reaction_ownership:    "own_summon"
//   custom_logic_action:                            ""
//
// Idempotent: re-runs are no-ops once the row has both fields and CLA is empty.
//
// Usage:
//   node tools/safe-edit/bin/_phantasmal-echo-to-declarative.js [--dry-run]

const { safeEdit, getDoc } = require("../lib");

const UUID = "Item.YDzMWktTnD9J9Jun";

const args = process.argv.slice(2);
let dryRun = false;
for (const a of args) {
  if (a === "--dry-run") dryRun = true;
  if (a === "--help" || a === "-h") { console.log("Usage: --dry-run"); process.exit(0); }
}

(async () => {
  const it = await getDoc(UUID);
  if (!it) { console.error(`not found: ${UUID}`); process.exit(1); }

  const row0 = it?.system?.props?.reaction_config_table?.["0"] ?? {};
  const claLen = (it?.system?.props?.custom_logic_action ?? "").length;

  const wantsKind  = row0.reaction_subject_kind !== "isPhantasm";
  const wantsOwn   = row0.reaction_ownership !== "own_summon";
  const wantsSrc   = row0.reaction_source !== "all";
  const wantsCla   = claLen > 0;

  console.log(`[apply] current state:`);
  console.log(`  reaction_subject_kind: ${JSON.stringify(row0.reaction_subject_kind ?? "")}  (want "isPhantasm")`);
  console.log(`  reaction_ownership:    ${JSON.stringify(row0.reaction_ownership ?? "")}  (want "own_summon")`);
  console.log(`  reaction_source:       ${JSON.stringify(row0.reaction_source ?? "")}  (want "all")`);
  console.log(`  custom_logic_action:   ${claLen} chars  (want 0)`);

  if (!wantsKind && !wantsOwn && !wantsSrc && !wantsCla) {
    console.log(`[apply] Already in target state. Nothing to do.`);
    return;
  }

  const patch = {};
  if (wantsKind) patch["system.props.reaction_config_table.0.reaction_subject_kind"] = "isPhantasm";
  if (wantsOwn)  patch["system.props.reaction_config_table.0.reaction_ownership"] = "own_summon";
  if (wantsSrc)  patch["system.props.reaction_config_table.0.reaction_source"] = "all";
  if (wantsCla)  patch["system.props.custom_logic_action"] = "";

  console.log(`\n[apply] Patch to apply:`);
  console.log(JSON.stringify(patch, null, 2));

  if (dryRun) {
    console.log(`\n[apply] DRY RUN — not writing.`);
    return;
  }

  try {
    const result = await safeEdit({
      uuid: UUID,
      patch,
      note: "Phantasmal Echo: replace custom_logic_action gate with declarative reaction_subject_kind + reaction_ownership filters",
    });
    console.log(`\n[apply] OK entryId=${result.entryId} backup=${result.backupPath}`);
  } catch (e) {
    console.error(`\n[apply] FAILED:`, e.message);
    process.exit(1);
  }
})();
