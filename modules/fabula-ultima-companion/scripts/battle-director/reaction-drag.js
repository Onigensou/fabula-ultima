// Reaction drag — pick a reaction card up out of your hand and drop it on the
// action card, as in a digital card game. Click still works; a press only turns
// into a drag after the pointer moves DRAG_SLOP px.
//
// A port of Fabula Arcana's startDrag (assets/fabula-arcana/duel.html): the 7 px
// threshold, the tilt with your speed, the dashed / solid drop outlines, the
// 220 ms slide home on a miss. What you hold is the whole card (user's call,
// 2026-11-20): 108% over your hand, 90% once it leaves it, and over the action
// card it leans a little toward the empty slot that opens there (the magnet,
// "Light" = 0.12 of the way) at 72%.
//
// The card in your hand can't leave its clip box, so you drag a COPY drawn above
// everything (the "ghost"); the hand card stays behind, faded, holding its place.
// Dropped on target, the ghost does not snap back: it TUCKS into the empty slot
// in the Reactions box, shrinking onto its own icon and fading, and the caller
// shows a see-through blinking badge there while the reaction's decision runs (a
// target pick, the host). Nothing is left covering the action card. When the host
// confirms, the badge lands where it is; a cancel or refusal grows the card back
// out of the slot and slides it home (user's call, 2026-11-21, after the live
// test). With no slot to tuck into it parks where it was let go (70%, glowing).
//
// This module only moves the card. Everything it means is decided by its caller
// through the hooks below, so the pills stay the single source of truth.
//
// Approved mockup: claude.ai/artifact/PRoeSXjL8cuiA8be4VEQ6K ("Card all the way").

import { playSfx, preloadSfx } from "./director-sfx.js";

const TAG = "[ReactionDrag]";
const STYLE_ID = "fud-rxdg-style";
const LAYER_ID = "rxdg-layer";

const DRAG_SLOP = 7;           // px of movement before a press is a drag (Fabula Arcana)
const SCALE_HAND = 1.08;       // over your hand
const SCALE_BOARD = 0.9;       // off it, so it doesn't hide the board
const SCALE_OVER = 0.72;       // over the action card with the magnet on
const SCALE_PARK = 0.7;        // parked, waiting for the host
const MAGNET = 0.12;           // how far the held card leans toward the slot (user picked "Light" live, 2026-11-21)
const ZONE_PAD = 24;           // px of give around the action card
const TILT_MAX = 14;           // degrees
const TILT_K = 0.02;           // degrees per px/s of horizontal speed (FA: ×1.2 per event)
const FOLLOW = 26, SIZE_EASE = 14, TILT_EASE = 18;   // per-second smoothing rates
const HOME_MS = 220;           // the slide home (FA snap-back)
const PARK_MS = 160;
const TUCK_MS = 240;           // dropped: the card folds onto its icon in the slot

const SOUND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
// Levels match the battle UI mix (reaction-landing.js LANDING_CUE): Cursor_Decide1
// is a very quiet file, Book1 a very loud one (peak -0.9 dB).
const PICK_CUE = Object.freeze({ url: `${SOUND}Cursor_Decide1.wav`, vol: 0.7 });
const MISS_CUE = Object.freeze({ url: `${SOUND}Soundboard/Book1.ogg`, vol: 0.16 });
export function preloadDragCues() { return preloadSfx([PICK_CUE.url, MISS_CUE.url]).catch(() => {}); }
const cue = (c) => { try { playSfx(c.url, c.vol); } catch (e) { console.warn(TAG, "sound failed", e); } };

const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

let _drag = null;              // the one drag in progress
export const isDragging = () => !!_drag;

function layer() {
  ensureStyles();
  let l = document.getElementById(LAYER_ID);
  if (!l) { l = document.createElement("div"); l.id = LAYER_ID; document.body.appendChild(l); }
  return l;
}

/** One transform shape for every state, so any two animate into each other:
 *  the card's local point L sits at T + L, turned and scaled about itself. */
function xf(T, L, rot, s) {
  return `translate(${T.x.toFixed(1)}px,${T.y.toFixed(1)}px) translate(${L.x.toFixed(1)}px,${L.y.toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${s.toFixed(4)}) translate(${(-L.x).toFixed(1)}px,${(-L.y).toFixed(1)}px)`;
}
/** T for a card drawn at `home` (its top-left, screen px) at screen scale k, in the shape above. */
const homeT = (home, L, k) => ({ x: home.x - L.x + k * L.x, y: home.y - L.y + k * L.y });

