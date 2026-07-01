// scripts/orbment/orbment-const.js
//
// Equipment Orbment system — shared constants & low-level helpers.
//
// The Orbment system lets a piece of equipment carry a number of SLOTS (tied
// to its rarity) into which an AUGMENT can be installed. An installed augment
// modifies the item by COMPILING its declared projection into fields the rest
// of the module already reads — it invents no new combat pathway:
//
//   • targeting → item.system.props.skill_target   (Multi(N) via resolveTargetPlan)
//   • rider     → item.system.props.reaction_config_table + effect_table rows
//                 (weapon-used keyword automation, e.g. Pierce / on-hit status)
//   • stat      → an embedded managed ActiveEffect on the item (equip-synced)
//
// Installed-augment STATE lives in item flags (system-managed; not a CSB sheet
// table) so no template migration is needed — see the plan discussion. The
// projected artifacts are TAGGED (below) so a recompile can cleanly strip the
// previous projection before re-applying, exactly like reconcileSetBonuses.

export const FLAG_NS = "fabula-ultima-companion";

// Flag sub-key under FLAG_NS holding the whole orbment record for an item:
//   { version, slots:[augmentId|null,…], baseSkillTarget, linkGroup:[itemId,…] }
export const ORBMENT_FLAG = "orbment";

// Tag stamped on every artifact the compiler creates, so recompile can find &
// remove the PRIOR projection without touching author/other-system data:
//   • embedded stat AEs: system.tags includes ORBMENT_TAG
//   • reaction_config_table / effect_table rows: label/key is prefixed ORBMENT_ROW_PREFIX
export const ORBMENT_TAG = "orbment";
export const ORBMENT_ROW_PREFIX = "orbment_";

// Visible sentinel that marks the START of the compiler-managed summary block in
// an item's description. Must be a VISIBLE string (not an HTML comment) — CSB /
// ProseMirror strips comments on re-serialization, which orphaned the block and
// caused duplicates. The block is always appended last, so the compiler strips
// from this sentinel to end.
export const DESC_SENTINEL = "🔮 Orbment";

// Rarity → slot count. Common/Uncommon (or blank) = 1, Rare = 2, Legendary = 3.
// Derived at runtime from item_rarity so it self-updates if rarity changes.
export function slotCountForRarity(rarity) {
  const r = String(rarity ?? "").trim().toLowerCase();
  if (r.includes("legendary")) return 3;
  if (r.includes("rare"))      return 2;
  return 1; // common / uncommon / unset
}

// The item_type an equippable carries in CSB props ("weapon" | "armor" | "shield").
export function itemKindOf(item) {
  return String(item?.system?.props?.item_type ?? "").trim().toLowerCase();
}

// How many slots THIS item exposes (from its rarity prop).
export function slotCountOf(item) {
  return slotCountForRarity(item?.system?.props?.item_rarity);
}

// Normalize a stored slot to { id, param } | null. Legacy slots were bare id
// strings (param-less) — coerce them so both shapes read the same.
export function normalizeSlot(s) {
  if (!s) return null;
  if (typeof s === "string") return { id: s, param: null };
  if (typeof s === "object" && s.id) return { id: String(s.id), param: s.param ?? null };
  return null;
}

// Read the raw orbment record off an item's flags (never null — normalized).
// `slots` is an array of { id, param } | null.
export function readOrbment(item) {
  const raw = item?.flags?.[FLAG_NS]?.[ORBMENT_FLAG] ?? null;
  const count = slotCountOf(item);
  const slots = new Array(count).fill(null);
  if (raw && Array.isArray(raw.slots)) {
    for (let i = 0; i < count; i++) slots[i] = normalizeSlot(raw.slots[i]);
  }
  return {
    version: Number(raw?.version ?? 1) || 1,
    slots,
    // baseProps: [{key,value}] — intrinsic values the compiler snapshotted before
    // a props-augment overrode them, so removal restores them exactly. Empty until
    // the first props-projection captures them.
    baseProps: Array.isArray(raw?.baseProps) ? raw.baseProps : [],
    linkGroup: Array.isArray(raw?.linkGroup) ? raw.linkGroup.filter(Boolean) : null,
  };
}

// Normalize an item NAME to a stem shared by a transform weapon's linked docs,
// so "+3 Zarg's Bow" and "+3 Zarg's Bow - Light" resolve to the same group.
// Strips a trailing " - <word(s)>" form suffix and collapses whitespace.
export function nameStem(name) {
  return String(name ?? "")
    .replace(/\s*[-–—]\s*[\w' ]+$/u, "")  // drop trailing " - Light" / " - Blade"
    .trim()
    .toLowerCase();
}
