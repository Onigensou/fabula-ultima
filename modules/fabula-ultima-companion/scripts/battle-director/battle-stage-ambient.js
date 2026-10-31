// ============================================================================
// Battle stage ambient — scene effects laid over a painted battle backdrop.
//
// A tile, a Foundry light or an FXMaster particle stays at a fixed canvas point,
// while the 3D camera and the parallax mesh move the painting under it, so a
// glow placed on a painted crystal would slide off at the first pan. These
// effects ask battle-stage-3d where their painted point is drawn this frame, and
// follow it.
//
// Which scenes: a backdrop whose preset has an `ambient` block (positions in
// canvas px on that image; battle-stage-3d-rules.js). Everything else is untouched.
//
//   glow    a soft halo on every crystal, breathing at its own pace
//   surge   every few seconds one crystal flares and spills light on the floor
//   arc     short hand-drawn arcs crackle on a random crystal
//   mist    slow fog bands along the back of the cave
//   ripple  drip rings on the pools
//
// Client-local, writes nothing to any document, and every client rolls its own
// timing. Drawn directly over the backdrop, so tiles and tokens stay above it.
// Holds still under reduced motion; hidden tabs get no frames at all.
//
//   FUCompanion.api.battleStageAmbient.status() / .refresh() / .tune({ strength })
// ============================================================================

import { log, warn } from "./logger.js";
import { resolvePreset } from "./battle-stage-3d-rules.js";
import { loadDepthField, DRAWN_HOOK } from "./battle-stage-3d-camera.js";

const STAGE_KEY = "__ONI_BATTLE_STAGE_3D__";

// Rest values (per second where it is a rate), matched to the approved mockup.
const LOOK = Object.freeze({
  mistBands: 9,
  surgeEvery: [5, 9], surgeDur: 1.5,
  arcEvery: [1.1, 2.8], arcSize: 2.3,
  rippleEvery: [0.9, 2.4], rippleDur: 1.8,
  arcTint: 0xa9bcff, mistTint: 0x5560c8, rippleTint: 0xb9c6ff,
});

const state = {
  scene: null, cfg: null, depthAt: null, root: null, ticking: false, starting: 0,
  strength: 1, t0: 0, last: 0, frames: 0, rect: null,
  tex: {}, halos: [], washes: [], mist: [], arcs: [], rippleGfx: null,
  surges: [], arcLive: [], ripples: [], tSurge: 2, tArc: 1, tRipple: 1,
};

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const stage3d = () => globalThis[STAGE_KEY];
const reducedMotion = () => { try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

function radialTexture(stops) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) r.addColorStop(o, col);
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  return PIXI.Texture.from(c);
}

function addSprite(tex, tint = 0xffffff) {
  const s = new PIXI.Sprite(tex);
  s.anchor.set(0.5);
  s.blendMode = PIXI.BLEND_MODES.ADD;
  s.tint = tint;
  s.visible = false;
  state.root.addChild(s);
  return s;
}

function stop() {
  stopTicking();
  const r = state.root;
  state.root = null;
  if (r) { try { r.parent?.removeChild(r); r.destroy({ children: true }); } catch (e) { warn("battle-stage-ambient: teardown failed", e); } }
  for (const k of ["halo", "wash"]) { try { state.tex[k]?.destroy(true); } catch {} }
  for (const f of state.tex.arcFrames ?? []) { try { f.destroy(false); } catch {} }
  state.tex = {};
  state.halos = []; state.washes = []; state.mist = []; state.arcs = []; state.rippleGfx = null;
  state.surges = []; state.arcLive = []; state.ripples = [];
  state.scene = null; state.cfg = null; state.depthAt = null;
}

