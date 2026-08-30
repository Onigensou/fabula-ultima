// ============================================================================
// Battle Director — camera.
//
// Two jobs, both of which Foundry gets wrong for a conflict arena:
//
// ── 1. The stage rect ───────────────────────────────────────────────────────
//
// A conflict scene used to be exactly as big as its artwork, so the "play
// area" and the canvas were the same rectangle. v2 scenes are deliberately
// LARGER than the play area: the extra margin is painted bleed that exists so
// the camera has somewhere to move without showing the void.
//
// So the two concepts have to be separated. The STAGE is the rectangle the
// fight is composed to — token anchors, framing, walls. The CANVAS is the
// stage plus bleed. `stageOf()` returns the stage; on a legacy scene with no
// flag it returns the whole scene rect, which makes every caller collapse to
// exactly its old behaviour (scale 1, origin 0). That is not a compatibility
// shim, it is just what the maths does when the two rects coincide.
//
//   flags["fabula-ultima-companion"].conflict = {
//     version: 2,
//     stage: { x: 439, y: 241, w: 1682, h: 788 }
//   }
//
// Coordinates are CANVAS-space (the same space token x/y live in), not
// scene-local, so the padding offset is already accounted for.
//
// ── 2. Clamping ─────────────────────────────────────────────────────────────
//
// Foundry's own Canvas#_constrainView does NOT keep the camera on the map:
//
//   const minScale = 1 / Math.max(d.width/innerWidth, d.height/innerHeight, maxZoom);
//   ...
//   x = Math.clamp(x, -padX, d.width + padX);   // padX = 0.4 * viewport
//
// The min-zoom is a CONTAIN fit (`max` of the two ratios), so at minimum zoom
// the shorter axis overflows and you see black bars; and the pivot is allowed
// to travel 0.4 of a viewport PAST the canvas edge in every direction. That is
// why the battle-end victory pan currently sails off the right of a 1682-wide
// scene showing several hundred pixels of void.
//
// `clampView()` is the missing COVER fit: it raises the scale until the
// viewport fits inside the canvas, then pins the pivot half a viewport in from
// each edge. Applied to every director camera move, on v2 and legacy scenes
// alike.
//
// ── 3. Stage-space intent ───────────────────────────────────────────────────
//
// Camera moves are broadcast to every client, and every client has a different
// window size. Broadcasting an absolute {x, y, scale} therefore frames the shot
// differently for a GM on a 1440p monitor and a player on a laptop — and the
// small window hits the void first. `focusView()` resolves a stage-space
// intent (a point plus a zoom factor RELATIVE TO the rest framing) into a
// concrete view using the receiving client's own viewport. Senders broadcast
// intent; receivers resolve it locally.
//
// The pure half of this module (resolveStage / computeRestView / clampView /
// focusView) touches no Foundry global, so director-camera.test.mjs runs it in
// bare Node.
// ============================================================================

const FLAG_NS = "fabula-ultima-companion";
const STAGE_FLAG = "conflict";

/* ── Pure core ─────────────────────────────────────────────────────────── */

/**
 * Clamp that survives inverted bounds. When a viewport exactly fills an axis,
 * floating-point drift can leave `lo` a hair above `hi`; snapping to the
 * midpoint is the correct answer there (dead centre), not a NaN or a jump.
 */
