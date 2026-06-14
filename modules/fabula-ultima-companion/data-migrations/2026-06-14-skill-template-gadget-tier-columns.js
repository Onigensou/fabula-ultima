/**
 * Migration: 2026-06-14-skill-template-gadget-tier-columns
 * ---------------------------------------------------------------------------
 * Add three numeric tier columns to the CSB `_Skill Template`
 * (id j0F5Msw5RZ8aIB3j):
 *   gadget_infusion_tier / gadget_alchemy_tier / gadget_magitech_tier
 *
 * The consolidated Tinkerer "Gadgets" meta-skill holds all three branches in
 * ONE skill item. "Which branches/tiers this character has unlocked" can no
 * longer be inferred from separate items, so it lives as numeric props on the
 * Gadgets skill instance: 0 none / 1 basic / 2 advanced / 3 superior. The
 * GM/level-up sets these per character; 0 leaves a branch inert.
 *
 * CSB strips any `system.props.*` whose key isn't a declared template column,
 * so these columns must exist before a Gadgets skill can carry the tier props
 * (and before the GM can edit them on the sheet). They're read at runtime by the
 * `GADGET_<TYPE>_TIER` formula identifier (skill-formulas.js), used in per-
 * infusion `condition_formula` gates (GADGET_INFUSION_TIER >= 2, …).
 *
 * Placement: the same fire-point panel that holds on_activate_effect_ref — a
 * robust, locatable anchor (placement is functionally irrelevant; the columns
 * exist only to keep the props from being stripped and to make them editable).
 *
 * IDEMPOTENT: per-column no-op if it already exists.
 */

export const key = "2026-06-14-skill-template-gadget-tier-columns";
export const description =
  "CSB template surgery: add gadget_infusion_tier / gadget_alchemy_tier / " +
  "gadget_magitech_tier numeric columns to _Skill Template (Gadgets unlock tiers).";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const FIELDS = [
  {
    key: "gadget_infusion_tier",
    label: "Gadget: Infusion Tier",
    tooltip: "Tinkerer Gadgets — Infusion branch unlock tier. 0 none / 1 basic (Cryo/Pyro/Volt) / 2 advanced (+Cyclone/Exorcism/Seismic/Shadow) / 3 superior (+Venom/Vampire). Read as GADGET_INFUSION_TIER.",
  },
  {
    key: "gadget_alchemy_tier",
    label: "Gadget: Alchemy Tier",
    tooltip: "Tinkerer Gadgets — Alchemy branch unlock tier (0–3). Read as GADGET_ALCHEMY_TIER. (Branch is a stub until the potion-mix subsystem lands.)",
  },
  {
    key: "gadget_magitech_tier",
    label: "Gadget: Magitech Tier",
    tooltip: "Tinkerer Gadgets — Magitech branch unlock tier (0–3). Read as GADGET_MAGITECH_TIER. (Branch is a stub until the magitech subsystem lands.)",
  },
];

function makeNumberFieldComponent(spec) {
  return {
    key: spec.key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: spec.tooltip ?? "", visibilityFormula: "",
    type: "numberField", size: "full-size", label: spec.label ?? spec.key,
    defaultValue: 0, min: 0, max: 3, step: 1,
  };
}

// Locate the panel holding the skill fire-point columns by finding the one
// whose direct children include `on_activate_effect_ref` (robust to renames).
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
  const added = [];
  for (const field of FIELDS) {
    if (contents.some((c) => c?.key === field.key)) continue;
    contents.push(makeNumberFieldComponent(field));
    added.push(field.key);
  }
  if (!added.length) {
    return { applied: true, summary: "all gadget tier columns already present" };
  }
  panel.contents = contents;
  // Bump the template version so CSB recompiles items against the new column
  // list (else the compiled-template prop gate strips freshly-set tier props).
  const curVer = Number(sysClone.templateSystemUniqueVersion) || 0;
  sysClone.templateSystemUniqueVersion = curVer + 1;
  await template.update({ system: sysClone });
  log(`added columns [${added.join(", ")}] to _Skill Template (version → ${curVer + 1})`);
  return { applied: true, summary: `added gadget tier columns: ${added.join(", ")}` };
}