/**
 * Make a hand card draggable. Hooks (all screen px):
 *   canStart()            may this card be picked up now?
 *   scale()               the hand's screen scale (local card px → screen px)
 *   home()                the card's untransformed top-left on screen
 *   zone()                the action card's rect, or null (no drop target)
 *   onPickUp()            the drag started
 *   onOver(over)          the pointer entered / left the drop target
 *   slotCentre()          where the empty slot is, for the magnet (or null)
 *   onDrop(ghost)         let go on target: return true to accept (the ghost is
 *                         now tucked or parked and belongs to the caller), false to send it home
 *   parkAt()              after an accepted drop: { rect, iconEl } — the slot to tuck
 *                         into and the hand card's icon to shrink onto — or null to park
 *   onMiss()              let go anywhere else; the card is on its way home
 * Returns a function that detaches it.
 */
export function makeDraggable(el, hooks) {
  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (_drag || !hooks.canStart?.()) return;
    e.preventDefault();                     // no text selection, no native image drag
    const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
    let started = false;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_SLOP) return;
        if (_drag || !hooks.canStart?.()) { stop(); return; }
        started = true;
        begin(el, hooks, x0, y0);
      }
      if (_drag) _drag.ptr = { x: ev.clientX, y: ev.clientY };
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      stop();
      if (started && _drag?.el === el) {
        // The click that follows this pointerup is the drag's, not a "use".
        el.addEventListener("click", swallowClick, { capture: true, once: true });
        setTimeout(() => el.removeEventListener("click", swallowClick, { capture: true }), 0);
        end(ev.type === "pointercancel");
      }
    };
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
  el.addEventListener("pointerdown", down);
  return () => el.removeEventListener("pointerdown", down);
}
function swallowClick(ev) { ev.stopPropagation(); ev.preventDefault(); }

function begin(el, hooks, x, y) {
  const k = hooks.scale?.() || 1;
  const home = hooks.home?.() ?? { x: 0, y: 0 };
  const w = el.offsetWidth, h = el.offsetHeight;
  const L = { x: clamp((x - home.x) / k, 12, w - 12), y: clamp((y - home.y) / k, 12, h - 12) };
  const wrap = document.createElement("div");
  wrap.className = "rxdg-wrap";
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
  const clone = el.cloneNode(true);
  clone.classList.remove("is-held", "is-busy", "is-incoming", "is-dealt", "is-leaving", "rxdg-source");
  clone.classList.add("rxdg-clone");
  clone.removeAttribute("style");
  wrap.appendChild(clone);
  layer().appendChild(wrap);
  el.classList.add("rxdg-source");
  // It starts where the hovered card was drawn (lifted 28 px, 112%), so the pick-up doesn't jump.
  const lift = { x: home.x, y: home.y - 28 * k };
  _drag = {
    el, hooks, wrap, k, home, L, w, h,
    ptr: { x, y }, T: homeT(lift, L, k * 1.12), s: k * 1.12, tilt: 0,
    over: false, last: performance.now(), raf: 0, rm: reducedMotion(),
  };
  const z = hooks.zone?.();
  document.body.classList.add("rxdg-dragging");
  markZone(true, false);
  cue(PICK_CUE);
  try { hooks.onPickUp?.(); } catch (e) { console.warn(TAG, "onPickUp threw", e); }
  if (!z) console.warn(TAG, "no drop target on screen");
  apply();
  _drag.raf = requestAnimationFrame(tick);
}

function apply() {
  const d = _drag;
  d.wrap.style.transform = xf(d.T, d.L, d.tilt, d.s);
}

function inZone(z, p) {
  return !!z && p.x >= z.left - ZONE_PAD && p.x <= z.right + ZONE_PAD && p.y >= z.top - ZONE_PAD && p.y <= z.bottom + ZONE_PAD;
}

function tick(now) {
  const d = _drag;
  if (!d) return;
  const dt = Math.min(0.05, (now - d.last) / 1000);
  d.last = now;
  if (dt > 0) {
    const z = d.hooks.zone?.() ?? null;
    const over = inZone(z, d.ptr);
    if (over !== d.over) {
      d.over = over;
      markZone(true, over);
      try { d.hooks.onOver?.(over); } catch (e) { console.warn(TAG, "onOver threw", e); }
    }
    let ax = d.ptr.x, ay = d.ptr.y;
    let s = d.ptr.y > d.home.y - 20 * d.k ? SCALE_HAND : SCALE_BOARD;
    const slot = over && !d.rm ? d.hooks.slotCentre?.() : null;
    if (slot) { ax += (slot.x - ax) * MAGNET; ay += (slot.y - ay) * MAGNET; s = SCALE_OVER; }
    const follow = d.rm ? 1 : 1 - Math.exp(-dt * FOLLOW);
    const px = d.T.x;
    // The grab point L, at screen scale s·k, sits under the (pulled) pointer.
    d.T.x += (ax - d.L.x - d.T.x) * follow;
    d.T.y += (ay - d.L.y - d.T.y) * follow;
    d.s += (s * d.k - d.s) * (d.rm ? 1 : 1 - Math.exp(-dt * SIZE_EASE));
    const tiltT = d.rm ? 0 : clamp((d.T.x - px) / dt * TILT_K, -TILT_MAX, TILT_MAX);
    d.tilt += (tiltT - d.tilt) * (1 - Math.exp(-dt * TILT_EASE));
    apply();
  }
  d.raf = requestAnimationFrame(tick);
}

