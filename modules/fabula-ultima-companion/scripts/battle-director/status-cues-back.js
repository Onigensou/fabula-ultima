// status-cues-back.js — the BEHIND-the-sprite half of the token status cues.
//
// status-cues.js draws its cues in one DOM layer over the whole canvas, so
// nothing it draws can pass behind a body. The Zombie miasma needs that (approved
// mockup claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX, section "Zombie": "about a
// third of the puffs pass behind the body"), so this module adds the second cue
// layer: one PIXI container per unit in canvas.primary, carrying the unit mesh's
// own depth keys a hair BEFORE the mesh (the same pattern as charge-orbit-fx.js's
// back layer). The body covers it, and a back-row unit's puffs never paint over
// a front-row unit.
//
//   - Placed every frame on the mesh's rendered rect (and again on the 3D camera's
//     "fu-stage3d-drawn" hook), so it rides the displaced, rescaled battler.
//   - Sized by the drawn body height / 250 (the cue --k), so depth and zoom carry over.
//   - Hidden outside battle, during cinematics (fuBattleMarksHidden, with the DOM
//     cues), and while the mesh is hidden (live board copy).
//   - The ticker runs only while at least one unit has a back cue.
//   - prefers-reduced-motion: the puffs hold still, like the DOM cues' paused
//     animations.
//
// The puffs are the mockup's `.ms` elements animated by its `zbMist` keyframes,
// replayed by hand (same keyframe stops, same ease-in-out per segment).
//
// Per client, display only: no socket, no document writes.

import { warn } from "./logger.js";
import { battleActive } from "./battle-focus.js";

const DRAWN_HOOK = "fu-stage3d-drawn";
const Z_EPS = 0.001;
const REF_H = 250;
const FADE_IN = 500, FADE_OUT = 500;     // the mockup's .zb-cue opacity transition (.5s)

const C = new Map();          // token id -> { token, key, cont, parts, t0, exit }
const exiting = new Set();
let _hidden = false, _installed = false, _tick = null, _tex = null;

// ───────── layout (pure)

// Deterministic per token so a rebuild does not reshuffle the puffs (status-cues rng).
function rng(seed) {
  let s = 7;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * The miasma puffs of one unit, the mockup's cueHTML('mist') loop verbatim.
 * Sizes / drifts are px at a 250 px sprite (multiply by k). `back` = drawn behind
 * the body (y > .08 and every third puff).
 * @returns {{ x, yb, s, sq, dx, rise, d, delay, back }[]}  x = 0..1 of the width,
 *   yb = the element's bottom as 0..1 of the height above the sprite bottom.
 */
export function miasmaPuffs(seed, cfg) {
  const r = rng(String(seed) + "mist"), out = [];
  for (let i = 0; i < cfg.rate; i++) {
    // height along the body: 0 = feet, up to Coverage × 92% of the sprite (the head)
    const y = Math.pow(r(), 1.25) * cfg.cov * 0.92, spread = 0.36 - 0.12 * y, side = r() < 0.5 ? -1 : 1, x = 0.5 + side * r() * spread;
    const big = (1 - 0.35 * y) * (26 + r() * 24) * (cfg.cov > 0 ? 1 : 1.25);
    const d = (3 + r() * 1.8) / cfg.spd;
    const yb = y - 0.03 + r() * 0.04;
    const s = big * cfg.size;
    const sq = y > 0.1 ? 0.75 : 0.5;
    const dx = side * (8 + r() * 18);
    const rise = -(14 + r() * 22);
    const delay = r() * d;
    out.push({ x, yb, s, sq, dx, rise, d, delay, back: y > 0.08 && i % 3 === 0 });
  }
  return out;
}

// CSS ease-in-out = cubic-bezier(.42, 0, .58, 1).
function easeInOut(t) {
  if (t <= 0) return 0; if (t >= 1) return 1;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 18; i++) {
    u = (lo + hi) / 2;
    const x = 3 * (1 - u) * (1 - u) * u * 0.42 + 3 * (1 - u) * u * u * 0.58 + u * u * u;
    if (x < t) lo = u; else hi = u;
  }
  return 3 * (1 - u) * u * u + u * u * u;   // y control points 0, 1
}
/**
 * The mockup's zbMist keyframes at phase t (0..1):
 *   0% { opacity 0; translate(0,0) scale(.6) }  30% { opacity mo }  70% { opacity .8mo }
 *   100% { opacity 0; translate(dx, rise) scale(1.45) }
 * Transform eases over the whole cycle (its only stops are 0% and 100%); opacity per segment.
 */
