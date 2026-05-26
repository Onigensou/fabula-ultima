/**
 * Migration: 2026-05-27-skill-template-passive-columns
 * ---------------------------------------------------------------------------
 * Adds 5 new SKILL-LEVEL columns to the `_Skill Template`'s `skill_effects_panel`,
 * all gated visible only when `skill_type === "Passive"`. These power the
 * passive-trigger layer shipped with Spiritist Batch 4 (Healing Power,
 * Support Magic) and let GMs author new passive skills directly in the
 * CSB sheet without editing JSON.
 *
 *   - passive_trigger              (select)  — which pipeline event fires
 *                                              this passive. Today the
 *                                              engine honors "spell_complete";
 *                                              future triggers register
 *                                              their key here for forward
 *                                              compat.
 *   - passive_trigger_filter       (select)  — disposition gate on the
 *                                              trigger payload's targets.
 *                                              any / ally_targets /
 *                                              enemy_targets / self_only.
 *   - passive_condition_formula    (textField) — formula evaluated against
 *                                              the caster (e.g.
 *                                              "HAS_ARCANE_WEAPON").
 *                                              Must be truthy for the
 *                                              passive to fire.
 *   - passive_optional             (checkbox) — when true, the engine
 *                                              prompts the GM with an
 *                                              Apply/Skip dialog before
 *                                              firing (RAW "may" wording).
 *   - on_passive_trigger_effect_ref (textField) — effect_label inside the
 *                                              skill's effect_table to
 *                                              dispatch when the passive
 *                                              fires.
 *
 * IDEMPOTENT: scans the body for each column key; skips fields that
 * already exist. Safe to re-run.
 *
 * Anchor: appended to the END of `skill_effects_panel.contents`, after
 * the existing `passive_check_bonus_formula` / `passive_damage_bonus_formula`
 * fields (which the panel already declares for the Skill passive-modifier
 * legacy use case). The new fields are functionally adjacent: same panel,
 * same Passive-gate.
 */

export const key = "2026-05-27-skill-template-passive-columns";
export const description =
  "Add passive_trigger / passive_trigger_filter / passive_condition_formula / " +
  "passive_optional / on_passive_trigger_effect_ref columns to _Skill Template " +
  "for in-sheet authoring of passive skills.";

const SKILL_TEMPLATE_UUID = "Item.j0F5Msw5RZ8aIB3j";
const GATE_FORMULA = `equalText(skill_type, "Passive")`;

const COLS = [
  {
    key: "passive_trigger",
    colSpan: 1, rowSpan: 1,
    cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: 'When this passive fires. "spell_complete" — after the caster\'s spell finishes resolving. More triggers register as the engine grows.',
    visibilityFormula: GATE_FORMULA,
    type: "select",
    size: "full-size",
    label: "Passive Trigger",
    defaultValue: "",
    selectedOptionType: "custom",
    options: [
      { key: "",                 value: "(none — never fires)" },
      { key: "spell_complete",   value: "spell_complete — after caster's spell resolves" },
    ],
  },
  {
    key: "passive_trigger_filter",
    colSpan: 1, rowSpan: 1,
    cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: "Disposition filter on the trigger's targets. Only fires when at least one target matches.",
    visibilityFormula: GATE_FORMULA,
    type: "select",
    size: "full-size",
    label: "Trigger Filter",
    defaultValue: "any",
    selectedOptionType: "custom",
    options: [
      { key: "any",            value: "any — no filter" },
      { key: "ally_targets",   value: "ally_targets — at least one ally target" },
      { key: "enemy_targets",  value: "enemy_targets — at least one enemy target" },
      { key: "self_only",      value: "self_only — caster is among targets" },
    ],
  },
  {
    key: "passive_condition_formula",
    colSpan: 1, rowSpan: 1,
    cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: 'Formula evaluated against the caster; must be truthy for the passive to fire. Identifiers include HAS_ARCANE_WEAPON, HAS_MELEE_WEAPON, HAS_RANGED_WEAPON, BOND_COUNT, etc. Leave blank for no condition.',
    visibilityFormula: GATE_FORMULA,
    type: "textField",
    size: "full-size",
    label: "Condition Formula",
    defaultValue: "",
    charList: "", maxLength: null, autocomplete: "",
  },
  {
    key: "passive_optional",
    colSpan: 1, rowSpan: 1,
    cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: 'When true, the engine prompts the GM "Apply / Skip" before firing (matches RAW "may" wording). When false, the passive auto-fires whenever conditions match.',
    visibilityFormula: GATE_FORMULA,
    type: "checkbox",
    size: "full-size",
    label: "Optional (prompt GM)",
    defaultChecked: true,
  },
  {
    key: "on_passive_trigger_effect_ref",
    colSpan: 1, rowSpan: 1,
    cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: "effect_label of the row in this skill's effect_table to dispatch when the passive fires.",
    visibilityFormula: GATE_FORMULA,
    type: "textField",
    size: "full-size",
    label: "On-Trigger Effect Ref",
    defaultValue: "",
    charList: "", maxLength: null, autocomplete: "",
  },
];

function findInBody(body, key) {
  let found = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || found) return;
    if (Array.isArray(node)) { for (const c of node) walk(c); return; }
    if (node.key === key) { found = node; return; }
    for (const v of Object.values(node)) walk(v);
  };
  walk(body);
  return found;
}

function findSkillEffectsPanel(body) {
  let panel = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || panel) return;
    if (Array.isArray(node)) { for (const c of node) walk(c); return; }
    if (node.type === "panel" && node.key === "skill_effects_panel") { panel = node; return; }
    for (const v of Object.values(node)) walk(v);
  };
  walk(body);
  return panel;
}

export async function migrate(game, log) {
  const tpl = await fromUuid(SKILL_TEMPLATE_UUID);
  if (!tpl) {
    log(`skill template ${SKILL_TEMPLATE_UUID} not found — skipping`);
    return { applied: true, summary: "no template present" };
  }
  const body = foundry.utils.deepClone(tpl.system?.body ?? {});
  const panel = findSkillEffectsPanel(body);
  if (!panel || !Array.isArray(panel.contents)) {
    log(`skill_effects_panel not found in template body — bailing`);
    return { applied: true, summary: "anchor missing" };
  }

  const toAdd = COLS.filter((c) => !findInBody(body, c.key));
  if (!toAdd.length) {
    log("all passive columns already present");
    return { applied: true, summary: "already authored" };
  }

  panel.contents.push(...toAdd.map((c) => ({ ...c })));
  await tpl.update({ "system.body": body });
  log(`added ${toAdd.length} column(s): ${toAdd.map((c) => c.key).join(", ")}`);
  return { applied: true, summary: `${toAdd.length} columns added` };
}
