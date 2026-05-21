/**
 * Migration: 2026-05-20-effect-targeting-columns
 * ---------------------------------------------------------------------------
 * Unified-targeting refactor (Phase F) template surgery.
 *
 * Adds the new `targeting` effect_kind sub-columns + `target_ref` +
 * `destination_ref` to the `_Skill Template`'s effect_table rowLayout,
 * and REMOVES the deprecated per-kind targeting columns
 * (`grant_target`, `target_lock`, `target_select`).
 *
 * The actual SKILL DATA migration (rewriting Painful Lesson / Acceleration /
 * Heart of Darkness / etc. to use the new shape) is a separate migration —
 * this one only modifies the template's editor layout so the new columns
 * persist on save and the old ones are gone from the UI.
 *
 * IDEMPOTENT — each column add/remove is gated on observable state.
 *
 * SCOPE: `_Skill Template` (id `j0F5Msw5RZ8aIB3j`) only — the only template
 * hosting skill items with reaction/effect tables today.
 */

export const key = "2026-05-20-effect-targeting-columns";
export const description =
  "Skill template editor surgery: add unified targeting columns " +
  "(candidate_source / category / mode / count / auto_confirm_when_obvious / " +
  "skip_when_passive / iteration_mode / target_ref / destination_ref), " +
  "remove deprecated grant_target / target_lock / target_select.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

const VF_KIND_IS_TARGETING =
  "equalText(sameRow(\"effect_kind\",''), \"targeting\")";

const VF_KIND_IS_REDIRECT =
  "equalText(sameRow(\"effect_kind\",''), \"redirect_target\")";

// target_ref is required on the five kinds that act on tokens. Visible
// when effect_kind is one of {grant, apply_ae, consume_charge,
// open_action_menu, redirect_target}.
const VF_KIND_CONSUMES_TARGETS =
  "or(" +
    "or(" +
      "equalText(sameRow(\"effect_kind\",''), \"grant\")," +
      "equalText(sameRow(\"effect_kind\",''), \"apply_ae\")" +
    ")," +
    "or(" +
      "equalText(sameRow(\"effect_kind\",''), \"consume_charge\")," +
      "or(" +
        "equalText(sameRow(\"effect_kind\",''), \"open_action_menu\")," +
        "equalText(sameRow(\"effect_kind\",''), \"redirect_target\")" +
      ")" +
    ")" +
  ")";

// count column hidden when mode = all (count is meaningless then).
const VF_TARGETING_AND_COUNT_MEANINGFUL =
  "and(" +
    VF_KIND_IS_TARGETING + "," +
    "not(equalText(sameRow(\"mode\",''), \"all\"))" +
  ")";

// Three categories of removal:
//   - Legacy per-kind targeting: grant_target / target_lock / target_select.
//     Documented and superseded by the unified targeting system.
//   - Orphan stubs from a prior design iteration: ae_target / charge_target /
//     target_category / target_mode / target_count / target_source. None are
//     read by any runtime code (`grep` confirmed). They cluttered the editor
//     and shouldn't exist.
// `target_prompt` and its sub-fields are NOT removed — Heart of Darkness's
// visible-token picker still reads them. Removal happens when HoD is
// migrated to the new targeting system in a later step.
const COLUMNS_TO_REMOVE = [
  "grant_target",
  "target_lock",
  "target_select",
  "ae_target",
  "charge_target",
  "target_category",
  "target_mode",
  "target_count",
  "target_source"
];

function commonFields(spec) {
  return {
    key: spec.key,
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: spec.tooltip ?? "",
    visibilityFormula: spec.visibilityFormula ?? ""
  };
}

function selectColumn(spec) {
  return {
    ...commonFields(spec),
    type: "select",
    size: "full-size",
    label: "",
    defaultValue: spec.defaultValue ?? "",
    selectedOptionType: "custom",
    options: spec.options,
    align: "left",
    colName: spec.colName ?? spec.key,
    readonlyPredefined: false
  };
}

