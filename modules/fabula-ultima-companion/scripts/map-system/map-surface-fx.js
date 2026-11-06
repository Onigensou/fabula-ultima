// ============================================================================
// Map surface FX: living details painted into a walk map's background.
//
// Ported from the approved Underground Decor mockup (2026-11-06), shader line
// for line, so the game shows what the user signed off. Two modes:
//
//   gas    (Nether Bridge)  the painted gas churns and rises, plumes drift up
//                           out of the chasm, green underglow on the chains and
//                           plank ends, crystal glows, near haze
//   water  (Ancient Mural)  the pool ripples with faint caustics, cave lighting
//                           (darkness + crystal lights, background only), crystal
//                           glows, near haze
//
// One mesh drawn directly over the background (same layer, one sort step up),
// so tiles and tokens stay on top: the party is never darkened or hazed.
// A "seal shimmer" (gas mode) breathes the Great Seal tile and runs a sheen
// round its rings while the tile is shown; the story gate hides the tile and
// the shimmer goes with it.
//
// Which scenes: Scene Config "Ambient FX" on + flags.<module>.surfaceFx (see
// map-surface-fx-core.js) + a mask in assets/surface-fx/. Never with Walk
// Parallax (both redraw the painting). Client-only, writes nothing.
// Reduced-motion users get one still frame. Moving particles (belches, spores,
// drips) are map-ambience.js.
// ============================================================================

import { readSurfaceConfig, MODULE_ID } from "./map-surface-fx-core.js";

const TAG = "[ONI][SurfaceFx]";
const warn = (...a) => console.warn(TAG, ...a);

const VERT = `
attribute vec2 aVertexPosition;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vWorld;
void main() {
  vWorld = aVertexPosition;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;

// The mockup's FRAG. Differences: P comes from world px (no camera rect), the
// glyph pass moved to the seal shader below, layer switches are uniforms.
const FRAG = `
precision highp float;
varying vec2 vWorld;
uniform sampler2D uArt, uMask;
uniform vec2 uOrigin, uMap, uCam;
uniform float uTime, uMode;
uniform float uChurn, uPlume, uRim, uCrystal, uWisp, uWater, uLight, uDark, uWispOut, uLightCap;
uniform vec3 uCrystals[10];
uniform vec3 uCrystalColor;
uniform vec4 uLights[12];
uniform vec3 uLightCol[12];
uniform float uNC, uNL;

float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 q) { vec2 i = floor(q), f = fract(q); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 q) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(q); q = q * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }

vec2 flowAt(vec2 px, float t) { vec2 q = px * 0.0032; float e = 0.55, tt = t * 0.045;
  float n1 = fbm(q + vec2(0.0, e) + tt), n2 = fbm(q - vec2(0.0, e) + tt), n3 = fbm(q + vec2(e, 0.0) - tt), n4 = fbm(q - vec2(e, 0.0) - tt);
  vec2 curl = vec2(n1 - n2, n4 - n3); return normalize(curl + 1e-5) * (0.55 + 0.9 * fbm(q * 1.7 - tt)) + vec2(0.04, -0.42); }

vec3 art(vec2 p) { return texture2D(uArt, clamp(p / uMap, 0.0, 1.0)).rgb; }
vec4 mask(vec2 p) { return texture2D(uMask, clamp(p / uMap, 0.0, 1.0)); }

