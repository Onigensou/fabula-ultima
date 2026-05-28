/**
 * Migration: 2026-05-28-passive-to-reaction-config
 * ---------------------------------------------------------------------------
 * Folds the standalone passive-trigger fields (passive_trigger,
 * passive_trigger_filter, passive_condition_formula, passive_mode,
 * on_passive_trigger_effect_ref, passive_optional) into a unified
 * `reaction_config_table` row with `reaction_isPassive: true`.
 *
 * Two parts:
 *
 *   1. SCHEMA — Adds 2 new columns + 1 new trigger option to the
 *      `reaction_config_table` rowLayout on each skill-shaped template
 *      (_Skill Template, _Skill Template (Copy), _Action Template):
 *        - reaction_passive_mode (select on/ask/off, visible when isPassive)
 *        - reaction_action_target (select ally/enemy/neutral, action target
 *          disposition filter)
 *        - New trigger option `creature_completes_spell` on reaction_trigger
 *
 *   2. DATA — For every Item master and every actor-borne Item copy:
 *      if `passive_trigger` is non-blank, synthesize the equivalent
 *      `reaction_config_table` row and clear the legacy fields. Migrates
 *      Spiritist's Healing Power + Support Magic (and any other authored
 *      skills using the same shape).
 *
 * IDEMPOTENT — both parts gate on observable state. Safe to re-run.
 */

import { log as moduleLog, warn as moduleWarn } from "../scripts/logger.js";

export const key = "2026-05-28-passive-to-reaction-config";
export const description =
  "Add reaction_passive_mode + reaction_action_target columns + " +
  "creature_completes_spell trigger to skill templates. Migrate " +
  "passive_trigger items to reaction_config_table rows.";

const SKILL_TEMPLATE_UUIDS = [
  "Item.j0F5Msw5RZ8aIB3j",   // _Skill Template
  "Item.Pif3bphWOo55e0hk",   // _Skill Template (Copy)
  "Item.se0MJ24EFYF4OiGf",   // _Action Template
];

const NEW_TRIGGER_OPTION = {
  key: "creature_completes_spell",
  value: "When a creature finishes casting a Spell",
};

const COL_REACTION_ACTION_TARGET = {
  key: "reaction_action_target",
  colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: 'Filter on the subject\'s action targets. "ally" matches when the action hit/targeted at least one creature with the subject\'s disposition (or neutral). "enemy" requires at least one opposed-disposition target. Blank disables.',
  visibilityFormula: "triggerHasSubject(sameRow(\"reaction_trigger\",''))",
  type: "select",
  size: "full-size",
  label: "",
  defaultValue: "",
  selectedOptionType: "custom",
  options: [
    { key: "",        value: "—" },
    { key: "ally",    value: "At least 1 ally target" },
    { key: "enemy",   value: "At least 1 enemy target" },
    { key: "neutral", value: "At least 1 neutral target" },
  ],
  align: "left",
  colName: "Action Target",
  readonlyPredefined: false,
};

const COL_REACTION_PASSIVE_MODE = {
  key: "reaction_passive_mode",
  colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: "Passive firing mode. 'on' = always fires when matched. 'ask' = GM gets Apply/Skip dialog (RAW 'may' wording). 'off' = disabled. Only relevant when Passive is checked.",
  visibilityFormula: "sameRow(\"reaction_isPassive\")",
  type: "select",
  size: "full-size",
  label: "",
  defaultValue: "ask",
  selectedOptionType: "custom",
  options: [
    { key: "on",  value: "On — always fires" },
    { key: "ask", value: "Ask — prompt GM" },
    { key: "off", value: "Off — disabled" },
  ],
  align: "left",
  colName: "Passive Mode",
  readonlyPredefined: false,
};

function findReactionConfigTable(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "reaction_config_table") return node;
  if (Array.isArray(node)) {
    for (const c of node) { const r = findReactionConfigTable(c); if (r) return r; }
    return null;
  }
  for (const k of Object.keys(node)) {
    const r = findReactionConfigTable(node[k]); if (r) return r;
  }
  return null;
}

// PART 1 — template surgery.
async function migrateTemplate(uuid, log) {
  const tpl = await fromUuid(uuid);
  if (!tpl) { log(`template ${uuid} not found — skipping`); return null; }
  const system = foundry.utils.deepClone(tpl.system ?? {});
  const rc = findReactionConfigTable(system);
  if (!rc) { log(`${tpl.name}: no reaction_config_table column found`); return null; }

  const layout = rc.rowLayout;
  let triggerAdded = false, actionTargetAdded = false, passiveModeAdded = false;

  // Trigger option.
  const trig = layout.find((c) => c.key === "reaction_trigger");
  if (trig?.options && !trig.options.some((o) => o.key === NEW_TRIGGER_OPTION.key)) {
    trig.options.push({ ...NEW_TRIGGER_OPTION });
    triggerAdded = true;
  }

  // reaction_action_target after reaction_action_intent.
  if (!layout.some((c) => c.key === COL_REACTION_ACTION_TARGET.key)) {
    const idx = layout.findIndex((c) => c.key === "reaction_action_intent");
    const insertAt = idx === -1 ? layout.length : idx + 1;
    layout.splice(insertAt, 0, foundry.utils.deepClone(COL_REACTION_ACTION_TARGET));
    actionTargetAdded = true;
  }

  // reaction_passive_mode after reaction_passive_target.
  if (!layout.some((c) => c.key === COL_REACTION_PASSIVE_MODE.key)) {
    const idx = layout.findIndex((c) => c.key === "reaction_passive_target");
    const insertAt = idx === -1 ? layout.length : idx + 1;
    layout.splice(insertAt, 0, foundry.utils.deepClone(COL_REACTION_PASSIVE_MODE));
    passiveModeAdded = true;
  }

  if (!triggerAdded && !actionTargetAdded && !passiveModeAdded) {
    log(`${tpl.name}: already migrated`);
    return null;
  }

  await tpl.update({ system });
  log(`${tpl.name}: trigger=${triggerAdded} actionTarget=${actionTargetAdded} passiveMode=${passiveModeAdded}`);
  return { triggerAdded, actionTargetAdded, passiveModeAdded };
}