function markZone(on, over) {
  const card = document.querySelector("#fud-bf-mirror-root .fud-bf-card");
  card?.classList.toggle("rxdg-dropok", on);
  card?.classList.toggle("rxdg-dropover", on && over);
}

async function end(cancelled) {
  const d = _drag;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  _drag = null;
  document.body.classList.remove("rxdg-dragging");
  markZone(false, false);
  let accepted = false;
  if (d.over && !cancelled) {
    try { accepted = !!d.hooks.onDrop?.(d.wrap); } catch (e) { console.warn(TAG, "onDrop threw", e); }
  }
  if (accepted) {
    let at = null;
    try { at = d.hooks.parkAt?.() ?? null; } catch (e) { console.warn(TAG, "parkAt threw", e); }
    if (!tuck(d, at)) park(d);
    return;
  }
  try { d.hooks.onMiss?.(); } catch (e) { console.warn(TAG, "onMiss threw", e); }
  await sendHome(d.wrap, d.el, { home: d.hooks.home?.() ?? d.home, k: d.hooks.scale?.() || d.k, L: d.L });
}

// Parked: straightens and settles to 70% where it was let go, glowing, until the
// host confirms (it flies) or it is sent home.
function park(d) {
  const w = d.wrap;
  w.classList.add("rxdg-parked");
  w._rxdg = { el: d.el, L: d.L, w: d.w, h: d.h };
  const to = xf(d.T, d.L, 0, SCALE_PARK * d.k);
  if (d.rm) { w.style.transform = to; return; }
  w.animate([{ transform: w.style.transform }, { transform: to }], { duration: PARK_MS, easing: "cubic-bezier(.2,.9,.3,1)" });
  w.style.transform = to;
}

// Tucked: the card shrinks onto its icon over the slot and fades as it gets there.
// It stays (invisible) at that spot, so a cancel can grow it back out from there.
function tuck(d, at) {
  const rect = at?.rect;
  if (!rect || !(rect.width > 0)) return false;
  const w = d.wrap;
  const er = d.el.getBoundingClientRect(), ir = at.iconEl?.getBoundingClientRect?.();
  const ke = er.width / (d.el.offsetWidth || er.width) || 1;
  const ic = ir && ir.width > 0
    ? { x: (ir.left - er.left + ir.width / 2) / ke, y: (ir.top - er.top + ir.height / 2) / ke, w: ir.width / ke }
    : { x: d.w / 2, y: d.h / 2, w: d.w };
  const s = rect.width / ic.w;
  const to = xf(tuckT(rect, ic, d.L, s), d.L, 0, s);
  w.classList.add("rxdg-tucked");
  w._rxdg = { el: d.el, L: d.L, w: d.w, h: d.h };
  if (!d.rm) {
    w.animate([{ transform: w.style.transform, opacity: 1 }, { opacity: 1, offset: 0.45 }, { transform: to, opacity: 0 }],
      { duration: TUCK_MS, easing: "cubic-bezier(.5,0,.2,1)" });
  }
  w.style.transform = to;
  w.style.opacity = "0";
  return true;
}
/** T that puts the card's local point ic (its icon centre) on the centre of rect at scale s. */
const tuckT = (rect, ic, L, s) => ({
  x: rect.left + rect.width / 2 - L.x - s * (ic.x - L.x),
  y: rect.top + rect.height / 2 - L.y - s * (ic.y - L.y),
});
export const isTucked = (wrap) => !!wrap?.classList?.contains("rxdg-tucked");

/**
 * Slide a ghost (held, parked or tucked) back into its hand card's place, then remove it
 * and show the hand card again. Plays Book1. Safe to call on a ghost that is gone.
 */
