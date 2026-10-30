// ============================================================================
// Battle stage 3D — the 3D camera (experimental, "3D camera" setting).
//
// The backdrop is redrawn by three.js as real geometry: a floor and a back
// wall, textured by projecting the painting from the painted camera (see
// buildProjector in battle-stage-3d-rules.js). The result is handed to PIXI as
// a texture and drawn where the scene background normally is, so every other
// canvas layer keeps working on top of it.
//
// Battlers stay ordinary Foundry tokens. Each frame they are moved to where
// the live camera sees their feet and scaled by how much nearer or further it
// has brought them:
//
//   - The token CONTAINER (tokens layer: border, bars, nameplate, hit area) is
//     moved for real, so clicks and anything that reads token.x / token.y
//     (Sequencer's atLocation / attachTo / stretchTo) land on the drawn body.
//   - The token MESH (primary group) is moved only for the screen render and
//     put back right after it, so depth-index, battler-pose and the idle bounce
//     keep seeing their own numbers.
//
// The camera follows the director's 2D camera: the floor under the view
// centre stays exactly where the 2D camera puts it, and the pan / zoom around
// it become a real truck / dolly. On top of that: a slow idle sway, and
// scripted shots through FUCompanion.api.battleStage3d.camera.
//
// Safety net: whenever something is holding the camera (`held()` returns its
// reasons: the battle waiting on input, a cinematic), every move above eases
// out to NEUTRAL, the painted camera behind the 2D view. Once fully there the
// real background and the tokens' own 2D spots are restored, so anything not
// yet ported to the drawn positions lines up exactly as it does in 2D.
//
// Known gaps (this is a prototype):
//   - token.center reports the drawn centre while the camera is live (installed
//     by battle-stage-3d.js); Foundry's own placement and depth-index keep
//     reading the 2D spot. token.w / token.h stay the 2D size: overlays that
//     size themselves off the body read drawnBox() / drawnMeshBounds().
//   - Effects at fixed canvas points (not on a token) do not follow the camera.
//   - Only backdrops with a `stage3d` model: a floor + wall (Training Ground)
//     or a relief built from the depth map (Overworld, Valley of the Dragon).
//     A relief stretches across depth edges (a tree against far hills) once
//     the camera swings; the depth map's dilate + blur keeps that soft.
// ============================================================================

import { log, warn } from "./logger.js";
import { rigCamera, liveBattler, projectNearFoot, floorDepth, reliefDepth, reliefPoint } from "./battle-stage-3d-rules.js";
import { shadowSpriteFor } from "../sprite-shadow/sprite-shadow-renderer.js";

const THREE_SRC = "modules/fabula-ultima-companion/assets/vendor/three-r128.min.js";

