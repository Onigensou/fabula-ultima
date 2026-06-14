/**
 * Migration: 2026-06-14-skill-template-pre-activate-fire-point
 * ---------------------------------------------------------------------------
 * Add a `pre_activate_effect_ref` text column to the CSB `_Skill Template`
 * (id j0F5Msw5RZ8aIB3j), mirroring `on_activate_effect_ref`.
 *
 * CSB strips any `system.props.*` whose key isn't a declared template column,
 * so this column must exist before skills can carry a pre_activate hook.
 *
 * The pre_activate chain fires in CAPTURE mode at skill COMPUTE — BEFORE the
 * action card is built — so the player's choices (prompt_element / open_action_
 * menu) are gathered up front, the card reflects them, and RESOLVE replays them
 * with no mid-resolve prompt (the cast animation flows straight into damage).
 * Runtime: fireActivationEffectPre (skill-effects.js) + the COMPUTE capture /
 * RESOLVE replay wiring (state-handlers.js).
 *
 * IDEMPOTENT: no-op if the column already exists.
 */

export const key = "2026-06-14-skill-template-pre-activate-fire-point";
export const description =
  "CSB template surgery: add pre_activate_effect_ref text column to _Skill Template " +
  "(pre-card capture fire-point).";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const FIELD = {
  key: "pre_activate_effect_ref",
  label: "Pre-Activate Effect Ref",
  tooltip:
    "An effect_label from the table above. Fires in CAPTURE mode at COMPUTE — BEFORE the action card is built — so choice rows (prompt_element / open_action_menu) gather the player's picks up front; they're replayed at RESOLVE with no re-prompt.",
};

function makeTextFieldComponent(spec) {
  return {
    key: spec.key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: spec.tooltip ?? "", visibilityFormula: "",
    type: "textField", size: "full-size", label: spec.label ?? spec.key,
    defaultValue: "", charList: "", maxLength: null, autocomplete: "",
  };
}

// Find the panel (container) that holds the skill fire-point columns by
// locating the one whose direct children include `on_activate_effect_ref` —
// robust to panel renames (reaction_config_panel → skill_effects_panel) and
// layout moves.
function findFirePointPanel(sys) {
  let found = null;
  const walk = (node) => {
    if (found || !node || typeof node !== "object") return;
    const kids = node.contents;
    if (Array.isArray(kids)) {
      if (kids.some((c) => c?.key === "on_activate_effect_ref")) { found = node; return; }
      for (const k of kids) walk(k);
    }
  };
  walk(sys?.body);
  return found;
}

export async function migrate(game, log = () => {}) {
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }
  const sysClone = foundry.utils.duplicate(template.system);
  const panel = findFirePointPanel(sysClone);
  if (!panel) {
    return { applied: false, summary: "fire-point panel (with on_activate_effect_ref) not found" };
  }
  const contents = Array.isArray(panel.contents) ? panel.contents : [];
  if (contents.some((c) => c?.key === FIELD.key)) {
    return { applied: true, summary: "pre_activate_effect_ref column already present" };
  }
  contents.push(makeTextFieldComponent(FIELD));
  // Bump the template version so CSB re-syncs items against the new column list
  // (items whose stamp no longer matches recompile on next render). Without this
  // the compiled-template prop gate can strip a freshly-set pre_activate_effect_ref.
  const curVer = Number(sysClone.templateSystemUniqueVersion) || 0;
  sysClone.templateSystemUniqueVersion = curVer + 1;
  await template.update({ system: sysClone });
  log(`added column ${FIELD.key} to _Skill Template (version → ${curVer + 1})`);
  return { applied: true, summary: "added pre_activate_effect_ref column" };
}