export async function sendHome(wrap, el, { home = null, k = null, L = null } = {}) {
  if (!wrap?.isConnected) { el?.classList.remove("rxdg-source"); return; }
  const meta = wrap._rxdg ?? {};
  const LL = L ?? meta.L ?? { x: 0, y: 0 };
  cue(MISS_CUE);
  const h = home ?? homeOf(el);
  const kk = k ?? scaleOf(el);
  try {
    if (h && el?.isConnected && !reducedMotion()) {
      const to = xf(homeT(h, LL, kk), LL, 0, kk);
      // A tucked card grows back out of the slot: visible again within the first third.
      const from = isTucked(wrap) ? [{ transform: wrap.style.transform, opacity: 0 }, { opacity: 1, offset: 0.3 }] : [{ transform: wrap.style.transform }];
      wrap.style.opacity = "";
      await wrap.animate([...from, { transform: to, opacity: 1 }], { duration: HOME_MS, easing: "cubic-bezier(.3,.8,.3,1)", fill: "forwards" }).finished.catch(() => {});
    }
  } finally {
    wrap.remove();
    el?.classList.remove("rxdg-source");
  }
}

/** Drop a ghost with no animation (the hand is being torn down). */
export function discardGhost(wrap, el) {
  wrap?.remove();
  el?.classList.remove("rxdg-source");
}

/** Cancel a drag in progress without dropping anything (teardown, card closed). */
export function abortDrag() {
  const d = _drag;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  _drag = null;
  document.body.classList.remove("rxdg-dragging");
  markZone(false, false);
  try { d.hooks.onMiss?.(); } catch {}
  discardGhost(d.wrap, d.el);
}

// Where a hand card is drawn when it isn't being dragged: its clip box plus its
// own offsets, at the clip box's screen scale.
function scaleOf(el) {
  const clip = el?.offsetParent;
  if (!clip) return 1;
  return clip.getBoundingClientRect().width / (clip.offsetWidth || 1) || 1;
}
function homeOf(el) {
  const clip = el?.offsetParent;
  if (!clip || !el.isConnected) return null;
  const r = clip.getBoundingClientRect(), k = scaleOf(el);
  return { x: r.left + el.offsetLeft * k, y: r.top + el.offsetTop * k };
}
export { homeOf as handCardHome, scaleOf as handCardScale };
// For reaction-drag.test.mjs (bare Node): the pure geometry.
export const _geom = Object.freeze({ xf, homeT, tuckT, inZone, DRAG_SLOP, ZONE_PAD, MAGNET });

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 121; }
.rxdg-wrap { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; will-change: transform;
  filter: drop-shadow(0 22px 22px rgba(0,0,0,.55)) drop-shadow(0 0 10px rgba(226,194,126,.75)); }
.rxdg-clone { position: absolute !important; left: 0 !important; top: 0 !important; margin: 0 !important;
  transform: none !important; translate: none !important; transition: none !important; animation: none !important;
  visibility: visible !important; opacity: 1 !important; pointer-events: none !important; box-shadow: none !important; }
@keyframes rxdgPark { from { filter: drop-shadow(0 12px 14px rgba(0,0,0,.5)) drop-shadow(0 0 6px rgba(226,194,126,.6)); }
  to { filter: drop-shadow(0 12px 14px rgba(0,0,0,.5)) drop-shadow(0 0 16px rgba(244,201,93,.95)); } }
.rxdg-wrap.rxdg-parked { animation: rxdgPark 900ms ease-in-out infinite alternate; }
/* The card left in your hand while you hold (or have parked) its copy. */
.rxh-clip .rxh-card.rxdg-source, .rxh-clip .rxh-card.rxdg-source:hover {
  opacity: .28 !important; transform: none !important; translate: none !important; pointer-events: none !important;
  box-shadow: 0 0 0 2px #b7935a !important; }
body.rxdg-dragging, body.rxdg-dragging * { cursor: grabbing !important; }
body.fud-rx-hand .rxh-clip .rxh-card.is-live:not(.is-held) { cursor: grab; }
.rxh-card img { -webkit-user-drag: none; user-select: none; }
.rxh-card { touch-action: none; user-select: none; -webkit-user-select: none; }
/* Drop target, the same two states as Fabula Arcana. */
#fud-bf-mirror-root .fud-bf-card.rxdg-dropok { outline: 3px dashed #c9a44a; outline-offset: 7px; }
#fud-bf-mirror-root .fud-bf-card.rxdg-dropover { outline: 3px solid #f4c95d; outline-offset: 7px; box-shadow: 0 0 26px 4px rgba(244,201,93,.75); }
@media (prefers-reduced-motion: reduce) { .rxdg-wrap.rxdg-parked { animation: none; } }
`;
  document.head.appendChild(st);
}