void main() {
  vec2 P = vWorld - uOrigin;
  vec3 col = art(P);
  vec4 m = mask(P);
  float t = uTime;
  // Light pools (water mode): darken the stone outside them ("light" layer),
  // and/or thin the haze inside them (wispOutsideLight, Valley camp mockup).
  vec3 L = vec3(0.0);
  if (uMode > 0.5 && (uLight > 0.5 || uWispOut > 0.5)) {
    for (int i = 0; i < 12; i++) {
      if (float(i) >= uNL) break;
      vec4 l = uLights[i];
      float d = distance(P, l.xy) / l.z;
      float fall = clamp(1.0 - d, 0.0, 1.0);
      fall = fall * fall * (0.85 + 0.15 * sin(t * 1.3 + float(i) * 1.7));
      L += uLightCol[i] * fall * l.w;
    }
  }

  if (uMode < 0.5) {
    if (uChurn > 0.5 && m.r > 0.003) {
      float luma = dot(col, vec3(0.3, 0.5, 0.2));
      vec2 f = flowAt(P, t) * 38.0 * smoothstep(0.05, 0.25, luma);
      float sp = 0.12;
      float ph0 = fract(t * sp), ph1 = fract(t * sp + 0.5), w0 = 1.0 - abs(1.0 - 2.0 * ph0);
      vec2 s0 = P - f * (ph0 - 0.5), s1 = P - f * (ph1 - 0.5);
      vec3 a0 = mix(col, art(s0), mask(s0).r), a1 = mix(col, art(s1), mask(s1).r);
      vec3 gas = a0 * w0 + a1 * (1.0 - w0);
      float n = fbm(P * 0.0024 + vec2(t * 0.017, t * 0.03));
      gas *= 0.86 + 0.3 * n;
      gas += vec3(0.30, 0.62, 0.16) * smoothstep(0.56, 0.86, n) * 0.22;
      col = mix(col, gas, m.r);
    }
    if (uRim > 0.5) {
      float breathe = 0.65 + 0.35 * sin(t * 0.7 + P.y * 0.0021);
      float near = m.g * (1.0 - m.r);
      float lum = dot(col, vec3(0.33));
      col += vec3(0.26, 0.55, 0.12) * near * breathe * (0.35 + lum) * 0.55;
    }
    if (uPlume > 0.5) {
      float acc = 0.0;
      vec2 q1 = P * vec2(0.0021, 0.0011) + vec2(0.0, t * 0.022);
      q1.x += 0.35 * sin(q1.y * 1.7 + t * 0.15);
      float n1 = fbm(q1 + fbm(q1 * 1.3 + t * 0.03));
      acc += smoothstep(0.52, 0.86, n1) * 0.55;
      vec2 q2 = P * vec2(0.0042, 0.0024) + vec2(t * 0.006, t * 0.06);
      float n2 = fbm(q2 + 0.6 * fbm(q2 * 1.6 - t * 0.04));
      acc += smoothstep(0.58, 0.9, n2) * 0.45;
      float wave = 0.75 + 0.25 * sin(P.y * 0.004 + t * 0.55);
      float a = acc * m.g * wave;
      vec3 gasCol = vec3(0.52, 0.95, 0.36);
      col = col + gasCol * a * 0.32;
      col = mix(col, gasCol * 0.75, a * 0.22);
    }
  } else {
    if (uWater > 0.5 && m.r > 0.003) {
      vec2 w = vec2(fbm(P * 0.02 + vec2(t * 0.25, 0.0)), fbm(P * 0.02 + vec2(4.0, t * 0.21))) - 0.5;
      vec2 s = P + w * vec2(5.0, 2.5);
      vec3 rip = mix(col, art(s), mask(s).r);
      float c1 = fbm(P * vec2(0.012, 0.024) + vec2(t * 0.05, t * 0.03));
      float caus = pow(1.0 - abs(sin(c1 * 18.0)), 14.0);
      rip += vec3(0.45, 0.48, 0.9) * caus * 0.12;
      col = mix(col, rip, m.r);
    }
    if (uLight > 0.5) {
      col = col * (1.0 - uDark) + col * uDark * min(L * 1.15, vec3(uLightCap));
    }
  }

  if (uCrystal > 0.5) {
    for (int i = 0; i < 10; i++) {
      if (float(i) >= uNC) break;
      vec3 c = uCrystals[i];
      float d = distance(P, c.xy) / c.z;
      float pulse = 0.6 + 0.4 * sin(t * (0.9 + 0.13 * float(i)) + float(i) * 2.1);
      col += uCrystalColor * exp(-d * d * 2.2) * 0.30 * pulse;
    }
  }

  if (uWisp > 0.0) {
    vec2 q = P + (uCam - uMap * 0.5) * 0.35;
    float n = fbm(q * 0.0038 + vec2(t * 0.03, t * 0.008));
    float n2 = fbm(q * 0.0085 - vec2(t * 0.018, -t * 0.006));
    float a = smoothstep(0.56, 0.9, n * 0.72 + n2 * 0.44) * uWisp;
    if (uWispOut > 0.5) a *= 1.0 - smoothstep(0.12, 0.6, dot(L, vec3(0.333)));
    vec3 wc = uMode < 0.5 ? vec3(0.62, 0.92, 0.55) : vec3(0.8, 0.62, 0.96);
    col = col * (1.0 - a) + wc * a;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// The mockup's seal pass, as an additive sheen over the glyph tile (the tile
// itself draws the glyph; its alpha carries the breathing pulse).
const SEAL_VERT = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vUV;
varying vec2 vWorld;
void main() {
  vUV = aTextureCoord; vWorld = aVertexPosition;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;
const SEAL_FRAG = `
precision highp float;
varying vec2 vUV;
varying vec2 vWorld;
uniform sampler2D uGlyph;
uniform vec2 uOrigin, uC;
uniform float uSquash, uTime, uPulse;
void main() {
  vec4 g = texture2D(uGlyph, vUV);
  if (g.a < 0.004) { gl_FragColor = vec4(0.0); return; }
  vec3 rgb = g.rgb / g.a;
  vec2 P = vWorld - uOrigin;
  float ang = atan((P.y - uC.y) * uSquash, P.x - uC.x);
  float sheen = pow(max(0.0, sin(ang * 3.0 - uTime * 0.9)), 18.0);
  float glint = smoothstep(0.55, 0.95, dot(rgb, vec3(0.33)));
  vec3 add = vec3(0.6, 1.0, 0.6) * sheen * glint * 0.55 * g.a * uPulse;
  gl_FragColor = vec4(add, 0.0);
}`;

const state = {
  sceneId: null, cfg: null, mesh: null, seal: null, sealTile: null,
  bgTex: null, maskTex: null, origin: [0, 0], t0: performance.now(), building: null, ticking: false,
};

const reducedMotion = () => { try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

const loadTex = (src) => loadTexture(src);   // Foundry v12 global, as exploration-parallax.js uses

function teardownMeshes() {
  for (const k of ["mesh", "seal"]) {
    const m = state[k]; state[k] = null;
    if (m) { try { m.parent?.removeChild(m); m.destroy(); } catch { /* */ } }
  }
  const tile = state.sealTile; state.sealTile = null;
  if (tile?.mesh && !tile.destroyed) { try { tile.mesh.alpha = tile.document.alpha; } catch { /* */ } }
  state.bgTex = null; state.maskTex = null;
}

function packUniforms(cfg) {
  const cr = new Float32Array(30);
  cfg.crystals.forEach((c, i) => cr.set(c, i * 3));
  const L = new Float32Array(48), LC = new Float32Array(36);
  cfg.lights.forEach((l, i) => { L.set([l[0], l[1], l[2], l[6]], i * 4); LC.set([l[3], l[4], l[5]], i * 3); });
  const on = (id) => (cfg.layers[id] ? 1 : 0);
  return {
    uMode: cfg.mode === "gas" ? 0 : 1,
    uChurn: on("churn"), uPlume: on("plume"), uRim: on("rim"), uCrystal: on("crystal"),
    uWater: on("water"), uLight: on("light"), uWisp: cfg.wisp, uDark: cfg.darkness,
    uWispOut: cfg.wispOutsideLight ? 1 : 0, uLightCap: cfg.lightCap,
    uCrystals: cr, uNC: cfg.crystals.length, uCrystalColor: cfg.crystalColor,
    uLights: L, uLightCol: LC, uNL: cfg.lights.length,
  };
}

function rectMesh(x, y, w, h, shader, withUV) {
  const g = new PIXI.Geometry().addAttribute("aVertexPosition", [x, y, x + w, y, x + w, y + h, x, y + h], 2);
  if (withUV) g.addAttribute("aTextureCoord", [0, 0, 1, 0, 1, 1, 0, 1], 2);
  g.addIndex([0, 1, 2, 0, 2, 3]);
  const m = new PIXI.Mesh(g, shader);
  m.eventMode = "none";
  return m;
}

async function build() {
  teardownMeshes();
  const scene = canvas?.scene, cfg = state.cfg;
  if (!scene || !cfg) return;
  const bg = canvas.primary?.background;
  if (!bg?.texture?.valid || bg.texture === PIXI.Texture.EMPTY) return;   // the tick retries once it loads
  const sceneId = scene.id, bgTex = bg.texture;

  let maskTex = null;
  try { maskTex = await loadTex(cfg.mask); } catch { maskTex = null; }
  if (canvas?.scene?.id !== sceneId || canvas.primary?.background?.texture !== bgTex) return;
  if (!maskTex?.valid) { warn(`no mask at ${cfg.mask}; surface FX off for this scene`); state.cfg = null; return; }

  const d = canvas.dimensions;
  const r = { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight };
  state.origin = [r.x, r.y];
  const shader = PIXI.Shader.from(VERT, FRAG, {
    uArt: bgTex, uMask: maskTex, uOrigin: [r.x, r.y], uMap: [r.w, r.h], uCam: [r.w / 2, r.h / 2], uTime: 0,
    ...packUniforms(cfg),
  });
  const mesh = rectMesh(r.x, r.y, r.w, r.h, shader, false);
  mesh.name = "surfaceFx";
  mesh.elevation = bg.elevation;
  mesh.sortLayer = bg.sortLayer;
  mesh.sort = (bg.sort || 0) + 1;
  mesh.zIndex = bg.zIndex;
  canvas.primary.addChild(mesh);
  state.mesh = mesh; state.bgTex = bgTex; state.maskTex = maskTex;

  buildSeal(cfg);
  onTick();
}

function buildSeal(cfg) {
  if (cfg.mode !== "gas" || !cfg.shimmerTile) return;
  const tile = canvas.tiles?.get?.(cfg.shimmerTile);
  const tex = tile?.mesh?.texture;
  if (!tile || !tex?.valid) { warn(`seal tile ${cfg.shimmerTile} not found; no shimmer`); return; }
  const dd = tile.document;
  const shader = PIXI.Shader.from(SEAL_VERT, SEAL_FRAG, {
    uGlyph: tex, uOrigin: state.origin, uC: [cfg.shimmer.cx, cfg.shimmer.cy], uSquash: cfg.shimmer.squash, uTime: 0, uPulse: 1,
  });
  const m = rectMesh(dd.x, dd.y, dd.width, dd.height, shader, true);
  m.name = "surfaceFxSeal";
  m.blendMode = PIXI.BLEND_MODES.ADD;
  m.elevation = tile.mesh.elevation;
  m.sortLayer = tile.mesh.sortLayer;
  m.sort = (tile.mesh.sort || 0) + 1;
  m.zIndex = tile.mesh.zIndex;
  canvas.primary.addChild(m);
  state.seal = m; state.sealTile = tile;
}

// Every frame. A throw here would stop PIXI's whole frame loop, so it never throws.
function onTick() {
  try {
    const scene = canvas?.scene;
    if (!scene || scene.id !== state.sceneId || !state.cfg) return;
    const bg = canvas.primary?.background;
    if (!state.building && bg?.texture?.valid && bg.texture !== PIXI.Texture.EMPTY && bg.texture !== state.bgTex) {
      state.building = build().catch((e) => warn("build failed", e)).finally(() => { state.building = null; });
      return;
    }
    const m = state.mesh;
    if (!m || m.destroyed) return;
    if (document.visibilityState === "hidden") return;
    const t = reducedMotion() ? 0 : (performance.now() - state.t0) / 1000;
    const un = m.shader.uniforms;
    un.uTime = t;
    un.uCam[0] = canvas.stage.pivot.x - state.origin[0];
    un.uCam[1] = canvas.stage.pivot.y - state.origin[1];

    const s = state.seal, tile = state.sealTile;
    if (s && !s.destroyed) {
      const shown = !!tile && !tile.destroyed && !tile.document.hidden && tile.visible !== false && tile.mesh?.visible !== false;
      s.visible = shown;
      if (shown) {
        const pulse = 0.88 + 0.12 * Math.sin(t * 1.1);
        tile.mesh.alpha = tile.document.alpha * pulse;
        s.shader.uniforms.uTime = t;
        s.shader.uniforms.uPulse = pulse;
      }
    }
  } catch (e) {
    warn("tick failed; surface FX off until the scene is redrawn", e);
    stop();
  }
}

function startTicker() {
  if (state.ticking) return;
  try { canvas.app.ticker.add(onTick); state.ticking = true; } catch (e) { warn("ticker add failed", e); }
}
function stop() {
  if (state.ticking) { try { canvas.app.ticker.remove(onTick); } catch { /* */ } state.ticking = false; }
  teardownMeshes();
}
function refresh() {
  stop();
  const scene = canvas?.scene ?? null;
  state.sceneId = scene?.id ?? null;
  try { state.cfg = readSurfaceConfig(scene); } catch (e) { warn("bad config", e); state.cfg = null; }
  if (state.cfg) startTicker();
}

Hooks.on("canvasReady", () => refresh());
Hooks.on("canvasTearDown", () => { stop(); state.sceneId = null; state.cfg = null; });
Hooks.on("updateScene", (scene, change) => {
  if (scene?.id !== canvas?.scene?.id) return;
  if (change?.flags?.[MODULE_ID] !== undefined || change?.background !== undefined) refresh();
});
// The seal mesh follows its tile's texture/size; rebuild if the tile changes shape.
Hooks.on("updateTile", (tile, change) => {
  if (tile?.id && tile.id === state.cfg?.shimmerTile && ("width" in change || "height" in change || "x" in change || "y" in change || change.texture)) refresh();
});

Hooks.once("ready", () => {
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.surfaceFx = {
    refresh,
    status: () => ({ on: !!state.mesh, seal: !!state.seal, cfg: state.cfg }),
  };
});
