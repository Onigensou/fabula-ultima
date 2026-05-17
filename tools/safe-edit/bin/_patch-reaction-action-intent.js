#!/usr/bin/env node
"use strict";

// Inserts the `reaction_action_intent` column (select: "" | "harmful" | "aid"
// | "neutral") into a doc's reaction_config_table rowLayout, after
// `reaction_ownership` (the existing universal-filter neighbor).
//
// Idempotent: if the column is already present, exits without writing.
//
// Targets (CLI-overridable with --uuid):
//   Item.j0F5Msw5RZ8aIB3j     — _Skill Template (master)
//
// Usage:
//   node tools/safe-edit/bin/_patch-reaction-action-intent.js [--dry-run] [--uuid <UUID>]...

const { safeEdit, getDoc } = require("../lib");

const DEFAULT_TARGETS = [
  "Item.j0F5Msw5RZ8aIB3j",
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

const ACTION_INTENT_COL = {
  key: "reaction_action_intent",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip:
    'Match only on actions with this intent. "harmful" = attack / offensive spell / damage source (Protect, Counterattack, Cover). "aid" = heal / buff spell / utility active. "neutral" = Passive / Item / Other. Blank = no filter.',
  visibilityFormula: 'triggerHasSubject(sameRow("reaction_trigger",\'\'))',
  type: "select",
  size: "full-size",
  label: "",
  defaultValue: "",
  selectedOptionType: "custom",
  options: [
    { key: "", value: "—" },
    { key: "harmful", value: "Harmful" },
    { key: "aid", value: "Aid" },
    { key: "neutral", value: "Neutral" },
  ],
  align: "left",
  colName: "Action Intent",
  readonlyPredefined: false,
};

// rowLayout may be either an array OR a keyed object (CSB normalizes both
// shapes at runtime). Iterate generically.
function rowLayoutEntries(layout) {
  if (Array.isArray(layout)) {
    return layout.map((col, i) => [String(i), col]);
  }
  if (layout && typeof layout === "object") {
    return Object.keys(layout)
      .map((k) => [k, layout[k]])
      .filter(([, v]) => v && typeof v === "object");
  }
  return [];
}

function rowLayoutContains(layout, key) {
  return rowLayoutEntries(layout).some(([, col]) => col?.key === key);
}

// Locate every reaction_config_table layout block under doc.system.
function findReactionConfigPath(doc) {
  const found = [];
  function walk(node, path) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], [...path, i]);
      return;
    }
    if (node && typeof node === "object") {
      if (node.key === "reaction_config_table" && node.rowLayout != null) {
        found.push({ path: [...path], node });
      }
      for (const k of Object.keys(node)) walk(node[k], [...path, k]);
    }
  }
  walk(doc.system, ["system"]);
  return found;
}

// Append the action-intent column to the layout, after reaction_ownership if
// present (else at the end). Returns the new layout in the same shape as the
// input (array or keyed object), or null if no change is needed.
function patchRowLayout(rowLayout) {
  if (rowLayoutContains(rowLayout, "reaction_action_intent")) return null;

  const entries = rowLayoutEntries(rowLayout);
  const out = [];
  let inserted = false;
  for (const [, col] of entries) {
    out.push(col);
    if (!inserted && col?.key === "reaction_ownership") {
      out.push(ACTION_INTENT_COL);
      inserted = true;
    }
  }
  if (!inserted) out.push(ACTION_INTENT_COL);

  if (Array.isArray(rowLayout)) return out;

  // Object-shaped: re-key 0..N to keep insertion order stable on read-back.
  const obj = {};
  out.forEach((col, i) => { obj[String(i)] = col; });
  return obj;
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

    let changed = 0;
    const topFieldsToWrite = new Set();
    for (const hit of hits) {
      const newLayout = patchRowLayout(hit.node.rowLayout);
      if (!newLayout) {
        console.log(`  ${hit.path.join(".")}.rowLayout already has action_intent`);
        continue;
      }
      hit.node.rowLayout = newLayout;
      changed++;
      if (hit.path.length >= 2 && hit.path[0] === "system") {
        topFieldsToWrite.add(hit.path[1]);
      }
      const cols = Array.isArray(newLayout) ? newLayout.length : Object.keys(newLayout).length;
      console.log(`  will write ${hit.path.join(".")}.rowLayout (-> ${cols} cols)`);
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
        note: "Add reaction_action_intent column to reaction_config_table rowLayout",
      });
      console.log(`  OK entryId=${result.entryId} backup=${result.backupPath}`);
    } catch (e) {
      console.error(`  FAILED:`, e.message);
    }
  }
  console.log(`\n[patch] Done.`);
})();
