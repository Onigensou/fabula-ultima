/**
 * Migration: 2026-05-23-painful-lesson-actor-ref-repair
 * ---------------------------------------------------------------------------
 * Repair actor-embedded copies of Painful Lesson whose `creature_takes_damage`
 * trigger row has a blank `reaction_effect_ref`. The master + most copies
 * correctly carry `pl_free_study`; Hina's copy (and possibly others) were
 * blanked at some point. With ref="" the matcher still finds the row and
 * shows PL in the reaction window, but selecting it silently does nothing
 * because applyEffectsForGroup skips effect_refs with empty strings.
 *
 * Same regression shape as the HoD ref-wipe healed by
 * 2026-05-23-heart-of-darkness-rewire.
 *
 * IDEMPOTENT: only writes when the row's ref is currently blank.
 */

export const key = "2026-05-23-painful-lesson-actor-ref-repair";
export const description =
  "Restore reaction_effect_ref=pl_free_study on actor-embedded Painful Lesson " +
  "copies whose creature_takes_damage row has been blanked.";

const ITEM_NAME         = "Painful Lesson";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const DESIRED_REF       = "pl_free_study";
const TRIGGER_KEY       = "creature_takes_damage";

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

async function repair(item, label, log) {
  const tbl = item?.system?.props?.reaction_config_table;
  if (!tbl || typeof tbl !== "object") return false;
  const clone = foundry.utils.duplicate(tbl);
  let changed = false;
  for (const k of Object.keys(clone)) {
    const row = clone[k];
    if (!row || row.$deleted) continue;
    if (String(row.reaction_trigger ?? "") !== TRIGGER_KEY) continue;
    if (String(row.reaction_effect_ref ?? "") === DESIRED_REF) continue;
    if (String(row.reaction_effect_ref ?? "") !== "") continue; // don't overwrite a non-empty divergent value
    row.reaction_effect_ref = DESIRED_REF;
    changed = true;
  }
  if (!changed) return false;
  await item.update({ "system.props.reaction_config_table": clone });
  log(`${label}: restored reaction_effect_ref=${DESIRED_REF}`);
  return true;
}

export async function migrate(game, log) {
  let touched = 0;
  for (const actor of (game.actors?.contents ?? [])) {
    for (const item of (actor.items?.contents ?? [])) {
      if (item.name !== ITEM_NAME) continue;
      if (!templateMatches(item)) continue;
      const label = `actor "${actor.name}" item "${item.name}" [${item.id}]`;
      if (await repair(item, label, log)) touched++;
    }
  }
  return {
    applied: true,
    summary: `${touched} actor copies repaired`
  };
}