async function start(scene) {
  const token = ++state.starting;
  stop();
  const cfg = scene ? resolvePreset(scene.background?.src) : null;
  const a = cfg?.ambient;
  if (!a) return;
  const bg = canvas.primary?.background;
  if (!bg) return;

  const [depthAt, arcTex, mistTex] = await Promise.all([
    loadDepthField(cfg.depthMap).catch((e) => { warn(`battle-stage-ambient: depth map missing ${cfg.depthMap}`, e); return null; }),
    loadTexture(a.arcSheet.src).catch(() => null),
    loadTexture(a.mistTexture).catch(() => null),
  ]);
  if (token !== state.starting || canvas?.scene?.id !== scene.id) return;
  if (!depthAt) return;

  const root = new PIXI.Container();
  root.name = "battleStageAmbient";
  // One sort step above the backdrop and whichever layer battle-stage-3d drew it with.
  root.elevation = bg.elevation;
  root.sortLayer = bg.sortLayer;
  root.sort = (bg.sort || 0) + 2;
  root.zIndex = bg.zIndex;
  state.root = root;
  state.scene = scene;
  state.cfg = cfg;
  state.depthAt = depthAt;
  const d = canvas.dimensions;
  state.rect = { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight };

  state.tex.halo = radialTexture([[0, "rgba(200,210,255,.95)"], [0.12, "rgba(130,140,255,.7)"], [0.45, "rgba(80,80,235,.22)"], [1, "rgba(60,60,220,0)"]]);
  state.tex.wash = radialTexture([[0, "rgba(120,130,255,.55)"], [0.5, "rgba(90,95,240,.2)"], [1, "rgba(70,70,230,0)"]]);

  if (mistTex?.valid) {
    state.mist = Array.from({ length: LOOK.mistBands }, (_, i) => ({
      sprite: addSprite(mistTex, LOOK.mistTint),
      x: ((i + 0.5) * state.rect.w) / LOOK.mistBands, y: rnd(268, 400), w: rnd(620, 1000),
      v: rnd(5, 13) * (Math.random() < 0.5 ? -1 : 1), a: rnd(0.07, 0.15), ph: rnd(0, 6),
    }));
  } else warn(`battle-stage-ambient: no mist texture ${a.mistTexture}`);
  state.halos = a.crystals.map((c) => ({ c, ph: c[0] * 0.013, sprite: addSprite(state.tex.halo) }));
  state.washes = a.crystals.map(() => addSprite(state.tex.wash));
  state.rippleGfx = new PIXI.Graphics();
  state.rippleGfx.blendMode = PIXI.BLEND_MODES.ADD;
  root.addChild(state.rippleGfx);
  if (arcTex?.valid) {
    const { cols, rows, frames } = a.arcSheet;
    const cw = arcTex.width / cols, ch = arcTex.height / rows;
    state.tex.arcFrames = Array.from({ length: frames }, (_, i) => new PIXI.Texture(arcTex.baseTexture, new PIXI.Rectangle((i % cols) * cw, Math.floor(i / cols) * ch, cw, ch)));
    state.arcs = Array.from({ length: 4 }, () => addSprite(state.tex.arcFrames[0], LOOK.arcTint));
  } else warn(`battle-stage-ambient: no arc sheet ${a.arcSheet.src}`);

  canvas.primary.addChild(root);
  state.t0 = state.last = performance.now();
  state.tSurge = 2; state.tArc = 1; state.tRipple = 1;
  startTicking();
  log(`battle-stage-ambient: on (${cfg.key})`);
}

/* ── Frame ───────────────────────────────────────────────────────────────── */

function pin(x, y) {
  const r = state.rect;
  const D = state.depthAt((x - r.x) / r.w, (y - r.y) / r.h);
  return stage3d()?.paintedPoint?.({ x, y }, D) ?? { x, y, s: 1 };
}

function place(sprite, x, y, w, h, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  sprite.visible = a > 0.002;
  if (!sprite.visible) return;
  const p = pin(x, y);
  sprite.position.set(p.x, p.y);
  sprite.scale.set((w * p.s) / sprite.texture.width, (h * p.s) / sprite.texture.height);
  sprite.alpha = a;
}

function surgeOf(c) {
  let b = 0;
  for (const e of state.surges) {
    if (e.c !== c) continue;
    const u = e.age / e.dur;
    b = Math.max(b, u < 0.12 ? u / 0.12 : Math.pow(1 - (u - 0.12) / 0.88, 2));
  }
  return b;
}

function step(dt) {
  const a = state.cfg.ambient, k = state.strength;
  const every = (key, [lo, hi], fn) => { state[key] -= dt * k; if (state[key] <= 0) { state[key] = rnd(lo, hi); fn(); } };
  const arcAt = (c, big) => state.arcLive.push({ c, age: 0, dur: a.arcSheet.ms / 1000, rot: rnd(0, Math.PI * 2), big });
  every("tSurge", LOOK.surgeEvery, () => { const c = pick(a.crystals); state.surges.push({ c, age: 0, dur: LOOK.surgeDur }); arcAt(c, 1.5); });
  every("tArc", LOOK.arcEvery, () => arcAt(pick(a.crystals), 1));
  every("tRipple", LOOK.rippleEvery, () => {
    const p = pick(a.pools);
    state.ripples.push({ x: p[0] + rnd(-p[2], p[2]), y: p[1] + rnd(-p[3], p[3]), age: 0, dur: LOOK.rippleDur });
  });
  for (const L of [state.surges, state.arcLive, state.ripples]) {
    for (const e of L) e.age += dt;
    for (let i = L.length - 1; i >= 0; i--) if (L[i].age >= L[i].dur) L.splice(i, 1);
  }
}

