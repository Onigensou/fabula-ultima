// ============================================================================
// Dungeon zoom — how close the camera sits during Dungeon mode.
//
// Dungeon mode locks the camera onto the party (dp-scan-mode's follow ticker),
// but the ticker re-applies whatever zoom the player already has, so the mouse
// wheel used to zoom freely: in to the sprites' pixels, or out until the whole
// map was on screen. This decides the zoom instead.
//
//   Outside Scan  one fixed zoom; the wheel does nothing.
//   Scan Mode     the wheel zooms, inside a range.
//   Always        never closer than MAX_ZOOM (sprites go soft beyond it).
//
// ── Why zoom is counted in TILES, with a map-size cap ──────────────────────
//
// A single zoom number cannot work across our maps. The distance between
// linked dungeon tiles (one "step") runs from 85 px (Wyrmwood_Map007) to
// 315 px (Valley_Map013), so one zoom would show two steps on one map and
// seven on another. So the zoom is solved per map from its own step:
//
//   scale = (visible height / 2) / (tiles * step)
//
// — "tiles" steps visible above and below the party (more side to side, the
// screen being wider than tall).
//
// The maps are also small next to a 1080p screen: at 3 tiles about half of
// them would already show 60-100% of the map, and Scan would have nothing
// left to reveal. So each zoom is also capped by how much of the MAP's area
// may be on screen at once, and whichever of the two is closer wins:
//
//   scale >= sqrt(visible area / (cap * map area))
//
// Both use the receiving client's own visible area (window minus sidebar), so
// two players on different screens see the same number of tiles.
//
// The pure half (DEFAULTS, medianStep, solveDungeonZoom, applyZoomRule) takes
// plain values; dungeon-zoom.test.mjs runs it in bare Node. The Foundry half
// below it reads the live scene, the dungeon state and the sidebar.
// ============================================================================

import { viewportOf } from "./director-camera.js";

const FLAG_NS = "fabula-ultima-companion";

/** Defaults; each of the three tile counts can be overridden per scene. */
export const DEFAULTS = Object.freeze({
  normalTiles: 3,      // steps visible above/below the party outside Scan
  normalCap: 0.35,     // at most this share of the map on screen outside Scan
  scanTiles: 6,        // Scan may zoom out to this many steps ...
  scanCap: 0.60,       // ... but never past this share of the map
  scanZoomIn: 1.25,    // Scan may zoom in to normal x this
  scanPanTiles: 5,     // Scan pan radius, in steps
  maxZoom: 2.5,        // hard ceiling, any mode
  fallbackStep: 130,   // map with no measurable links (median of all dungeons)
});

/** Per-scene override keys, under flags[NS].oniFabula.general. */
export const SCENE_KEYS = Object.freeze({
  normalTiles: "dungeonZoomTiles",
  scanTiles: "dungeonScanTiles",
  scanPanTiles: "dungeonScanPanTiles",
});

/* ── Pure core ─────────────────────────────────────────────────────────── */

const pos = (v) => (Number.isFinite(v) && v > 0 ? v : NaN);

/**
 * Median distance between linked tile centres.
 *
 * Median, not mean: a map's few long bridge links would otherwise drag the
 * step up and zoom every map out. `centerOf(id)` returns {x, y} or null; links
 * to a missing tile are skipped.
 */
export function medianStep(links, centerOf, fallback = DEFAULTS.fallbackStep) {
  const d = [];
  for (const l of Object.values(links ?? {})) {
    const a = centerOf(l?.a), b = centerOf(l?.b);
    if (!a || !b) continue;
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    if (len > 0) d.push(len);
  }
  if (!d.length) return { step: fallback, links: 0 };
  d.sort((p, q) => p - q);
  const m = d.length >> 1;
  const step = d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
  return { step, links: d.length };
}