function numberColumn(spec) {
  return {
    ...commonFields(spec),
    type: "numberField",
    size: "full-size",
    label: "",
    defaultValue: spec.defaultValue ?? "",
    allowDecimal: false,
    minVal: "",
    maxVal: "",
    allowRelative: false,
    showControls: false,
    controlsStyle: "hover",
    controlsCustomIncrements: "",
    inputStyle: "text",
    align: "left",
    colName: spec.colName ?? spec.key,
    readonlyPredefined: false
  };
}

function checkboxColumn(spec) {
  return {
    ...commonFields(spec),
    type: "checkbox",
    size: "full-size",
    label: "",
    defaultChecked: spec.defaultChecked ?? false,
    align: "left",
    colName: spec.colName ?? spec.key,
    readonlyPredefined: false
  };
}

function textFieldColumn(spec) {
  return {
    ...commonFields(spec),
    type: "textField",
    size: "full-size",
    label: "",
    defaultValue: spec.defaultValue ?? "",
    charList: "",
    maxLength: null,
    autocomplete: "",
    align: "left",
    colName: spec.colName ?? spec.key,
    readonlyPredefined: false
  };
}

// Order matters for editor UX — group targeting-kind columns together,
// then ref columns at the end (read like consumer fields).
const COLUMNS_TO_ADD = [
  selectColumn({
    key: "candidate_source",
    tooltip:
      "Pre-filter the candidate pool. Combat = every combatant. Trigger Subject = " +
      "the creature the trigger is about. Trigger Actor = the acting creature " +
      "(attacker, applier). Action Targets = targets[] of the originating action " +
      "card. Self = reactor only.",
    visibilityFormula: VF_KIND_IS_TARGETING,
    defaultValue: "combat",
    options: [
      { key: "combat",          value: "Combat" },
      { key: "trigger_subject", value: "Trigger Subject" },
      { key: "trigger_actor",   value: "Trigger Actor" },
      { key: "action_targets",  value: "Action Targets" },
      { key: "self",            value: "Self" }
    ],
    colName: "Source"
  }),

  selectColumn({
    key: "category",
    tooltip:
      "Disposition filter applied after candidate_source. Ally = friendly + " +
      "neutral. Enemy = hostile + neutral. Creature = all. Blank = no filter.",
    visibilityFormula: VF_KIND_IS_TARGETING,
    defaultValue: "",
    options: [
      { key: "",         value: "—" },
      { key: "creature", value: "Creature" },
      { key: "ally",     value: "Ally" },
      { key: "enemy",    value: "Enemy" }
    ],
    colName: "Category"
  }),

  selectColumn({
    key: "mode",
    tooltip:
      "How many tokens to take from the filtered pool. Exact = pick count. " +
      "Up To = pick 0..count. All = take every eligible candidate, no picker.",
    visibilityFormula: VF_KIND_IS_TARGETING,
    defaultValue: "exact",
    options: [
      { key: "exact", value: "Exact (pick N)" },
      { key: "up_to", value: "Up To (pick 0..N)" },
      { key: "all",   value: "All (everyone eligible)" }
    ],
    colName: "Mode"
  }),

  numberColumn({
    key: "count",
    tooltip: "How many tokens to pick (exact) or up to how many (up_to).",
    visibilityFormula: VF_TARGETING_AND_COUNT_MEANINGFUL,
    defaultValue: "1",
    colName: "Count"
  }),

  checkboxColumn({
    key: "auto_confirm_when_obvious",
    tooltip:
      "If the filtered pool has exactly one eligible token, skip the picker — " +
      "use that token without a prompt.",
    visibilityFormula: VF_KIND_IS_TARGETING,
    defaultChecked: true,
    colName: "Auto-Confirm"
  }),

  checkboxColumn({
    key: "skip_when_passive",
    tooltip:
      "When the effect chain runs in a passive context, apply to the entire " +
      "eligible pool with no picker.",
    visibilityFormula: VF_KIND_IS_TARGETING,
    defaultChecked: true,
    colName: "Skip Passive"
  }),

  selectColumn({
    key: "iteration_mode",
    tooltip:
      "How consumers receive the resolved list. Together = full list once " +
      "(matches FU multi-target spell/attack semantics). Per-Token = re-invoke " +
      "each consumer once per token in the list.",
    visibilityFormula: VF_KIND_IS_TARGETING,
    defaultValue: "together",
    options: [
      { key: "together",  value: "Together (one list)" },
      { key: "per_token", value: "Per-Token (re-invoke)" }
    ],
    colName: "Iteration"
  }),

  textFieldColumn({
    key: "target_ref",
    tooltip:
      "effect_label of a targeting row in this same effect_table. The dispatcher " +
      "resolves it lazily and memoizes the result for the rest of the chain. " +
      "Required on grant / apply_ae / consume_charge / open_action_menu / " +
      "redirect_target.",
    visibilityFormula: VF_KIND_CONSUMES_TARGETS,
    defaultValue: "",
    colName: "Target Ref"
  }),

  textFieldColumn({
    key: "destination_ref",
    tooltip:
      "For redirect_target: effect_label of a targeting row resolving WHERE the " +
      "redirected action lands. Classic Protect uses a row with " +
      "candidate_source: 'self'. Cover-style skills point at an ally targeting row.",
    visibilityFormula: VF_KIND_IS_REDIRECT,
    defaultValue: "",
    colName: "Destination Ref"
  })
];

