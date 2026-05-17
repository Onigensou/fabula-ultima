/**
 * Migration: 2026-05-17-painful-lesson-master-author
 * ---------------------------------------------------------------------------
 * Authors Painful Lesson declaratively on the world master + actor copies.
 *
 * Rule (Core p. 234):
 *   "After another creature causes you to lose Hit Points, you may immediately
 *    perform the Study action on that creature for free. If you do, gain a
 *    bonus equal to SL to your Check."
 *
 * Declarative wiring:
 *   isReaction: true
 *   reaction_config_table[0] = {
 *     reaction_trigger:        "creature_takes_damage",
 *     reaction_source:         "self",
 *     reaction_damage_source:  "enemy",
 *     reaction_action_intent:  "harmful",
 *     reaction_effect_ref:     "pl_free_study",
 *     reaction_isPassive:      false
 *   }
 *   effect_table[0] = {
 *     effect_label:         "pl_free_study",
 *     effect_kind:          "open_action_menu",
 *     allowed_types:        "Study",
 *     free_mode:            true,
 *     check_bonus_formula:  "SL"
 *   }
 *
 * Runs AFTER `2026-05-17-painful-lesson-columns` so the new template columns
 * exist; writes against `_Skill Template`-linked items only.
 *
 * IDEMPOTENT: deep-equal check on canonical state.
 */

export const key = "2026-05-17-painful-lesson-master-author";
export const description =
  "Author Painful Lesson declaratively on world master + actor copies " +
  "(creature_takes_damage from enemy → free Study with +SL bonus).";

const ITEM_NAME = "Painful Lesson";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const TARGET_TRIGGER_ROW = Object.freeze({
  $deleted: false,
  reaction_trigger:       "creature_takes_damage",
  reaction_source:        "self",
  reaction_damage_source: "enemy",
  reaction_action_intent: "harmful",
  reaction_effect_ref:    "pl_free_study",
  reaction_isPassive:     false
});

const TARGET_EFFECT_ROW = Object.freeze({
  $deleted: false,
  effect_label:        "pl_free_study",
  effect_kind:         "open_action_menu",
  allowed_types:       "Study",
  free_mode:           true,
  check_bonus_formula: "SL"
});

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const subset = (row, keys) => Object.fromEntries(keys.map(k => [k, row?.[k]]));
const deepEqualSubset = (a, b, keys) =>
  stableStringify(subset(a, keys)) === stableStringify(subset(b, keys));

function findReactionRow(table) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && r.reaction_trigger === "creature_takes_damage"
        && r.reaction_effect_ref === "pl_free_study") {
      return { key: k, row: r };
    }
  }
  return null;
}

function findEffectRow(table) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && r.effect_label === "pl_free_study") return { key: k, row: r };
  }
  return null;
}

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

async function authorOnItem(item, label, log) {
  const props = item.system?.props ?? {};
  const isReaction = props.isReaction === true;
  const triggerTable = props.reaction_config_table ?? {};
  const effectTable  = props.effect_table ?? {};

  const triggerKeys = Object.keys(TARGET_TRIGGER_ROW).filter(k => k !== "$deleted");
  const effectKeys  = Object.keys(TARGET_EFFECT_ROW).filter(k => k !== "$deleted");

  const existingTrig = findReactionRow(triggerTable);
  const existingEff  = findEffectRow(effectTable);

  const trigOk = !!existingTrig && deepEqualSubset(existingTrig.row, TARGET_TRIGGER_ROW, triggerKeys);
  const effOk  = !!existingEff  && deepEqualSubset(existingEff.row,  TARGET_EFFECT_ROW,  effectKeys);

  if (isReaction && trigOk && effOk) {
    log(`${label}: already authored`);
    return false;
  }

  const newTriggerTable = foundry.utils.duplicate(
    typeof triggerTable === "object" && triggerTable ? triggerTable : {}
  );
  if (existingTrig) {
    newTriggerTable[existingTrig.key] = { ...TARGET_TRIGGER_ROW };
  } else {
    let i = 0;
    while (Object.prototype.hasOwnProperty.call(newTriggerTable, String(i))) i++;
    newTriggerTable[String(i)] = { ...TARGET_TRIGGER_ROW };
  }

  const newEffectTable = foundry.utils.duplicate(
    typeof effectTable === "object" && effectTable ? effectTable : {}
  );
  if (existingEff) {
    newEffectTable[existingEff.key] = { ...TARGET_EFFECT_ROW };
  } else {
    let i = 0;
    while (Object.prototype.hasOwnProperty.call(newEffectTable, String(i))) i++;
    newEffectTable[String(i)] = { ...TARGET_EFFECT_ROW };
  }

  await item.update({
    "system.props.isReaction": true,
    "system.props.reaction_config_table": newTriggerTable,
    "system.props.effect_table": newEffectTable
  });
  log(
    `${label}: authored (` +
    [
      !isReaction && "isReaction",
      !trigOk     && "trigger row",
      !effOk      && "effect row"
    ].filter(Boolean).join(", ") +
    ")"
  );
  return true;
}

export async function migrate(game, log) {
  let mastersAuthored = 0;
  let mastersSkipped  = 0;
  let copiesAuthored  = 0;
  let copiesSkipped   = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    if (!templateMatches(item)) {
      log(`world master "${item.name}" [${item.id}]: skipped — template ${item.system?.template} is not _Skill Template`);
      mastersSkipped++;
      continue;
    }
    if (await authorOnItem(item, `world master "${item.name}" [${item.id}]`, log)) mastersAuthored++;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      if (!templateMatches(item)) {
        log(`actor "${actor.name}" item "${item.name}" [${item.id}]: skipped — template ${item.system?.template} is not _Skill Template`);
        copiesSkipped++;
        continue;
      }
      if (await authorOnItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log)) copiesAuthored++;
    }
  }

  return {
    applied: true,
    summary:
      `${mastersAuthored} master${mastersAuthored === 1 ? "" : "s"} authored ` +
      `(${mastersSkipped} skipped), ` +
      `${copiesAuthored} copies authored (${copiesSkipped} skipped)`
  };
}