/**
 * The three zoom numbers for one map on one client.
 *
 * @param {object} p
 * @param {number} p.step      tile step in world px
 * @param {{w,h}}  p.visible   visible canvas area in CSS px (window minus chrome)
 * @param {{w,h}}  p.map       scene rect (sceneWidth/sceneHeight)
 * @param {object} [p.tuning]  any DEFAULTS keys to override
 * @returns {{normal, scanOut, scanIn, scanRadius, step}}
 *   normal   fixed scale outside Scan
 *   scanOut  furthest-out scale in Scan (<= normal)
 *   scanIn   closest-in scale in Scan (>= normal)
 *   scanRadius  Scan pan radius in world px
 */
export function solveDungeonZoom({ step, visible, map, tuning = {} }) {
  const t = { ...DEFAULTS, ...tuning };
  const s = pos(step) || t.fallbackStep;
  const vw = pos(visible?.w) || 1620, vh = pos(visible?.h) || 1027;
  const mw = pos(map?.w), mh = pos(map?.h);

  const byTiles = (n) => (vh / 2) / (Math.max(0.5, n) * s);
  // No map size → no cap (a cap of 0 never wins the max below).
  const byCap = (cap) => (mw && mh && cap > 0) ? Math.sqrt((vw * vh) / (cap * mw * mh)) : 0;

  const normal = Math.min(t.maxZoom, Math.max(byTiles(t.normalTiles), byCap(t.normalCap)));
  const scanOut = Math.min(normal, Math.max(byTiles(t.scanTiles), byCap(t.scanCap)));
  const scanIn = Math.max(normal, Math.min(t.maxZoom, normal * t.scanZoomIn));
  return { normal, scanOut, scanIn, scanRadius: t.scanPanTiles * s, step: s };
}

/** The scale a requested view is allowed to have. */
export function applyZoomRule(requested, limits, scanning) {
  if (!scanning) return limits.normal;
  const r = Number(requested);
  if (!Number.isFinite(r)) return limits.normal;
  return Math.min(limits.scanIn, Math.max(limits.scanOut, r));
}

/* ── Foundry-facing half ───────────────────────────────────────────────── */

// Live, in-memory tuning (console only; a reload resets it). Lets the values be
// tried on a real client before they are written into DEFAULTS.
let _tuning = {};
let _stepCache = { sceneId: null, step: DEFAULTS.fallbackStep, links: 0 };

const dpState = () => globalThis.__ONI_DUNGEON_PATHING__?.state ?? null;
const DP = () => globalThis.DungeonPathing ?? null;

function generalOf(scene) {
  return scene?.flags?.[FLAG_NS]?.oniFabula?.general ?? null;
}

