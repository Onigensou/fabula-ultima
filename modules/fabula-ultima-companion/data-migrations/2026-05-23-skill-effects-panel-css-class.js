/**
 * Migration: 2026-05-23-skill-effects-panel-css-class
 * ---------------------------------------------------------------------------
 * Restore `cssClass: "item-type-css"` on the `skill_effects_panel` outer panel
 * so it visually matches `reaction_config_panel`. At some point in the
 * template's history the class was stripped to "" on this panel only, which
 * removed the standard item-panel styling (border, padding, background) that
 * every other content panel in the template still has.
 *
 * The companion title-wrap migration (2026-05-23-skill-effects-panel-title-wrap)
 * already mirrored reaction_config_panel's inner-panel structure; this one
 * mirrors the outer CSS class.
 *
 * IDEMPOTENT — only writes if the current class differs from "item-type-css".
 *
 * SCOPE: `_Skill Template` (id `j0F5Msw5RZ8aIB3j`).
 */

export const key = "2026-05-23-skill-effects-panel-css-class";
export const description =
  "Set cssClass=\"item-type-css\" on skill_effects_panel to match reaction_config_panel.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const TARGET_CLASS = "item-type-css";

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

async function patchTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const panel = findSkillEffectsPanel({ contents: [sysClone.body] });
  if (!panel) {
    log("skill_effects_panel not found in template body — aborting");
    return { ok: false };
  }

  const current = String(panel.cssClass ?? "");
  if (current === TARGET_CLASS) {
    log(`cssClass already "${TARGET_CLASS}" — no-op`);
    return { ok: true, templateTouched: false };
  }

  panel.cssClass = TARGET_CLASS;
  await template.update({ system: sysClone });
  log(`set skill_effects_panel.cssClass from "${current}" -> "${TARGET_CLASS}"`);
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
    summary: `template ${res.templateTouched ? "patched (cssClass set)" : "unchanged (cssClass already correct)"}`
  };
}
