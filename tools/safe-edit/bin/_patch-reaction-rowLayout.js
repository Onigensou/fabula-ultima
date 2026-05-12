#!/usr/bin/env node
"use strict";

// Inserts `reaction_subject_kind` (textField) and `reaction_ownership`
// (select) columns into a doc's reaction_config_table rowLayout, between
// `reaction_debuff_count_min` and `reaction_effect_ref`.
//
// Idempotent: if both columns are already present, exits without writing.
//
// Targets (CLI-overridable with --uuid):
//   Item.j0F5Msw5RZ8aIB3j     — _Skill Template (master)
//   Item.YDzMWktTnD9J9Jun     — Phantasmal Echo (the skill we're rewriting)
//
// Usage:
//   node tools/safe-edit/bin/_patch-reaction-rowLayout.js [--dry-run] [--uuid <UUID>]...

const { safeEdit, getDoc } = require("../lib");

const DEFAULT_TARGETS = [
  "Item.j0F5Msw5RZ8aIB3j",
  "Item.YDzMWktTnD9J9Jun",
];

const args = process.argv.slice(2);
let dryRun = false;
const uuids = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dry-run") { dryRun = true; continue; }
  if (args[i] === "--uuid") { uuids.push(args[++i]); continue; }
  if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: --dry-run; --uuid <UUID> (repeatable)");
    process.exit(0);
  }
}
const targets = uuids.length ? uuids : DEFAULT_TARGETS;

// ---------------- New columns ----------------
const SUBJECT_KIND_COL = {
  key: "reaction_subject_kind",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip:
    "Subject-kind filter: actor.system.props.<this> must be truthy. Common values: isPhantasm, isSummon. Blank = no filter. Available on any trigger with a per-creature subject.",
  visibilityFormula: 'triggerHasSubject(sameRow("reaction_trigger",\'\'))',
  type: "textField",
  size: "full-size",
  label: "",
  defaultValue: "",
  charList: "",
  maxLength: null,
  autocomplete: "",
  align: "left",
  colName: "Subject Kind",
  readonlyPredefined: false,
};

const OWNERSHIP_COL = {
  key: "reaction_ownership",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip:
    "Subject/reactor relationship. own_summon = subject token was summoned by the reactor (token flag summonedBy == reactor actor UUID).",
  visibilityFormula: 'triggerHasSubject(sameRow("reaction_trigger",\'\'))',
  type: "select",
  size: "full-size",
  label: "",
  defaultValue: "",
  selectedOptionType: "custom",
  options: [
    { key: "", value: "—" },
    { key: "own_summon", value: "Own Summon" },
  ],
  align: "left",
  colName: "Ownership",
  readonlyPredefined: false,
};

// ---------------- Locate reaction_config_table block ----------------
function findReactionConfigPath(doc) {
  const found = [];
  function walk(node, path) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], [...path, i]);
      return;
    }
    if (node && typeof node === "object") {
      if (node.key === "reaction_config_table" && Array.isArray(node.rowLayout)) {
        found.push({ path: [...path], node });
      }
      for (const k of Object.keys(node)) walk(node[k], [...path, k]);
    }
  }
  walk(doc.system, ["system"]);
  return found;
}

// Build the patched rowLayout. Returns null if already patched.
function patchRowLayout(rowLayout) {
  const hasKind = rowLayout.some((c) => c?.key === "reaction_subject_kind");
  const hasOwn  = rowLayout.some((c) => c?.key === "reaction_ownership");
  if (hasKind && hasOwn) return null;

  const out = [];
  for (const col of rowLayout) {
    out.push(col);
    if (col?.key === "reaction_debuff_count_min") {
      if (!hasKind) out.push(SUBJECT_KIND_COL);
      if (!hasOwn) out.push(OWNERSHIP_COL);
    }
  }
  // If debuff_count_min wasn't present, append at the end (defensive — every
  // current template has it, so this branch is just paranoia).
  if (!out.some((c) => c?.key === "reaction_subject_kind")) out.push(SUBJECT_KIND_COL);
  if (!out.some((c) => c?.key === "reaction_ownership")) out.push(OWNERSHIP_COL);
  return out;
}

(async () => {
  console.log(`[patch] dryRun=${dryRun}, targets=${targets.length}`);
  for (const uuid of targets) {
    console.log(`\n[patch] ${uuid}`);
    const it = await getDoc(uuid);
    if (!it) { console.warn(`  skip — not found`); continue; }

    const hits = findReactionConfigPath(it);
    if (!hits.length) {
      console.warn(`  skip — no reaction_config_table layout block found`);
      continue;
    }
    if (hits.length > 1) {
      console.warn(`  WARNING — found ${hits.length} reaction_config_table layout blocks; patching all`);
    }

    // Mutate the doc in place, then write back at the top-level system field
    // that contains the layout block (typically `system.body`). Flat-dotted
    // paths can't address array indices because deepMerge treats string-key
    // objects as overlays, not as array splices.
    let changed = 0;
    const topFieldsToWrite = new Set();
    for (const hit of hits) {
      const newLayout = patchRowLayout(hit.node.rowLayout);
      if (!newLayout) {
        console.log(`  ${hit.path.join(".")}.rowLayout already has both columns`);
        continue;
      }
      hit.node.rowLayout = newLayout;
      changed++;
      // hit.path[0] is "system"; hit.path[1] is the top-level system field
      // ("body" / "header" / etc.). Replace that whole field.
      if (hit.path.length >= 2 && hit.path[0] === "system") {
        topFieldsToWrite.add(hit.path[1]);
      }
      console.log(`  will write ${hit.path.join(".")}.rowLayout (-> ${newLayout.length} cols)`);
    }
    if (!changed) continue;

    const patch = {};
    for (const field of topFieldsToWrite) {
      patch[`system.${field}`] = it.system[field];
    }

    if (dryRun) {
      console.log(`  DRY RUN — would write ${changed} block(s)`);
      continue;
    }

    try {
      const result = await safeEdit({
        uuid,
        patch,
        note: "Add reaction_subject_kind + reaction_ownership columns to reaction_config_table rowLayout",
      });
      console.log(`  OK entryId=${result.entryId} backup=${result.backupPath}`);
    } catch (e) {
      console.error(`  FAILED:`, e.message);
    }
  }
  console.log(`\n[patch] Done.`);
})();
