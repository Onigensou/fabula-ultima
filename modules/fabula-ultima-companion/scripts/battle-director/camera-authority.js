// Camera Authority — our own camera rules, in our own system.
//
// Three jobs:
//   1. Keep a player's view inside the play area (the video-game bounding box).
//   2. Keep the play area out from under the chat sidebar, so nothing on the
//      map can hide behind chrome.
//   3. Get out of the way when a cinematic wants the camera.
//
// ── Coexistence with LockView, and why no migration is needed ───────────────
//
// LockView swaps Canvas.prototype.pan / animatePan per scene, from its own
// scene flags, on canvasReady:
//
//   its boundingBox flag ON  -> it installs overrides that call ITS constrain
//                               function. Our wrapper never runs. Old scenes
//                               behave exactly as they always have.
//   its boundingBox flag OFF -> it RESTORES Foundry's originals, which call
//                               this._constrainView — our wrapper. The scene
//                               is ours.
//
// So the handover is automatic and per scene. Leave the flag off on new scenes
// and they are ours; leave the hundred existing scenes alone and they are
// unchanged. Nothing has to be migrated, and both systems can be installed at
// once without fighting.
//
// ── Why _constrainView is the whole surface ────────────────────────────────
//
// Verified against the live client rather than assumed — every camera path
// funnels through it:
//
//   pan()               -> _constrainView
//   animatePan()        -> _constrainView
//   _onMouseWheel()     -> pan()
//   _onDragCanvasPan()  -> animatePan()
//
// One wrapper therefore covers mouse wheel, drag-pan, edge-scroll and every
// programmatic move, which is what LockView needed four prototype swaps to do.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
//
// Input suppression for exploration. movementControl-cameraRuntime already
// re-asserts the follow lock every tick, so a player's pan is undone the frame
// after it happens. Adding a second mechanism that also refuses the pan would
// mean two systems writing the same transform, which is how cameras start to
// stutter. The clamp below is enough to bound it.

import { log, warn } from "./logger.js";
import {
  stageOf, hasStageRect, restViewFor, viewportOf, pivotShift, panTo,
} from "./director-camera.js";

const FLAG_NS = "fabula-ultima-companion";
const SCENE_MODE_PATH = ["oniFabula", "general", "sceneMode"];

let _installed = false;
let _suspendCount = 0;
let _pendingReframe = false;
let _ro = null;
let _lastSidebarW = -1;
let _reframeTimer = null;

/* ── Suspension ─────────────────────────────────────────────────────────── */
//
// Counted, not boolean: nested or overlapping cinematics must not have the
// inner one's resume unlock the outer one's.

export function suspendCamera() {
  _suspendCount++;
  return () => resumeCamera();
}

export function resumeCamera() {
  _suspendCount = Math.max(0, _suspendCount - 1);
  if (_suspendCount === 0 && _pendingReframe) {
    _pendingReframe = false;
    // A sidebar toggle that arrived mid-shot is applied once the camera is free.
    scheduleReframe(0);
  }
}

export function isCameraSuspended() { return _suspendCount > 0; }

/* ── Scope ──────────────────────────────────────────────────────────────── */

function sceneModeOf(scene) {
  let node = scene?.flags?.[FLAG_NS];
  for (const k of SCENE_MODE_PATH) node = node?.[k];
  return typeof node === "string" ? node : null;
}

/**
 * Is this scene ours to clamp?
 *
 * Only when LockView is NOT already clamping it. Its flag being off is exactly
 * the signal that the scene was authored without it, which is the migration
 * story: new scenes simply do not tick the box.
 */
function isOurScene(scene) {
  if (!scene) return false;
  const lv = scene.flags?.LockView;
  if (lv && (lv.boundingBox || lv.lockPan || lv.lockZoom)) return false;
  return true;
}

function shouldConstrain(scene) {
  try {
    if (_suspendCount > 0) return false;
    if (game?.user?.isGM) return false;          // the GM is never fenced in
    if (!canvas?.ready) return false;
    return isOurScene(scene ?? canvas.scene);
  } catch (_) { return false; }
}