export function mistFrame(t, mo) {
  const e = easeInOut(t);
  let a;
  if (t < 0.3) a = mo * easeInOut(t / 0.3);
  else if (t < 0.7) a = mo + (0.8 * mo - mo) * easeInOut((t - 0.3) / 0.4);
  else a = 0.8 * mo * (1 - easeInOut((t - 0.7) / 0.3));
  return { move: e, scale: 0.6 + 0.85 * e, alpha: a };
}

// ───────── texture: the .ms element's look
// radial-gradient(ellipse, rgba(mc,.9), rgba(mc,.4) 45%, rgba(mc,0) 70%) on a box with
// border-radius 50% (the gradient's default size is farthest-corner: radius = half-box × √2),
// then filter: blur(2.4px × k). The blur is baked at 4% of the box (2.4 k over a puff that
// is ~40–100 k wide); the box sits in a 1.28× canvas so the blur has room.
const TEX_BOX = 100, TEX_PAD = 1.28;
function puffTexture(mc) {
  if (_tex && _tex.mc === mc && !_tex.t.destroyed) return _tex.t;
  const N = Math.round(TEX_BOX * TEX_PAD), cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const g = cv.getContext("2d"), c = N / 2, R = (TEX_BOX / 2) * Math.SQRT2;
  const grad = g.createRadialGradient(c, c, 0, c, c, R);
  grad.addColorStop(0, `rgba(${mc},.9)`); grad.addColorStop(0.45, `rgba(${mc},.4)`); grad.addColorStop(0.7, `rgba(${mc},0)`);
  g.filter = `blur(${(TEX_BOX * 0.04).toFixed(1)}px)`;
  g.beginPath(); g.arc(c, c, TEX_BOX / 2, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
  const t = PIXI.Texture.from(cv);
  _tex = { mc, t };
  return t;
}

// ───────── one unit
function makeCue(token, key, spec) {
  const cont = new PIXI.Container();
  cont.eventMode = "none";
  const tex = puffTexture(spec.mc);
  const parts = spec.puffs.filter((p) => p.back).map((p) => {
    const spr = new PIXI.Sprite(tex);
    spr.anchor.set(0.5); spr.eventMode = "none"; spr.alpha = 0;
    cont.addChild(spr);
    return { p, spr };
  });
  const cue = { token, key, spec, cont, parts, t0: performance.now(), exit: null };
  const prim = canvas.primary;
  if (prim) { prim.addChild(cont); prim.sortDirty = true; }
  return cue;
}
function dispose(cue) {
  try { cue.cont.parent?.removeChild(cue.cont); cue.cont.destroy({ children: true }); } catch { /* gone */ }
  for (const [id, c] of C) if (c === cue) C.delete(id);
  exiting.delete(cue);
}

/**
 * Bring one token's back layer in line with its cue set. status-cues calls this from
 * renderCues; `want` = { key, mc, mo, puffs } or null (no back cue).
 */
export function syncBackCues(token, want) {
  if (!token?.id || typeof PIXI === "undefined") return;
  const live = C.get(token.id);
  if (live && want && live.key === want.key && !live.exit) return;
  if (live) { C.delete(token.id); live.exit ??= { t0: performance.now() }; exiting.add(live); }
  if (want && want.puffs.some((p) => p.back) && canvas?.primary) {
    try { C.set(token.id, makeCue(token, want.key, want)); } catch (e) { warn("[StatusCuesBack] make failed", e); }
  }
  ensureTicker();
}
export function dropBackCues(tokenId) {
  const c = C.get(tokenId);
  if (c) dispose(c);
}
export function setBackCuesHidden(hidden) { _hidden = !!hidden; }

// ───────── drawing
function copyKeys(o, mesh, dz) {
  const z = (mesh.zIndex ?? 0) + dz;
  if (o.elevation !== mesh.elevation || o.sortLayer !== mesh.sortLayer || o.sort !== mesh.sort || o.zIndex !== z) {
    o.elevation = mesh.elevation; o.sortLayer = mesh.sortLayer; o.sort = mesh.sort; o.zIndex = z;
    if (canvas.primary) canvas.primary.sortDirty = true;
  }
}
// The mesh's rendered rect in primary space (charge-orbit-fx.js rectOf).
function rectOf(token) {
  const mesh = token?.mesh, prim = canvas.primary;
  if (!mesh || mesh.destroyed || !prim) return null;
  try {
    const b = mesh.getBounds(false);
    if (!b || !(b.width > 0) || !(b.height > 0)) return null;
    const tl = prim.worldTransform.applyInverse(new PIXI.Point(b.x, b.y));
    const br = prim.worldTransform.applyInverse(new PIXI.Point(b.x + b.width, b.y + b.height));
    return { x: tl.x, w: br.x - tl.x, h: br.y - tl.y, feet: br.y };
  } catch { return null; }
}
const meshShown = (token) => !!(token && !token.destroyed && token.visible && token.mesh && !token.mesh.destroyed
  && token.mesh.visible && (token.mesh.worldAlpha ?? 1) > 0.05);
let _reduce = null;
function reducedMotion() {
  try { _reduce ??= globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null; } catch { _reduce = null; }
  return !!_reduce?.matches;
}

function drawCue(cue, now) {
  const { token, cont, parts, spec } = cue;
  let fade = Math.min(1, (now - cue.t0) / FADE_IN);
  if (cue.exit) {
    const u = (now - cue.exit.t0) / FADE_OUT;
    if (u >= 1) { dispose(cue); return; }
    fade = Math.min(fade, 1 - u);
  }
  const R = rectOf(token);
  const show = battleActive() && !_hidden && R && meshShown(token);
  cont.visible = !!show;
  if (!show) return;
  copyKeys(cont, token.mesh, -Z_EPS);
  const k = R.h / REF_H;
  const clock = reducedMotion() ? (cue.frozenAt ??= now) : (cue.frozenAt = null, now);
  const secs = (clock - cue.t0) / 1000;
  for (const { p, spr } of parts) {
    // CSS: animation-delay = -delay → the cycle starts `delay` seconds in.
    const t = (((secs + p.delay) % p.d) + p.d) % p.d / p.d;
    const f = mistFrame(t, spec.mo);
    const w = p.s * k, h = w * p.sq;
    // Element box: centred on left = x·W (margin-left −s/2), its bottom yb·H above the feet;
    // transform-origin = the box centre.
    const cx = R.x + R.w * p.x + p.dx * k * f.move;
    const cy = R.feet - R.h * p.yb - h / 2 + p.rise * k * f.move;
    spr.position.set(cx, cy);
    spr.width = w * TEX_PAD * f.scale; spr.height = h * TEX_PAD * f.scale;
    spr.alpha = f.alpha * fade;
  }
}

function frame() {
  if (!C.size && !exiting.size) return stopTicker();
  const now = performance.now();
  for (const cue of [...C.values(), ...exiting]) {
    try { if (!cue.token || cue.token.destroyed) { dispose(cue); continue; } drawCue(cue, now); }
    catch (e) { warn("[StatusCuesBack] draw failed", e); dispose(cue); }
  }
}
function ensureTicker() {
  if (_tick || !canvas?.app?.ticker) return;
  _tick = () => frame();
  canvas.app.ticker.add(_tick, null, PIXI.UPDATE_PRIORITY.LOW);
}
function stopTicker() { if (_tick) { try { canvas.app.ticker.remove(_tick); } catch { /* gone */ } _tick = null; } }
function clearAll() { for (const c of [...C.values(), ...exiting]) dispose(c); exiting.clear(); stopTicker(); }

/** Install once (every client). status-cues drives which units have a back cue. */
export function installBackCues() {
  if (_installed) return;
  _installed = true;
  Hooks.on("canvasTearDown", () => clearAll());
  Hooks.on(DRAWN_HOOK, () => { if (C.size || exiting.size) frame(); });
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.statusCuesBack = {
    cues: () => [...C.entries()].map(([id, c]) => ({ id, key: c.key, parts: c.parts.length, visible: c.cont.visible })),
  };
}