function sceneTuning(scene) {
  const g = generalOf(scene) ?? {};
  const out = {};
  for (const [k, key] of Object.entries(SCENE_KEYS)) {
    const n = Number(g[key]);
    if (g[key] !== null && g[key] !== "" && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

function stepOf(scene) {
  if (!scene) return DEFAULTS.fallbackStep;
  if (_stepCache.sceneId === scene.id) return _stepCache.step;
  const links = scene.flags?.[FLAG_NS]?.dungeonPathing?.links ?? {};
  const centerOf = (id) => {
    const t = id ? scene.tiles?.get?.(id) : null;
    return t ? { x: t.x + t.width / 2, y: t.y + t.height / 2 } : null;
  };
  const r = medianStep(links, centerOf);
  _stepCache = { sceneId: scene.id, step: r.step, links: r.links };
  return r.step;
}

/** Is the dungeon zoom rule in charge of this client's camera right now? */
export function dungeonZoomActive(scene) {
  try {
    if (game?.user?.isGM) return false;                 // the GM is never fenced in
    const st = dpState();
    if (!st?.active) return false;
    if (scene && st.sceneId && st.sceneId !== scene.id) return false;
    if (DP()?.FastTravel?.active) return false;         // the map view pans/zooms freely
    if (generalOf(scene)?.sceneMode !== "dungeon") return false;
    return true;
  } catch { return false; }
}

export function isScanning() {
  try { return !!DP()?.ScanMode?.active; } catch { return false; }
}

/** Zoom limits for `scene` on this client. */
export function dungeonZoomLimits(scene = globalThis.canvas?.scene) {
  const vp = viewportOf();
  const ins = vp.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const d = globalThis.canvas?.scene === scene ? globalThis.canvas?.dimensions : scene?.dimensions;
  return solveDungeonZoom({
    step: stepOf(scene),
    visible: { w: Math.max(200, vp.w - ins.left - ins.right), h: Math.max(200, vp.h - ins.top - ins.bottom) },
    map: { w: d?.sceneWidth ?? scene?.width, h: d?.sceneHeight ?? scene?.height },
    tuning: { ...sceneTuning(scene), ..._tuning },
  });
}

/**
 * Scan pan radius in world px. A hand-set "Scan Mode Radius" (px) on the scene
 * still wins, so scenes tuned by hand before this keep their feel.
 */
export function dungeonScanRadius(scene = globalThis.canvas?.scene) {
  const px = Number(generalOf(scene)?.scanRadius);
  if (Number.isFinite(px) && px > 0) return px;
  return dungeonZoomLimits(scene).scanRadius;
}

/** Called from the Camera Authority wrapper with the already-constrained view. */
export function constrainDungeonZoom(view, scene) {
  if (!dungeonZoomActive(scene)) return view;
  const limits = dungeonZoomLimits(scene);
  const scale = applyZoomRule(view?.scale, limits, isScanning());
  return Math.abs(scale - Number(view?.scale)) < 1e-4 ? view : { ...view, scale };
}

export function invalidateDungeonStep() { _stepCache.sceneId = null; }

/**
 * Console tuning, e.g. FUCompanion.api.cameraAuthority.dungeonZoom.tune({ normalTiles: 2.5 }).
 * In memory only. tune(null) clears it. Re-applies the zoom straight away.
 */
export function tuneDungeonZoom(partial) {
  _tuning = partial === null ? {} : { ..._tuning, ...partial };
  try {
    const c = globalThis.canvas;
    if (c?.ready && dungeonZoomActive(c.scene)) {
      c.animatePan({ x: c.stage.pivot.x, y: c.stage.pivot.y, scale: c.stage.scale.x, duration: 250 });
    }
  } catch { /* camera busy */ }
  return { ...DEFAULTS, ...sceneTuning(globalThis.canvas?.scene), ..._tuning };
}

/**
 * The rule runs inside _constrainView, i.e. only when something moves the
 * camera. A scene opens at its authored initial zoom (3x on some dungeons) and,
 * until the party token is placed, nothing pans, so that zoom would stand.
 * Settle it explicitly a moment after load, and again once LockView's 2 s
 * initial-view window and Camera Authority's party refocus have passed.
 */
function settleDungeonZoom() {
  try {
    const c = globalThis.canvas;
    if (!c?.ready || !dungeonZoomActive(c.scene)) return;
    const want = applyZoomRule(c.stage.scale.x, dungeonZoomLimits(c.scene), isScanning());
    if (Math.abs(want - c.stage.scale.x) < 1e-3) return;
    c.pan({ x: c.stage.pivot.x, y: c.stage.pivot.y, scale: want });
  } catch { /* canvas tearing down */ }
}

export function installDungeonZoomHooks() {
  Hooks.on("canvasReady", () => {
    invalidateDungeonStep();
    for (const ms of [600, 2600]) setTimeout(settleDungeonZoom, ms);
  });
  Hooks.on("updateScene", (s) => { if (s?.id === _stepCache.sceneId) invalidateDungeonStep(); });
  for (const h of ["createTile", "updateTile", "deleteTile"]) {
    Hooks.on(h, (t) => { if (t?.parent?.id === _stepCache.sceneId) invalidateDungeonStep(); });
  }
  // The window or the chat sidebar changing size changes the visible area the
  // zoom is solved for.
  let t = null;
  const later = (ms) => { clearTimeout(t); t = setTimeout(settleDungeonZoom, ms); };
  window.addEventListener("resize", () => later(250));
  Hooks.on("collapseSidebar", () => later(50));
}

export const DungeonZoomApi = {
  limits: dungeonZoomLimits,
  scanRadius: dungeonScanRadius,
  active: dungeonZoomActive,
  tune: tuneDungeonZoom,
  defaults: DEFAULTS,
};