function clamp(v, lo, hi) {
  if (!(hi > lo)) return (lo + hi) / 2;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Strict numeric coercion.
 *
 * `Number(null)` is 0 and `Number("")` is 0, so a flag with a null or blank
 * field would otherwise pass a bare Number.isFinite check and silently become
 * a legitimate coordinate of zero — a half-written stage rect would be
 * accepted as complete and the fight would compose against it. Numeric strings
 * ARE accepted, because these flags get hand-authored as JSON.
 */
function num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const finite = (n) => Number.isFinite(n);

/**
 * Pick the stage rect: the flag if it is complete and sane, else the fallback
 * (the scene's own rect). `explicit` tells callers which one they got, which
 * is what gates the rest-framing change to v2 scenes only.
 *
 * @param {object|null} flagStage  raw `flags[NS].conflict.stage`
 * @param {object} fallbackRect    {x, y, w, h} — normally the scene rect
 */
export function resolveStage(flagStage, fallbackRect) {
  const x = num(flagStage?.x), y = num(flagStage?.y);
  const w = num(flagStage?.w), h = num(flagStage?.h);
  if (finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0) {
    return { x, y, w, h, explicit: true };
  }
  const fx = num(fallbackRect?.x), fy = num(fallbackRect?.y);
  const fw = num(fallbackRect?.w), fh = num(fallbackRect?.h);
  if (finite(fx) && finite(fy) && finite(fw) && finite(fh) && fw > 0 && fh > 0) {
    return { x: fx, y: fy, w: fw, h: fh, explicit: false };
  }
  // Last resort: the historical conflict-scene size. Reaching this means the
  // scene document is malformed; a sane rect beats NaN propagating into a pan.
  return { x: 0, y: 0, w: 1682, h: 788, explicit: false };
}

/**
 * Rest framing: CONTAIN the stage in the viewport.
 *
 * Contain, not cover, is deliberate. Cover would crop the stage on any client
 * whose aspect differs from the stage's — and the stage is the part that must
 * always be visible. Containing means the leftover on the short axis is filled
 * by bleed art instead of black, which is exactly what the bleed is for.
 */
export function computeRestView(stage, viewport) {
  const scale = Math.min(viewport.w / stage.w, viewport.h / stage.h);
  return { x: stage.x + stage.w / 2, y: stage.y + stage.h / 2, scale };
}

/**
 * Force the visible rectangle to lie inside `canvasRect`.
 *
 * Raises scale first (a viewport bigger than the canvas can never be placed
 * legally), then pins the pivot. `canvasRect` is Foundry's
 * `canvas.dimensions.rect` shape: {x, y, width, height}.
 */
export function clampView(view, canvasRect, viewport) {
  const need = Math.max(viewport.w / canvasRect.width, viewport.h / canvasRect.height);
  const scale = Math.max(Number(view?.scale) || need, need);
  const vw = viewport.w / scale;
  const vh = viewport.h / scale;
  return {
    x: clamp(Number(view?.x), canvasRect.x + vw / 2, canvasRect.x + canvasRect.width - vw / 2),
    y: clamp(Number(view?.y), canvasRect.y + vh / 2, canvasRect.y + canvasRect.height - vh / 2),
    scale,
  };
}

/**
 * Resolve a stage-space intent into a clamped concrete view.
 *
 * `zoom` is a multiple of the REST scale, so 1 = the resting framing and 1.5 =
 * half again as close, on every client regardless of window size.
 */
export function focusView({ point, zoom = 1 }, { stage, canvasRect, viewport }) {
  const rest = computeRestView(stage, viewport);
  const target = {
    x: finite(Number(point?.x)) ? Number(point.x) : rest.x,
    y: finite(Number(point?.y)) ? Number(point.y) : rest.y,
    scale: rest.scale * (Number(zoom) || 1),
  };
  return clampView(target, canvasRect, viewport);
}

/* ── Foundry-facing wrappers ───────────────────────────────────────────── */

/** This client's viewport in CSS pixels. */
export function viewportOf() {
  return {
    w: (typeof window !== "undefined" && window.innerWidth) || 1920,
    h: (typeof window !== "undefined" && window.innerHeight) || 1080,
  };
}

/**
 * The stage rect for a scene, in canvas coordinates.
 *
 * The fallback is the scene's own rect offset by the padding origin, so a
 * padded legacy scene still resolves to where its artwork actually is rather
 * than to (0,0).
 */
export function stageOf(scene) {
  const flagStage = scene?.flags?.[FLAG_NS]?.[STAGE_FLAG]?.stage ?? null;
  const d = scene?.dimensions ?? null;
  const fallback = d
    ? { x: d.sceneX ?? 0, y: d.sceneY ?? 0, w: d.sceneWidth ?? scene?.width, h: d.sceneHeight ?? scene?.height }
    : { x: 0, y: 0, w: scene?.width, h: scene?.height };
  return resolveStage(flagStage, fallback);
}

/** Is this scene authored against the v2 stage/bleed split? */
export function hasStageRect(scene) {
  return stageOf(scene).explicit === true;
}

/** The live canvas rect, or a computed one when the scene is not drawn yet. */
function canvasRectOf(scene = null) {
  const live = globalThis.canvas?.dimensions?.rect;
  const sameScene = !scene || globalThis.canvas?.scene?.id === scene.id;
  if (live && sameScene) return live;
  const d = scene?.dimensions;
  if (d) return { x: 0, y: 0, width: d.width, height: d.height };
  return { x: 0, y: 0, width: scene?.width ?? 1682, height: scene?.height ?? 788 };
}

/** Rest framing for a scene on THIS client. */
export function restViewFor(scene) {
  const view = computeRestView(stageOf(scene), viewportOf());
  return clampView(view, canvasRectOf(scene), viewportOf());
}

/** Clamp an absolute view against the current canvas. */
export function clampToCanvas(view, scene = null) {
  return clampView(view, canvasRectOf(scene), viewportOf());
}

/** Resolve a broadcast stage-space intent on THIS client. */
export function resolveIntent({ point, zoom = 1 }, scene = null) {
  return focusView({ point, zoom }, {
    stage: stageOf(scene ?? globalThis.canvas?.scene ?? null),
    canvasRect: canvasRectOf(scene),
    viewport: viewportOf(),
  });
}

/**
 * Clamped pan. Every director camera move should go through here rather than
 * calling canvas.animatePan directly, so nothing can leave the artwork.
 */
export async function panTo(view, { duration = 500, scene = null } = {}) {
  const c = globalThis.canvas;
  if (!c?.ready || !c.animatePan) return null;
  const v = clampToCanvas(view, scene);
  await c.animatePan({ x: v.x, y: v.y, scale: v.scale, duration });
  return v;
}

/**
 * Apply rest framing and make it stick.
 *
 * Setting the view once is not enough on a COLD scene draw. Other canvasReady
 * consumers pan too — LockView in particular reassigns Canvas.prototype.pan
 * and re-applies its own view from a `canvasReady` handler — and on the first
 * ever draw of an arena the artwork is still downloading, so those handlers
 * land AFTER the director's pan instead of before it. Observed live: the first
 * launch of a new 2560x1270 arena settled at scale 1.1719 instead of 1.1415,
 * cropping ~22px off each side of the stage; the second and third launches,
 * with the texture cached, won the race and were correct. A race that only
 * shows up on a cold load is exactly the one that will hit a player and not
 * the GM who authored the scene.
 *
 * Rather than depend on ordering, assert the framing and check it held. Cheap
 * (one pan, one comparison) and indifferent to who else is panning.
 */
export async function settleRestFraming(scene, { attempts = 3, gapMs = 220 } = {}) {
  if (!hasStageRect(scene)) return null;
  const c = globalThis.canvas;
  let want = null;
  for (let i = 0; i < attempts; i++) {
    want = restViewFor(scene);
    try { scene._viewPosition = { x: want.x, y: want.y, scale: want.scale }; } catch (_) {}
    if (!c?.ready || c.scene?.id !== scene.id) return want;
    try { c.pan({ x: want.x, y: want.y, scale: want.scale }); } catch (_) {}
    if (i === attempts - 1) break;
    await new Promise((r) => setTimeout(r, gapMs));
    const s = c.stage?.scale?.x, px = c.stage?.pivot?.x, py = c.stage?.pivot?.y;
    const held = Math.abs(s - want.scale) < 1e-3
              && Math.abs(px - want.x) < 1
              && Math.abs(py - want.y) < 1;
    if (held) break;
  }
  return want;
}

/** Snap (no animation) — used when restoring a remembered viewport. */
export function panSnap(view, { scene = null } = {}) {
  const c = globalThis.canvas;
  if (!c?.ready || !c.pan) return null;
  const v = clampToCanvas(view, scene);
  c.pan({ x: v.x, y: v.y, scale: v.scale });
  return v;
}

/* ── Public API ────────────────────────────────────────────────────────── */
//
// Published because several camera consumers — battleEnd-fx-listener among
// them — ship as CLASSIC scripts in module.json and therefore cannot import.
// Without this they would have to re-implement the clamp inline, which is
// exactly how the two copies would drift apart.
//
// `init` rather than `ready`: a classic script's Hooks.once("ready") body runs
// before some module code would otherwise have published, and a listener that
// finds no API silently falls back to unclamped panning.

export const CameraApi = {
  stageOf, hasStageRect, restViewFor, settleRestFraming, clampToCanvas, resolveIntent,
  panTo, panSnap, viewportOf,
  resolveStage, computeRestView, clampView, focusView,
};

// globalThis-qualified: a bare `Hooks` would be a ReferenceError under the
// bare-Node test harness, which imports this module directly.
globalThis.Hooks?.once?.("init", () => {
  try {
    const mod = globalThis.game?.modules?.get(FLAG_NS);
    if (mod) { mod.api = mod.api || {}; mod.api.camera = CameraApi; }
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.camera = CameraApi;
  } catch (e) {
    console.warn("[Director:Camera] API publish failed", e);
  }
});
