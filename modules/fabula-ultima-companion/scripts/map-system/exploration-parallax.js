// ============================================================================
// Exploration parallax — a painted walk map that shifts with the camera.
//
// The follow camera scrolls a walk map flat: the far canyon and the rocks at
// the front of the frame all slide past at the same speed, which reads as a
// picture, not a place. Here the painting is redrawn every frame through a
// weight map baked from its depth (Depth Anything, then rated against the
// walkable ground; the bake tool lives outside the repo, see
// assets/walk-depth/README.md):
//
//   - the walkable ground (inside the walls) has weight 0 and never moves, so
//     feet, walls, doors and examine points stay exactly on the painting;
//   - farther than the ground at its row (sky, the canyon behind): drawn
//     pulled toward the view centre, so it scrolls slower than the camera;
//   - nearer (cliffs rising beside the path, foreground rocks): pushed out
//     from the centre, so it scrolls faster;
//   - a little depth of field toward the far plane.
//
// The shift is taken from the CURRENT view centre, not from a rest view as on
// the battle stage (battle-director/battle-stage-3d.js, whose mesh insertion
// this follows): a walk map scrolls without bound, and a texel's shift is
// weight x its offset from the centre, so it stays under a fraction of half a
// screen wherever the camera is. At the centre, where the party walks, it is 0.
//
// Which scenes: exploration mode, Scene Config "Walk Parallax" on, a weight
// map named after the background image in assets/walk-depth/, and no
// foreground occluders (they are cut from the unwarped painting and would
// drift off it). Client-local; writes nothing. Per-user switch: Party Menu ->
// Config -> Graphic -> Walk-map parallax. Reduced-motion users get none.
//
// Live tuning: FUCompanion.api.walkParallax.tune({ far: 0.2, near: 0.1, dof: 0.3 })
// (session only; copy the numbers into the scene's flags to keep them).
// ============================================================================

import { getClientOption } from "../shared/client-options.js";

const MODULE_ID = "fabula-ultima-companion";
const WEIGHT_DIR = "modules/fabula-ultima-companion/assets/walk-depth";
const TAG = "[ONI][WalkParallax]";
const warn = (...a) => console.warn(TAG, ...a);

// Scene flags, under flags.<module>.oniFabula.general (dungeon-configuration-ui.js).
const KEYS = { enabled: "parallaxEnabled", far: "parallaxFar", near: "parallaxNear", dof: "parallaxDof" };
const DEFAULTS = Object.freeze({ far: 0.18, near: 0.10, dof: 0.35, blurPx: 5 });

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

