// ============================================================================
// Battle stage 3D — the battlefield as a real 3D space behind a painted camera.
//
// Two layers, both client-local and write nothing to any document:
//
//   1. Depth scale. Battlers further back are drawn smaller. This module only
//      supplies the curve; map-system/depth-index.js applies it to the token
//      meshes (it already owns feet-planting, depth sort and the idle-bounce
//      hand-off), and calls battler-pose back so pose art is re-fitted on top.
//
//   2. Parallax. A mesh drawn over the scene background samples the backdrop
//      through its depth map: scenery behind the battle line moves less than
//      the camera, foreground moves more, and the band of floor the battlers
//      stand on does not move at all. Driven every frame by the live camera
//      (director pans and push-ins) plus a slow idle drift, and softened with
//      a little depth of field toward the far and near planes.
//
// Which scenes: any whose background image has a preset in
// battle-stage-3d-rules.js (Training Ground, the Overworld battle and the
// Valley of the Dragon battle). Everything else is untouched.
//
// Per-user switch, Party Menu -> Config -> Graphic -> Battle depth (the client
// setting "battleStage3d", registered by shared/client-options.js): Full /
// 3D (experimental, see battle-stage-3d-camera.js) / Depth only / Off.
// Live tuning: FUCompanion.api.battleStage3d.tune({ pan: 0.6, dofFar: 0 })
// (session only; copy the numbers into PRESETS to keep them).
// ============================================================================

import { log, warn } from "./logger.js";
import { stageOf, restViewFor } from "./director-camera.js";
import {
  resolvePreset, buildCamera, tokenScaleAt, parallaxUniforms,
  floorToWorld, worldToCanvas, pxPerMetreAt, floorDisparityAt, buildProjector, stageModeFor, STAGE_LABEL,
} from "./battle-stage-3d-rules.js";
import { Stage3dCamera, SHOTS } from "./battle-stage-3d-camera.js";
import { isCameraSuspended } from "./camera-authority.js";
import { getActiveSurfaces } from "./director-surfaces.js";
import { getClientOption } from "../shared/client-options.js";

const OPTION = "battleStage3d";
const MODES = { full: "full", camera: "camera", scale: "scale", off: "off" };
const GLOBAL_KEY = "__ONI_BATTLE_STAGE_3D__";
const REST_TTL_MS = 500;

