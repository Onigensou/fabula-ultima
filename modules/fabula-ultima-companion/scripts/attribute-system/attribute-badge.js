// ============================================================================
// Unspent Attribute Point badge.
//
// Same contract as the Skill Point badge: it appears only where the point can
// actually be spent — a camp lobby or the title screen — and clicking it opens
// the Status window. A character who hits level 20 mid-fight is not nagged
// about a decision the gate will not let them make yet.
//
// THE BOTTOM-LEFT STACK, floor upward:
//
//   camp / dungeon button row     bottom 80, 64 tall
//   Skill Point badge             when points are unspent
//   THIS badge                    when advances are unspent
//   main controller badge         above whichever are present
//
// Each layer MEASURES the ones below rather than reserving space for them,
// because any of them can be absent. This one measures the Skill Point badge;
// the controller badge measures both. Every layer calls the controller badge's
// reposition() on show/hide so the stack settles in one frame instead of
// drifting until the next resize.
// ============================================================================

import { ATTR } from "./attribute-const.js";
import { readStatus } from "./attribute-api.js";

const STYLE_ID = "oni-attribute-badge-style";
const ROOT_ID = "oni-attribute-badge";
const GAP = 10;

/** Directly above the button row, plus the Skill Point badge if it is showing. */
function dockBottom() {
  const btn = globalThis.DungeonPathing?.UI?.SCAN_BUTTON;
  const base = Number(btn?.BOTTOM ?? 80) + Number(btn?.SIZE ?? 64) + GAP;
  const sp = document.getElementById("oni-levelup-badge");
  return base + (sp ? Math.round(sp.getBoundingClientRect().height) + GAP : 0);
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${ROOT_ID} { position: fixed; z-index: 99997; left: 20px;
  display: flex; align-items: center; gap: 9px; padding: 8px 13px 8px 10px;
  border-radius: 10px; cursor: pointer; user-select: none;
  background: linear-gradient(180deg,#5d4630,#4a371f); color: #f6ecd8;
  border: 2px solid #8a6c45; box-shadow: 0 6px 18px rgba(0,0,0,.45);
  font-family: Signika, sans-serif; transition: transform .12s ease, box-shadow .12s ease; }
#${ROOT_ID}:hover { transform: translateY(-2px); box-shadow: 0 9px 22px rgba(0,0,0,.5); }
#${ROOT_ID} .ab-n { display: flex; align-items: center; justify-content: center;
  min-width: 26px; height: 26px; padding: 0 6px; border-radius: 13px; flex: 0 0 auto;
  background: linear-gradient(180deg,#f0d99a,#e0c179); color: #4b3517;
  font-weight: 800; font-size: 15px; border: 1px solid #8a6c45; }
#${ROOT_ID} .ab-t { font-size: 13px; font-weight: 700; line-height: 1.15; }
#${ROOT_ID} .ab-s { font-size: 11px; opacity: .8; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} { transition: none; } }
`;
  document.head.appendChild(s);
}

const myActor = () => {
  const t = canvas?.tokens?.controlled?.[0]?.actor;
  if (t) return t;
  return game.user?.character ?? null;
};

export const AttributeBadge = {
  _el: null,

  refresh() {
    const actor = myActor();
    if (!actor) return this.hide();

    const st = readStatus(actor.uuid);
    // Gate AND availability: the badge is the moment spending becomes possible,
    // so it needs both to be true, not either.
    if (!st?.ok || st.advances.available < 1 || !st.gate.open) return this.hide();

    injectStyles();
    if (!this._el) {
      const el = document.createElement("div");
      el.id = ROOT_ID;
      el.title = "Open your Status window";
      el.addEventListener("click", () => {
        globalThis.FUCompanion?.api?.attributes?.app?.open?.(myActor()?.uuid);
      });
      document.body.appendChild(el);
      this._el = el;
    }

    const n = st.advances.available;
    this._el.innerHTML =
      `<span class="ab-n">${n}</span>
       <span class="ab-t">Unspent Attribute Point${n === 1 ? "" : "s"}
         <span class="ab-s" style="display:block">Click to raise an attribute</span></span>`;
    this._el.style.bottom = `${dockBottom()}px`;
    this._nudgeStack();
  },

  hide() {
    if (!this._el) return;
    this._el.remove();
    this._el = null;
    this._nudgeStack();
  },

  /** Let the layers above settle now rather than on the next resize. */
  _nudgeStack() {
    try { globalThis.FUCompanion?.api?.MovementControlControllerBadge?.reposition?.(); } catch { /* optional */ }
  },
};

function schedule() {
  // One frame late: the Skill Point badge may be showing or hiding in the same
  // tick, and this badge's position depends on its measured height.
  requestAnimationFrame(() => { try { AttributeBadge.refresh(); } catch { /* non-fatal */ } });
}

Hooks.once("ready", () => {
  schedule();
  // The gate is scene + camp-phase driven, and the point total changes on write.
  for (const h of ["canvasReady", "updateScene", "updateActor", "controlToken"]) Hooks.on(h, schedule);
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.attributes = globalThis.FUCompanion.api.attributes ?? {};
  globalThis.FUCompanion.api.attributes.badge = AttributeBadge;
});
