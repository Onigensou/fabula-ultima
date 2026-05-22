/**
 * Migration: 2026-05-23-skill-effects-panel-title-wrap
 * ---------------------------------------------------------------------------
 * Visual parity fix for the _Skill Template editor: the "Skill Effects" panel
 * (skill_effects_panel containing effect_table) renders without the extra
 * inner-panel wrapping that reaction_config_panel uses for its "Reaction
 * Config" title. The structural difference produces inconsistent vertical
 * spacing between the two panels in the item sheet.
 *
 * This migration wraps the existing "Skill Effects" title label in an inner
 * panel, matching the structure used by reaction_config_panel exactly:
 *
 *   Before:
 *     skill_effects_panel (panel, cssClass="item-type-css")
 *     ├── label "Skill Effects"
 *     └── effect_table (compactDynamicTable)
 *
 *   After:
 *     skill_effects_panel (panel, cssClass="item-type-css")
 *     ├── inner panel (cssClass="")
 *     │   └── label "Skill Effects"
 *     └── effect_table (compactDynamicTable)
 *
 * The inner panel mirrors the one in reaction_config_panel (vertical flow,
 * left align, not collapsible, no title). No new CSS class is introduced.
 *
 * IDEMPOTENT — if the first child of skill_effects_panel is already a panel,
 * we treat the wrap as done and no-op.
 *
 * SCOPE: `_Skill Template` (id `j0F5Msw5RZ8aIB3j`).
 */

export const key = "2026-05-23-skill-effects-panel-title-wrap";
export const description =
  "Wrap the 'Skill Effects' title label inside skill_effects_panel in an " +
  "inner panel, mirroring reaction_config_panel's structure.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

function findSkillEffectsPanel(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "skill_effects_panel" && node.type === "panel") return node;
  const contents = Array.isArray(node.contents) ? node.contents : [];
  for (const child of contents) {
    const hit = findSkillEffectsPanel(child);
    if (hit) return hit;
  }
  return null;
}

function buildInnerPanelWrappingTitle(titleLabel) {
  return {
    key: "",
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "",
    visibilityFormula: "",
    type: "panel",
    contents: [titleLabel],
    flow: "vertical",
    align: "left",
    collapsible: false,
    defaultCollapsed: false,
    title: "",
    titleStyle: "default"
  };
}

function isTitleLabel(node) {
  return !!node
    && node.type === "label"
    && node.style === "title"
    && String(node.value ?? "").trim().toLowerCase() === "skill effects";
}

async function patchTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const panel = findSkillEffectsPanel({ contents: [sysClone.body] });
  if (!panel) {
    log("skill_effects_panel not found in template body — aborting");
    return { ok: false };
  }

  const contents = Array.isArray(panel.contents) ? panel.contents : [];
  if (!contents.length) {
    log("skill_effects_panel has no contents — aborting (unexpected shape)");
    return { ok: false };
  }

  // Idempotency: if the first child is already a panel, assume already wrapped.
  if (contents[0]?.type === "panel") {
    log("first child of skill_effects_panel is already a panel — no-op");
    return { ok: true, templateTouched: false };
  }

  // First child must be the "Skill Effects" title label.
  if (!isTitleLabel(contents[0])) {
    log(`first child is not the expected 'Skill Effects' title label ` +
        `(type="${contents[0]?.type}", value="${contents[0]?.value}") — aborting`);
    return { ok: false };
  }

  const wrapped = buildInnerPanelWrappingTitle(contents[0]);
  panel.contents = [wrapped, ...contents.slice(1)];

  await template.update({ system: sysClone });
  log("wrapped 'Skill Effects' title label in inner panel");
  return { ok: true, templateTouched: true };
}

export async function migrate(game, log) {
  const template = game.items?.get(TEMPLATE_ID);
  if (!template) {
    return { applied: true, summary: `no _Skill Template (${TEMPLATE_ID}); nothing to do` };
  }
  const res = await patchTemplate(template, log);
  if (!res.ok) {
    return { applied: false, summary: "template patch failed" };
  }
  return {
    applied: true,
    summary: `template ${res.templateTouched ? "patched (title wrapped)" : "unchanged (already wrapped)"}`
  };
}