// PART 2 — item data migration.
//
// Looks at an item's `system.props.passive_trigger`. If non-blank, builds
// an equivalent reaction_config_table row + clears the legacy fields.
// Returns true if the item was mutated.
function buildMigrationPatch(props) {
  const trigger = String(props?.passive_trigger ?? "").trim();
  if (!trigger) return null;

  // Old "spell_complete" string → new canonical trigger key.
  const newTrigger = (trigger === "spell_complete" || trigger === "creature_completes_spell")
    ? "creature_completes_spell"
    : trigger;
  const oldFilter = String(props?.passive_trigger_filter ?? "").trim().toLowerCase();
  let actionTarget = "";
  if (oldFilter === "ally_targets") actionTarget = "ally";
  else if (oldFilter === "enemy_targets") actionTarget = "enemy";
  const condition = String(props?.passive_condition_formula ?? "").trim();
  const explicitMode = String(props?.passive_mode ?? "").trim().toLowerCase();
  const mode = ["on", "ask", "off"].includes(explicitMode)
    ? explicitMode
    : (props?.passive_optional === false ? "on" : "ask");
  const effectRef = String(props?.on_passive_trigger_effect_ref ?? "").trim();

  const newRow = {
    reaction_trigger: newTrigger,
    reaction_source: "self",
    reaction_damage_source: "",
    reaction_damage_type: "",
    reaction_damage_amount: "",
    reaction_debuff_count_target: "",
    reaction_debuff_count_min: "",
    reaction_subject_kind: "",
    reaction_ownership: "",
    reaction_action_intent: "",
    reaction_action_target: actionTarget,
    reaction_effect_ref: effectRef,
    reaction_isPassive: true,
    reaction_passive_target: "self",
    reaction_passive_mode: mode,
    condition_formula: condition,
    requires_skill: "",
    $deleted: false,
  };

  const rc = (props.reaction_config_table && typeof props.reaction_config_table === "object")
    ? foundry.utils.deepClone(props.reaction_config_table)
    : {};

  // Idempotency: if a row with the same trigger+effect_ref+isPassive already
  // exists, don't add another. Just clear old fields below.
  let alreadyHasRow = false;
  for (const k of Object.keys(rc)) {
    const r = rc[k];
    if (r && !r.$deleted
        && r.reaction_trigger === newRow.reaction_trigger
        && r.reaction_effect_ref === newRow.reaction_effect_ref
        && r.reaction_isPassive === true) {
      alreadyHasRow = true;
      break;
    }
  }
  if (!alreadyHasRow) {
    let nextKey = 0;
    while (Object.prototype.hasOwnProperty.call(rc, String(nextKey))) nextKey++;
    rc[String(nextKey)] = newRow;
  }

  const patch = {
    "system.props.reaction_config_table": rc,
    "system.props.passive_trigger": "",
    "system.props.passive_trigger_filter": "",
    "system.props.passive_condition_formula": "",
    "system.props.passive_mode": "",
    "system.props.on_passive_trigger_effect_ref": "",
    "system.props.passive_optional": false,
  };
  return patch;
}

async function migrateMasters(game, log) {
  let updated = 0;
  const names = [];
  for (const item of (game.items?.contents ?? [])) {
    const patch = buildMigrationPatch(item.system?.props);
    if (!patch) continue;
    await item.update(patch);
    updated++;
    names.push(item.name);
  }
  if (updated) log(`migrated ${updated} master(s): ${names.join(", ")}`);
  return updated;
}

async function migrateActorCopies(game, log) {
  let updated = 0;
  const summary = new Map();
  for (const actor of (game.actors?.contents ?? [])) {
    for (const item of (actor.items?.contents ?? [])) {
      const patch = buildMigrationPatch(item.system?.props);
      if (!patch) continue;
      await item.update(patch);
      updated++;
      const list = summary.get(actor.name) ?? [];
      list.push(item.name);
      summary.set(actor.name, list);
    }
  }
  if (updated) {
    const parts = [...summary.entries()].map(([a, names]) => `${a}: ${names.join("/")}`);
    log(`migrated ${updated} actor copy(ies): ${parts.join(" | ")}`);
  }
  return updated;
}

export async function migrate(game, log) {
  // Part 1 — template schema.
  for (const uuid of SKILL_TEMPLATE_UUIDS) {
    try { await migrateTemplate(uuid, log); }
    catch (e) { moduleWarn("template migration threw for", uuid, e); }
  }

  // Part 2 — item data.
  const m = await migrateMasters(game, log);
  const a = await migrateActorCopies(game, log);

  return {
    applied: true,
    summary: `templates schema-augmented; ${m} master(s) + ${a} actor copy(ies) data-migrated`,
  };
}
