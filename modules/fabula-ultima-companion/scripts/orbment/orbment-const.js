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

// Visible sentinel that marked the START of the summary block v1/v2 appended to
// an item's description. v3 writes no block (the item card's Orbment footer
// shows installs); the compiler and the card still STRIP any leftover block.
export const DESC_SENTINEL = "🔮 Orbment";

// Strip the block by its VISIBLE sentinel, NOT by HTML comment markers — CSB /
// ProseMirror strips comments on re-serialization, which orphaned old blocks and
// caused duplicates. The block was always appended LAST, so cut from the FIRST
// sentinel to the end (removes any accumulated dupes), backing up over the
// block's opening wrapper run (whitespace, <hr>, opening p/strong/b/em/span —
// only opening tags, so it stops at any author close-tag).
export function stripOrbmentDescBlock(html) {
  const s = String(html ?? "");
  const idx = s.indexOf(DESC_SENTINEL);
  if (idx === -1) return s.replace(/\n{3,}/g, "\n\n").trimEnd();
  const lead = s.slice(0, idx).match(/(?:\s|<hr\s*\/?>|<(?:p|strong|b|em|span)\b[^>]*>)*$/i);
  const cut = lead ? idx - lead[0].length : idx;
  return s.slice(0, cut).replace(/\n{3,}/g, "\n\n").trimEnd();
}

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

// How an installed augment got there (v3): "roll" (Alchemist), "field" (Camp
// Forge), "upgrade" (the Upgrade heroic skill), "craft" (a GM install). Pre-v3
// installs have none and read as "craft" (rulebook value).
export const SLOT_SOURCES = Object.freeze(["roll", "field", "upgrade", "craft"]);

// Normalize a stored slot to { id, param, value, source } | null. Legacy slots
// were bare id strings (param-less) — coerce them so every shape reads the same.
// `value` null = the augment's rulebook value (registry resolveValue).
export function normalizeSlot(s) {
  if (!s) return null;
  if (typeof s === "string") return { id: s, param: null, value: null, source: "craft" };
  if (typeof s === "object" && s.id) {
    const v = Number(s.value);
    return {
      id: String(s.id),
      param: s.param ?? null,
      value: s.value == null || !Number.isFinite(v) ? null : v,
      source: SLOT_SOURCES.includes(s.source) ? s.source : "craft",
    };
  }
  return null;
}

// Read the raw orbment record off an item's flags (never null — normalized).
// `slots` is an array of { id, param, value, source } | null.
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
