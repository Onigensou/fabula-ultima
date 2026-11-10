// charge-orbit-fx.js — a looping pixelfx clip that circles a unit while it holds
// charges of an effect, one clip per charge count.
//
// First user: Skizzik's Static (Static Buildup). Each charge is a ball of
// lightning on a tilted orbit at the waist: 1 charge = 1 ball, 2 = 2 balls; the
// third discharges (that shot is the passive's own play_animation, which hides
// this cue while it plays). Approved look: claude.ai/artifact/GmHAYWhV8rCRHVigfTc4bw
// (2026-11-10). Clips: pixelfx fu/static-orbit, exported as 3 layers
// (pxfx_bolt_static_orbit1/2).
//
// DATA (any effect): flags.fabula-ultima-companion.chargeOrbit on the AE =
//   { clips: { "1": <base url>, "2": <base url>, ... },   base = Forge URL without _back.webm
//     w: 240,                 clip width in clip px
//     anchor: { x, y },       the clip's feet point, 0..1 (pixelfx origin)
//     bodyH: 90 }             the body height, in clip px, the clip was drawn around
// The charge count is the AE's flags.fabula-ultima-companion.charges. A count with
// no clip uses the highest clip below it.
//
// HOW (same pattern as grapple-grip-fx.js)
//   - Two containers per unit in canvas.primary, carrying the unit mesh's own depth
//     keys: the BACK layer (far half of the orbit) a hair before the mesh, the FRONT
//     (+ the light layer, ADD) a hair after it. The body covers the far balls and a
//     back-row unit's orbit never paints over a front unit.
//   - Placed every frame on the mesh's rendered rect, and again on the 3D camera's
//     "fu-stage3d-drawn" hook, so it rides the displaced, rescaled battler.
//   - Sized by the drawn body height (R.h / bodyH), so depth and zoom carry over.
//   - Hidden outside battle, during cinematics (fuBattleMarksHidden: an action's own
//     animation, the discharge), and while the mesh is hidden (live board copy).
//   - Videos come from Foundry's loadTexture (cached per URL, so two units with the
//     same count share one <video>); a video pauses when nobody shows it.
//
// Per client, display only: no socket, no document writes.

import { log, warn } from "./logger.js";
import { battleActive } from "./battle-focus.js";

const NS = "fabula-ultima-companion";
const DRAWN_HOOK = "fu-stage3d-drawn";
const Z_EPS = 0.001;
const FADE_IN = 220, FADE_OUT = 260;

const C = new Map();            // token id -> cue
const users = new Map();        // video element -> number of cues showing it
let _hidden = false, _installed = false, _tick = null;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** The charge-orbit spec on an actor: { spec, charges, key } of the first AE carrying one, or null. */
export function chargeOrbitOf(actor) {
  try {
    for (const e of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (e?.disabled) continue;
      const spec = e.flags?.[NS]?.chargeOrbit;
      if (!spec?.clips) continue;
      const charges = Math.floor(Number(e.flags?.[NS]?.charges ?? 1)) || 0;
      if (charges <= 0) continue;
      const counts = Object.keys(spec.clips).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      const use = counts.filter((n) => n <= charges).pop() ?? counts[0];
      const base = spec.clips[String(use)];
      if (!base) continue;
      return { spec, charges, base, key: `${e.id}|${base}` };
    }
  } catch { /* */ }
  return null;
}

// ───────── videos
async function layerSprite(url, blend) {
  let tex = null;
  try { tex = await loadTexture(url); } catch (e) { warn("[charge-orbit] load failed", url, e); }
  if (!tex) return null;
  const spr = new PIXI.Sprite(tex);
  spr.eventMode = "none";
  if (blend != null) spr.blendMode = blend;
  const vid = tex.baseTexture?.resource?.source ?? null;
  if (vid && vid.tagName === "VIDEO") { try { vid.loop = true; vid.muted = true; } catch { /* */ } }
  return { spr, vid: vid?.tagName === "VIDEO" ? vid : null };
}
function hold(vid) { if (!vid) return; users.set(vid, (users.get(vid) ?? 0) + 1); vid.play?.()?.catch?.(() => {}); }
function release(vid) {
  if (!vid) return;
  const n = (users.get(vid) ?? 1) - 1;
  if (n > 0) { users.set(vid, n); return; }
  users.delete(vid);
  try { vid.pause(); } catch { /* */ }
}

