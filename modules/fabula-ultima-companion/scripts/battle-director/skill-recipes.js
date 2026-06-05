// Skill recipes — authoring sugar for the most common skill patterns.
//
// THE PROBLEM the declarative engine has (per the user design discussion):
//   - The simplest "drain MP" skill needs 3 effect_table rows: a grant,
//     a targeting row, plus the `post_damage_effect_ref` prop pointing
//     at the grant.
//   - "Heal an ally" needs the same shape.
//   - Authors get lost in the indirection.
//
// THE SUGAR — recipes:
//   The skill carries 3-4 slim props (`recipe`, `recipe_resource`,
//   `recipe_amount`, `recipe_target`). At action time, this file
//   synthesizes the equivalent effect_table rows + fire-point ref so
//   the dispatcher sees a fully canonical skill.
//
// B.1 recipes:
//   - "drain"        — after damage, recover a resource on the caster
//                      (or other target). Wires `post_damage_effect_ref`.
//   - "heal_target"  — on activate, grant resource to the skill's
//                      targets. Wires `on_activate_effect_ref`.
//   - "self_grant"   — on activate, grant resource to the caster.
//                      Wires `on_activate_effect_ref`.
//
// Both `recipe_target` and `recipe_amount` accept the same reserved-
// word/formula sugar as the canonical schema:
//   - recipe_target: "self" | "action_targets" | <label>
//   - recipe_amount: literal number OR formula string ("MP_DEALT / 2",
//                    "SL * 2", "HR + 15", etc.)
//
// Explicit `effect_table` ALWAYS wins — recipes are a fallback that
// activates only when no effect_table row carries the relevant fire-
// point label. Authors can write a recipe AND override individual rows.

import { log, warn } from "./logger.js";

// Default target per recipe (when `recipe_target` is blank).
const RECIPE_DEFAULT_TARGET = {
  drain:       "self",
  heal_target: "action_targets",
  self_grant:  "self",
};

// Which fire-point each recipe wires up.
const RECIPE_FIRE_POINT = {
  drain:       "post_damage_effect_ref",
  heal_target: "on_activate_effect_ref",
  self_grant:  "on_activate_effect_ref",
};

// The synthesized grant row's stable label (used by the fire-point
// pointer). Suffixed by the recipe to avoid clashes when the same skill
// happens to carry both a recipe and a hand-authored effect_table row
// with the same label.
function recipeLabel(recipe) { return `__recipe_${recipe}__`; }

// Public — does this skill use a recipe? Returns the recipe key or null.
export function readRecipe(skill) {
  const recipe = String(skill?.system?.props?.recipe ?? "").trim().toLowerCase();
  if (!recipe) return null;
  if (!Object.prototype.hasOwnProperty.call(RECIPE_DEFAULT_TARGET, recipe)) {
    warn(`skill-recipes: unknown recipe "${recipe}"; skipping expansion`);
    return null;
  }
  return recipe;
}

// Public — build a synthetic runtime view that overlays recipe-generated
// rows + fire-point refs onto the skill. Caller should read effects /
// fire-points from this view, not from `skill.system.props.*` directly.
//
// Returns the original skill if no recipe (cheap fast-path).
export function getRuntimeSkillView(skill) {
  const recipe = readRecipe(skill);
  if (!recipe) return { skill, effect_table: skill?.system?.props?.effect_table ?? null,
                        fire_points: readFirePointsFromSkill(skill), recipeApplied: null };

  const p = skill.system?.props ?? {};
  const resource = String(p.recipe_resource ?? "").trim().toLowerCase();
  const amount   = p.recipe_amount ?? "";
  const target   = String(p.recipe_target ?? "").trim() || RECIPE_DEFAULT_TARGET[recipe];

  if (!resource) {
    warn(`skill-recipes: recipe "${recipe}" on ${skill.name} missing recipe_resource; recipe inert`);
    return { skill, effect_table: p.effect_table ?? null, fire_points: readFirePointsFromSkill(skill), recipeApplied: null };
  }
  if (amount === "" || amount == null) {
    warn(`skill-recipes: recipe "${recipe}" on ${skill.name} missing recipe_amount; recipe inert`);
    return { skill, effect_table: p.effect_table ?? null, fire_points: readFirePointsFromSkill(skill), recipeApplied: null };
  }

  // Build the synthesized grant row. Its label is stable per recipe so
  // multiple invocations look up the same row from skill-effects.findEffectRow.
  const label = recipeLabel(recipe);
  const grantRow = {
    effect_label: label,
    effect_kind:  "grant",
    grant_resource: resource,
    grant_amount:   amount,
    target_ref:     target,    // reserved string ("self", "action_targets") works via inline-ref sugar in skill-targeting.js
  };

  // Merge with author-provided effect_table — author rows ALWAYS win
  // (if a row has effect_label === recipeLabel(...), use the author's).
  const authoredTable = p.effect_table ?? p.reaction_effect_table ?? null;
  const mergedTable = { ...(authoredTable ?? {}) };
  let alreadyAuthored = false;
  for (const key of Object.keys(mergedTable)) {
    const row = mergedTable[key];
    if (row?.effect_label === label && !row.$deleted) { alreadyAuthored = true; break; }
  }
  if (!alreadyAuthored) {
    // Pick an unused key (CSB tables use stringified small integers).
    let nextKey = 0;
    while (Object.prototype.hasOwnProperty.call(mergedTable, String(nextKey))) nextKey++;
    mergedTable[String(nextKey)] = grantRow;
  }

  // Wire the fire-point — author's explicit fire-point ALWAYS wins.
  const firePointKey = RECIPE_FIRE_POINT[recipe];
  const authorFirePoint = String(p[firePointKey] ?? "").trim();
  const fire_points = readFirePointsFromSkill(skill);
  if (!authorFirePoint) fire_points[firePointKey] = label;

  log(`skill-recipes: expanded "${recipe}" on ${skill.name} → grant ${resource} ${amount} → ${target} (fire: ${firePointKey})`);

  // Return a view that overlays the synthesized table + fire-points.
  // The view shape mirrors what skill-effects expects from the skill:
  // `view.skill` is the original Item (for actor lookups, AE template
  // resolution, etc.); `view.effect_table` is the merged table;
  // `view.fire_points` is the merged fire-point dict.
  return {
    skill,
    effect_table: mergedTable,
    fire_points,
    recipeApplied: recipe,
  };
}