// A texel at p is drawn at d = p + a(p) * (c - p): a > 0 pulls it toward the
// view centre c (scrolls slower), a < 0 pushes it out (scrolls faster). The
// pixel at d samples p = (d - a c) / (1 - a), with a re-read at each estimate.
const FRAG = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uSampler;
uniform sampler2D uBlur;
uniform sampler2D uWeight;
uniform vec2 uCenter;
uniform float uFar;
uniform float uNear;
uniform float uDof;
float signedW(vec2 uv) { return texture2D(uWeight, clamp(uv, 0.0, 1.0)).r * 2.0 - 1.0; }
float shiftOf(vec2 uv) { float w = signedW(uv); return w > 0.0 ? w * uFar : w * uNear; }
void main() {
  vec2 p = vUV;
  for (int i = 0; i < 3; i++) {
    float a = shiftOf(p);
    p = (vUV - a * uCenter) / (1.0 - a);
  }
  p = clamp(p, 0.0, 1.0);
  float b = clamp(uDof * max(signedW(p), 0.0), 0.0, 1.0);
  gl_FragColor = mix(texture2D(uSampler, p), texture2D(uBlur, p), b);
}`;

const state = {
  sceneId: null,
  cfg: null,
  mesh: null,
  blurRT: null,
  bgTex: null,
  rect: null,
  building: null,
  ticking: false,
  override: {},
};

const num = (v, d) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** "https://…/Game%20Map/Valley_Map010.png?v=2" -> "Valley_Map010" */
function backdropKey(src) {
  if (typeof src !== "string" || !src) return null;
  let s = src.split(/[?#]/)[0];
  s = s.slice(s.lastIndexOf("/") + 1);
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  const dot = s.lastIndexOf(".");
  return (dot > 0 ? s.slice(0, dot) : s) || null;
}

function reducedMotion() {
  try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

function configFor(scene) {
  if (!scene || getClientOption("walkParallax") === "off" || reducedMotion()) return null;
  const g = scene.getFlag?.(MODULE_ID, "oniFabula")?.general ?? {};
  if (g.sceneMode !== "exploration" || g[KEYS.enabled] !== true) return null;
  if (g.occludersEnabled === true) return null;
  const key = backdropKey(scene.background?.src);
  if (!key) return null;
  const o = state.override;
  return {
    key,
    weightMap: `${WEIGHT_DIR}/${key}.webp`,
    far: clamp(num(o.far ?? g[KEYS.far], DEFAULTS.far), 0, 0.6),
    near: clamp(num(o.near ?? g[KEYS.near], DEFAULTS.near), 0, 0.6),
    dof: clamp(num(o.dof ?? g[KEYS.dof], DEFAULTS.dof), 0, 1),
  };
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
  if (m) { try { m.parent?.removeChild(m); m.destroy({ children: true }); } catch { /* */ } }
  if (state.blurRT) { try { state.blurRT.destroy(true); } catch { /* */ } state.blurRT = null; }
  state.bgTex = null;
}

async function buildMesh() {
  teardownMesh();
  const scene = canvas?.scene;
  const cfg = state.cfg;
  if (!scene || !cfg) return;
  const bg = canvas.primary?.background;
  if (!bg?.texture?.valid || bg.texture === PIXI.Texture.EMPTY) return;   // the tick retries once it loads

  const sceneId = scene.id;
  const bgTex = bg.texture;
  let weightTex = null;
  try { weightTex = await loadTexture(cfg.weightMap); } catch { weightTex = null; }
  if (canvas?.scene?.id !== sceneId || canvas.primary?.background?.texture !== bgTex) return;
  if (!weightTex?.valid) { warn(`no weight map at ${cfg.weightMap}; parallax off for this scene`); state.cfg = null; return; }

  const d = canvas.dimensions;
  const rect = { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight };
  const geom = new PIXI.Geometry()
    .addAttribute("aVertexPosition", [rect.x, rect.y, rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h, rect.x, rect.y + rect.h], 2)
    .addAttribute("aTextureCoord", [0, 0, 1, 0, 1, 1, 0, 1], 2)
    .addIndex([0, 1, 2, 0, 2, 3]);
  state.blurRT = blurredCopy(bgTex, DEFAULTS.blurPx);
  const shader = PIXI.Shader.from(VERT, FRAG, {
    uSampler: bgTex, uBlur: state.blurRT, uWeight: weightTex,
    uCenter: [0.5, 0.5], uFar: cfg.far, uNear: cfg.near, uDof: cfg.dof,
  });
  const mesh = new PIXI.Mesh(geom, shader);
  mesh.name = "walkParallax";
  // Directly over the background: same elevation and sort layer, one sort
  // step later; tiles and tokens stay above.
  mesh.elevation = bg.elevation;
  mesh.sortLayer = bg.sortLayer;
  mesh.sort = (bg.sort || 0) + 1;
  mesh.zIndex = bg.zIndex;
  canvas.primary.addChild(mesh);

  state.mesh = mesh;
  state.bgTex = bgTex;
  state.rect = rect;
  onTick();
}

// Every frame: where the view centre is on the painting. A throw here would
// stop PIXI's whole frame loop, so it never throws.
function onTick() {
  try {
    const scene = canvas?.scene;
    if (!scene || scene.id !== state.sceneId || !state.cfg) return;
    const bg = canvas.primary?.background;
    // The background (re)loaded under us: build (again) on the new texture.
    if (!state.building && bg?.texture?.valid && bg.texture !== PIXI.Texture.EMPTY && bg.texture !== state.bgTex) {
      state.building = buildMesh().catch((e) => warn("build failed", e)).finally(() => { state.building = null; });
      return;
    }
    const m = state.mesh;
    if (!m || m.destroyed) return;
    const r = state.rect, un = m.shader.uniforms;
    un.uCenter[0] = (canvas.stage.pivot.x - r.x) / r.w;
    un.uCenter[1] = (canvas.stage.pivot.y - r.y) / r.h;
    un.uFar = state.cfg.far;
    un.uNear = state.cfg.near;
    un.uDof = state.cfg.dof;
  } catch (e) {
    warn("tick failed; parallax off until the scene is redrawn", e);
    stop();
  }
}

function startTicker() {
  if (state.ticking) return;
  try { canvas.app.ticker.add(onTick); state.ticking = true; } catch (e) { warn("ticker add failed", e); }
}

function stop() {
  if (state.ticking) { try { canvas.app.ticker.remove(onTick); } catch { /* */ } state.ticking = false; }
  teardownMesh();
}

/** (Re)read the scene and switch parallax on or off for it. */
function refresh() {
  stop();
  const scene = canvas?.scene ?? null;
  state.sceneId = scene?.id ?? null;
  state.cfg = configFor(scene);
  if (state.cfg) startTicker();
}

Hooks.on("canvasReady", () => refresh());
Hooks.on("canvasTearDown", () => { stop(); state.sceneId = null; state.cfg = null; });
Hooks.on("updateScene", (scene, change) => {
  if (scene?.id !== canvas?.scene?.id) return;
  if (change?.flags?.[MODULE_ID] !== undefined || change?.background !== undefined) refresh();
});
Hooks.on("fuClientOptionChanged", ({ key } = {}) => { if (key === "walkParallax") refresh(); });

Hooks.once("ready", () => {
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.walkParallax = {
    /** Session-only strengths, e.g. tune({ far: 0.25 }); tune({}) clears. */
    tune(o = {}) { state.override = Object.keys(o).length ? { ...state.override, ...o } : {}; refresh(); return state.cfg; },
    status: () => ({ on: !!state.mesh, cfg: state.cfg, defaults: DEFAULTS }),
  };
});
