/**
 * [ONI] Spec Canon Guard
 * ---------------------------------------------------------------------------
 * Shared validator for skill specs (CreateSkillFromSpec input shape OR a
 * full Item.create payload). Enforces the canon rules documented in
 * `docs/skill-authoring-canon.md`:
 *
 *   • No deprecated top-level props (passive_mode, post_damage_effect_ref,
 *     passive_check_bonus_formula, passive_damage_bonus).
 *   • No hardcoded class-flag passives (props.<x>_passive: true).
 *   • Spec carrying reaction_config_table rows OR AE-bound reactionConfig
 *     MUST set props.isReaction: true.
 *
 * USAGE — static analysis (synchronous, no Foundry deps):
 *
 *   import { validateSpecCanon } from "/modules/fabula-ultima-companion/scripts/lint/spec-canon-guard.js";
 *   const result = validateSpecCanon({ props, activeEffects });
 *   // → { ok: boolean, errors: string[] }
 *
 *   `props`   — the spec.props object (same shape as system.props).
 *   `activeEffects` — array of embedded AE docs (same shape as the spec's
 *                     `activeEffects` field). Optional.
 *
 *   Returns ok:false with `errors` listing every canon violation found.
 *
 * USAGE — from a macro (Foundry classic-script context):
 *
 *   const mod = await import("/modules/fabula-ultima-companion/scripts/lint/spec-canon-guard.js");
 *   const { ok, errors } = mod.validateSpecCanon({ props: spec.props, activeEffects: spec.activeEffects });
 *
 * USAGE — from a migration (ES module context):
 *
 *   import { validateSpecCanon } from "../scripts/lint/spec-canon-guard.js";
 *   const { ok, errors } = validateSpecCanon({ props: newDoc.system.props });
 *   if (!ok) throw new Error(`canon: ${errors.join("; ")}`);
 *
 * KEEP IN SYNC WITH
 *   • scripts/lint/reaction-config-lint.js  (DEPRECATED_* rules)
 *   • macros/Authoring/CreateSkillFromSpec.js (which now wraps this module)
 */

export const FORBIDDEN_TOP_LEVEL_PROPS = [
  {
    key: "passive_mode",
    message:
      "Mode lives on reaction_config_table[N].reaction_passive_mode. " +
      "Remove props.passive_mode from the spec.",
  },
  {
    key: "post_damage_effect_ref",
    message:
      "Author a reaction_config_table row with trigger " +
      "`creature_deals_damage` + source=self + effect_ref pointing " +
      "into effect_table. The top-level field is deprecated.",
  },
  {
    key: "passive_check_bonus_formula",
    message:
      "Author a reaction_config_table row with trigger " +
      "`creature_performs_check` + effect_kind=grant. The top-level " +
      "field is deprecated.",
  },
  {
    key: "passive_damage_bonus",
    message:
      "Author a reaction_config_table row with trigger " +
      "`creature_deals_damage` + effect_kind=grant. The top-level " +
      "field is deprecated.",
  },
];

function checkForbiddenTopLevel(props, errors) {
  for (const { key, message } of FORBIDDEN_TOP_LEVEL_PROPS) {
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      errors.push(`Forbidden top-level prop "${key}" — ${message}`);
    }
  }
}

function checkClassFlagPassives(props, errors) {
  for (const k of Object.keys(props)) {
    if (!k.endsWith("_passive")) continue;
    if (k === "isPassive") continue;
    if (props[k] !== true) continue;
    errors.push(
      `Forbidden top-level passive flag "${k}: true" — replace with a ` +
        `reaction_config_table row carrying the appropriate trigger + ` +
        `reaction_effect_ref. The engine should not gate on class-specific ` +
        `boolean props.`,
    );
  }
}

function hasMeaningfulRC(rcTable) {
  if (!rcTable || typeof rcTable !== "object") return false;
  return Object.values(rcTable).some(
    (r) => r && !r.$deleted && (r.reaction_trigger || r.reaction_effect_ref),
  );
}

function hasAEReactionConfig(activeEffects) {
  if (!Array.isArray(activeEffects)) return false;
  return activeEffects.some((ae) => {
    const cfg = ae?.flags?.["fabula-ultima-companion"]?.reactionConfig;
    if (!cfg) return false;
    return Object.values(cfg.reaction_config_table ?? {}).some(
      (r) => r && !r.$deleted && r.reaction_trigger,
    );
  });
}

function checkIsReactionFlag(props, activeEffects, errors) {
  const hasSpecRC = hasMeaningfulRC(props?.reaction_config_table);
  const hasAERC = hasAEReactionConfig(activeEffects);
  if (!hasSpecRC && !hasAERC) return;
  if (props?.isReaction === true) return;
  const whereParts = [];
  if (hasSpecRC) whereParts.push("on the skill");
  if (hasAERC) whereParts.push("on an embedded AE");
  errors.push(
    `Spec authors reaction_config_table rows ${whereParts.join(" AND ")} ` +
      `but props.isReaction is not true. Set props.isReaction: true so ` +
      `the CSB sheet shows the Reactions panel + the lint can verify ` +
      `the rest of the reaction shape.`,
  );
}

/**
 * Validate a skill spec against the authoring canon.
 *
 * @param {object} args
 * @param {object} args.props          — spec.props (same shape as system.props)
 * @param {Array}  [args.activeEffects] — embedded AE docs (spec.activeEffects)
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSpecCanon({ props, activeEffects } = {}) {
  const errors = [];
  const p = props ?? {};
  checkForbiddenTopLevel(p, errors);
  checkClassFlagPassives(p, errors);
  checkIsReactionFlag(p, activeEffects, errors);
  return { ok: errors.length === 0, errors };
}

// Globally exposed for ad-hoc use from the console / macros that prefer
// not to dynamic-import.
if (typeof globalThis !== "undefined") {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint ?? {};
  globalThis.FUCompanion.api.lint.validateSpecCanon = validateSpecCanon;
}