function readFirePointsFromSkill(skill) {
  const p = skill?.system?.props ?? {};
  return {
    on_activate_effect_ref: String(p.on_activate_effect_ref ?? "").trim(),
    post_damage_effect_ref: String(p.post_damage_effect_ref ?? "").trim(),
  };
}

// ── Unified runtime view (resolveAction-unification) ──────────────────────
//
// `getRuntimeActionView(source)` generalizes `getRuntimeSkillView` so EVERY
// turn action reads through one path: an Item → a uniform view. It is a strict
// superset of the skill view — the existing `{ skill, effect_table, fire_points,
// recipeApplied }` fields are preserved verbatim (so the Skill/Spell resolve
// path is byte-identical), plus action-level metadata the unified resolver +
// COMPUTE consult: `source`, `kind`, `check_mode`, `roll_atrs`,
// `defense_target_type`, `skill_target`, `picker`, `cost`.
//
// `kind` classification (from the Item's props):
//   - item_type === "weapon"            → "Attack"
//   - skill_type === "spell"            → "Spell"
//   - action_command set (Common items) → that command's action kind
//   - otherwise                         → "Skill"
//
// `check_mode` precedence: an explicit `props.check_mode` wins; else derived —
// a rolled skill/spell/attack is "opposed", a no-Check skill is "none".
export function getRuntimeActionView(source, ctx = {}) {
  const base = getRuntimeSkillView(source);   // { skill, effect_table, fire_points, recipeApplied }
  const p = source?.system?.props ?? {};

  const itemType = String(p.item_type ?? "").trim().toLowerCase();
  const skillType = String(p.skill_type ?? "").trim().toLowerCase();
  const actionCommand = String(p.action_command ?? "").trim().toLowerCase();

  // Command → action kind for the Battle Director / Common singleton items.
  const COMMAND_KIND = {
    guard: "Guard", hinder: "Hinder", study: "Study",
    equipment: "Equipment", item: "Item",
  };

  let kind;
  if (actionCommand && COMMAND_KIND[actionCommand]) kind = COMMAND_KIND[actionCommand];
  else if (itemType === "weapon") kind = "Attack";
  else if (skillType === "spell") kind = "Spell";
  else kind = "Skill";

  const isCheck = p.isCheck === true || String(p.isCheck) === "true";
  const explicitMode = String(p.check_mode ?? "").trim().toLowerCase();
  const check_mode = explicitMode
    || (kind === "Attack" ? "opposed"
        : isCheck ? "opposed"
        : "none");

  return {
    ...base,
    source,
    kind,
    check_mode,
    roll_atrs: { A1: p.rolled_atr1 ?? null, A2: p.rolled_atr2 ?? null },
    defense_target_type: String(p.defense_target_type ?? p.target_defense ?? "").trim().toLowerCase() || null,
    skill_target: String(p.skill_target ?? "").trim(),
    picker: String(p.picker ?? "").trim().toLowerCase() || null,
    check_difficulty_level: Number(p.check_difficulty_level ?? 0) || 0,
  };
}
