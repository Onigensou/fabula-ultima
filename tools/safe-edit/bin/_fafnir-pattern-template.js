// CSB template work for the Imp's action pattern.
// Run from tools/safe-edit; --apply to write.
//
// WHY THIS EXISTS: an action-pattern row keeps only the keys the template
// declares, and a select keeps only values that are one of its options. Author
// `enemy_lacks_status` or `status_avoid` without doing this first and the row
// works at runtime (the engine reads raw props) right up until somebody OPENS
// the sheet — at which point CSB re-serializes the table, the unknown select
// value falls back to the default and the undeclared column is dropped, and the
// revert is written to disk. That is the failure that silently un-did Dryad's
// burn_spread twice; see feedback_csb_template_restamp_resets.
//
// Four changes at the action_pattern_table's rowLayout:
//   [1] condition select     + enemy_lacks_status
//   [4] string field          visibility extended to enemy_lacks_status
//   [6] target focus select  + status_focus, status_avoid
//   [10] NEW action_pattern_focus_status text column
//
// The template is patched AND so is every actor listed below. Patching the
// per-actor `system.body` alone would be futile (a reloadTemplate re-stamps it
// from the template and drops the edit) — but with the template fixed FIRST,
// the actor patch is what makes the new columns work before anyone clicks
// reload, and a later re-stamp brings the same columns back rather than
// removing them. Both, in that order, is the durable combination.
const { getByKey } = require("../lib/db");
const { IDS } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const TEMPLATE = "yegF6R8aaymhrvCg";                 // _Fabula NPC template v.2
const TARGET_ACTORS = [IDS.IM, IDS.DGD];             // the two monsters built this session

// The six conditions whose evaluators read `row.stringRaw`, plus the new one.
const STRING_CONDITIONS = [
  "active_effect", "self_has_status", "self_lacks_status",
  "enemy_has_status", "enemy_lacks_status", "creature_has_status", "effect_stacks",
];
const STRING_VIS =
  `sameRow(or(${STRING_CONDITIONS.map((c) => `equalText("action_pattern_condition","${c}")`).join(", ")}))`;

const FOCUS_STATUS_VIS =
  `sameRow(or(equalText("action_pattern_target_focus","status_focus"), ` +
  `equalText("action_pattern_target_focus","status_avoid")))`;

// Balanced-paren assertion. The last attempt at this file's kind of edit used
// string surgery, matched inside a tail of ")))" and produced an unbalanced
// formula that CSB then swallowed silently.
function assertBalanced(formula, what) {
  const open = (formula.match(/\(/g) ?? []).length;
  const close = (formula.match(/\)/g) ?? []).length;
  if (open !== close) throw new Error(`${what}: unbalanced parens (${open} open, ${close} close)`);
}

function patternRowLayout(doc) {
  const rl = doc?.system?.body?.contents?.[0]?.contents?.[1]?.contents?.[5]
    ?.contents?.[0]?.contents?.[0]?.rowLayout;
  if (!Array.isArray(rl)) return null;
  // Positional paths are brittle, so verify we landed on the right table before
  // writing anything into it.
  if (rl[0]?.key !== "action_pattern_name" || rl[1]?.key !== "action_pattern_condition") return null;
  return rl;
}

function addOption(col, key, value, what) {
  if (!Array.isArray(col.options)) throw new Error(`${what}: no options array`);
  if (col.options.some((o) => o.key === key)) return false;
  col.options.push({ key, value });
  return true;
}

function patchDoc(doc, label) {
  const rl = patternRowLayout(doc);
  if (!rl) return { ok: false, note: `${label}: no action_pattern rowLayout at the expected path` };
  const notes = [];

  // [1] condition select
  if (addOption(rl[1], "enemy_lacks_status", "Enemy Lacks Status", `${label} condition`)) {
    notes.push("+enemy_lacks_status");
  }

  // [4] string-field visibility
  if (rl[4]?.key !== "action_pattern_string") throw new Error(`${label}: rowLayout[4] is not the string field`);
  assertBalanced(STRING_VIS, `${label} string visibility`);
  if (rl[4].visibilityFormula !== STRING_VIS) {
    rl[4].visibilityFormula = STRING_VIS;
    notes.push("string vis += enemy_lacks_status");
  }

  // [6] target focus select
  if (rl[6]?.key !== "action_pattern_target_focus") throw new Error(`${label}: rowLayout[6] is not the focus select`);
  if (addOption(rl[6], "status_focus", "Status Focus — aim at holders of Focus Status", `${label} focus`)) {
    notes.push("+status_focus");
  }
  if (addOption(rl[6], "status_avoid", "Status Avoid — aim at NON-holders of Focus Status", `${label} focus`)) {
    notes.push("+status_avoid");
  }

  // [10] the paired status column. Cloned from the string field so it inherits
  // whatever CSB expects of a textField in this table rather than being
  // hand-rolled.
  assertBalanced(FOCUS_STATUS_VIS, `${label} focus-status visibility`);
  const existing = rl.findIndex((c) => c?.key === "action_pattern_focus_status");
  const col = {
    ...JSON.parse(JSON.stringify(rl[4])),
    key: "action_pattern_focus_status",
    colName: "Focus Status",
    tooltip: "Status name read by the status_focus / status_avoid target-focus modes. " +
      "status_focus narrows the pick to creatures carrying it; status_avoid narrows it to " +
      "creatures who do not. Either way, if nobody qualifies the pool is left alone and the " +
      "action still resolves — gate the ROW as well when it should not fire at all.",
    visibilityFormula: FOCUS_STATUS_VIS,
    defaultValue: "",
  };
  if (existing >= 0) { rl[existing] = col; notes.push("focus-status col refreshed"); }
  else { rl.push(col); notes.push("+action_pattern_focus_status col"); }

  return { ok: true, note: notes.length ? `${label}: ${notes.join(", ")}` : `${label}: already current` };
}

run(async ({ changes }) => {
  const tpl = await getByKey("actors", `!actors!${TEMPLATE}`);
  if (!tpl) throw new Error("missing NPC template actor");
  const tplRes = patchDoc(tpl, "template");
  if (!tplRes.ok) throw new Error(tplRes.note);
  changes.push([`!actors!${TEMPLATE}`, tpl, tplRes.note]);

  for (const id of TARGET_ACTORS) {
    const a = await getByKey("actors", `!actors!${id}`);
    if (!a) {
      // Expected on the first run — the monsters are written by their own build
      // scripts. Re-run this after them.
      console.log(`  (skip) actor ${id} not built yet`);
      continue;
    }
    const res = patchDoc(a, a.name ?? id);
    if (!res.ok) throw new Error(res.note);
    changes.push([`!actors!${id}`, a, res.note]);
  }
}, "fafnir-castle: action-pattern template columns");
