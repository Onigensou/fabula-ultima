// ============================================================================
// Out-of-Combat Healing System — Constants & shared config
//
// A self-service "overworld heal menu" (FF7–9 style): a player opens a local
// HUD, picks a healing Skill / Spell / Item, targets a party member from a 2×2
// panel, and the heal is applied. Resource writes that touch actors the player
// may not own are mediated through the GM via socketlib (see healing-socket.js).
//
// This file holds only constants + a tiny local SFX helper. No DOM, no socket
// wiring (that lives in healing-socket.js / healing-api.js).
// ============================================================================

export const HEAL_MODULE_ID = "fabula-ultima-companion";
export const HEAL_TAG = "[FU][Healing]";

// socketlib request names (player → GM). Kept namespaced to avoid clashes with
// the other socketlib registrants in the module.
export const HEAL_SOCKET = Object.freeze({
  APPLY: "healing.apply",   // { casterUuid, targetUuid, actionUuid, consumableUuid? } → GM applies, returns result
});

// Action categories → HUD tabs. Derived from the *granted action's* skill_type
// (item-granted spells land in SPELL, not ITEM). Consumables → ITEM.
export const HEAL_CATEGORY = Object.freeze({
  SKILL: "Skill",
  SPELL: "Spell",
  ITEM: "Item",
  CREATE: "Create",
});

// Feather cursor sprite (same asset/pattern as the Save/Load system UI).
export const HEAL_CURSOR_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/feather.png";

// Inventory-Point creatable presets (Fabula Ultima core "Spending Inventory
// Points"). World items; creating one spends IP and uses it immediately (no
// stored quantity). Tonic's status-cleanse is a placeholder for now.
export const HEAL_CREATE_PRESETS = Object.freeze([
  { name: "Remedy", uuid: "Item.LIkvHKcRlhLRuRyt" },
  { name: "Elixir", uuid: "Item.C1sbMzuHM6lA5u8q" },
  { name: "Tonic",  uuid: "Item.ZO0vkyhHeR2pR4QH", cleanse: true },
]);

// Keyboard controls (JRPG-style). Arrows navigate; Z confirms; X cancels/backs.
export const HEAL_KEYS = Object.freeze({
  UP: ["ArrowUp", "w", "W"],
  DOWN: ["ArrowDown", "s", "S"],
  LEFT: ["ArrowLeft", "a", "A"],
  RIGHT: ["ArrowRight", "d", "D"],
  CONFIRM: ["z", "Z", "Enter"],
  CANCEL: ["x", "X", "Escape"],
  TAB_NEXT: ["e", "E", "Tab"],     // cycle category tabs
  TAB_PREV: ["q", "Q"],
});

// ── Local SFX ───────────────────────────────────────────────────────────────
// The user asked for SFX only (no floating numbers / cast VFX — battle keeps
// those). All sounds play locally on the operating client; resource changes
// propagate as real actor updates so other clients hear nothing extra.
const _SND_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const HEAL_SFX = Object.freeze({
  OPEN:    { src: `${_SND_BASE}bond_create.wav`,        volume: 0.6 },
  MOVE:    { src: `${_SND_BASE}BattleCursor_4.wav`,     volume: 0.45 },
  SELECT:  { src: `${_SND_BASE}BattleCursor_2.wav`,     volume: 0.55 },
  ARM:     { src: `${_SND_BASE}check_ready.wav`,        volume: 0.6 },
  HEAL:    { src: `${_SND_BASE}Soundboard/Item3.ogg`,   volume: 0.7 },
  CANCEL:  { src: `${_SND_BASE}BattleCursor_2.wav`,     volume: 0.4 },
  DENY:    { src: `${_SND_BASE}BattleCursor_4.wav`,     volume: 0.35 },
  EXIT:    { src: `${_SND_BASE}bond_cleared.wav`,       volume: 0.6 },
  FULL:    { src: `${_SND_BASE}bond_cleared.wav`,       volume: 0.55 },  // target unhealable (full / can't benefit)
});

// Play a healing SFX locally. `key` is one of HEAL_SFX's keys (string) or a
// config object. Failures are swallowed — audio must never break the HUD.
export function playHealSfx(key) {
  const cfg = typeof key === "string" ? HEAL_SFX[key] : key;
  if (!cfg?.src) return;
  try {
    foundry.audio?.AudioHelper?.play?.({ src: cfg.src, volume: cfg.volume ?? 0.6, autoplay: true, loop: false }, false)
      ?? AudioHelper.play({ src: cfg.src, volume: cfg.volume ?? 0.6, autoplay: true, loop: false }, false);
  } catch (e) {
    console.warn(HEAL_TAG, "SFX play failed", e);
  }
}

// ── Live-tunable layout constants ───────────────────────────────────────────
// Mutated by the tuner (FUCompanion.api.healing.tuner) and applied to the HUD
// as CSS custom properties so changes are instant. Edit these defaults to bake
// in a final design.
export const HEAL_TUNE = {
  // Panels
  frameWidth: 1260,    // px (clamped to 95vw)
  frameHeight: 615,    // px (clamped to 92vh)
  pickerWidth: 34,     // % of frame width (action picker / left panel)
  cellGap: 16,         // px gap between actor panels

  // Battle sprite (floating element, anchored to the cell's bottom-right)
  spriteWidth: 142,    // px
  spriteHeight: 148,   // px
  spriteRight: -3,     // px from the panel's right edge (negative = pop out)
  spriteBottom: 23,    // px from the panel's bottom edge (negative = pop out)

  // Actor name
  nameSize: 27,            // px
  nameStrokeColor: "#f7d8a1",
  nameStrokeWidth: 0.5,    // px

  // Stat text
  resSize: 16,         // px (value text)
  labelSize: 17,       // px (HP/MP/IP label)
  rowGap: 2,           // px gap between stat rows
};

// Map the tune config → CSS custom properties for the overlay root.
export function tuneVars(t = HEAL_TUNE) {
  return {
    "--hl-frame-w": `${t.frameWidth}px`,
    "--hl-frame-h": `${t.frameHeight}px`,
    "--hl-picker-w": `${t.pickerWidth}%`,
    "--hl-cell-gap": `${t.cellGap}px`,
    "--hl-sprite-w": `${t.spriteWidth}px`,
    "--hl-sprite-h": `${t.spriteHeight}px`,
    "--hl-sprite-right": `${t.spriteRight}px`,
    "--hl-sprite-bottom": `${t.spriteBottom}px`,
    "--hl-name-size": `${t.nameSize}px`,
    "--hl-name-stroke": String(t.nameStrokeColor),
    "--hl-name-stroke-w": `${t.nameStrokeWidth}px`,
    "--hl-res-size": `${t.resSize}px`,
    "--hl-label-size": `${t.labelSize}px`,
    "--hl-row-gap": `${t.rowGap}px`,
  };
}

// Canonical resource slots in actor.system.props (CSB stores current_* as
// strings, max_* as numbers — always coerce with Number()).
export const HEAL_RESOURCE = Object.freeze({
  hp: { cur: "current_hp", max: "max_hp", label: "HP", color: "#5fcf6b" },
  mp: { cur: "current_mp", max: "max_mp", label: "MP", color: "#5fa8ef" },
  ip: { cur: "current_ip", max: "max_ip", label: "IP", color: "#e0b341" },
});
