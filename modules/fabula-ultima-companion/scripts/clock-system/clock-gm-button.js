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

// Matched to the Check Requester button (cr-sidebar-button.js), which is the
// established pattern for this column: same 60px diameter, same z-index, same
// 22px icon, same hover tooltip. A smaller button would sit off-centre from its
// neighbours, because they all share one `right:` edge rather than a centreline.
const CFG = {
  offsetRightPx: 313,   // fallback when the sidebar anchor hasn't published yet
  offsetBottomPx: 462,  // next free slot above Rewind (390)
  sizePx: 60,
  zIndex: 83,
  label: "Clocks",
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
  background: rgba(18,18,22,0.86);
  box-shadow: 0 10px 24px rgba(0,0,0,.35), 0 2px 0 rgba(255,255,255,.06) inset;
  display: grid; place-items: center;
  cursor: pointer; user-select: none; -webkit-user-select: none;
  transform: translateZ(0);
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
  position: relative;
}
#${BTN_ID}:hover  { transform: translateY(-1px) scale(1.02); background: rgba(28,28,34,.92); border-color: rgba(255,255,255,.32); }
#${BTN_ID}:active { transform: translateY(0) scale(.99); }

#${BTN_ID} .oni-clock-btn-icon {
  font-size: 22px; line-height: 1; color: #e8d7a8;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.45));
}
#${BTN_ID} .oni-clock-btn-tip {
  position: absolute; right: 0; bottom: calc(100% + 10px);
  background: rgba(10,10,12,.92); border: 1px solid rgba(255,255,255,.18);
  border-radius: 10px; padding: 8px 10px; font-size: 12px;
  color: rgba(255,255,255,.9); white-space: nowrap;
  opacity: 0; transform: translateY(4px);
  transition: opacity 120ms ease, transform 120ms ease;
  pointer-events: none; box-shadow: 0 10px 24px rgba(0,0,0,.35);
}
#${BTN_ID}:hover .oni-clock-btn-tip { opacity: 1; transform: translateY(0); }
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
  btn.innerHTML =
    `<div class="oni-clock-btn-tip">${CFG.label}</div>` +
    `<div class="oni-clock-btn-icon"><i class="fas fa-clock"></i></div>`;
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
