// Developer Tools launcher (GM only).
//
// A single bottom-left 🛠️ button that bundles the director's dev tools (SFX
// checker, icon adjuster, …) instead of each one floating its own button. The
// button is a TOGGLE: turning it on reveals a vertical stack of smaller
// circular child buttons (one per registered tool) that each act as their own
// button. The smaller size conveys their parent-child relationship. The launcher
// is anchored ABOVE the Foundry Players list and tracks its height (the list
// grows/shrinks as players connect / expand), so it never sits behind that box.
//
// Tools self-register via registerDevTool({ id, icon, label, onClick }) — the
// menu is order-independent (registration appends to a list; the stack reads it
// when shown). New tools get a slot for free.

import { log, warn } from "./logger.js";

const BTN_ID = "fud-devtools-btn";
const KIDS_ID = "fud-devtools-children";
const STYLE_ID = "fud-devtools-style";
const SIZE = 46;          // parent button diameter
const CHILD_SIZE = 34;    // child button diameter (smaller → reads as a child)
const CHILD_GAP = 9;      // vertical gap between stacked buttons
const LEFT = 16;
const GAP_ABOVE_PLAYERS = 12;

// { id, icon, label, onClick }
const _tools = [];
let _booted = false;

// ── registration ──────────────────────────────────────────────────────────
export function registerDevTool({ id, icon = "•", label = "Tool", onClick } = {}) {
  if (!id || typeof onClick !== "function") return;
  const i = _tools.findIndex((t) => t.id === id);
  const tool = { id, icon, label, onClick };
  if (i >= 0) _tools[i] = tool; else _tools.push(tool);
  // Rebuild the stack if it's currently shown.
  if (document.getElementById(KIDS_ID)) buildChildren();
}

// Bottom offset (px) just ABOVE the dev-tools button — tool panels anchor here
// so they open clear of the Players list, not behind it.
export function devToolsAnchorBottom() {
  return playersHeight() + GAP_ABOVE_PLAYERS + SIZE + 10;
}

// Left offset (px) just to the RIGHT of the dev-tools button column — tool
// panels anchor here so they don't cover the launcher + its speed-dial child
// buttons (which let you re-trigger a tool on another target without first
// closing the panel).
export function devToolsAnchorLeft() {
  return LEFT + SIZE + 12;
}

// ── boot ────────────────────────────────────────────────────────────────────
export function initDevToolsMenu() {
  try {
    if (_booted) return;
    if (!game.user?.isGM) return;
    if (document.getElementById(BTN_ID)) { _booted = true; return; }
    ensureStyle();
    mountButton();
    _booted = true;
    log("dev-tools-menu: mounted");
  } catch (e) {
    warn("initDevToolsMenu threw", e);
  }
}

function playersHeight() {
  const players = document.getElementById("players");
  return players ? (players.offsetHeight || 0) : 0;
}

function reposition() {
  const bottom = playersHeight() + GAP_ABOVE_PLAYERS;
  const btn = document.getElementById(BTN_ID);
  if (btn) btn.style.bottom = `${bottom}px`;
  const kids = document.getElementById(KIDS_ID);
  if (kids) kids.style.bottom = `${bottom + SIZE + CHILD_GAP}px`;
}

function mountButton() {
  const btn = document.createElement("div");
  btn.id = BTN_ID;
  btn.title = "Developer Tools";
  btn.textContent = "🛠️";
  btn.addEventListener("click", toggle);
  document.body.appendChild(btn);
  reposition();

  // Keep above the Players list as it resizes (players connect / expand).
  try {
    const players = document.getElementById("players");
    if (players && window.ResizeObserver) {
      new ResizeObserver(() => reposition()).observe(players);
    }
  } catch (_e) {}
  try { window.addEventListener("resize", reposition); } catch (_e) {}
  try { Hooks.on("renderPlayerList", () => setTimeout(reposition, 0)); } catch (_e) {}
}

// ── toggle ──────────────────────────────────────────────────────────────────
function toggle() {
  const btn = document.getElementById(BTN_ID);
  if (document.getElementById(KIDS_ID)) {
    document.getElementById(KIDS_ID).remove();
    btn?.classList.remove("on");
  } else {
    buildChildren();
    btn?.classList.add("on");
  }
}

function buildChildren() {
  document.getElementById(KIDS_ID)?.remove();
  const kids = document.createElement("div");
  kids.id = KIDS_ID;

  if (!_tools.length) {
    const empty = document.createElement("div");
    empty.className = "fud-dt-empty";
    empty.textContent = "—";
    empty.title = "No tools registered.";
    kids.appendChild(empty);
  } else {
    _tools.forEach((tool, i) => {
      const b = document.createElement("div");
      b.className = "fud-dt-child";
      b.title = tool.label;
      b.textContent = tool.icon;
      // Staggered pop-in (column-reverse → first tool nearest the parent).
      b.style.animationDelay = `${i * 35}ms`;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        try { tool.onClick(); }
        catch (e) { warn(`dev-tools-menu: tool "${tool.id}" onClick threw`, e); }
      });
      kids.appendChild(b);
    });
  }

  document.body.appendChild(kids);
  reposition();
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${BTN_ID} {
  position: fixed; left: ${LEFT}px; bottom: 12px; width: ${SIZE}px; height: ${SIZE}px; z-index: 80;
  display: flex; align-items: center; justify-content: center; border-radius: 50%;
  cursor: pointer; user-select: none; font-size: 20px; color: #d8dce6;
  background: radial-gradient(circle at 35% 30%, #3a3f4b, #1b1e25);
  border: 1px solid rgba(255,255,255,.22); box-shadow: 0 3px 10px rgba(0,0,0,.45);
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
}
#${BTN_ID}:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,.55); }
/* Toggled-on state — gold ring + glow so it reads as "open". */
#${BTN_ID}.on {
  border-color: rgba(255,216,102,.85);
  box-shadow: 0 0 0 2px rgba(255,216,102,.25), 0 4px 14px rgba(0,0,0,.55);
}
#${KIDS_ID} {
  position: fixed; left: ${LEFT}px; width: ${SIZE}px; z-index: 80;
  display: flex; flex-direction: column-reverse; align-items: center; gap: ${CHILD_GAP}px;
  pointer-events: none; /* container ignores clicks; children re-enable */
}
#${KIDS_ID} .fud-dt-child {
  pointer-events: auto;
  width: ${CHILD_SIZE}px; height: ${CHILD_SIZE}px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; user-select: none; font-size: 15px; color: #e8eaf0;
  background: radial-gradient(circle at 35% 30%, #333845, #15181f);
  border: 1px solid rgba(255,255,255,.18); box-shadow: 0 2px 7px rgba(0,0,0,.5);
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
  transform-origin: center bottom;
  animation: fud-dt-pop .16s ease-out both;
}
#${KIDS_ID} .fud-dt-child:hover {
  transform: translateY(-1px) scale(1.08);
  border-color: rgba(255,216,102,.7); box-shadow: 0 4px 12px rgba(0,0,0,.6);
}
#${KIDS_ID} .fud-dt-empty {
  pointer-events: auto; width: ${CHILD_SIZE}px; height: ${CHILD_SIZE}px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; opacity: .5; color: #aab2c2;
  border: 1px dashed rgba(255,255,255,.2);
}
@keyframes fud-dt-pop { 0% { opacity: 0; transform: scale(.4) translateY(6px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
