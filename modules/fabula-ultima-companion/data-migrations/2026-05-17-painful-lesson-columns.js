/**
 * Migration: 2026-05-17-painful-lesson-columns
 * ---------------------------------------------------------------------------
 * Phase F template surgery:
 *   1. Add `reaction_damage_source` column to `reaction_config_table`.
 *      Universal filter that matches the *acting creature's* disposition
 *      relative to the reactor — orthogonal to `reaction_source` (which
 *      matches the *subject* / target). Used by Painful Lesson:
 *      "After another creature [enemy] causes you to lose HP".
 *
 *   2. Add 5 columns to `effect_table` for the `open_action_menu` effect_kind:
 *        allowed_types          — comma-separated TurnUI button labels
 *        free_mode              — checkbox; register a free-action grant
 *        max_mp_cost            — number; per-spell MP cap
 *        check_bonus_formula    — formula string; resolved at apply time,
 *                                 added to next action's check (e.g. SL)
 *        damage_bonus_formula   — formula string; same for damage
 *
 *      Without these declared columns, CSB silently strips the writes on
 *      save (see [[csb-template-gating]]). The AE-borne reaction editor
 *      (ActiveEffectManager-reaction-ui.js) already supports these fields
 *      via its standalone editor — this migration brings parity to skill
 *      items.
 *
 * IDEMPOTENT: each column added only if absent.
 */

export const key = "2026-05-17-painful-lesson-columns";
export const description =
  "Template surgery: add reaction_damage_source + open_action_menu columns " +
  "(allowed_types, free_mode, max_mp_cost, check_bonus_formula, damage_bonus_formula) " +
  "to the _Skill Template.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

// --- reaction_config_table additions ---------------------------------------

const REACTION_DAMAGE_SOURCE_COL = {
  key: "reaction_damage_source",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip:
    "Filter the trigger's *acting creature* (attacker / applier / healer) by " +
    "disposition relative to the reactor. Independent of Source (which filters " +
    "the *subject*). Blank = inert.",
  visibilityFormula: "triggerHasSubject(sameRow(\"reaction_trigger\",''))",
  type: "select",
  size: "full-size",
  label: "",
  defaultValue: "",
  selectedOptionType: "custom",
  options: [
    { key: "self",    value: "Self" },
    { key: "ally",    value: "Ally" },
    { key: "enemy",   value: "Enemy" },
    { key: "neutral", value: "Neutral" },
    { key: "all",     value: "All" }
  ],
  align: "left",
  colName: "Damage Source",
  readonlyPredefined: false
};

// --- effect_table additions (all gated to effect_kind == "open_action_menu") --

function textFieldCol(key, label, tooltip) {
  return {
    key,
    colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip,
    visibilityFormula: `equalText(sameRow("effect_kind",''), "open_action_menu")`,
    type: "textField",
    size: "full-size",
    label: "",
    defaultValue: "",
    autocomplete: "",
    align: "left",
    colName: label,
    readonlyPredefined: false
  };
}

const ALLOWED_TYPES_COL = textFieldCol(
  "allowed_types",
  "Allowed Types",
  "Comma-separated TurnUI button labels (Attack, Spell, Study, etc.). Other buttons render disabled."
);

const FREE_MODE_COL = {
  key: "free_mode",
  colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: "Register a pending free-action grant so the next action bypasses the budget gate.",
  visibilityFormula: `equalText(sameRow("effect_kind",''), "open_action_menu")`,
  type: "checkbox",
  size: "full-size",
  label: "",
  defaultChecked: false,
  align: "left",
  colName: "Free Mode",
  readonlyPredefined: false
};

const MAX_MP_COST_COL = {
  key: "max_mp_cost",
  colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: "Optional cap on the MP cost of a Spell selectable through the free action. Blank = no cap.",
  visibilityFormula: `equalText(sameRow("effect_kind",''), "open_action_menu")`,
  type: "numberField",
  size: "full-size",
  label: "",
  defaultValue: "",
  allowDecimal: false,
  minVal: "0",
  maxVal: "",
  allowRelative: false,
  showControls: false,
  controlsStyle: "hover",
  controlsCustomIncrements: "",
  inputStyle: "text",
  align: "left",
  colName: "Max MP",
  readonlyPredefined: false
};

const CHECK_BONUS_FORMULA_COL = textFieldCol(
  "check_bonus_formula",
  "Check Bonus",
  "Formula string (same grammar as grant_amount, e.g. \"SL\"). Resolved at " +
  "apply time; added to the next action's check. Painful Lesson: \"SL\"."
);

const DAMAGE_BONUS_FORMULA_COL = textFieldCol(
  "damage_bonus_formula",
  "Damage Bonus",
  "Formula string. Resolved at apply time; added to the next action's damage."
);

const NEW_EFFECT_COLS = [
  ALLOWED_TYPES_COL,
  FREE_MODE_COL,
  MAX_MP_COST_COL,
  CHECK_BONUS_FORMULA_COL,
  DAMAGE_BONUS_FORMULA_COL
];

// --- migration entry --------------------------------------------------------

export async function migrate(game, log) {
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }

  const sysClone = foundry.utils.duplicate(template.system);
  const tab = sysClone?.body?.contents?.[0]?.contents?.[0];
  if (!tab || tab.type !== "tab" || !Array.isArray(tab.contents)) {
    return { applied: false, summary: "unexpected tab shape at body.contents[0].contents[0]" };
  }

  const rcp = tab.contents.find(c => c?.key === "reaction_config_panel");
  const sep = tab.contents.find(c => c?.key === "skill_effects_panel");
  if (!rcp || !sep) {
    return { applied: false, summary: "reaction_config_panel or skill_effects_panel missing" };
  }

  const rct = rcp.contents?.find(c => c?.key === "reaction_config_table");
  const eft = sep.contents?.find(c => c?.key === "effect_table");
  if (!rct || !Array.isArray(rct.rowLayout)) {
    return { applied: false, summary: "reaction_config_table or its rowLayout missing" };
  }
  if (!eft || !Array.isArray(eft.rowLayout)) {
    return { applied: false, summary: "effect_table or its rowLayout missing" };
  }

  let added = 0;

  // Step 1: insert reaction_damage_source RIGHT AFTER reaction_source so it
  // renders adjacent to its sibling filter.
  if (!rct.rowLayout.some(c => c?.key === "reaction_damage_source")) {
    const srcIdx = rct.rowLayout.findIndex(c => c?.key === "reaction_source");
    const insertAt = srcIdx >= 0 ? srcIdx + 1 : rct.rowLayout.length;
    rct.rowLayout.splice(insertAt, 0, REACTION_DAMAGE_SOURCE_COL);
    log("added column reaction_damage_source to reaction_config_table");
    added++;
  }

  // Step 2: append open_action_menu columns to effect_table.
  for (const col of NEW_EFFECT_COLS) {
    if (eft.rowLayout.some(c => c?.key === col.key)) continue;
    eft.rowLayout.push(col);
    log(`added column ${col.key} to effect_table`);
    added++;
  }

  if (added === 0) {
    return { applied: true, summary: "all columns already present" };
  }

  await template.update({ system: sysClone });
  return { applied: true, summary: `added ${added} column(s)` };
}
