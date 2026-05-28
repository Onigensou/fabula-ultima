/**
 * Migration: 2026-05-29-vismagus-reaction-config
 * ---------------------------------------------------------------------------
 * Converts Vismagus from a hardcoded name-checked passive to a canonical
 * reaction_config_table + effect_table pair.
 *
 * Before (deprecated):
 *   system.props.vismagus_passive = true
 *   system.props.passive_mode      = "ask"
 *   (engine: state-handlers.js literally checked `it.name === "Vismagus"`
 *    and read these two fields directly)
 *
 * After (canonical):
 *   reaction_config_table["0"] = {
 *     reaction_trigger:    "caster_short_on_mp",
 *     reaction_source:     "self",
 *     reaction_isPassive:  true,
 *     reaction_passive_mode: "ask",
 *     reaction_effect_ref: "vismagus_swap"
 *   }
 *   effect_table["0"] = {
 *     effect_label:   "vismagus_swap",
 *     effect_kind:    "substitute_cost",
 *     from_resource:  "mp",
 *     to_resource:    "hp",
 *     multiplier:     2,
 *     min_remaining:  1
 *   }
 *   system.props.passive_mode      = ""           (cleared)
 *   system.props.vismagus_passive  = (removed)
 *   system.props.isReaction        = true         (was already true)
 *
 * Engine extensions shipping alongside:
 *   - new effect_kind `substitute_cost` in skill-effects.js
 *   - state-handlers.js TARGET cost gate now dispatches via
 *     `firePassiveTriggers` with trigger `caster_short_on_mp`. No
 *     skill-name hardcoding remains.
 *
 * BD-scoped per [[skill-authoring-canon]] rule 5 — only touches items
 * inside the Battle Director folder tree (master direct, actor copies
 * via system.uniqueId lookup).
 *
 * IDEMPOTENT: re-runs no-op when the reaction row + effect row are
 * already present and the deprecated fields are cleared.
 */

export const key = "2026-05-29-vismagus-reaction-config";
export const description =
  "Vismagus: replace vismagus_passive + props.passive_mode hardcoded " +
  "checks with reaction_config_table[caster_short_on_mp] + effect_table" +
  "[vismagus_swap] (substitute_cost mp→hp×2). Clears deprecated fields.";

const SKILL_NAME    = "Vismagus";
const BD_ROOT_NAME  = "Battle Director";

const REACTION_ROW = {
  reaction_trigger: "caster_short_on_mp",
  reaction_source: "self",
  reaction_damage_source: "",
  reaction_damage_type: "",
  reaction_damage_amount: "",
  reaction_debuff_count_target: "",
  reaction_debuff_count_min: "",
  reaction_subject_kind: "",
  reaction_ownership: "",
  reaction_action_intent: "",
  reaction_action_target: "",
  reaction_effect_ref: "vismagus_swap",
  reaction_isPassive: true,
  reaction_passive_target: "self",
  reaction_passive_mode: "ask",
  condition_formula: "",
  requires_skill: "",
  $deleted: false,
};

const EFFECT_ROW = {
  effect_label: "vismagus_swap",
  effect_kind: "substitute_cost",
  from_resource: "mp",
  to_resource: "hp",
  multiplier: 2,
  min_remaining: 1,
  target_ref: "self",
  $deleted: false,
};

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

function actorCopyIsBattleDirector(item, masterIndexByUniqueId) {
  const uid = String(item?.system?.uniqueId ?? "").trim();
  if (!uid) return false;
  const master = masterIndexByUniqueId.get(uid);
  if (!master) return false;
  return isInBattleDirectorTree(master);
}

function itemNeedsUpdate(item) {
  const p = item?.system?.props ?? {};
  const rc0 = p.reaction_config_table?.["0"] ?? null;
  const ef0 = p.effect_table?.["0"] ?? null;
  if (!rc0 || rc0.reaction_trigger !== "caster_short_on_mp") return true;
  if (!ef0 || ef0.effect_kind !== "substitute_cost") return true;
  if (p.vismagus_passive !== undefined) return true;
  if (p.passive_mode && ["on", "ask", "off"].includes(String(p.passive_mode).toLowerCase())) return true;
  return false;
}

async function applyPatch(item, ownerLabel, log) {
  if (!itemNeedsUpdate(item)) {
    log(`  ${ownerLabel} / "${item.name}": already canon`);
    return false;
  }
  const rc = foundry.utils.deepClone(item.system.props.reaction_config_table ?? {});
  rc["0"] = REACTION_ROW;
  const ef = foundry.utils.deepClone(item.system.props.effect_table ?? {});
  ef["0"] = EFFECT_ROW;
  try {
    await item.update({
      "system.props.reaction_config_table": rc,
      "system.props.effect_table": ef,
      "system.props.passive_mode": "",
      "system.props.-=vismagus_passive": null,
    });
    log(`  ${ownerLabel} / "${item.name}": canonized`);
    return true;
  } catch (e) {
    log(`  ${ownerLabel} / "${item.name}": update failed: ${e?.message ?? e}`);
    return false;
  }
}

export async function migrate(game, log) {
  let updated = 0;
  const masterIndexByUniqueId = new Map();
  for (const item of game.items?.contents ?? []) {
    const uid = String(item?.system?.uniqueId ?? "").trim();
    if (uid && !masterIndexByUniqueId.has(uid)) masterIndexByUniqueId.set(uid, item);
  }

  for (const item of game.items?.contents ?? []) {
    if (item.name !== SKILL_NAME) continue;
    if (!isInBattleDirectorTree(item)) {
      log(`  world / "${item.name}": skipped (not in BD tree)`);
      continue;
    }
    if (await applyPatch(item, "world", log)) updated += 1;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== SKILL_NAME) continue;
      if (!actorCopyIsBattleDirector(item, masterIndexByUniqueId)) {
        log(`  actor "${actor.name}" / "${item.name}": skipped (master not in BD tree)`);
        continue;
      }
      if (await applyPatch(item, `actor "${actor.name}"`, log)) updated += 1;
    }
  }

  return {
    applied: true,
    summary: `Vismagus canonized on ${updated} item(s)`,
  };
}
