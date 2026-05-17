/**
 * Migration: 2026-05-18-painful-lesson-dedupe
 * ---------------------------------------------------------------------------
 * Clean up Painful Lesson's reaction_config_table — earlier migration runs
 * left a duplicate row with blank reaction_effect_ref alongside the proper
 * pl_free_study row. The author migration's existence-check matched on
 * trigger+effect_ref pair, so a pre-existing trigger row with blank ref
 * wasn't recognized and got an additional row appended.
 *
 * This migration marks the duplicate (blank-ref) row as $deleted, leaving
 * the pl_free_study row as the only active row.
 *
 * Idempotent.
 */

export const key = "2026-05-18-painful-lesson-dedupe";
export const description =
  "Mark Painful Lesson's blank-reaction_effect_ref duplicate row as deleted.";

const ITEM_NAME = "Painful Lesson";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

async function dedupeItem(item, label, log) {
  const rct = item.system?.props?.reaction_config_table ?? {};
  const blankRefRows = [];
  let hasGoodRow = false;
  for (const k of Object.keys(rct)) {
    const r = rct[k];
    if (!r || r.$deleted) continue;
    if (r.reaction_trigger !== "creature_takes_damage") continue;
    if (!r.reaction_effect_ref) blankRefRows.push(k);
    else if (r.reaction_effect_ref === "pl_free_study") hasGoodRow = true;
  }

  if (!hasGoodRow) {
    log(`${label}: pl_free_study row missing; skipping (run author migration first)`);
    return false;
  }
  if (!blankRefRows.length) {
    log(`${label}: no duplicate blank-ref rows`);
    return false;
  }

  const newRct = foundry.utils.duplicate(rct);
  for (const k of blankRefRows) {
    newRct[k] = { ...newRct[k], $deleted: true };
  }
  await item.update({ "system.props.reaction_config_table": newRct });
  log(`${label}: marked ${blankRefRows.length} blank-ref row(s) as $deleted`);
  return true;
}

export async function migrate(game, log) {
  let mastersDeduped = 0;
  let copiesDeduped = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    if (!templateMatches(item)) continue;
    if (await dedupeItem(item, `world master "${item.name}" [${item.id}]`, log)) mastersDeduped++;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      if (!templateMatches(item)) continue;
      if (await dedupeItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log)) copiesDeduped++;
    }
  }

  return {
    applied: true,
    summary: `${mastersDeduped} master(s) + ${copiesDeduped} copies deduped`
  };
}
