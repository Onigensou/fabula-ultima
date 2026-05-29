/**
 * Migration: 2026-05-30-skill-effects-panel-strip-deprecated
 * ---------------------------------------------------------------------------
 * Template surgery: removes nine deprecated columns from the
 * _Skill Template's skill_effects_panel, leaving only the canonical
 * `effect_table` (the declarative panel) and `on_activate_effect_ref`
 * (the single fire-point the canon endorses).
 *
 * Why: per [[skill-canon-hardening]] / [[skill-authoring-canon]] the
 * Skill Effects panel should expose only `On-Activate Effect Ref`.
 * Everything else — post-damage refs, passive bonus formulas, passive
 * trigger selects, top-level passive_mode, etc. — has been replaced
 * by `reaction_config_table` rows + `effect_table` rows (the canonical
 * declarative pipeline). The fields stuck around because removing
 * them required a template surgery + engine-read cleanup; this
 * migration does the surgery half. The engine reads are dropped in
 * the accompanying commit.
 *
 * Columns dropped:
 *   • post_damage_effect_ref
 *   • passive_check_bonus_formula
 *   • passive_damage_bonus_formula
 *   • passive_trigger
 *   • passive_trigger_filter
 *   • passive_condition_formula
 *   • passive_mode               (canonical home: reaction_passive_mode)
 *   • on_passive_trigger_effect_ref
 *   • passive_optional           (superseded by passive_mode in 2026-05-27)
 *
 * Storage: dropping columns from the template does NOT delete stored
 * values on existing items — CSB silently strips writes to non-column
 * props but persists historical reads. The engine cleanup commit
 * removes the matching prop-read paths so stored ghost values are
 * inert. The reaction-config-lint DEPRECATED_* rules still flag any
 * item that has these values in storage, so a future housekeeping
 * pass can null them out cleanly.
 *
 * Idempotent: re-runs no-op when the columns are already absent.
 */

export const key = "2026-05-30-skill-effects-panel-strip-deprecated";
export const description =
  "Strip 9 deprecated columns from _Skill Template skill_effects_panel " +
  "(post_damage_effect_ref, passive_*, etc.) — only on_activate_effect_ref + effect_table remain.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const DROPPED_KEYS = new Set([
  "post_damage_effect_ref",
  "passive_check_bonus_formula",
  "passive_damage_bonus_formula",
  "passive_trigger",
  "passive_trigger_filter",
  "passive_condition_formula",
  "passive_mode",
  "on_passive_trigger_effect_ref",
  "passive_optional",
]);

function findPanel(node, key, depth = 0) {
  if (depth > 20 || !node || typeof node !== "object") return null;
  if (node.key === key) return node;
  if (Array.isArray(node)) {
    for (const v of node) { const r = findPanel(v, key, depth + 1); if (r) return r; }
    return null;
  }
  for (const v of Object.values(node)) { const r = findPanel(v, key, depth + 1); if (r) return r; }
  return null;
}

export async function migrate(game, log) {
  const tmpl = game.items.get(TEMPLATE_ID);
  if (!tmpl) {
    log(`_Skill Template "${TEMPLATE_ID}" not found — nothing to do.`);
    return { applied: true, summary: "no template" };
  }

  const sysClone = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});
  const panel = findPanel(sysClone, "skill_effects_panel");
  if (!panel || !Array.isArray(panel.contents)) {
    log(`skill_effects_panel not found or has no contents — nothing to strip.`);
    return { applied: true, summary: "no panel" };
  }

  const before = panel.contents.length;
  // Filter out direct contents whose `key` is one of the dropped set.
  // Nested panel/label/spacer entries with empty key are preserved.
  panel.contents = panel.contents.filter((c) => {
    const k = c?.key;
    if (k && DROPPED_KEYS.has(k)) {
      log(`  dropping column "${k}"`);
      return false;
    }
    return true;
  });
  const removed = before - panel.contents.length;

  if (removed === 0) {
    log(`No deprecated columns present — template already clean.`);
    return { applied: true, summary: "already canon" };
  }

  try {
    await tmpl.update({ system: sysClone });
    log(`_Skill Template: stripped ${removed} deprecated column(s).`);
  } catch (e) {
    log(`_Skill Template update failed: ${e?.message ?? e}`);
    return { applied: false, summary: `template update failed: ${e?.message ?? e}` };
  }

  // No itemRefresh pass — removing columns doesn't affect stored values,
  // only what the sheet renders. The engine cleanup commit makes the
  // ghost values inert; a future housekeeping migration can null them
  // out across actor copies if storage cleanliness becomes a concern.
  return {
    applied: true,
    summary: `stripped ${removed} deprecated columns`,
  };
}