const VERT = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vUV;
void main() {
  vUV = aTextureCoord;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;

// Inverse warp: find the source texel that lands on this pixel by iterating
// src = uv - shift(src). Three steps settle it for the shifts used here. The
// weights mirror shiftUV() in the rules file, which is what the tests check.
const FRAG = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uSampler;
uniform sampler2D uBlur;
uniform sampler2D uDepth;
uniform vec2 uOffset;
uniform vec2 uPivot;
uniform float uDolly;
uniform vec2 uBand;
uniform float uNear;
uniform vec2 uDof;
uniform float uAlpha;

float disp(vec2 uv) { return texture2D(uDepth, clamp(uv, 0.0, 1.0)).r * 2.0; }
float farW(float D) { return clamp(1.0 - D / max(uBand.x, 1e-4), 0.0, 1.0); }
float nearW(float D) { return clamp((D - uBand.y) / max(uBand.y, 1e-4), 0.0, 1.5); }
vec2 shiftAt(vec2 uv) {
  float D = disp(uv);
  float w = farW(D) - uNear * nearW(D);
  return w * (uOffset + (uPivot - uv) * uDolly);
}
void main() {
  vec2 s = shiftAt(vUV);
  s = shiftAt(vUV - s);
  s = shiftAt(vUV - s);
  vec2 src = clamp(vUV - s, 0.0, 1.0);
  float D = disp(src);
  float b = clamp(uDof.x * farW(D) + uDof.y * min(nearW(D), 1.0), 0.0, 1.0);
  vec4 c = mix(texture2D(uSampler, src), texture2D(uBlur, src), b);
  gl_FragColor = c * uAlpha;
}`;

const state = {
  override: {},
  sceneId: null,
  cfg: null,
  cam: null,
  mesh: null,
  blurRT: null,
  bgTex: null,
  building: null,
  t0: 0,
  rest: null,
  restAt: 0,
  restKey: "",
  ticking: false,
  camera3d: null,
  holds: new Map(),     // id -> reason; explicit holds on the 3D camera
  holdSeq: 0,
  free: false,          // debug: ignore every hold (the shot tour)
};

/* ── Camera holds (the safety net) ───────────────────────────────────────── */
//
// The 3D camera displaces battlers; anything still anchored on the plain 2D
// token would land beside them. So while the battle waits on an input surface
// that is not known to follow the drawn battlers, or a cinematic plays, the
// camera eases back to neutral (exact 2D). Anything else that needs the plain
// view (the unit-inspect close-up) takes an explicit hold().

// Surfaces (director-surfaces kinds) that are safe under the live camera:
// docked to the screen (the command window, lists, the action card, the round
// bar, the loader), or anchored on battlers through drawnBox (the pickers, the
// reaction blades). A kind missing here, a new one, holds the camera.
// Unregistered input (the GM desk, the plate drawer) is screen-docked; the
// desk's ring follows drawnBox.
const SAFE_SURFACES = new Set([
  "target-picker", "turn-picker", "reaction-menu",
  "turn-ui", "list-picker", "attribute-pair-picker", "passive-manager",
  "action-card", "action-card-mirror", "round-banner", "battle-loader",
]);

// Mirrors director-player-hud's settled flag (true outside a battle), which
// only ever announces flips. Registered at evaluation so no flip is missed;
// read through the hook rather than importing the HUD (it pulls in the GM desk).
let battleSettled = true;
Hooks.on("fu-battle-phase", ({ settled } = {}) => { battleSettled = settled !== false; });

function waitingOnUnportedInput() {
  if (!battleSettled) return false;
  return getActiveSurfaces({ category: "surface" }).some((e) => !SAFE_SURFACES.has(e.kind));
}

/** Why the 3D camera is held at neutral right now ([] = free). */
function cameraHolds() {
  if (state.free) return [];
  const out = [];
  if (waitingOnUnportedInput()) out.push("input");
  if (isCameraSuspended()) out.push("cinematic");
  for (const reason of state.holds.values()) out.push(reason);
  return out;
}

/**
 * Hold the 3D camera at neutral until the returned release is called (once;
 * extra calls are no-ops). A no-op off the 3D camera, so callers need no
 * guard: const release = globalThis.__ONI_BATTLE_STAGE_3D__?.hold?.("x").
 */
function hold(reason = "hold") {
  const id = ++state.holdSeq;
  state.holds.set(id, String(reason));
  return () => { state.holds.delete(id); };
}

/* ── Settings ────────────────────────────────────────────────────────────── */

// The per-user choice lives with the other display options (Party Menu ->
// Config -> Graphic -> Battle depth); shared/client-options.js registers it.
function mode() {
  return getClientOption(OPTION) || MODES.full;
}

// What this scene actually gets (see stageModeFor in the rules file).
function sceneMode(cfg) {
  return stageModeFor(mode(), cfg);
}

Hooks.on("fuClientOptionChanged", ({ key } = {}) => { if (key === OPTION) refresh("setting"); });

/* ── Scene config ────────────────────────────────────────────────────────── */

function configFor(scene) {
  if (!scene) return null;
  const cfg = resolvePreset(scene.background?.src, state.override);
  if (!cfg) return null;
  const cam = buildCamera(cfg, stageOf(scene), Number(scene.grid?.size) || 100);
  return { cfg, cam };
}

// Read by depth-index.js (classic script) through the global below.
function tokenDepthConfig(scene) {
  if (mode() === MODES.off) return null;
  const c = configFor(scene);
  if (!c || !(c.cfg.strength > 0)) return null;
  const cam = c.cam;
  return { factorAt: (footY) => tokenScaleAt(footY, cam), sort: true, source: "battle-stage-3d" };
}

// depth-index.js resolves its config while tokens are first drawn, which can be
// before this module's ready hook, so the seam exists from evaluation on.
// Where a token is DRAWN. Overlays anchored on a token read this instead of
// token.center / token.w: under the 3D camera it is the displaced, rescaled
// body; on every other scene it is exactly the 2D token, so a ported overlay
// behaves as before wherever there is no 3D. drawnCenter is the older,
// narrower seam (null when the camera is not displacing the token).
function drawnBox(token) {
  if (!token || token.destroyed) return null;
  const tracked = !!state.camera3d?.drawnCenter(token);
  const s = tracked ? token.scale.x : 1;
  const x = token.x, y = token.y, w = token.w * s, h = token.h * s;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, footY: y + h, scale: s, is3d: tracked };
}

// Screen-space bounds of the token's mesh (or its sprite shadow, `obj`) where
// the camera draws it. Those only sit at their drawn spot inside a render, so
// getBounds() read from a DOM overlay's own tick gives the 2D spot; this moves
// it. Plain getBounds() wherever the camera is not displacing the token.
function drawnMeshBounds(token, obj = token?.mesh) {
  const rect = obj?.getBounds?.();
  const cam = state.camera3d;
  const map = rect ? cam?.drawnMap(token) : null;
  if (!map || cam.meshLive) return rect ?? null;
  const wt = canvas.stage.worldTransform;
  const f = wt.apply({ x: map.fx, y: map.fy }), b = wt.apply({ x: map.bx, y: map.by });
  return new PIXI.Rectangle(b.x + (rect.x - f.x) * map.m, b.y + (rect.y - f.y) * map.m, rect.width * map.m, rect.height * map.m);
}

// A screen point on the token's 2D mesh (mesh.toGlobal outside a render) moved
// to where the camera draws it; the point itself wherever it is not displacing.
function drawnScreenPoint(token, p) {
  const cam = state.camera3d;
  const map = cam?.drawnMap(token);
  if (!map || cam.meshLive) return { x: p.x, y: p.y };
  const wt = canvas.stage.worldTransform;
  const f = wt.apply({ x: map.fx, y: map.fy }), b = wt.apply({ x: map.bx, y: map.by });
  return { x: b.x + (p.x - f.x) * map.m, y: b.y + (p.y - f.y) * map.m };
}

// Where a world point placed against the token's 2D spot will be drawn once the
// 2D camera sits at `view` ({x, y, scale}): {x, y, m} in world px, or null when
// the camera is not displacing the token (then it is the point itself).
function predictDrawn(token, p, view) {
  return state.camera3d?.predictPoint(token, p, view) ?? null;
}

globalThis[GLOBAL_KEY] = { tokenDepthConfig, drawnBox, drawnMeshBounds, drawnScreenPoint, predictDrawn, drawnCenter: (token) => state.camera3d?.drawnCenter(token) ?? null, hold };

// Token#center reads the DOCUMENT in v12, so anything placed at token.center
// (skill animation scripts, reaction menus, scrolling text) would land on the
// battler's 2D spot while the camera draws it elsewhere. While the camera
// displaces a token, center reports where its body is drawn instead; flat or
// off the 3D camera it is untouched. Foundry's own placement keeps the 2D spot
// (mesh position, vision and light sources, visibility tests run with the
// override bypassed), and depth-index plants the mesh from getCenterPoint().
let centerBypass = 0;
function installDrawnCenter() {
  // Token is a script-scope class in v12 (not a globalThis property): walk the
  // configured class up to the prototype that owns the getter.
  let proto = CONFIG.Token?.objectClass?.prototype ?? null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "center")) proto = Object.getPrototypeOf(proto);
  const desc = proto && Object.getOwnPropertyDescriptor(proto, "center");
  if (!desc?.get || desc.get.oniDrawn) return;
  const get = function () {
    if (!centerBypass) {
      const c = state.camera3d?.drawnCenter(this);
      if (c) return new PIXI.Point(c.x, c.y);
    }
    return desc.get.call(this);
  };
  get.oniDrawn = true;
  Object.defineProperty(proto, "center", { ...desc, get });
  const bypass = (fn) => function (...args) { centerBypass++; try { return fn.apply(this, args); } finally { centerBypass--; } };
  for (const name of ["_refreshPosition", "initializeSources"]) {
    if (typeof proto[name] === "function") proto[name] = bypass(proto[name]);
  }
  const vis = Object.getOwnPropertyDescriptor(proto, "isVisible");
  if (vis?.get) Object.defineProperty(proto, "isVisible", { ...vis, get: bypass(vis.get) });
}

function refreshTokenDepth() {
  const di = globalThis.__ONI_DEPTH_INDEX__;
  try { di?.invalidateConfig?.("battle-stage-3d"); di?.refreshAllTokens?.("battle-stage-3d"); } catch (e) { warn("battle-stage-3d: depth refresh failed", e); }
}

/* ── Parallax mesh ───────────────────────────────────────────────────────── */

function reducedMotion() {
  try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

function blurredCopy(tex, px) {
  const w = Math.max(1, Math.ceil(tex.width / 2));
  const h = Math.max(1, Math.ceil(tex.height / 2));
  const rt = PIXI.RenderTexture.create({ width: w, height: h });
  const spr = new PIXI.Sprite(tex);
  spr.width = w; spr.height = h;
  const f = new PIXI.BlurFilter(px, 4);
  f.repeatEdgePixels = true;
  spr.filters = [f];
  canvas.app.renderer.render(spr, { renderTexture: rt, clear: true });
  spr.destroy();
  f.destroy();
  return rt;
}

function teardownMesh() {
  const m = state.mesh;
  state.mesh = null;
  if (m) { try { m.parent?.removeChild(m); m.destroy({ children: true }); } catch {} }
  if (state.blurRT) { try { state.blurRT.destroy(true); } catch {} state.blurRT = null; }
  state.bgTex = null;
}

async function buildMesh() {
  teardownMesh();
  const scene = canvas?.scene;
  const c = configFor(scene);
  if (!c || sceneMode(c.cfg) !== MODES.full) return;
  const bg = canvas.primary?.background;
  if (!bg?.texture?.valid || bg.texture === PIXI.Texture.EMPTY) return;   // the tick retries once it loads

  const sceneId = scene.id;
  const bgTex = bg.texture;
  const depthTex = await loadTexture(c.cfg.depthMap);
  if (canvas?.scene?.id !== sceneId || canvas.primary?.background?.texture !== bgTex) return;
  if (!depthTex?.valid) { warn(`battle-stage-3d: depth map missing ${c.cfg.depthMap}`); return; }

  const d = canvas.dimensions;
  const rect = { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight };
  const geom = new PIXI.Geometry()
    .addAttribute("aVertexPosition", [rect.x, rect.y, rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h, rect.x, rect.y + rect.h], 2)
    .addAttribute("aTextureCoord", [0, 0, 1, 0, 1, 1, 0, 1], 2)
    .addIndex([0, 1, 2, 0, 2, 3]);
  state.blurRT = blurredCopy(bgTex, c.cfg.blurPx);
  const shader = PIXI.Shader.from(VERT, FRAG, {
    uSampler: bgTex, uBlur: state.blurRT, uDepth: depthTex,
    uOffset: [0, 0], uPivot: [0.5, 0.5], uDolly: 0, uBand: [0.1, 0.8],
    uNear: c.cfg.near, uDof: [c.cfg.dofFar, c.cfg.dofNear], uAlpha: 1,
  });
  const mesh = new PIXI.Mesh(geom, shader);
  mesh.name = "battleStage3d";
  // Directly over the background: same elevation and sort layer, one sort
  // step later; tiles (500) and tokens (700) stay above.
  mesh.elevation = bg.elevation;
  mesh.sortLayer = bg.sortLayer;
  mesh.sort = (bg.sort || 0) + 1;
  mesh.zIndex = bg.zIndex;
  canvas.primary.addChild(mesh);

  state.mesh = mesh;
  state.bgTex = bgTex;
  state.sceneRect = rect;
  state.t0 = performance.now();
  state.rest = null;
  log(`battle-stage-3d: parallax on (${c.cfg.key})`);
  onTick();
}

function restView(scene) {
  const now = performance.now();
  const key = `${window.innerWidth}x${window.innerHeight}`;
  if (state.rest && now - state.restAt < REST_TTL_MS && key === state.restKey) return state.rest;
  state.rest = restViewFor(scene);
  state.restAt = now;
  state.restKey = key;
  return state.rest;
}

function onTick() {
  const scene = canvas?.scene;
  if (!scene || scene.id !== state.sceneId) return;
  const bg = canvas.primary?.background;

  // Background (re)loaded under us — scene-texture-repair swaps it in late.
  if (sceneMode(state.cfg) === MODES.full && state.cfg && !state.building && bg?.texture?.valid && bg.texture !== state.bgTex) {
    state.building = buildMesh().catch((e) => warn("battle-stage-3d: build failed", e)).finally(() => { state.building = null; });
    return;
  }
  const m = state.mesh;
  if (!m || m.destroyed) return;

  const cfg = state.cfg, cam = state.cam;
  const view = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
  const u = parallaxUniforms({
    view, rest: restView(scene), t: (performance.now() - state.t0) / 1000,
    cfg, cam, sceneRect: state.sceneRect, orbit: !reducedMotion(),
  });
  const un = m.shader.uniforms;
  un.uOffset[0] = u.offsetUV[0]; un.uOffset[1] = u.offsetUV[1];
  un.uPivot[0] = u.pivotUV[0]; un.uPivot[1] = u.pivotUV[1];
  un.uDolly = u.dolly;
  un.uBand[0] = u.band[0]; un.uBand[1] = u.band[1];
  un.uNear = cfg.near;
  un.uDof[0] = cfg.dofFar; un.uDof[1] = cfg.dofNear;
}

function startTicker() {
  if (state.ticking) return;
  try { canvas.app.ticker.add(onTick); state.ticking = true; } catch (e) { warn("battle-stage-3d: ticker add failed", e); }
}

function stopTicker() {
  if (!state.ticking) return;
  try { canvas.app.ticker.remove(onTick); } catch {}
  state.ticking = false;
}

/* ── 3D camera ───────────────────────────────────────────────────────────── */

function stopCamera3d() {
  const c = state.camera3d;
  state.camera3d = null;
  if (c) { try { c.stop(); } catch (e) { warn("battle-stage-3d: camera stop failed", e); } }
}

function startCamera3d(scene, c) {
  const P = buildProjector(c.cfg, c.cam, stageOf(scene));
  if (!P) { log(`battle-stage-3d: ${c.cfg.key} has no floor/wall model; 3D camera falls back to depth scale`); return; }
  const cam3d = new Stage3dCamera({
    scene, cfg: c.cfg, P, restView: () => restView(scene), sway: () => !reducedMotion(), held: cameraHolds,
    lost: () => { if (state.camera3d === cam3d) state.camera3d = null; },
  });
  state.camera3d = cam3d;
  cam3d.start().catch((e) => {
    warn("battle-stage-3d: 3D camera failed to start", e);
    if (state.camera3d === cam3d) stopCamera3d();
  });
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

function refresh(reason = "manual") {
  teardownMesh();
  stopCamera3d();
  const scene = canvas?.scene;
  const c = configFor(scene);
  state.sceneId = c ? scene.id : null;
  state.cfg = c?.cfg ?? null;
  state.cam = c?.cam ?? null;
  // On a fresh canvas depth-index already sized each token as it was drawn.
  if (reason !== "canvasReady") refreshTokenDepth();
  if (c && sceneMode(c.cfg) === MODES.camera) { stopTicker(); startCamera3d(scene, c); log(`battle-stage-3d: ${reason} -> ${c.cfg.key} (camera)`); return; }
  if (!c || sceneMode(c.cfg) !== MODES.full) { stopTicker(); return; }
  startTicker();
  state.building = buildMesh().catch((e) => warn("battle-stage-3d: build failed", e)).finally(() => { state.building = null; });
  log(`battle-stage-3d: ${reason} -> ${c.cfg.key} (${mode()})`);
}

function status() {
  const scene = canvas?.scene;
  const c = configFor(scene);
  return {
    mode: mode(),
    // What this scene is drawn with: "3d" camera, "parallax", "scale" only, or plain "2d".
    stage: STAGE_LABEL[stageModeFor(mode(), c?.cfg ?? null)],
    scene: scene?.name ?? null,
    preset: c?.cfg?.key ?? null,
    parallax: !!state.mesh && !state.mesh.destroyed,
    camera3d: state.camera3d?.running ?? false,
    reducedMotion: reducedMotion(),
    override: { ...state.override },
    camera: c ? { horizonY: c.cam.hz, refY: c.cam.refY, camHeightM: +c.cam.camH.toFixed(2), band: c.cam.band } : null,
  };
}

/* ── API ─────────────────────────────────────────────────────────────────── */

export const BattleStage3dApi = {
  status,
  refresh: () => refresh("api"),
  /** Session-only overrides on top of the preset; rebuilds. tune() with no args clears them. */
  tune(partial = null) {
    state.override = partial ? { ...state.override, ...partial } : {};
    refresh("tune");
    return status();
  },
  /** Where a token is drawn: {x, y, w, h, cx, cy, footY, scale, is3d}; the plain 2D box off the 3D camera. */
  drawnBox,
  /** Screen bounds of the token's mesh where it is drawn (mesh.getBounds() off the 3D camera). */
  drawnMeshBounds,
  /** Draw scale for a battler whose feet are at canvas row footY (1 when off). */
  scaleAt(footY) {
    const c = mode() === MODES.off ? null : configFor(canvas?.scene);
    return c ? tokenScaleAt(footY, c.cam) : 1;
  },
  /** Draw scale of a placed token, from its feet. */
  tokenScale(token) {
    const doc = token?.document;
    if (!doc) return 1;
    const h = token.h || doc.height * (canvas.grid?.size ?? 100);
    return this.scaleAt(doc.y + h);
  },
  /** Canvas point on the floor -> metres {X, Z}; null on a scene without a preset. */
  floorToWorld(pt) { const c = configFor(canvas?.scene); return c ? floorToWorld(pt, c.cam) : null; },
  /** Metres {X, Y (up), Z} -> canvas point + true-perspective scale. */
  worldToCanvas(p) { const c = configFor(canvas?.scene); return c ? worldToCanvas(p, c.cam) : null; },
  /** The 3D camera (setting "3D camera"): scripted shots on top of the director's camera. */
  camera: {
    status: () => state.camera3d?.status() ?? { running: false },
    /** Why the camera is held at neutral right now ([] = free). */
    holds: cameraHolds,
    /** Hold the camera at neutral; returns the release. */
    hold,
    /** Debug: true ignores every hold (input waits, cinematics); false restores them. */
    free(on = true) { state.free = !!on; return cameraHolds(); },
    /** Tween {yaw, tilt (degrees), push (<1 = closer)}; resolves on arrival. Held = stays neutral. */
    go: (partial, ms) => state.camera3d?.go(partial, ms) ?? Promise.resolve(),
    /** Named shot: painted, left, right, low, high. */
    shot: (name, ms) => (SHOTS[name] ? state.camera3d?.go(SHOTS[name], ms) : null) ?? Promise.resolve(),
    shots: () => Object.keys(SHOTS),
    /** Debug: make the GPU drop the camera's WebGL context, as a driver reset would. */
    loseContext() { const r = state.camera3d?.renderer; if (!r) return false; r.getContext().getExtension("WEBGL_lose_context")?.loseContext(); return true; },
    /** Run through every shot and back to the painted view (ignores holds while it runs). */
    async tour() {
      const wasFree = state.free;
      state.free = true;
      try {
        for (const [name, ms] of [["left", 2200], ["right", 3200], ["low", 2200], ["high", 2400], ["painted", 2000]]) {
          if (!state.camera3d?.running) return;
          await state.camera3d.go(SHOTS[name], ms);
          await new Promise((r) => setTimeout(r, 700));
        }
      } finally { state.free = wasFree; }
    },
  },
  pxPerMetreAt(y) { const c = configFor(canvas?.scene); return c ? pxPerMetreAt(y, c.cam) : null; },
  disparityAt(y) { const c = configFor(canvas?.scene); return c ? floorDisparityAt(y, c.cam) : null; },
};

export function initBattleStage3d() {
  try {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.battleStage3d = BattleStage3dApi;
  } catch (e) { warn("battle-stage-3d: api attach failed", e); }
  try { installDrawnCenter(); } catch (e) { warn("battle-stage-3d: drawn-center override failed", e); }

  Hooks.on("canvasReady", () => refresh("canvasReady"));
  Hooks.on("canvasTearDown", () => { stopTicker(); teardownMesh(); stopCamera3d(); state.sceneId = null; });
  Hooks.on("updateScene", (scene, change) => {
    if (scene.id !== canvas?.scene?.id) return;
    if (change?.background !== undefined) refresh("updateScene");
  });
  if (canvas?.ready) refresh("init");
}
