/**
 * Migration: 2026-05-21-high-speed-author
 * ---------------------------------------------------------------------------
 * Authors Zarg's "High Speed" skill in the unified-targeting + open_action_menu
 * shape. The current item has a `conflict_start` reaction row with an empty
 * `reaction_effect_ref` and no `effect_table` rows — so clicking the pill
 * does nothing today.
 *
 * After migration:
 *   - reaction_config_table row gets `reaction_effect_ref = "hs_free_action"`.
 *   - effect_table gets a single `hs_free_action` row:
 *       open_action_menu
 *         allowed_types:        "Attack,Hinder"
 *         free_mode:            true
 *         check_bonus_formula:  "SL"
 *     (No target_ref — High Speed doesn't lock onto a creature; the action
 *     menu's normal target picker handles target selection per-action.)
 *
 * NOT covered yet (per user direction):
 *   - The "spend 10 MP" gate (no consume_resource effect_kind exists).
 *     Skill fires freely until that's added.
 *   - RAW says the +SL bonus applies only to the Hinder/Objective branch,
 *     not Attack. Single open_action_menu can't conditionally bonus by
 *     button — this implementation applies +SL to both.
 *
 * IDEMPOTENT. Walks master + actor copies.
 */

export const key = "2026-05-21-high-speed-author";
export const description =
  "Author Zarg's High Speed in the unified shape: conflict_start row " +
  "references a new `hs_free_action` open_action_menu effect with " +
  "Attack+Hinder enabled and +SL check bonus.";

const MASTER_ID = "pGPOqWRyrAFLbHho";       // High Speed master
const EFFECT_LABEL = "hs_free_action";
const REACTION_TRIGGER = "conflict_start";

const NEW_EFFECT_ROW = {
  $deleted: false,
  effect_label: EFFECT_LABEL,
  effect_kind: "open_action_menu",
  allowed_types: "Attack,Hinder",
  free_mode: true,
  check_bonus_formula: "SL",
  damage_bonus_formula: ""
};

function tableToArray(tbl) {
  if (!tbl) return [];
  if (Array.isArray(tbl)) return tbl.slice();
  return Object.keys(tbl).map(k => tbl[k]);
}
function arrayToObjectTable(arr) {
  const out = {};
  arr.forEach((row, i) => { out[String(i)] = row; });
  return out;
}

async function migrateHighSpeedItem(item, log) {
  const matches = item.id === MASTER_ID || item.system?.uniqueId === MASTER_ID;
  if (!matches) return false;

  const props = item.system?.props ?? {};
  const rcRaw = props.reaction_config_table;
  const etRaw = props.effect_table;
  const rcRows = tableToArray(rcRaw);
  const etRows = tableToArray(etRaw);

  let modified = false;
  let patch = {};

  // 1. Add the effect row if missing.
  const hasEffect = etRows.some(r => r?.effect_label === EFFECT_LABEL);
  if (!hasEffect) {
    etRows.push({ ...NEW_EFFECT_ROW });
    patch["system.props.effect_table"] = arrayToObjectTable(etRows);
    modified = true;
  }

  // 2. Set reaction_effect_ref on the conflict_start row if missing.
  let triggerRowKey = null;
  const isArray = Array.isArray(rcRaw);
  const rcKeys = isArray ? rcRaw.map((_, i) => String(i)) : Object.keys(rcRaw ?? {});
  for (const k of rcKeys) {
    const r = isArray ? rcRaw[Number(k)] : rcRaw[k];
    if (r?.reaction_trigger === REACTION_TRIGGER && !r?.$deleted) {
      triggerRowKey = k;
      break;
    }
  }
  if (triggerRowKey != null) {
    const existing = isArray ? rcRaw[Number(triggerRowKey)] : rcRaw[triggerRowKey];
    if (existing?.reaction_effect_ref !== EFFECT_LABEL) {
      patch[`system.props.reaction_config_table.${triggerRowKey}.reaction_effect_ref`] = EFFECT_LABEL;
      modified = true;
    }
  } else {
    log(`High Speed "${item.name}" [${item.id}] has no conflict_start row — skipping the reference patch (effect_table still added if missing)`);
  }

  if (!modified) return false;

  await item.update(patch);
  log(`authored High Speed "${item.name}" [${item.id}] — effect row added=${!hasEffect}, ref set=${triggerRowKey != null}`);
  return true;
}

export async function migrate(game, log) {
  let count = 0;
  for (const item of game.items?.contents ?? []) {
    try { if (await migrateHighSpeedItem(item, log)) count++; }
    catch (e) { log(`master "${item.name}" [${item.id}] failed: ${e?.message ?? e}`); }
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      try { if (await migrateHighSpeedItem(item, log)) count++; }
      catch (e) { log(`actor "${actor.name}" item "${item.name}" failed: ${e?.message ?? e}`); }
    }
  }
  return {
    applied: true,
    summary: `High Speed authored on ${count} item${count === 1 ? "" : "s"}`
  };
}
