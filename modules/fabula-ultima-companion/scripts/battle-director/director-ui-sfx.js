// Director UI sound layer — hover + click cues for the director's interactive
// surfaces (action card buttons/pills, turn picker, octopath turn menu,
// reaction menu, skill / option / target / weapon-mode / attribute pickers,
// passive manager). One delegated listener pair on `document` handles every
// surface, so new buttons that use the same class vocabulary get sound for
// free — no per-button wiring.
//
// Cues (Legacy parity — same files the legacy Turn UI used):
//   hover  → BattleCursor_4.wav   (light cursor blip on mouse-enter)
//   click  → switch_mode.wav      (select / activate)
//
// Playback is LOCAL only (playSfx, never broadcast): UI hover/click is each
// client's own interaction, not something to fan out to other screens. The
// cues are warm-decoded by preloadDirectorSfx so the first hover/click of a
// session plays without a fetch hitch.
//
// Not a manifest entry: imported by director-boot.js (an existing esmodule)
// and initialised from its ready hook, so it loads on a normal reload.

import { log, warn } from "./logger.js";
import { playSfx } from "./director-sfx.js";

const FORGE_SOUND_BASE =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const UI_HOVER_SFX_URL = FORGE_SOUND_BASE + "BattleCursor_4.wav";
export const UI_CLICK_SFX_URL = FORGE_SOUND_BASE + "switch_mode.wav";

const HOVER_VOL = 0.5;
const CLICK_VOL = 0.6;

// Every interactive element the director renders. Almost all are
// `<div role="button">` with a `fud-`-prefixed class; the generic `.pill` /
// `.item` cases are scoped to their menu containers so they don't leak onto
// unrelated DOM. `closest()` is matched against this list on each event.
const INTERACTIVE_SELECTOR = [
  // Action card — buttons, reaction apply/skip, equip options, reaction pills.
  ".fud-btn",
  "[data-fud-action]",
  "[data-fud-reaction-action]",
  ".fud-bf-equip-option",
  ".fud-bf-reaction-pill",
  // Pickers.
  ".fud-opt-picker-row", ".fud-opt-picker-cancel",
  ".fud-app-attr-btn", ".fud-app-dl-step", ".fud-app-dl-preset", ".fud-app-btn",
  ".fud-skp-row", ".fud-skp-cancel",
  ".fud-target-btn",
  ".fud-wmp-option", ".fud-wmp-cancel",
  // Passive manager.
  ".fud-passive-mgr-row", ".fud-passive-mgr-close",
  // Turn picker pills + octopath turn menu items + reaction menu items
  // (scoped to their containers so plain `.pill` / `.item` elsewhere are
  // never caught).
  '[id^="fud-pickturn-"] .pill',
  '[id^="fud-octopath-"] .item',
  '[id^="fud-react-menu-"] .item',
].join(",");

// Treat these as non-activating — a hover is fine but a "click" cue would
// falsely imply something happened.
function isDisabled(el) {
  if (!el) return true;
  if (el.classList?.contains("is-disabled")) return true;
  if (el.classList?.contains("is-locked")) return true;
  if (el.getAttribute?.("aria-disabled") === "true") return true;
  if (el.hasAttribute?.("disabled")) return true;
  return false;
}

let _installed = false;
let _lastHoverEl = null;

function onPointerOver(e) {
  try {
    const el = e.target?.closest?.(INTERACTIVE_SELECTOR);
    if (!el || el === _lastHoverEl) return;
    _lastHoverEl = el;
    if (isDisabled(el)) return; // moved onto a disabled control — stay quiet
    playSfx(UI_HOVER_SFX_URL, HOVER_VOL);
  } catch (err) {
    warn("director-ui-sfx onPointerOver threw", err);
  }
}

function onPointerOut(e) {
  // Reset the hover tracker once the pointer actually leaves the tracked
  // element (moving to a node outside it). Re-entering the same element
  // afterwards replays the hover cue, as expected.
  if (_lastHoverEl && (!e.relatedTarget || !_lastHoverEl.contains(e.relatedTarget))) {
    _lastHoverEl = null;
  }
}

function onClick(e) {
  try {
    const el = e.target?.closest?.(INTERACTIVE_SELECTOR);
    if (!el || isDisabled(el)) return;
    playSfx(UI_CLICK_SFX_URL, CLICK_VOL);
  } catch (err) {
    warn("director-ui-sfx onClick threw", err);
  }
}

// Install the delegated listeners once, on every client (players interact
// with their own menus / action-card mirror too). Capture phase so the cue
// fires even when a surface's own handler calls stopPropagation on bubble.
export function initDirectorUiSfx() {
  try {
    if (_installed) return;
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("click", onClick, true);
    _installed = true;
    log("director-ui-sfx: hover/click listeners installed");
  } catch (e) {
    warn("initDirectorUiSfx threw", e);
  }
}
