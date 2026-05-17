/**
 * Migration: 2026-05-17-passive-bonus-formula-columns
 * ---------------------------------------------------------------------------
 * Phase E template surgery: add `passive_check_bonus_formula` and
 * `passive_damage_bonus_formula` columns to the `skill_effects_panel` on
 * the `_Skill Template`. These are formula-string text fields read by
 * the passive-modifier-engine (action phase) to apply count-based or
 * conditional check/damage bonuses without per-skill JS.
 *
 * Adversity is the worked example: "+1 check / +2 damage per status effect
 * suffered (cap +3 / +6, per Jan 2025 playtest)" becomes
 *   passive_check_bonus_formula:  "min(STATUS_COUNT, 3)"
 *   passive_damage_bonus_formula: "min(STATUS_COUNT * 2, 6)"
 *
 * Runtime read:
 *   modules/fabula-ultima-companion/scripts/passive-system/passive-modifier-engine.js
 *   modules/fabula-ultima-companion/scripts/reaction-system/formula-evaluator.js
 *
 * IDEMPOTENT: skips if either column already exists in skill_effects_panel.
 */

export const key = "2026-05-17-passive-bonus-formula-columns";
export const description =
  "Add passive_check_bonus_formula + passive_damage_bonus_formula columns " +
  "to the _Skill Template skill_effects_panel.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

const NEW_FORMULA_FIELDS = [
  {
    key: "passive_check_bonus_formula",
    label: "Passive Check Bonus Formula",
    tooltip:
      "Formula string (same grammar as grant_amount). Adds the result to " +
      "the actor's check accuracy on every action. Reads identifiers like " +
      "STATUS_COUNT, BOND_COUNT, SL. Example: \"min(STATUS_COUNT, 3)\" for " +
      "Adversity. Blank disables."
  },
  {
    key: "passive_damage_bonus_formula",
    label: "Passive Damage Bonus Formula",
    tooltip:
      "Formula string. Adds the result to the action's damage bonus on " +
      "every action. Same identifier set as passive_check_bonus_formula. " +
      "Example: \"min(STATUS_COUNT * 2, 6)\". Blank disables."
  }
];

function makeTextFieldComponent(spec) {
  return {
    key: spec.key,
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: spec.tooltip ?? "",
    visibilityFormula: "",
    type: "textField",
    size: "full-size",
    label: spec.label ?? spec.key,
    defaultValue: "",
    charList: "",
    maxLength: null,
    autocomplete: ""
  };
}

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

  const panel = tab.contents.find(c => c?.key === "skill_effects_panel");
  if (!panel || !Array.isArray(panel.contents)) {
    return {
      applied: false,
      summary: "skill_effects_panel missing — run 2026-05-17-skill-effects-panel-extract first"
    };
  }

  let added = 0;
  for (const spec of NEW_FORMULA_FIELDS) {
    if (panel.contents.some(c => c?.key === spec.key)) continue;
    panel.contents.push(makeTextFieldComponent(spec));
    added++;
    log(`added column ${spec.key} to skill_effects_panel`);
  }

  if (added === 0) {
    return { applied: true, summary: "all formula columns already present" };
  }

  await template.update({ system: sysClone });
  return { applied: true, summary: `added ${added} formula column(s)` };
}
