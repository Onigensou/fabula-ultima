/**
 * Migration: 2026-05-17-skill-effects-panel-extract
 * ---------------------------------------------------------------------------
 * Phase D template surgery v2: extract `effect_table`, `post_damage_effect_ref`,
 * and `on_activate_effect_ref` OUT of the `reaction_config_panel` (which is
 * gated by `visibilityFormula: "isReaction"` — hidden on non-reaction skills)
 * and into a new sibling `skill_effects_panel` with NO visibility gate.
 *
 * Reasoning: the effect_table is general-purpose (any skill can fire effects
 * via post_damage_effect_ref / on_activate_effect_ref, not just reactions).
 * The previous template-surgery migration put them inside the reaction panel
 * for proximity to reaction_effect_ref, but that made them invisible to
 * authors of non-reaction skills like Drain Spirit (which uses
 * post_damage_effect_ref without checking the isReaction box).
 *
 * NEW LAYOUT:
 *   tab.contents[0] (empty panel)
 *   tab.contents[1] (text_panel)
 *   tab.contents[2] (empty panel)
 *   tab.contents[3] (skill_effects_panel — NEW; effect_table + 2 refs)
 *   tab.contents[4] (reaction_config_panel — reaction_config_table only)
 *   tab.contents[5] (table — existing)
 *
 * IDEMPOTENT: skips if `skill_effects_panel` already exists at tab level
 * with the three component keys inside.
 */

export const key = "2026-05-17-skill-effects-panel-extract";
export const description =
  "Extract effect_table + post_damage_effect_ref + on_activate_effect_ref " +
  "from the isReaction-gated reaction_config_panel into a new always-visible " +
  "skill_effects_panel sibling.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

const KEYS_TO_EXTRACT = ["effect_table", "post_damage_effect_ref", "on_activate_effect_ref"];

function makeSkillEffectsPanel(extractedComponents) {
  // Header label (matches the visual style of the reaction_config_panel header).
  const header = {
    key: "",
    colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: "", visibilityFormula: "",
    type: "label",
    size: "full-size",
    icon: "",
    value: "Skill Effects",
    prefix: "", suffix: "",
    rollMessage: "", altRollMessage: "",
    rollMessageToChat: true, altRollMessageToChat: true,
    style: "title"
  };

  return {
    key: "skill_effects_panel",
    colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: "", visibilityFormula: "",
    type: "panel",
    contents: [header, ...extractedComponents],
    flow: "vertical",
    align: "left",
    collapsible: true,
    defaultCollapsed: false,
    title: "",
    titleStyle: "default"
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

  // Idempotency: skip if skill_effects_panel already in place with the expected children.
  const existingPanel = tab.contents.find(c => c?.key === "skill_effects_panel");
  if (existingPanel?.contents?.some(c => c?.key === "effect_table")) {
    log("skill_effects_panel already extracted; nothing to do");
    return { applied: true, summary: "already extracted" };
  }

  const reactionPanelIdx = tab.contents.findIndex(c => c?.key === "reaction_config_panel");
  if (reactionPanelIdx < 0) {
    return { applied: false, summary: "reaction_config_panel missing in tab" };
  }
  const reactionPanel = tab.contents[reactionPanelIdx];
  if (!Array.isArray(reactionPanel.contents)) {
    return { applied: false, summary: "reaction_config_panel has no contents array" };
  }

  // Extract the three components from the reaction panel.
  const extracted = [];
  const remaining = [];
  for (const comp of reactionPanel.contents) {
    if (comp && KEYS_TO_EXTRACT.includes(comp.key)) {
      extracted.push(comp);
    } else {
      remaining.push(comp);
    }
  }

  if (extracted.length === 0) {
    log(`no extractable components in reaction_config_panel (keys: ${KEYS_TO_EXTRACT.join(", ")})`);
    return { applied: true, summary: "nothing to extract" };
  }

  // Sort extracted by canonical order so the new panel has a consistent layout.
  extracted.sort((a, b) => KEYS_TO_EXTRACT.indexOf(a.key) - KEYS_TO_EXTRACT.indexOf(b.key));

  // Remove the extracted components from the reaction panel.
  reactionPanel.contents = remaining;

  // Build the new sibling panel.
  const newPanel = makeSkillEffectsPanel(extracted);

  // Insert at the reaction panel's index so the new panel renders BEFORE the
  // reaction panel (effect_table defined first, then referenced by reactions).
  tab.contents.splice(reactionPanelIdx, 0, newPanel);

  await template.update({ system: sysClone });
  log(`extracted ${extracted.length} component(s) into skill_effects_panel (${extracted.map(c => c.key).join(", ")})`);

  return {
    applied: true,
    summary: `extracted ${extracted.length} columns into skill_effects_panel`
  };
}