function draw(t) {
  const k = state.strength, r = state.rect;
  for (const m of state.mist) {
    const span = r.w + 240;
    const x = r.x + (((m.x + m.v * t) % span) + span) % span - 120;
    place(m.sprite, x, m.y + Math.sin(t * 0.2 + m.ph) * 6, m.w, m.w * 0.3, m.a * k);
  }
  state.halos.forEach((h, i) => {
    const c = h.c, b = surgeOf(c);
    const size = c[2] * (3.4 + b * 1.1);
    place(h.sprite, c[0], c[1], size, size, (0.3 + 0.13 * Math.sin(t * 0.75 + h.ph) + 0.05 * Math.sin(t * 2.3 + h.ph * 2)) * k + b * 0.6);
    place(state.washes[i], c[0], c[1] + c[2] * 1.2 + 90, c[2] * 7 + 420, c[2] * 2 + 190, b * k);
  });

  const g = state.rippleGfx;
  g.clear();
  for (const e of state.ripples) {
    const u = e.age / e.dur, p = pin(e.x, e.y), rx = (6 + 62 * u) * p.s;
    g.lineStyle(1.5, LOOK.rippleTint, Math.min(1, (1 - u) * 0.75 * k));
    g.drawEllipse(p.x, p.y, rx, rx * 0.27);
  }

  const frames = state.tex.arcFrames;
  state.arcs.forEach((s, i) => {
    const e = state.arcLive[i];
    if (!e || !frames) { s.visible = false; return; }
    const f = Math.min(frames.length - 1, Math.floor((e.age / e.dur) * frames.length));
    s.texture = frames[f];
    const size = e.c[2] * LOOK.arcSize * e.big;
    place(s, e.c[0], e.c[1], size, size, k);
    s.rotation = e.rot;
  });
}

function frame() {
  if (!state.root || state.root.destroyed) return;
  try {
    if (canvas?.scene?.id !== state.scene?.id) return;
    const now = performance.now();
    const still = reducedMotion();
    const dt = Math.min(0.05, Math.max(0, now - state.last) / 1000);
    state.last = now;
    if (!still) step(dt);
    draw(still ? 0 : (now - state.t0) / 1000);
    state.frames++;
  } catch (e) {
    // A throw here would land in PIXI's render loop and freeze the canvas.
    warn("battle-stage-ambient: frame failed; stopping", e);
    stop();
  }
}

// With the 3D camera live, painted points are fresh only after its prerender, so
// the frame runs from its announcement. Otherwise from our own prerender.
function onPrerender() {
  if (!canvas?.app?.renderer?.renderingToScreen) return;
  if (stage3d()?.cameraLive?.()) return;
  frame();
}

function startTicking() {
  if (state.ticking) return;
  canvas.app.renderer.on("prerender", onPrerender);
  state.ticking = true;
}

function stopTicking() {
  if (!state.ticking) return;
  try { canvas.app.renderer.off("prerender", onPrerender); } catch {}
  state.ticking = false;
}

/* ── API ─────────────────────────────────────────────────────────────────── */

export const BattleStageAmbientApi = {
  status: () => ({
    on: !!state.root, preset: state.cfg?.key ?? null, strength: state.strength, frames: state.frames,
    crystals: state.halos.length, mist: state.mist.length, arcs: state.arcs.length, reducedMotion: reducedMotion(),
  }),
  refresh: () => start(canvas?.scene),
  /** Session-only: { strength } scales every effect's brightness and rate. */
  tune({ strength } = {}) { if (Number.isFinite(strength)) state.strength = strength; return this.status(); },
};

export function initBattleStageAmbient() {
  try {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.battleStageAmbient = BattleStageAmbientApi;
  } catch (e) { warn("battle-stage-ambient: api attach failed", e); }

  const startSafe = (scene) => start(scene).catch((e) => warn("battle-stage-ambient: start failed", e));
  Hooks.on("canvasReady", () => startSafe(canvas?.scene));
  Hooks.on("canvasTearDown", () => { state.starting++; stop(); });
  Hooks.on("updateScene", (scene, change) => {
    if (scene.id === canvas?.scene?.id && change?.background !== undefined) startSafe(scene);
  });
  Hooks.on(DRAWN_HOOK, () => { if (stage3d()?.cameraLive?.()) frame(); });
  if (canvas?.ready) startSafe(canvas.scene);
}