// Walk the template body's nested `contents` arrays looking for the
// compactDynamicTable with key === "effect_table". The prior-art
// migration's hardcoded index path is fragile if panels shift; recursive
// search survives reordering.
function findEffectTable(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "effect_table" && node.type === "compactDynamicTable") {
    return node;
  }
  const contents = Array.isArray(node.contents) ? node.contents : [];
  for (const child of contents) {
    const hit = findEffectTable(child);
    if (hit) return hit;
  }
  return null;
}

function rowLayoutOf(table) {
  return Array.isArray(table?.rowLayout) ? table.rowLayout : null;
}

async function migrateTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const table = findEffectTable({ contents: [sysClone.body] });
  if (!table) {
    log("effect_table compactDynamicTable not found in template body — aborting");
    return { ok: false, summary: "effect_table not found" };
  }
  const rows = rowLayoutOf(table);
  if (!rows) {
    log("effect_table has no rowLayout array — aborting");
    return { ok: false, summary: "rowLayout missing" };
  }

  let needsWrite = false;

  // Phase 1: remove deprecated columns. Filter in place to preserve any
  // unknown column ordering authors may have added.
  const before = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i] && COLUMNS_TO_REMOVE.includes(rows[i].key)) {
      log(`removing deprecated column "${rows[i].key}"`);
      rows.splice(i, 1);
      needsWrite = true;
    }
  }
  if (rows.length !== before) {
    log(`column count after removals: ${before} -> ${rows.length}`);
  }

  // Phase 2: add new columns at the end. Idempotent — skip if already
  // present by key.
  for (const newCol of COLUMNS_TO_ADD) {
    if (rows.some(r => r?.key === newCol.key)) continue;
    rows.push(newCol);
    log(`added column "${newCol.key}"`);
    needsWrite = true;
  }

  if (!needsWrite) {
    return { ok: true, summary: "template already migrated" };
  }

  // Per [feedback_no_dotted_array_updates] — write the full system block,
  // not a dotted-path patch into rowLayout.
  await template.update({ system: sysClone });
  return { ok: true, summary: `template updated (rowLayout columns: ${rows.length})` };
}

export async function migrate(game, log) {
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }
  const result = await migrateTemplate(template, log);
  if (!result.ok) {
    return { applied: false, summary: result.summary };
  }
  return { applied: true, summary: result.summary };
}
