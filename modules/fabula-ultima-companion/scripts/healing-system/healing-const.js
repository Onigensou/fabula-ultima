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
});

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

// Canonical resource slots in actor.system.props (CSB stores current_* as
// strings, max_* as numbers — always coerce with Number()).
export const HEAL_RESOURCE = Object.freeze({
  hp: { cur: "current_hp", max: "max_hp", label: "HP", color: "#5fcf6b" },
  mp: { cur: "current_mp", max: "max_mp", label: "MP", color: "#5fa8ef" },
  ip: { cur: "current_ip", max: "max_ip", label: "IP", color: "#e0b341" },
});
