/**
 * Migration: 2026-05-21-trigger-add-conflict-end
 * ---------------------------------------------------------------------------
 * Adds `conflict_end` to the `reaction_trigger` select dropdown on the
 * _Skill Template's `reaction_config_table` column, then repairs any
 * already-written rows whose `reaction_trigger` was silently stripped to
 * empty because the value wasn't in the dropdown when the row was saved.
 *
 * Why: the runtime trigger registry (`oni.ReactionTriggers`) and the
 * phaseHandler's `preDeleteCombat` emitter both already know about
 * `conflict_end`/`end_of_conflict`, but the CSB select column on the
 * template hadn't been updated to match. Saving a row with
 * reaction_trigger="conflict_end" produced an empty value in the stored
 * data (CSB's column-gating: writes are silently dropped if the value
 * isn't in the select's allowed options). See memory: csb-template-gating.
 *
 * The repair pass scans every item with a reaction_config_table and
 * rewrites any row matching (reaction_trigger="" AND reaction_effect_ref
 * ending in "_clear") to use conflict_end. Narrow on purpose — we only
 * touch what we KNOW we broke, not arbitrary empty-trigger rows that
 * might be legitimate work-in-progress.
 *
 * Dependency: 2026-05-21-reaction-gate-columns (same template surgery
 * pattern; this just adds one select option, not new columns).
 *
 * IDEMPOTENT.
 *
 * SCOPE: `_Skill Template` (id `j0F5Msw5RZ8aIB3j`).
 */

export const key = "2026-05-21-trigger-add-conflict-end";
export const description =
  "Add 'conflict_end' option to reaction_trigger dropdown; rewrite " +
  "pds_clear-style rows whose trigger was previously stripped to empty.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const NEW_OPTION  = { key: "conflict_end", value: "At the end of conflict" };

function findReactionConfigTable(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "reaction_config_table" && node.type === "compactDynamicTable") {
    return node;
  }
  const contents = Array.isArray(node.contents) ? node.contents : [];
  for (const child of contents) {
    const hit = findReactionConfigTable(child);
    if (hit) return hit;
  }
  return null;
}

async function patchTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const table = findReactionConfigTable({ contents: [sysClone.body] });
  if (!table) {
    log("reaction_config_table compactDynamicTable not found in template body — aborting");
    return { ok: false };
  }
  const triggerCol = (table.rowLayout ?? []).find(c => c?.key === "reaction_trigger");
  if (!triggerCol) {
    log("reaction_trigger column not found in rowLayout — aborting");
    return { ok: false };
  }
  const opts = Array.isArray(triggerCol.options) ? triggerCol.options : [];
  if (opts.some(o => o?.key === NEW_OPTION.key)) {
    log("conflict_end already present in dropdown — template no-op");
    return { ok: true, templateTouched: false };
  }
  // Insert right after conflict_start to keep lifecycle triggers grouped.
  const conflictStartIdx = opts.findIndex(o => o?.key === "conflict_start");
  const insertAt = conflictStartIdx >= 0 ? conflictStartIdx + 1 : opts.length;
  opts.splice(insertAt, 0, NEW_OPTION);
  triggerCol.options = opts;

  await template.update({ system: sysClone });
  log(`inserted "conflict_end" at dropdown index ${insertAt} (total options now ${opts.length})`);
  return { ok: true, templateTouched: true };
}

async function repairItemRows(item, log) {
  const table = item.system?.props?.reaction_config_table;
  if (!table || typeof table !== "object") return false;

  // Snapshot as plain rows array (table may be array OR keyed object).
  const entries = Array.isArray(table)
    ? table.map((row, i) => [String(i), row])
    : Object.entries(table);

  let changed = false;
  const next = {};
  for (const [k, row] of entries) {
    if (!row || typeof row !== "object") { next[k] = row; continue; }

    const trig = String(row.reaction_trigger ?? "").trim();
    const eff  = String(row.reaction_effect_ref ?? "").trim();

    // Only fix what we KNOW the v6 migration broke: empty-trigger rows
    // whose effect_ref is *_clear (the PP-clear lifecycle row).
    if (trig === "" && /(^|_)clear$/.test(eff)) {
      next[k] = { ...row, reaction_trigger: "conflict_end" };
      changed = true;
    } else {
      next[k] = row;
    }
  }
  if (!changed) return false;

  await item.update({ "system.props.reaction_config_table": next });
  log(`repaired empty-trigger _clear row(s) on item ${item.id} (parent="${item.parent?.name ?? "world"}")`);
  return true;
}

async function repairAllRows(game, log) {
  let touched = 0;
  for (const item of game.items?.contents ?? []) {
    try { if (await repairItemRows(item, log)) touched++; }
    catch (e) { log(`world item ${item.id} repair failed: ${e?.message ?? e}`); }
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      try { if (await repairItemRows(item, log)) touched++; }
      catch (e) { log(`actor item ${item.id} (${actor.name}) repair failed: ${e?.message ?? e}`); }
    }
  }
  return touched;
}

export async function migrate(game, log) {
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }

  // Phase 1: template surgery (must happen before row repair so the new
  // dropdown value is accepted on save).
  const res = await patchTemplate(template, log);
  if (!res.ok) {
    return { applied: false, summary: "template patch failed" };
  }

  // Phase 2: repair existing rows whose trigger was stripped.
  const repaired = await repairAllRows(game, log);

  return {
    applied: true,
    summary: `template ${res.templateTouched ? "patched" : "unchanged"}, ${repaired} row-set(s) repaired`
  };
}
