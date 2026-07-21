// ============================================================================
// Unspent Skill Point badge.
//
// Appears at the side of the screen when the player arrives somewhere they can
// actually spend — a camp lobby or the title screen — carrying unspent points.
// Clicking it opens the level-up window.
//
// Deliberately NOT shown everywhere. A player levels up mid-session and keeps
// playing; nagging them during a boss fight about a decision they are not
// allowed to make yet is noise. The badge is the moment the gate opens.
//
// Anchors above the camp button rather than beside it — camp already owns that
// screen corner (bottom 80 / left 20, 64px), and two systems competing for the
// same pixels is how floating UI ends up overlapping.
// ============================================================================

import { LEVELUP, num } from "./levelup-const.js";
import { gateState } from "./levelup-gate.js";

const STYLE_ID = "oni-levelup-badge-style";
const ROOT_ID = "oni-levelup-badge";

// The bottom-left control stack, from the floor up:
//
//   camp / dungeon button row   bottom 80, 64 tall
//   THIS badge                  bottom 154, only when points are unspent
//   main controller badge       above whichever of the two is topmost
//
// The button row's geometry is read defensively from the Dungeon Pathing UI
// constants, matching how movementControl-controllerBadge.js docks. That badge
// measures this one and offsets itself, so when there is nothing to spend it
// simply falls back to the 154 slot.
const GAP = 10;
const dockBottom = () => {
  const btn = globalThis.DungeonPathing?.UI?.SCAN_BUTTON;
  return Number(btn?.BOTTOM ?? 80) + Number(btn?.SIZE ?? 64) + GAP;
};

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${ROOT_ID} { position: fixed; z-index: 99997; left: 20px;
  display: flex; align-items: center; gap: 9px; padding: 8px 14px 8px 10px;
  border-radius: 10px; cursor: pointer; border: 1px solid #8a6c45;
  background: linear-gradient(180deg,#5d4630,#41301c); color: #f6ecd8;
  font-family: Signika, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.45);
  animation: oni-lu-in .28s ease-out; }
#${ROOT_ID}:hover { background: linear-gradient(180deg,#6d543a,#4d3a22); }
#${ROOT_ID} .lub-n { min-width: 30px; height: 30px; padding: 0 6px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 17px;
  background: #2b2110; color: #ffd479; border: 1px solid #8a6c45;
  animation: oni-lu-pulse 2.4s ease-in-out infinite; }
#${ROOT_ID} .lub-t { font-size: 13px; font-weight: 600; line-height: 1.15; }
#${ROOT_ID} .lub-s { font-size: 10.5px; opacity: .75; }
@keyframes oni-lu-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes oni-lu-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,212,121,.0); }
  50% { box-shadow: 0 0 0 5px rgba(255,212,121,.16); } }
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} { animation: none; } #${ROOT_ID} .lub-n { animation: none; } }
`;
  document.head.appendChild(s);
}

/** The actor this user would be levelling, or null. */
function myActor() {
  const assigned = game.user?.character ?? null;
  if (assigned) return assigned;
  // A GM with no assigned character is not "a player with points to spend";
  // they manage levels from the sheet, so the badge stays out of their way.
  return null;
}

const Badge = {
  _el: null,

  refresh() {
    const actor = myActor();
    const points = actor ? num(actor.system?.props?.[LEVELUP.PROP.SKILL_POINT], 0) : 0;
    const open = gateState().open;
    if (!actor || points < 1 || !open) return this.hide();
    this.show(points);
  },

  show(points) {
    injectStyles();
    const fresh = !this._el;
    if (fresh) {
      const el = document.createElement("div");
      el.id = ROOT_ID;
      el.title = "Open the level-up window";
      el.addEventListener("click", () => {
        const a = globalThis.FUCompanion?.api?.levelUp;
        a?.open?.(myActor()?.uuid);
      });
      document.body.appendChild(el);
      this._el = el;
    }
    this._el.style.bottom = `${dockBottom()}px`;
    this._el.innerHTML =
      `<div class="lub-n">${points}</div>
       <div><div class="lub-t">Unspent Skill Point${points === 1 ? "" : "s"}</div>
       <div class="lub-s">Click to spend</div></div>`;
    // Height can change with the label ("Point" vs "Points"), so re-settle the
    // stack on every show, not only when the element is first created.
    this._restack();
  },

  hide() {
    if (!this._el) return;
    this._el.remove();
    this._el = null;
    this._restack();
  },

  // Let the controller badge re-measure. It docks above this one when present
  // and returns to its usual slot when not.
  _restack() {
    try { globalThis.FUCompanion?.api?.MovementControlControllerBadge?.reposition?.(); }
    catch { /* badge not on this scene */ }
  },
};

Hooks.once("ready", () => {
  Badge.refresh();

  // Points changed on my character.
  Hooks.on("updateActor", (doc) => {
    if (doc?.id === game.user?.character?.id) Badge.refresh();
  });
  // Camp phase lives in a world setting; the scene mode decides camp vs title.
  Hooks.on("updateSetting", (setting) => {
    if (String(setting?.key ?? "").includes("campPhase")) Badge.refresh();
  });
  Hooks.on("updateScene", () => Badge.refresh());
  Hooks.on("canvasReady", () => Badge.refresh());
  // A level awarded mid-session mints a point; the badge should be waiting the
  // moment the party reaches camp rather than only after some other event.
  Hooks.on("oni:expAwarded", () => Badge.refresh());

  const a = globalThis.FUCompanion?.api?.levelUp;
  if (a) a.badge = Badge;
});

export { Badge };