const BG_VERT = `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const BG_FRAG = `
precision highp float;
varying vec3 vW;
uniform sampler2D map;
uniform float f, hz, Hp, cx, flipV;
uniform vec4 sceneRect;
uniform vec3 floorAvg, wallAvg;
void main(){
  float Z = max(0.01, -vW.z);
  vec2 p = vec2(cx + f * vW.x / Z, hz + f * (Hp - vW.y) / Z);
  vec2 uv = (p - sceneRect.xy) / sceneRect.zw;
  vec2 cl = clamp(uv, vec2(0.0), vec2(1.0));
  vec3 c = texture2D(map, vec2(cl.x, flipV > 0.5 ? 1.0 - cl.y : cl.y)).rgb;
  float off = length((uv - cl) * sceneRect.zw) / 260.0;
  c = mix(c, vW.y < 0.02 ? floorAvg : wallAvg, clamp(off, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}`;

let threeLoading = null;
function loadThree() {
  if (globalThis.THREE?.WebGLRenderer) return Promise.resolve(globalThis.THREE);
  if (threeLoading) return threeLoading;
  threeLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = foundry.utils.getRoute(THREE_SRC);
    s.onload = () => (globalThis.THREE ? resolve(globalThis.THREE) : reject(new Error("three.js loaded without THREE")));
    s.onerror = () => reject(new Error(`three.js failed to load (${THREE_SRC})`));
    document.head.appendChild(s);
  });
  threeLoading.catch(() => { threeLoading = null; });
  return threeLoading;
}

// The depth map as numbers (one grey channel, value = D / 2), for building a relief.
async function loadDepthField(path) {
  const img = new Image();
  img.decoding = "async";
  img.src = foundry.utils.getRoute(path);
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const w = c.width, h = c.height;
  const D = new Float32Array(w * h);
  for (let i = 0; i < D.length; i++) D[i] = (px[i * 4] / 255) * 2;
  // Bilinear disparity at backdrop UV (clamped to the edges).
  return (u, v) => {
    const x = Math.min(w - 1, Math.max(0, u * w - 0.5)), y = Math.min(h - 1, Math.max(0, v * h - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = D[y0 * w + x0] + (D[y0 * w + x1] - D[y0 * w + x0]) * fx;
    const b = D[y1 * w + x0] + (D[y1 * w + x1] - D[y1 * w + x0]) * fx;
    return a + (b - a) * fy;
  };
}

// Mean colour of the painting's bottom (floor) and top (scenery) bands: what
// fills in past the painting's edge once the camera turns. Null if the image
// cannot be read back (a cross-origin texture without CORS).
function paintingAverages(src) {
  try {
    const c = document.createElement("canvas");
    c.width = 32; c.height = 32;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, 0, 0, 32, 32);
    const px = g.getImageData(0, 0, 32, 32).data;
    const mean = (r0, r1) => {
      const m = [0, 0, 0]; let n = 0;
      for (let y = r0; y < r1; y++) for (let x = 0; x < 32; x++) { const i = (y * 32 + x) * 4; m[0] += px[i]; m[1] += px[i + 1]; m[2] += px[i + 2]; n++; }
      return m.map((v) => v / n / 255);
    };
    return { wall: mean(0, 8), floor: mean(22, 32) };
  } catch { return null; }
}

// A grid over the painting (denser) and well past its edges, each vertex
// pushed out along the projector's ray to its relief depth. Past the edges
// there is no depth to read: the relief eases back to bare floor and horizon
// within a few percent of the width, so an edge rock does not smear outward.
function buildReliefGeometry(THREE, P, rect, depthAt) {
  const fade = 0.03 * rect.w;
  const outside = (x, y) => Math.max(rect.x - x, x - rect.x - rect.w, rect.y - y, y - rect.y - rect.h, 0);
  const span = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  const xs = [...span(rect.x - rect.w * 0.8, rect.x, 16).slice(0, -1), ...span(rect.x, rect.x + rect.w, 220), ...span(rect.x + rect.w, rect.x + rect.w * 1.8, 16).slice(1)];
  const ys = [...span(rect.y - rect.h * 0.3, rect.y, 8).slice(0, -1), ...span(rect.y, rect.y + rect.h, 150), ...span(rect.y + rect.h, rect.y + rect.h * 1.6, 14).slice(1)];
  const nx = xs.length, ny = ys.length;
  const pos = new Float32Array(nx * ny * 3);
  let k = 0;
  for (const y of ys) {
    const v = (y - rect.y) / rect.h;
    for (const x of xs) {
      const keep = Math.max(0, 1 - outside(x, y) / fade);
      const Z = reliefDepth(y, keep > 0 ? depthAt((x - rect.x) / rect.w, v) * keep : 0, P);
      const p = reliefPoint({ x, y }, Z, P);
      pos[k++] = p.X; pos[k++] = p.Y; pos[k++] = p.Z;
    }
  }
  const idx = new (nx * ny > 65535 ? Uint32Array : Uint16Array)((nx - 1) * (ny - 1) * 6);
  k = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

// Easing into neutral is quick (whatever was held is about to need 2D); back
// out to the free camera is slower.
const NEUTRAL_IN_MS = 450;
const NEUTRAL_OUT_MS = 900;

// Fired after every frame that moved the drawn battlers (and once on settling
// back to plain 2D), so DOM overlays placed from drawnBox() can follow them.
export const DRAWN_HOOK = "fu-stage3d-drawn";

export const SHOTS = Object.freeze({
  painted: { yaw: 0, tilt: 0, push: 1 },
  left: { yaw: 18, tilt: 3, push: 0.9 },
  right: { yaw: -18, tilt: 3, push: 0.9 },
  low: { yaw: -5, tilt: -6, push: 0.8 },
  high: { yaw: 4, tilt: 14, push: 1.05 },
});

export class Stage3dCamera {
  constructor({ scene, cfg, P, restView, sway, held = () => [], lost = null }) {
    this.sceneId = scene.id;
    this.cfg = cfg;
    this.P = P;
    this.restView = restView;      // () => {x, y, scale}
    this.sway = sway;              // () => boolean
    this.held = held;              // () => string[]; non-empty = ease to neutral
    this.lost = lost;              // () => void; the GPU dropped our context (after stop)
    this.shot = { yaw: 0, tilt: 0, push: 1 };
    this.tween = null;
    this.t0 = performance.now();
    this.holds = held();
    this.nLin = this.holds.length ? 1 : 0;   // start where we belong, no ease
    this.neutral = this.nLin;
    this.flat = false;             // fully neutral: drawn as plain 2D this frame
    this.lastNow = this.t0;
    this.tokens = new Map();       // token -> {lx, ly, bx, by, map}
    this.meshLive = false;         // meshes sit at their drawn spots (inside a render)
    this.meshSaves = [];
    this.lastRig = null;
    this.frames = 0;
    this._pre = () => this.#prerender();
    this._post = () => this.#postrender();
  }

  async start() {
    const THREE = await loadThree();
    const depthAt = this.P.relief ? await loadDepthField(this.cfg.depthMap) : null;
    if (canvas?.scene?.id !== this.sceneId) return false;
    const bg = canvas.primary?.background;
    const src = bg?.texture?.baseTexture?.resource?.source ?? null;
    if (!src) throw new Error("no background image to project");
    this.bgTex = bg.texture;

    const el = document.createElement("canvas");
    const r = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: false });
    r.setPixelRatio(1);
    r.setClearColor(new THREE.Color(...this.P.void));
    this.renderer = r;
    // A GPU reset (driver timeout) takes the context with it: drop to the 2D
    // view instead of drawing a blank backdrop for the rest of the battle.
    this._lostCtx = (e) => {
      e?.preventDefault?.();
      warn("battle-stage-3d: WebGL context lost; 3D camera off, back to the 2D view");
      this.stop();
      this.lost?.();
    };
    el.addEventListener("webglcontextlost", this._lostCtx, false);
    this.glCanvas = el;
    this.scene3 = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);

    const isBitmap = typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap;
    const tex = new THREE.Texture(src);
    tex.flipY = !isBitmap;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = r.capabilities.getMaxAnisotropy();
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.tex3 = tex;

    const d = canvas.dimensions;
    const P = this.P;
    const avg = (!P.floorAvg || !P.wallAvg) ? paintingAverages(src) : null;
    const floorAvg = P.floorAvg ?? avg?.floor ?? [0.3, 0.25, 0.2];
    const wallAvg = P.wallAvg ?? avg?.wall ?? [0.25, 0.22, 0.2];
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: tex }, f: { value: P.f }, hz: { value: P.hz }, Hp: { value: P.Hp }, cx: { value: P.cx },
        flipV: { value: isBitmap ? 0 : 1 },
        sceneRect: { value: new THREE.Vector4(d.sceneX, d.sceneY, d.sceneWidth, d.sceneHeight) },
        floorAvg: { value: new THREE.Vector3(...floorAvg) }, wallAvg: { value: new THREE.Vector3(...wallAvg) },
      },
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      side: THREE.DoubleSide,
    });
    this.mat = mat;
    if (P.relief) {
      const rect = { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight };
      this.scene3.add(new THREE.Mesh(buildReliefGeometry(THREE, P, rect, depthAt), mat));
    } else this.#addFloorAndWall(THREE, P, d, mat);

    this.pixiTex = PIXI.Texture.from(el);
    const spr = new PIXI.Sprite(this.pixiTex);
    spr.name = "battleStage3dCamera";
    spr.elevation = bg.elevation;
    spr.sortLayer = bg.sortLayer;
    spr.sort = (bg.sort || 0) + 1;
    spr.zIndex = bg.zIndex;
    spr.visible = false;           // until the first frame has drawn into it
    canvas.primary.addChild(spr);
    this.sprite = spr;

    this.qa = new THREE.Quaternion(); this.qb = new THREE.Quaternion();
    this.AX = new THREE.Vector3(1, 0, 0); this.AY = new THREE.Vector3(0, 1, 0);

    canvas.app.renderer.on("prerender", this._pre);
    canvas.app.renderer.on("postrender", this._post);
    this.running = true;
    log(`battle-stage-3d: 3D camera on (${this.cfg.key})`);
    return true;
  }

  // Enclosed arena: a floor and a back wall at the painting's wall row.
  #addFloorAndWall(THREE, P, d, mat) {
    const zw = floorDepth(P.wallY, P);
    const front = 12;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.scale.set(zw * 2.2, zw + front, 1);
    floor.position.set(0, 0, -(zw - front) / 2);
    const top = P.Hp - ((d.sceneY - P.hz) * zw) / P.f;      // painting's top edge, on the wall
    const wallH = Math.max(top + 12, 20);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    wall.scale.set(zw * 2.2, wallH, 1);
    wall.position.set(0, wallH / 2, -zw);
    this.scene3.add(floor, wall);
  }

  stop() {
    if (!this.running && !this.renderer) return;
    this.running = false;
    try { canvas.app.renderer.off("prerender", this._pre); canvas.app.renderer.off("postrender", this._post); } catch {}
    this.#postrender();
    for (const [token] of this.tokens) {
      if (token.destroyed) continue;
      try {
        token.scale.set(1, 1);
        token.position.set(token.document.x, token.document.y);
        token.renderFlags?.set?.({ refreshPosition: true });
      } catch {}
    }
    this.tokens.clear();
    try { const bg = canvas.primary?.background; if (bg && !bg.destroyed) bg.renderable = true; } catch {}
    if (this.sprite) { try { this.sprite.parent?.removeChild(this.sprite); this.sprite.destroy(); } catch {} this.sprite = null; }
    if (this.pixiTex) { try { this.pixiTex.destroy(true); } catch {} this.pixiTex = null; }
    try { this.mat?.dispose(); this.tex3?.dispose(); this.scene3?.traverse((o) => o.geometry?.dispose?.()); } catch {}
    // Our own forceContextLoss below must not read as a GPU reset.
    try { this.glCanvas?.removeEventListener("webglcontextlost", this._lostCtx, false); } catch {}
    this.glCanvas = null;
    try { this.renderer?.dispose(); this.renderer?.forceContextLoss?.(); } catch {}
    this.renderer = null;
    this.#announce();
  }

  /** Tween the scripted part of the camera. Resolves when it lands. */
  go(partial = {}, ms = 1400) {
    const from = { ...this.shot };
    const to = { ...from, ...partial };
    return new Promise((resolve) => { this.tween = { from, to, t0: performance.now(), ms: Math.max(1, ms), done: resolve }; });
  }

  /**
   * How the camera moves this token this frame, or null when it is not
   * displacing it: a point p placed against the 2D spot is drawn at
   * (bx, by) + (p - (fx, fy)) * m, where (fx, fy) is the 2D foot point.
   */
  drawnMap(token) {
    if (!this.running || this.flat || !token || token.destroyed) return null;
    return this.tokens.get(token)?.map ?? null;
  }

  /**
   * Where a world point placed against this token's 2D spot would be drawn if
   * the 2D camera sat at `view` ({x, y, scale}) right now: what a planned pan
   * (unit inspect's close-up) aims with. Null when the camera is not displacing
   * the token, or the view is the one being drawn and drawnMap already says.
   */
  predictPoint(token, p, view) {
    if (!this.running || this.flat || !token || token.destroyed || !this.tokens.has(token)) return null;
    const rig = rigCamera({
      view, rest: this.restView(), shot: this.shot,
      t: (performance.now() - this.t0) / 1000, sway: this.sway(), neutral: this.neutral,
    }, this.P, this.cfg);
    const st = this.tokens.get(token);
    const foot = { x: st.bx + token.w / 2, y: st.by + token.h };
    const b = liveBattler(foot, this.P, rig);
    const m = Math.max(0.2, Math.min(4, b.scale));
    return { x: b.x + (p.x - foot.x) * m, y: b.y + (p.y - foot.y) * m, m };
  }

  /**
   * Where feet standing at a 2D canvas point are drawn this frame: {x, y, m}
   * (drawn feet, size factor), or null when the camera is flat. For a body
   * moving across the floor away from any token's spot (an entrance run-in).
   */
  projectFoot(foot) {
    if (!this.running || this.flat || !this.lastRig || !foot) return null;
    const b = liveBattler(foot, this.P, this.lastRig);
    return { x: b.x, y: b.y, m: Math.max(0.2, Math.min(4, b.scale)) };
  }

  /**
   * Where a point in the arena near feet at 2D canvas point `foot` is drawn
   * this frame (projectNearFoot: `off` = {x, h, z} in rest px at that row),
   * or null when the camera is flat. For entrance paths that live in the
   * arena: an arrow flying in, wisps circling, shards flying out.
   */
  projectNear(foot, off) {
    if (!this.running || this.flat || !this.lastRig || !foot) return null;
    return projectNearFoot(foot, off, this.P, this.lastRig);
  }

  /** Where the token's centre is drawn this frame, or null when the camera is not displacing it. */
  drawnCenter(token) {
    if (!this.running || this.flat || !this.tokens.has(token) || token.destroyed) return null;
    return { x: token.position.x + (token.w * token.scale.x) / 2, y: token.position.y + (token.h * token.scale.y) / 2 };
  }

  status() {
    const g = this.lastRig;
    return {
      running: !!this.running,
      frames: this.frames,
      neutral: +this.neutral.toFixed(3),
      flat: this.flat,
      holds: [...this.holds],
      shot: { ...this.shot },
      rig: g ? { yaw: +g.yaw.toFixed(2), tilt: +g.tilt.toFixed(2), k: +g.k.toFixed(3), camera: g.C.map((v) => +v.toFixed(2)) } : null,
      tokens: [...this.tokens.keys()].filter((t) => !t.destroyed).map((t) => ({
        name: t.name, x: Math.round(t.position.x - t.document.x), y: Math.round(t.position.y - t.document.y), scale: +t.scale.x.toFixed(3),
      })),
    };
  }

  #stepTween(now) {
    const tw = this.tween;
    if (!tw) return;
    const u = Math.min(1, (now - tw.t0) / tw.ms);
    const e = ease(u);
    for (const k of Object.keys(tw.to)) this.shot[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * e;
    if (u >= 1) { this.tween = null; tw.done?.(); }
  }

  #prerender() {
    const pr = canvas.app.renderer;
    if (!this.running || !pr.renderingToScreen || canvas?.scene?.id !== this.sceneId) return;
    try { this.#frame(); } catch (e) { warn("battle-stage-3d: camera frame failed; stopping", e); this.stop(); }
  }

  #postrender() {
    this.meshLive = false;
    const saves = this.meshSaves;
    for (const s of saves) {
      const m = s.mesh;
      if (m.destroyed) continue;
      m.position.set(s.x, s.y);
      m.scale.set(s.sx, s.sy);
    }
    saves.length = 0;
  }

  #stepNeutral(now) {
    this.holds = this.held();
    const dt = Math.max(0, now - this.lastNow);
    this.lastNow = now;
    this.nLin = this.holds.length
      ? Math.min(1, this.nLin + dt / NEUTRAL_IN_MS)
      : Math.max(0, this.nLin - dt / NEUTRAL_OUT_MS);
    this.neutral = ease(this.nLin);
  }

  // Fully neutral: the real background and every token on its own 2D spot.
  #drawFlat() {
    const entering = !this.flat;
    if (entering) {
      this.flat = true;
      this.sprite.visible = false;
      const bg = canvas.primary.background;
      if (bg && !bg.destroyed) bg.renderable = true;
    }
    for (const token of canvas.tokens?.placeables ?? []) {
      const st = this.tokens.get(token);
      if (!st || token.destroyed) continue;
      if (token.position.x !== st.lx || token.position.y !== st.ly) { st.bx = token.position.x; st.by = token.position.y; }
      if (token.position.x !== st.bx || token.position.y !== st.by) token.position.set(st.bx, st.by);
      if (token.scale.x !== 1 || token.scale.y !== 1) token.scale.set(1, 1);
      st.lx = st.bx; st.ly = st.by;
      st.map = null;
    }
    for (const [token] of this.tokens) if (token.destroyed) this.tokens.delete(token);
    if (entering) this.#announce();
  }

  #announce() {
    try { Hooks.callAll(DRAWN_HOOK, this); } catch (e) { warn("battle-stage-3d: drawn hook threw", e); }
  }

  #frame() {
    const now = performance.now();
    this.#stepTween(now);
    this.#stepNeutral(now);
    if (this.neutral >= 1) { this.lastRig = null; this.#drawFlat(); this.frames++; return; }
    this.flat = false;
    this.sprite.visible = true;
    const stage = canvas.stage;
    const view = { x: stage.pivot.x, y: stage.pivot.y, scale: stage.scale.x };
    const rig = rigCamera({
      view, rest: this.restView(), shot: this.shot,
      t: (now - this.t0) / 1000, sway: this.sway(), neutral: this.neutral,
    }, this.P, this.cfg);
    this.lastRig = rig;

    // ── Backdrop ──
    const scr = canvas.app.renderer.screen;
    const W = Math.max(1, Math.round(scr.width)), H = Math.max(1, Math.round(scr.height));
    const win = { x: view.x - W / (2 * view.scale), y: view.y - H / (2 * view.scale), w: W / view.scale, h: H / view.scale };
    const r = this.renderer;
    const el = r.domElement;
    if (el.width !== W || el.height !== H) r.setSize(W, H, false);

    const cam = this.camera;
    cam.position.set(rig.C[0], rig.C[1], rig.C[2]);
    this.qa.setFromAxisAngle(this.AY, (rig.yaw * Math.PI) / 180);
    this.qb.setFromAxisAngle(this.AX, (-rig.tilt * Math.PI) / 180);
    cam.quaternion.copy(this.qa).multiply(this.qb);
    // Full frame centred on the principal point c0; the window is the 2D view.
    const halfW = Math.max(Math.abs(win.x - rig.c0.x), Math.abs(win.x + win.w - rig.c0.x)) + 1;
    const halfH = Math.max(Math.abs(win.y - rig.c0.y), Math.abs(win.y + win.h - rig.c0.y)) + 1;
    cam.fov = (2 * Math.atan(halfH / rig.f) * 180) / Math.PI;
    cam.aspect = halfW / halfH;
    cam.setViewOffset(halfW * 2, halfH * 2, win.x - (rig.c0.x - halfW), win.y - (rig.c0.y - halfH), win.w, win.h);
    cam.updateProjectionMatrix();
    r.render(this.scene3, cam);
    this.pixiTex.baseTexture.update();

    const spr = this.sprite;
    spr.position.set(win.x, win.y);
    spr.width = win.w;
    spr.height = win.h;
    const bg = canvas.primary.background;
    if (bg && bg.renderable) bg.renderable = false;

    // ── Battlers ──
    for (const token of canvas.tokens?.placeables ?? []) {
      if (token.destroyed || !token.mesh) continue;
      let st = this.tokens.get(token);
      if (!st) { st = { lx: NaN, ly: NaN, bx: token.position.x, by: token.position.y }; this.tokens.set(token, st); }
      // Foundry (or an animation) moved it since our last write: that is the new 2D spot.
      if (token.position.x !== st.lx || token.position.y !== st.ly) { st.bx = token.position.x; st.by = token.position.y; }
      const w = token.w, h = token.h;
      const foot = { x: st.bx + w / 2, y: st.by + h };
      const b = liveBattler(foot, this.P, rig);
      const m = Math.max(0.2, Math.min(4, b.scale));
      const nx = b.x - (w / 2) * m, ny = b.y - h * m;
      token.position.set(nx, ny);
      token.scale.set(m, m);
      st.lx = token.position.x; st.ly = token.position.y;
      st.map = { fx: foot.x, fy: foot.y, bx: b.x, by: b.y, m };

      const mesh = token.mesh;
      if (mesh.destroyed) continue;
      this.meshSaves.push({ mesh, x: mesh.position.x, y: mesh.position.y, sx: mesh.scale.x, sy: mesh.scale.y });
      mesh.position.set(b.x + (mesh.position.x - foot.x) * m, b.y + (mesh.position.y - foot.y) * m);
      mesh.scale.set(mesh.scale.x * m, mesh.scale.y * m);
      // Its ground shadow (sprite-shadow) is placed from the 2D mesh: carry it along.
      const sh = shadowSpriteFor(token.id);
      if (sh && !sh.destroyed) {
        this.meshSaves.push({ mesh: sh, x: sh.position.x, y: sh.position.y, sx: sh.scale.x, sy: sh.scale.y });
        sh.position.set(b.x + (sh.position.x - foot.x) * m, b.y + (sh.position.y - foot.y) * m);
        sh.scale.set(sh.scale.x * m, sh.scale.y * m);
      }
    }
    for (const [token] of this.tokens) if (token.destroyed) this.tokens.delete(token);
    this.meshLive = true;
    this.frames++;
    this.#announce();
  }
}
