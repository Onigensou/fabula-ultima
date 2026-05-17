/**
 * Migration: 2026-05-18-painful-lesson-target-lock
 * ---------------------------------------------------------------------------
 * Phase F follow-up: enforce "on that creature" from Painful Lesson's RAW.
 *
 *   1. Add `target_lock` column to `effect_table` rowLayout on _Skill Template.
 *      Values: "" (no lock) | "damage_source" | "subject". Visible only when
 *      effect_kind === "open_action_menu".
 *
 *   2. Update Painful Lesson's row 0 with `target_lock: "damage_source"` so
 *      the resulting Study locks its target to the creature that caused the
 *      damage (RAW: "perform the Study action on that creature for free").
 *
 * IDEMPOTENT.
 */

export const key = "2026-05-18-painful-lesson-target-lock";
export const description =
  "Add target_lock column to open_action_menu + author Painful Lesson with " +
  "target_lock: damage_source.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const ITEM_NAME = "Painful Lesson";
const TARGET_LOCK_VALUE = "damage_source";

function makeTargetLockCol() {
  return {
    key: "target_lock",
    colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip:
      "Lock the next action's target to a specific token. \"damage_source\" " +
      "uses the trigger's acting creature (Painful Lesson: \"on that creature\"). " +
      "\"subject\" uses the trigger's subject. Blank = no lock.",
    visibilityFormula: `equalText(sameRow("effect_kind",''), "open_action_menu")`,
    type: "select",
    size: "full-size",
    label: "",
    defaultValue: "",
    selectedOptionType: "custom",
    options: [
      { key: "damage_source", value: "Damage Source" },
      { key: "subject",       value: "Subject" }
    ],
    align: "left",
    colName: "Target Lock",
    readonlyPredefined: false
  };
}

async function migrateTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const tab = sysClone?.body?.contents?.[0]?.contents?.[0];
  if (!tab?.contents) return { ok: false, summary: "unexpected tab shape" };

  const sep = tab.contents.find(c => c?.key === "skill_effects_panel");
  const eft = sep?.contents?.find(c => c?.key === "effect_table");
  if (!eft || !Array.isArray(eft.rowLayout)) {
    return { ok: false, summary: "effect_table.rowLayout missing" };
  }

  if (eft.rowLayout.some(c => c?.key === "target_lock")) {
    return { ok: true, summary: "target_lock column already present" };
  }

  eft.rowLayout.push(makeTargetLockCol());
  await template.update({ system: sysClone });
  log("added column target_lock to effect_table");
  return { ok: true, summary: "added target_lock column" };
}

function findPlEffectRow(table) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && r.effect_label === "pl_free_study") return { key: k, row: r };
  }
  return null;
}

async function authorOnItem(item, label, log) {
  const eft = item.system?.props?.effect_table ?? {};
  const found = findPlEffectRow(eft);
  if (!found) {
    log(`${label}: pl_free_study row not present; skipping author`);
    return false;
  }
  if (String(found.row.target_lock ?? "") === TARGET_LOCK_VALUE) {
    log(`${label}: target_lock already set`);
    return false;
  }

  const newTable = foundry.utils.duplicate(eft);
  newTable[found.key] = { ...newTable[found.key], target_lock: TARGET_LOCK_VALUE };
  await item.update({ "system.props.effect_table": newTable });
  log(`${label}: set target_lock=${TARGET_LOCK_VALUE} on pl_free_study row`);
  return true;
}

export async function migrate(game, log) {
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }
  const tplResult = await migrateTemplate(template, log);
  if (!tplResult.ok) return { applied: false, summary: tplResult.summary };

  let mastersAuthored = 0;
  let copiesAuthored = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    if (String(item.system?.template ?? "") !== TEMPLATE_ID) continue;
    if (await authorOnItem(item, `world master "${item.name}" [${item.id}]`, log)) mastersAuthored++;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      if (String(item.system?.template ?? "") !== TEMPLATE_ID) continue;
      if (await authorOnItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log)) copiesAuthored++;
    }
  }

  return {
    applied: true,
    summary: `${tplResult.summary}; ${mastersAuthored} master(s) + ${copiesAuthored} copies updated`
  };
}
