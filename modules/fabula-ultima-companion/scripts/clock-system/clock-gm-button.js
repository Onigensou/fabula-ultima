// ============================================================================
// Clock System — floating GM control button.
//
// Joins the right-edge button column (Check Roller 38, Combat 110, EXP 180,
// AEM 254, Request Check 322, Rewind 390 …) at the next free slot. Like the
// others it hangs off `--fu-sidebar-anchor-right`, published frame-by-frame by
// scripts/custom-ui/sidebar-anchor.js, so it tracks the chat sidebar as it
// expands and collapses.
//
// GM-only, and it opens the GM manager — which is itself GM-only and refuses
// to open for a player, so this is an affordance rather than a gate.
// ============================================================================

import { CLOCK_TAG } from "./clock-const.js";

const ROOT_ID = "oni-clock-gm-root";
const BTN_ID = "oni-clock-gm-btn";
const STYLE_ID = "oni-clock-gm-styles";

const CFG = {
  offsetRightPx: 313,   // fallback when the sidebar anchor hasn't published yet
  offsetBottomPx: 462,  // next free slot above Rewind (390)
  sizePx: 44,
  zIndex: 60,
};

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${ROOT_ID} {
  position: fixed;
  right: var(--fu-sidebar-anchor-right, ${CFG.offsetRightPx}px);
  bottom: ${CFG.offsetBottomPx}px;
  z-index: ${CFG.zIndex};
  pointer-events: none;
}
#${BTN_ID} {
  pointer-events: auto;
  width: ${CFG.sizePx}px; height: ${CFG.sizePx}px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.22);
  background: rgba(18, 18, 22, 0.86);
  box-shadow: 0 10px 24px rgba(0,0,0,0.35), 0 2px 0 rgba(255,255,255,0.06) inset;
  display: grid; place-items: center;
  cursor: pointer; user-select: none;
  color: #e8d7a8; font-size: 19px;
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
}
#${BTN_ID}:hover {
  transform: translateY(-1px);
  background: rgba(34, 30, 24, 0.94);
  border-color: rgba(244, 226, 168, 0.45);
}
#${BTN_ID}:active { transform: translateY(0); }
`;
  document.head.appendChild(style);
}

export function installClockGmButton() {
  if (!game.user.isGM) {
    document.getElementById(ROOT_ID)?.remove();
    return;
  }
  if (document.getElementById(ROOT_ID)) return;

  ensureStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const btn = document.createElement("div");
  btn.id = BTN_ID;
  btn.title = "Clocks";
  btn.innerHTML = `<i class="fas fa-clock"></i>`;
  btn.addEventListener("click", () => {
    const manager = globalThis.FUCompanion?.api?.clocks?.manager;
    if (!manager) { ui.notifications?.warn("Clocks: manager not ready."); return; }
    manager.toggle();
  });

  root.appendChild(btn);
  document.body.appendChild(root);
  console.debug(CLOCK_TAG, "GM button installed");
}

Hooks.once("ready", () => {
  try { installClockGmButton(); }
  catch (e) { console.warn(CLOCK_TAG, "GM button install failed", e); }
});
