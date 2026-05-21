/**
 * Migration: 2026-05-20-painful-lesson-rekey
 * ---------------------------------------------------------------------------
 * Re-asserts `effect_kind: "open_action_menu"` on Painful Lesson's
 * `pl_free_study` effect row across the world master and every actor copy.
 *
 * Why:
 *   The original author migration (2026-05-17-painful-lesson-master-author)
 *   correctly authored the row with `effect_kind: "open_action_menu"` and
 *   is idempotent — but it only re-runs the first time it's seen. Once it
 *   marks itself "applied" in the ledger, any later drift (e.g. a manual
 *   edit through the row editor UI where the `effect_kind` dropdown
 *   defaulted back to "grant") leaves Painful Lesson silently broken:
 *   applyGrantEffect short-circuits on missing `grant_resource`, so the
 *   reaction looks like it fires but does nothing.
 *
 *   This migration is a targeted re-rekey: it ONLY rewrites `effect_kind`
 *   on rows where `effect_label === "pl_free_study"`. All other row fields
 *   (allowed_types, free_mode, check_bonus_formula, target_lock, etc.)
 *   are left untouched.
 *
 * Idempotent. Safe to re-author multiple times.
 */

export const key = "2026-05-20-painful-lesson-rekey";
export const description =
  "Re-assert effect_kind=open_action_menu on Painful Lesson's pl_free_study row " +
  "(fixes drift from row-editor saves that default the kind dropdown to 'grant').";

const ITEM_NAME = "Painful Lesson";
const TARGET_LABEL = "pl_free_study";
const TARGET_KIND = "open_action_menu";

async function rekeyOnItem(item, label, log) {
  const tableRaw = item.system?.props?.effect_table;
  if (!tableRaw || typeof tableRaw !== "object") {
    return { applied: false, reason: "no_effect_table" };
  }

  const cloned = foundry.utils.duplicate(tableRaw);
  let touchedRow = null;

  for (const k of Object.keys(cloned)) {
    const row = cloned[k];
    if (!row || row.$deleted) continue;
    if (row.effect_label !== TARGET_LABEL) continue;
    if (row.effect_kind === TARGET_KIND) continue; // already correct
    cloned[k] = { ...row, effect_kind: TARGET_KIND };
    touchedRow = { key: k, previousKind: row.effect_kind ?? null };
    break;
  }

  if (!touchedRow) {
    return { applied: false, reason: "no_drift" };
  }

  await item.update({ "system.props.effect_table": cloned });
  log(`${label}: rekeyed row ${touchedRow.key} (was ${touchedRow.previousKind ?? "<unset>"} → ${TARGET_KIND})`);
  return { applied: true, ...touchedRow };
}

export async function migrate(game, log) {
  let mastersFixed = 0;
  let copiesFixed = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    const res = await rekeyOnItem(item, `world master "${item.name}" [${item.id}]`, log);
    if (res.applied) mastersFixed++;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      const res = await rekeyOnItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log);
      if (res.applied) copiesFixed++;
    }
  }

  return {
    applied: true,
    summary: `${mastersFixed} master(s), ${copiesFixed} copies rekeyed to ${TARGET_KIND}`
  };
}
