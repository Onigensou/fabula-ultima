// ============================================================================
// Stealth Mode — the GM's docked button.
//
// Joins the right-edge button column, hanging off `--fu-sidebar-anchor-right`
// like the rest of it, so it tracks the chat sidebar as that expands and
// collapses. Column, bottom → top (12px gaps):
//
//   Check Roller      38   60px
//   Combat           110   52px
//   EXP Awarder      174   52px
//   AEM              238   52px
//   Check Requester  302   52px
//   Clocks           366   52px
//   Rewind           430   52px — battle-only
//   Stealth          494   52px — this one, stealth-scene-only
//
// Unlike its neighbours this button is CONDITIONAL: it exists only while the
// viewed scene is in stealth mode, and takes itself off the column otherwise.
// A control for a mode you are not in is clutter, and the column is shared.
// ============================================================================

import { TAG } from "./sm-constants.js";

const ROOT_ID  = "oni-stealth-gm-root";
const BTN_ID   = "oni-stealth-gm-btn";
const STYLE_ID = "oni-stealth-gm-styles";

const CFG = {
  offsetRightPx: 313,   // fallback until the sidebar anchor publishes
  offsetBottomPx: 494,
  sizePx: 52,
  zIndex: 83,
  label: "Stealth Control",
};

let _onToggle = null;

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
/* Lit while the panel is open, so the button reports the panel's state
   instead of the GM having to look for the panel to find out. */
#${BTN_ID}.is-open {
  border-color: rgba(95,227,161,.55);
  box-shadow: 0 10px 24px rgba(0,0,0,.35), 0 0 16px rgba(95,227,161,.28);
}
#${BTN_ID} .oni-stealth-btn-icon {
  font-size: 22px; line-height: 1; color: #9fe8c4;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.45));
}
#${BTN_ID}.is-open .oni-stealth-btn-icon { color: #5fe3a1; }
#${BTN_ID} .oni-stealth-btn-tip {
  position: absolute; right: 0; bottom: calc(100% + 10px);
  background: rgba(10,10,12,.92); border: 1px solid rgba(255,255,255,.18);
  border-radius: 10px; padding: 8px 10px; font-size: 12px;
  color: rgba(255,255,255,.9); white-space: nowrap;
  opacity: 0; transform: translateY(4px);
  transition: opacity 120ms ease, transform 120ms ease;
  pointer-events: none; box-shadow: 0 10px 24px rgba(0,0,0,.35);
}
#${BTN_ID}:hover .oni-stealth-btn-tip { opacity: 1; transform: translateY(0); }
`;
  document.head.appendChild(style);
}

/** Put the button on the column. GM only. */
export function install(onToggle) {
  _onToggle = onToggle ?? _onToggle;
  if (!game.user?.isGM) { remove(); return; }
  if (document.getElementById(ROOT_ID)) return;

  ensureStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const btn = document.createElement("div");
  btn.id = BTN_ID;
  btn.innerHTML =
    `<div class="oni-stealth-btn-tip">${CFG.label}</div>` +
    `<div class="oni-stealth-btn-icon"><i class="fas fa-user-secret"></i></div>`;
  btn.addEventListener("click", () => {
    try { _onToggle?.(); } catch (e) { console.warn(TAG, "GM button toggle threw", e); }
  });

  root.appendChild(btn);
  document.body.appendChild(root);
}

export function remove() {
  document.getElementById(ROOT_ID)?.remove();
}

/** Reflect whether the panel is currently open. */
export function setOpen(open) {
  document.getElementById(BTN_ID)?.classList.toggle("is-open", !!open);
}