/* ── The clamp ──────────────────────────────────────────────────────────── */

function clampNum(v, lo, hi) {
  if (!Number.isFinite(v)) return (lo + hi) / 2;
  if (lo > hi) return (lo + hi) / 2;            // play area smaller than the view
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Confine the VISIBLE rect to the play area.
 *
 * The pivot renders at the window centre, but the visible centre is offset from
 * that by the reserved chrome, so the clamp is applied to the VISIBLE centre and
 * the pivot derived back from it. Clamping the pivot directly would let the play
 * area's right edge slide under the sidebar — the whole problem this exists for.
 *
 * ── Why the axes are clamped independently ────────────────────────────────
 *
 * "Keep the visible rect inside the stage" sounds right and is wrong: the stage
 * is 1682x788 (2.13:1) while a sidebar-reduced 1620x1027 viewport is 1.58:1. No
 * rect of that shape fits inside the stage while also SHOWING all of it, so that
 * rule forces a zoom of 1.30 and the player can never see the whole arena.
 *
 * Per axis instead:
 *   the visible extent fits within the stage  -> pan, bounded by the stage
 *   it does not                               -> bounded by the canvas, so the
 *                                                overflow lands on painted bleed
 *                                                rather than on void
 *
 * At rest framing on a v2 scene that yields exactly what a conflict wants: the
 * board is pinned horizontally (nothing to pan into) and only floats within the
 * bleed vertically.
 *
 * The zoom floor is the REST framing — you cannot zoom out past "the whole board
 * is visible" — raised by the canvas cover fit so a legacy scene with no bleed
 * can never show void.
 */
export function clampToPlayArea(view, scene = null) {
  const sc = scene ?? canvas?.scene ?? null;
  const stage = stageOf(sc);
  const vp = viewportOf();
  const ins = vp.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const visW = Math.max(200, vp.w - ins.left - ins.right);
  const visH = Math.max(200, vp.h - ins.top - ins.bottom);

  const d = canvas?.dimensions ?? null;
  const canvasRect = d
    ? { x: 0, y: 0, w: d.width, h: d.height }
    : { x: stage.x, y: stage.y, w: stage.w, h: stage.h };

  const restScale = Math.min(visW / stage.w, visH / stage.h);   // contain the stage
  const coverCanvas = Math.max(visW / canvasRect.w, visH / canvasRect.h);
  const floor = Math.max(restScale, coverCanvas);
  const scale = Math.max(Number(view?.scale) || floor, floor);

  const shift = pivotShift(ins, scale);
  const halfW = visW / scale / 2;
  const halfH = visH / scale / 2;

  const axis = (desired, half, sLo, sLen, cLo, cLen) => {
    if (half * 2 <= sLen) return clampNum(desired, sLo + half, sLo + sLen - half);
    if (half * 2 <= cLen) return clampNum(desired, cLo + half, cLo + cLen - half);
    return cLo + cLen / 2;
  };

  const cx = axis((Number(view?.x) || 0) - shift.x, halfW, stage.x, stage.w, canvasRect.x, canvasRect.w);
  const cy = axis((Number(view?.y) || 0) - shift.y, halfH, stage.y, stage.h, canvasRect.y, canvasRect.h);

  return { x: cx + shift.x, y: cy + shift.y, scale };
}

/* ── The wrapper ────────────────────────────────────────────────────────── */

// Foundry declares its classes as top-level . A class
// declaration binds in the GLOBAL LEXICAL environment, which is not the same
// thing as a property of globalThis — so globalThis.Canvas is undefined while
// a bare Canvas resolves perfectly. Reaching for globalThis.Canvas made the
// install silently no-op, which looked exactly like a working clamp that never
// fired. Resolve the bare binding, guarded for module-evaluation order.
function canvasClass() {
  try { return typeof Canvas !== "undefined" ? Canvas : (globalThis.Canvas ?? null); }
  catch (_) { return globalThis.Canvas ?? null; }
}

let _installReason = "not attempted";
export function cameraAuthorityStatus() {
  return {
    reason: _installReason,
    wrapped: !!canvasClass()?.prototype?.__fuCameraAuthority,
    suspended: _suspendCount > 0,
  };
}

// Idempotent and retried on canvasReady. A one-shot install is fragile here:
// the wrapper has to survive whatever else on the page reassigns camera
// prototypes, and a silent no-op would look exactly like a working clamp that
// simply never fires.
function installConstrainWrapper() {
  const proto = canvasClass()?.prototype;
  if (!proto) { _installReason = "no Canvas.prototype"; return false; }
  if (proto.__fuCameraAuthority) { _installReason = "already wrapped"; return true; }
  const original = proto._constrainView;
  if (typeof original !== "function") {
    _installReason = "_constrainView is " + typeof original;
    warn("camera-authority: Canvas.prototype._constrainView missing — not installed");
    return false;
  }
  proto._constrainView = function fuConstrainView(view) {
    const base = original.call(this, view);
    try {
      if (!shouldConstrain(this?.scene)) return base;
      return clampToPlayArea(base, this?.scene);
    } catch (e) {
      warn("camera-authority: clamp threw, falling back to core", e);
      return base;
    }
  };
  proto.__fuCameraAuthority = true;
  _installReason = "ok";
  return true;
}

/* ── Re-framing on a sidebar toggle ─────────────────────────────────────── */
//
// A conflict scene is framed to contain the stage. Opening the chat box makes
// the visible rect narrower, so that framing no longer holds and the right of
// the board goes under the chat. Re-frame when the sidebar's width settles.
//
// Conflict auto-collapses the sidebar on battle start, so in practice this fires
// for a player who deliberately opens chat mid-fight — a consequence of their
// own action, which is why a re-frame there reads as a response rather than a
// glitch.

function scheduleReframe(delay = 180) {
  clearTimeout(_reframeTimer);
  _reframeTimer = setTimeout(async () => {
    try {
      const scene = canvas?.scene;
      if (!canvas?.ready || !scene) return;
      if (!hasStageRect(scene)) return;             // only authored play areas
      if (isCameraSuspended()) { _pendingReframe = true; return; }
      if (!isOurScene(scene) && !game?.user?.isGM) return;
      await panTo(restViewFor(scene), { duration: 420, scene });
    } catch (e) { warn("camera-authority: reframe threw", e); }
  }, delay);
}

function watchSidebar() {
  const el = document.getElementById("sidebar");
  if (!el || _ro) return;
  _lastSidebarW = el.offsetWidth;
  // ResizeObserver rather than the collapseSidebar hook: that hook fires in the
  // COMPLETION callback of jQuery's animate, and only for the collapse toggle —
  // it misses a drag-resize entirely. Same reasoning as custom-ui/sidebar-anchor.
  _ro = new ResizeObserver(() => {
    const w = el.offsetWidth;
    if (Math.abs(w - _lastSidebarW) < 2) return;
    _lastSidebarW = w;
    scheduleReframe();
  });
  _ro.observe(el);
}

/* ── Boot ───────────────────────────────────────────────────────────────── */

export function initCameraAuthority() {
  if (_installed) return;
  _installed = true;

  const ok = installConstrainWrapper();

  Hooks.on("canvasReady", () => {
    // Let LockView's own canvasReady handler swap the prototypes first; ours
    // lives a level below on _constrainView, so ordering only matters for the
    // first framing pass.
    setTimeout(() => {
      try { installConstrainWrapper(); watchSidebar(); scheduleReframe(0); } catch (_) {}
    }, 300);
  });

  if (canvas?.ready) { watchSidebar(); }

  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.cameraAuthority = {
    suspend: suspendCamera,
    resume: resumeCamera,
    isSuspended: isCameraSuspended,
    clampToPlayArea,
    reframe: () => scheduleReframe(0),
    sceneModeOf,
    isOurScene,
    status: cameraAuthorityStatus,
    install: installConstrainWrapper,
  };

  log(`camera-authority: ${ok ? "installed" : "NOT installed"} (constrainView wrapper)`);
}