// ───────── one cue
async function makeCue(token, orbit) {
  const back = new PIXI.Container(), front = new PIXI.Container();
  back.eventMode = front.eventMode = "none";
  const cue = { token, key: orbit.key, spec: orbit.spec, back, front, parts: [], t0: performance.now(), exit: null, ready: false };
  C.set(token.id, cue);
  const [b, f, l] = await Promise.all([
    layerSprite(`${orbit.base}_back.webm`, null),
    layerSprite(`${orbit.base}_front.webm`, null),
    layerSprite(`${orbit.base}_light.webm`, PIXI.BLEND_MODES.ADD),
  ]);
  if (C.get(token.id) !== cue || cue.exit) { for (const p of [b, f, l]) if (p) { try { p.spr.destroy(); } catch { /* */ } } return cue; }
  for (const [p, host] of [[b, back], [f, front], [l, front]]) {
    if (!p) continue;
    host.addChild(p.spr);
    hold(p.vid);
    cue.parts.push(p);
  }
  const prim = canvas.primary;
  if (prim) { prim.addChild(back); prim.addChild(front); prim.sortDirty = true; }
  cue.ready = true;
  cue.t0 = performance.now();
  return cue;
}

function dispose(cue) {
  for (const p of cue.parts) release(p.vid);
  cue.parts = [];
  for (const o of [cue.back, cue.front]) { try { o.parent?.removeChild(o); o.destroy({ children: true }); } catch { /* gone */ } }
  for (const [id, c] of C) if (c === cue) C.delete(id);
}
function beginExit(cue) { if (!cue.exit) cue.exit = { t0: performance.now() }; }

// ───────── which units want one
function refresh() {
  if (!canvas?.ready || !canvas.tokens) return;
  const want = new Map();
  if (battleActive()) {
    for (const t of canvas.tokens.placeables) {
      if (t.destroyed || !t.actor) continue;
      const o = chargeOrbitOf(t.actor);
      if (o) want.set(t.id, o);
    }
  }
  for (const [id, cue] of C) {
    const w = want.get(id);
    if (!w || w.key !== cue.key) beginExit(cue);
  }
  for (const [id, o] of want) {
    const live = C.get(id);
    if (live && !live.exit && live.key === o.key) continue;
    // a count change swaps the clip: the old one fades out under the new one
    if (live) { C.delete(id); live.exit ??= { t0: performance.now() }; exiting.add(live); }
    makeCue(canvas.tokens.get(id), o).catch((e) => warn("[charge-orbit] make failed", e));
  }
  ensureTicker();
}
const exiting = new Set();

// ───────── drawing
function copyKeys(o, mesh, dz) {
  const z = (mesh.zIndex ?? 0) + dz;
  if (o.elevation !== mesh.elevation || o.sortLayer !== mesh.sortLayer || o.sort !== mesh.sort || o.zIndex !== z) {
    o.elevation = mesh.elevation; o.sortLayer = mesh.sortLayer; o.sort = mesh.sort; o.zIndex = z;
    if (canvas.primary) canvas.primary.sortDirty = true;
  }
}
// the mesh's rendered rect in primary space
function rectOf(token) {
  const mesh = token?.mesh, prim = canvas.primary;
  if (!mesh || mesh.destroyed || !prim) return null;
  try {
    const b = mesh.getBounds(false);
    if (!b || !(b.width > 0) || !(b.height > 0)) return null;
    const tl = prim.worldTransform.applyInverse(new PIXI.Point(b.x, b.y));
    const br = prim.worldTransform.applyInverse(new PIXI.Point(b.x + b.width, b.y + b.height));
    return { w: br.x - tl.x, h: br.y - tl.y, cx: (tl.x + br.x) / 2, feet: br.y };
  } catch { return null; }
}
const meshShown = (token) => !!(token && !token.destroyed && token.visible && token.mesh && !token.mesh.destroyed && token.mesh.visible && token.mesh.worldAlpha > 0.05);

function drawCue(cue, now) {
  const { token, back, front, spec } = cue;
  if (!cue.ready) return;
  let alpha = clamp01((now - cue.t0) / FADE_IN);
  if (cue.exit) {
    const u = (now - cue.exit.t0) / FADE_OUT;
    if (u >= 1) { exiting.delete(cue); dispose(cue); return; }
    alpha = Math.min(alpha, 1 - u);
  }
  const R = rectOf(token);
  const show = battleActive() && !_hidden && R && meshShown(token);
  back.visible = front.visible = !!show;
  if (!show) return;
  copyKeys(back, token.mesh, -Z_EPS); copyKeys(front, token.mesh, Z_EPS);
  const w = Number(spec.w) || 240, bodyH = Number(spec.bodyH) || 90;
  const ax = Number(spec.anchor?.x ?? 0.5), ay = Number(spec.anchor?.y ?? 0.875);
  const s = R.h / bodyH;
  for (const p of cue.parts) {
    const sp = p.spr;
    if (sp.destroyed) continue;
    const tw = sp.texture?.orig?.width || w, th = sp.texture?.orig?.height || w;
    sp.anchor.set(ax, ay);
    sp.width = w * s; sp.height = w * s * (th / tw);
    sp.position.set(R.cx, R.feet);
    sp.alpha = alpha;
  }
}

function frame() {
  if (!C.size && !exiting.size) return stopTicker();
  const now = performance.now();
  for (const cue of [...C.values(), ...exiting]) {
    try { if (!cue.token || cue.token.destroyed) { exiting.delete(cue); dispose(cue); continue; } drawCue(cue, now); }
    catch (e) { warn("[charge-orbit] draw failed", e); exiting.delete(cue); dispose(cue); }
  }
}
function ensureTicker() {
  if (_tick || !canvas?.app?.ticker) return;
  _tick = () => frame();
  canvas.app.ticker.add(_tick, null, PIXI.UPDATE_PRIORITY.LOW);
}
function stopTicker() { if (_tick) { try { canvas.app.ticker.remove(_tick); } catch { /* gone */ } _tick = null; } }
function clearAll() { for (const c of [...C.values(), ...exiting]) dispose(c); exiting.clear(); stopTicker(); }

/** Install once (every client). */
export function installChargeOrbitFx() {
  if (_installed) return;
  _installed = true;
  const soon = foundry.utils.debounce(() => { try { refresh(); } catch (e) { warn("[charge-orbit] refresh threw", e); } }, 30);
  for (const h of ["createActiveEffect", "deleteActiveEffect", "updateActiveEffect", "createToken", "deleteToken", "fuBattleFocusChanged"]) Hooks.on(h, soon);
  Hooks.on("canvasReady", () => { clearAll(); soon(); });
  Hooks.on("canvasTearDown", () => clearAll());
  Hooks.on(DRAWN_HOOK, () => { if (C.size || exiting.size) frame(); });
  Hooks.on("fuBattleMarksHidden", (hidden) => { _hidden = !!hidden; });
  if (canvas?.ready) soon();
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.chargeOrbit = {
    refresh,
    cues: () => [...C.entries()].map(([id, c]) => ({ id, key: c.key, ready: c.ready, exit: !!c.exit, parts: c.parts.length, visible: c.front.visible })),
  };
  log("[charge-orbit] installed");
}
