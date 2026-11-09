// ============================================================================
// Soul Tithe FX — the in-game host (every client).
//
// Plays the user-approved round-end effects (soul-fx-effects.js) on the battle
// view, and keeps every Soul Fragment burning (soul-fx-lib.js makeSoulFlame).
// The rules (events/soul-tithe.js) run on the GM; they call presentSoulFx(),
// which broadcasts the show and hands back the beat clock the writes follow.
//
// DENSITY: one effect pixel = one screen pixel at the scene's default battle
// view, the pixel-entrance rule (pixel-entrance-fx.js): drawn on CPU frames,
// uploaded as NEAREST textures, scaled with the camera, never re-rasterised.
//
// SPACE: the cross-field effects draw in "field space": E = D x the world point
// where the 3D camera draws it (drawnMap), so a silhouette is captured at
// D x its drawn scale and lines up 1:1 with its mesh. One field container per
// show (position 0, scale 1/D), at the depth of the frontmost token involved.
// Each fragment's idle fire rides its own token instead (two containers, just
// behind and just in front of its mesh), so it follows it wherever it goes.
//
// THE APPROVED CUTBACKS (2026-11-09):
//   - Idle fire is BAKED: it loops every 2 s and is a pure function of the
//     clock, so every live frame drawn at a 1/30 s slot is kept (run-length
//     packed) and replayed from then on. Live drawing only while it is
//     igniting, flaring or not yet baked.
//   - Everything updates at 30 fps; the simulation still sub-steps at 1/120 s.
//   - Tight textures: every layer of every effect is its own small texture
//     that follows what it draws (soul-fx-effects `layers`).
//   - The idle fire's big soft lights (halo, column, floor pool) are GPU
//     sprites, not pixels.
//   - Per-silhouette data is built once per art (cached) at the start.
//   - Draws are spread across display frames under a per-frame budget, so a
//     30 fps tick never lands as one long frame on a fast screen.
//
// A NEW fragment is spawned hidden (token flag soulFxHoldUntil, server time):
// every client keeps it invisible until its own Soul Tithe arrival reveals it,
// or the hold runs out (a client that missed the show, an F5). Nothing here
// writes a document.
// ============================================================================

import { warn, log } from "../../battle-director/logger.js";
import { restViewFor } from "../../battle-director/director-camera.js";
import { shadowSpriteFor, STYLE as SHADOW_STYLE } from "../../sprite-shadow/sprite-shadow-renderer.js";
import { shouldRender, hasOtherViewers } from "../../battle-director/presentation-clock.js";
import { registerExternalDefeat } from "../../battle-director/defeat-fx.js";
import { getClientOption } from "../../shared/client-options.js";
import { createFrame, clearFrame, painterFor } from "../../battle-director/pixel-entrance/pixelfx/core/index.js";
import { makeSil, placeSil, makeSoulFlame, FLAME_LOOP, SOUL } from "./soul-fx-lib.js";
import { makeTithe, makeCalling, makeDestroy, TITHE, CALLING, DESTROY } from "./soul-fx-effects.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_SOUL_FX_PLAY";
export const HOLD_FLAG = "soulFxHoldUntil";
/** How long a new fragment stays hidden waiting for its arrival (ms of server time). */
export const HOLD_MS = 9000;

/** The fragment's look: the token's own tint and alpha (written by the rules) and this lift on top. */
export const FRAGMENT_LOOK = Object.freeze({ tint: "#a6ff9c", alpha: 0.9, lift: 1.6, screen: [0.07, 0.19, 0.08] });

// Two rates (2026-11-09 "is 60 viable?"): FX_HZ = the transient shows and any LIVE
// fire (igniting, flaring), each user's "Effects frame rate" option (60 or 30, Party
// Menu > Config > Graphic); BAKE_HZ = the idle fire's baked loop, fixed at 30 (at 60 its
// memory doubles and it bakes slower; measured in tools/staging-world/soul-fx-hz.mjs).
let FX_HZ = 30;
let BAKE_HZ = 30;
function applyRateOption() {
  const v = Number(getClientOption("fxFrameRate"));
  FX_HZ = v === 30 || v === 60 ? v : 60;
  _lastFx = -1;
}
const SUB_DT = 1 / 120;
const BUDGET_MS = 4;          // draw work per display frame before the rest waits a frame
const MASK_ALPHA = 96;
const TOKEN_WAIT_MS = 1500;
let BAKE_SLOTS = Math.round(FLAME_LOOP * BAKE_HZ);

const isFragmentDoc = (doc) => doc?.flags?.[MODULE_ID]?.soulFragment === true;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const serverNow = () => { try { return game.time.serverTime; } catch { return Date.now(); } };

/* ── Geometry ───────────────────────────────────────────────────────────── */

function densityFor(scene) {
  try { const v = restViewFor(scene); if (v?.scale > 0) return v.scale; } catch { /* no stage */ }
  return canvas.stage?.scale?.x || 1;
}
function mapOf(token) { try { return globalThis.__ONI_BATTLE_STAGE_3D__?.drawnMap?.(token) ?? null; } catch { return null; } }
/** Where a 2D point placed against the token's spot is drawn (world px), and the drawn scale. */
function drawn(token, p) {
  const m = mapOf(token);
  return m ? { x: m.bx + (p.x - m.fx) * m.m, y: m.by + (p.y - m.fy) * m.m, m: m.m } : { x: p.x, y: p.y, m: 1 };
}
// The mesh's 2D box in primary space (outside a render getBounds gives the 2D spot).
function meshGeometry(token) {
  const mesh = token.mesh;
  try {
    const b = mesh.getBounds(false);
    if (b && b.width > 0 && b.height > 0) {
      const inv = (x, y) => canvas.primary.worldTransform.applyInverse(new PIXI.Point(x, y));
      const tl = inv(b.x, b.y), br = inv(b.x + b.width, b.y + b.height);
      return { x0: tl.x, y0: tl.y, w: br.x - tl.x, h: br.y - tl.y, flip: (mesh.scale?.x ?? 1) < 0 ? -1 : 1 };
    }
  } catch { /* fall through */ }
  const w = Math.abs(mesh.width) || token.w, h = Math.abs(mesh.height) || token.h;
  return { x0: token.center.x - w / 2, y0: token.center.y - h / 2, w, h, flip: (mesh.scale?.x ?? 1) < 0 ? -1 : 1 };
}
function tokenArt(token) {
  const src = token.mesh?.texture?.baseTexture?.resource?.source ?? null;
  if (!src) return null;
  const video = typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement;
  const w = video ? src.videoWidth : (src.naturalWidth ?? src.width), h = video ? src.videoHeight : (src.naturalHeight ?? src.height);
  return w > 0 && h > 0 ? { src, w, h, key: src.currentSrc || src.src || token.document?.texture?.src || "" } : null;
}
/** The float the TokenMagic filters draw this frame (idle Float + hover lift), world px, + = down. */
function floatDy(token) {
  const mesh = token?.mesh, fs = mesh?.filters;
  if (!fs?.length) return 0;
  let t = 0, pad = 0;
  for (const f of fs) {
    const ty = Number(f?.translationY);
    if (!f?.filterId || !Number.isFinite(ty) || ty === 0) continue;
    t += ty; pad = Math.max(pad, Number(f.padding) || 0);
  }
  if (!t) return 0;
  // a positive translation draws the body HIGHER (sprite-shadow-airborne FLY.sign, verified
  // live); the frame is the mesh plus its padding, the shadow's own lift formula
  return -t * (Math.abs(mesh.height) + 2 * pad) * (mapOf(token)?.m ?? 1);
}
function tokenReady(token) {
  return !!(token && !token.destroyed && token.mesh && !token.mesh.destroyed && tokenArt(token));
}
async function waitTokens(ids) {
  const t0 = performance.now();
  for (;;) {
    const ts = ids.map((id) => canvas?.tokens?.get?.(id) ?? null);
    if (ts.every(tokenReady)) return ts;
    if (performance.now() - t0 > TOKEN_WAIT_MS) return ts.map((t) => (tokenReady(t) ? t : null));
    await new Promise((r) => setTimeout(r, 40));
  }
}

/* ── Colour ─────────────────────────────────────────────────────────────── */

const hexRgb = (h) => { const n = parseInt(String(h).replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const TINT = hexRgb(FRAGMENT_LOOK.tint);
const C6 = [SOUL[6] & 255, (SOUL[6] >>> 8) & 255, (SOUL[6] >>> 16) & 255];
/** What the mesh shows for an art pixel: tint (the document), then the lift (our filter). */
function fragmentColour(r, g, b) {
  const L = FRAGMENT_LOOK.lift, S = FRAGMENT_LOOK.screen;
  const f = (v, t, s) => Math.round(clamp(((v * t) / 255 / 255) * L * (1 - s) + s, 0, 1) * 255);
  return [f(r, TINT[0], S[0]), f(g, TINT[1], S[1]), f(b, TINT[2], S[2])];
}
/** The lift as a ColorMatrix, mixed toward the soul's pale step by `bright`. */
function liftMatrix(bright = 0) {
  const L = FRAGMENT_LOOK.lift, S = FRAGMENT_LOOK.screen, b = clamp(bright, 0, 1), k = 1 - b;
  const g = (i) => L * (1 - S[i]) * k, o = (i) => S[i] * k + (C6[i] / 255) * b;
  return [g(0), 0, 0, 0, o(0), 0, g(1), 0, 0, o(1), 0, 0, g(2), 0, o(2), 0, 0, 0, 1, 0];
}
/** The owner drained toward a cold ash of their own value (the mock's ash()). */
function ashMatrix(k) {
  const a = clamp(k, 0, 1), q = 1 - a, R = [0.299, 0.587, 0.114], T = [0.8, 0.9, 0.86];
  const row = (i) => [0, 1, 2].map((j) => (i === j ? q : 0) + a * T[i] * R[j]);
  return [...row(0), 0, 0, ...row(1), 0, 0, ...row(2), 0, 0, 0, 0, 0, 1, 0];
}
const CMF = () => PIXI.ColorMatrixFilter ?? PIXI.filters?.ColorMatrixFilter;
/** Keep `filter` on the mesh (TokenMagic rewrites the whole array: put it back when it does). */
function ensureFilter(mesh, filter) {
  if (!mesh || mesh.destroyed || !filter) return;
  const fs = mesh.filters ?? [];
  if (!fs.includes(filter)) mesh.filters = [...fs, filter];
}
function dropFilter(mesh, filter) {
  if (!mesh || mesh.destroyed || !filter) return;
  const fs = mesh.filters ?? [];
  if (fs.includes(filter)) mesh.filters = fs.filter((f) => f !== filter).length ? fs.filter((f) => f !== filter) : null;
}

/* ── Silhouettes (cached per art and size) ──────────────────────────────── */

const _artCache = new Map();
function captureArt(token, dens, fragment) {
  const geo = meshGeometry(token), art = tokenArt(token);
  if (!art) return null;
  const W = Math.max(1, Math.round(geo.w * dens)), H = Math.max(1, Math.round(geo.h * dens));
  const key = `${art.key}|${W}x${H}|${geo.flip}|${fragment ? 1 : 0}`;
  let a = _artCache.get(key);
  if (!a) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    if (geo.flip < 0) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(art.src, 0, 0, W, H);
    let data;
    try { data = ctx.getImageData(0, 0, W, H).data; } catch (e) { warn("soul-fx: token art cannot be read (CORS)", e); return null; }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > MASK_ALPHA) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, mask = new Uint8Array(w * h), pixels = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * W + x0 + x) * 4;
      if (data[i + 3] <= MASK_ALPHA) continue;
      mask[y * w + x] = 1;
      const [r, g, b] = fragment ? fragmentColour(data[i], data[i + 1], data[i + 2]) : [data[i], data[i + 1], data[i + 2]];
      pixels[y * w + x] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    a = { x0, y0, w, h, sil: makeSil({ x: 0, y: 0, w, h, mask, pixels }) };
    if (_artCache.size > 48) _artCache.delete(_artCache.keys().next().value);
    _artCache.set(key, a);
  }
  return { ...a, geo };
}
/** The token's silhouette in field space (effect px of where it is drawn now, un-floated). */
function fieldSil(token, D, fragment) {
  const m = mapOf(token)?.m ?? 1, dens = D * m;
  const a = captureArt(token, dens, fragment);
  if (!a) return null;
  const d = drawn(token, { x: a.geo.x0 + a.x0 / dens, y: a.geo.y0 + a.y0 / dens });
  return placeSil(a.sil, Math.round(d.x * D), Math.round(d.y * D));
}
/** The token's feet (bottom centre of its art) in 2D world px, for a silhouette captured at `dens`. */
function feet2d(a, dens) {
  return { x: a.geo.x0 + (a.x0 + a.w / 2) / dens, y: a.geo.y0 + (a.y0 + a.h) / dens };
}

/* ── Depth (the pixel-entrance rule: at the token's own depth, never above every token) ── */

function copyDepth(c, mesh) {
  c.elevation = mesh.elevation; c.sortLayer = mesh.sortLayer; c.sort = mesh.sort; c.zIndex = mesh.zIndex;
}
function sameDepth(c, mesh) {
  return c.elevation === mesh.elevation && c.sortLayer === mesh.sortLayer && c.sort === mesh.sort && c.zIndex === mesh.zIndex;
}
/** Put `c` directly before (where = 0) or after (1) the mesh, sharing its sort keys. */
function placeBy(c, mesh, where) {
  const prim = canvas.primary;
  if (!prim || !mesh || mesh.destroyed) return;
  const i = prim.children.indexOf(mesh), j = prim.children.indexOf(c);
  const want = where ? i + 1 : i;
  if (!sameDepth(c, mesh)) { copyDepth(c, mesh); prim.sortDirty = true; }
  if (i < 0) { if (j < 0) prim.addChild(c); return; }
  if (where ? j === i + 1 : j === i - 1) return;
  if (j >= 0) prim.removeChild(c);
  const k = prim.children.indexOf(mesh);
  prim.addChildAt(c, where ? k + 1 : k);
}
const depthKey = (m) => [m.elevation ?? 0, m.sortLayer ?? 0, m.sort ?? 0, m.zIndex ?? 0];
const depthCmp = (a, b) => { const A = depthKey(a), B = depthKey(b); for (let i = 0; i < 4; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; };

/* ── Textures from pixelfx frames ────────────────────────────────────────── */

function bufTexture(buf, w, h) {
  return PIXI.Texture.fromBuffer(new Uint8Array(buf.buffer, buf.byteOffset, w * h * 4), w, h, { scaleMode: PIXI.SCALE_MODES.NEAREST, alphaMode: PIXI.ALPHA_MODES.UNPACK });
}
function upload(sprite) { try { sprite.texture.baseTexture.resource.update(); } catch { /* gone */ } }
/** A frame shown as two sprites (colour, then additive light) in `parent`. */
function frameSprites(parent, frame) {
  const color = new PIXI.Sprite(bufTexture(frame.color, frame.w, frame.h));
  const light = new PIXI.Sprite(bufTexture(frame.light, frame.w, frame.h));
  light.blendMode = PIXI.BLEND_MODES.ADD;
  parent.addChild(color, light);
  return { color, light };
}
function destroySprites(s) {
  for (const sp of [s?.color, s?.light]) { if (!sp) continue; try { sp.parent?.removeChild(sp); sp.destroy({ texture: true, baseTexture: true }); } catch { /* gone */ } }
}

/** A tight, growing, moving frame for one effect layer. */
class DynLayer {
  constructor(parent) { this.parent = parent; this.frame = null; this.sp = null; this.cap = [0, 0]; }
  hide() { if (this.sp) { this.sp.color.visible = false; this.sp.light.visible = false; } }
  draw(b, fn) {
    if (!b) { this.hide(); return; }
    const x0 = Math.floor(b.x0) - 1, y0 = Math.floor(b.y0) - 1;
    const w = Math.ceil(b.x1) - x0 + 2, h = Math.ceil(b.y1) - y0 + 2;
    if (!(w > 0 && h > 0 && w < 4096 && h < 4096)) { this.hide(); return; }
    if (w > this.cap[0] || h > this.cap[1]) {
      const W = Math.ceil(Math.max(w, this.cap[0]) / 32) * 32, H = Math.ceil(Math.max(h, this.cap[1]) / 32) * 32;
      destroySprites(this.sp);
      this.frame = createFrame(W, H);
      this.sp = frameSprites(this.parent, this.frame);
      this.cap = [W, H];
    }
    const f = this.frame;
    f.ox = x0; f.oy = y0;
    clearFrame(f);
    fn(painterFor(f));
    for (const s of [this.sp.color, this.sp.light]) { s.position.set(x0, y0); s.visible = true; upload(s); }
  }
  destroy() { destroySprites(this.sp); this.sp = null; this.frame = null; }
}

/* ── Glow sprites (the idle fire's big soft lights, on the GPU) ─────────── */

let _glowTex = null, _poolTex = null;
function radialTexture() {
  const N = 128, cv = document.createElement("canvas");
  cv.width = N; cv.height = N;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5 - N / 2) / (N / 2), dy = (y + 0.5 - N / 2) / (N / 2), d = dx * dx + dy * dy;
    const f = d >= 1 ? 0 : (1 - Math.sqrt(d)) ** 2, v = Math.round(f * 255), i = (y * N + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = img.data[i + 3] = v;
  }
  ctx.putImageData(img, 0, 0);
  return PIXI.Texture.from(cv);
}
function glowTexture() { return (_glowTex ??= radialTexture()); }
function poolTexture() { return (_poolTex ??= radialTexture()); }
function glowSprite(parent) {
  const s = new PIXI.Sprite(glowTexture());
  s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.ADD; s.visible = false;
  parent.addChild(s);
  return s;
}
function setGlow(s, g) {
  if (!g || g.k <= 0.004) { s.visible = false; return; }
  s.texture = g.kind === "pool" ? poolTexture() : glowTexture();
  s.position.set(g.x, g.y);
  s.width = g.r * 2; s.height = (g.ry ?? g.r) * 2;
  s.tint = ((g.c & 255) << 16) | (((g.c >>> 8) & 255) << 8) | ((g.c >>> 16) & 255);
  s.alpha = clamp(g.k, 0, 1);
  s.visible = true;
}

/* ── Baked loop frames: run-length packed (zeros / literals) ─────────────── */

function rlePack(src) {
  const n = src.length, out = new Uint32Array(n + 2 * Math.ceil(n / 2) + 2);
  let o = 0, i = 0;
  while (i < n) {
    let z = 0;
    while (i < n && src[i] === 0) { z++; i++; }
    const s = i;
    while (i < n && src[i] !== 0) i++;
    out[o++] = z; out[o++] = i - s;
    out.set(src.subarray(s, i), o); o += i - s;
  }
  return out.slice(0, o);
}
function rleUnpack(rle, dst) {
  dst.fill(0);
  let o = 0, i = 0;
  while (o < rle.length) {
    i += rle[o++];
    const l = rle[o++];
    dst.set(rle.subarray(o, o + l), i);
    i += l; o += l;
  }
}

/* ── The scheduler: 30 fps ticks, draws spread under a frame budget ─────── */

const _fires = new Map();   // tokenId -> FragmentFire
const _runs = new Set();
const _queue = new Map();   // job key -> job, oldest first: what a frame over budget leaves for the next
let _ticker = null, _tickerOwner = null, _lastFx = -1;

// On the canvas app's own ticker, just before its render (LOW): after Foundry has
// applied this frame's token refreshes, so a hidden mesh cannot flash back for a frame.
function startTicker() {
  if (typeof PIXI === "undefined") return;
  const tk = canvas?.app?.ticker ?? PIXI.Ticker.shared;
  if (_ticker && _tickerOwner === tk) return;
  if (_ticker) { try { _tickerOwner.remove(_ticker); } catch { /* gone */ } }
  _ticker = () => { try { frame(); } catch (e) { warn("soul-fx: frame threw", e); } };
  _tickerOwner = tk;
  tk.add(_ticker, null, (PIXI.UPDATE_PRIORITY?.LOW ?? -25) + 1);
}
// The show's clock. A rig may replace it to step a show frame by frame (setClock).
const REAL_CLOCK = () => performance.now();
let _clock = REAL_CLOCK;
function frame(all = false) {
  if (!canvas?.ready) return;
  const tStart = performance.now();
  const now = _clock(), fxTick = Math.floor((now / 1000) * FX_HZ), isTick = fxTick !== _lastFx;
  if (isTick) _lastFx = fxTick;
  const jobs = [];
  for (const run of _runs) run.step(now, isTick, jobs);
  for (const f of _fires.values()) f.step(now, isTick, jobs);
  // a newer job for the same layer replaces the waiting one, in its place in the line
  for (const j of jobs) { if (_queue.has(j.key)) _dropped++; _queue.set(j.key, j); }
  // the transient layers come first (they are the beat); at least one job a frame
  const t0 = performance.now();
  let n = 0;
  for (const [k, j] of _queue) {
    if (!all && n++ > 0 && performance.now() - t0 > BUDGET_MS) break;
    _queue.delete(k);
    try { j.run(); } catch (e) { warn("soul-fx: draw threw", e); }
    _drawn++;
  }
  if (_queue.size && (_runs.size || _fires.size)) _deferredFrames++;
  // what this cost the frame (status(): the last ~10 s, for rigs and the console)
  if (_runs.size || _fires.size) {
    _cost[_costAt] = performance.now() - tStart; _costAt = (_costAt + 1) % _cost.length;
    if (_costN < _cost.length) _costN++;
  }
}
const _cost = new Float32Array(1200);
let _costAt = 0, _costN = 0;
// jobs drawn / replaced before they were drawn (a layer that skipped an update) / frames that left work for the next
let _drawn = 0, _dropped = 0, _deferredFrames = 0;
function costStats() {
  if (!_costN) return null;
  const a = Array.from(_cost.subarray(0, _costN)).sort((x, y) => x - y), sum = a.reduce((s, v) => s + v, 0);
  return { drawn: _drawn, dropped: _dropped, deferredFrames: _deferredFrames, frames: _costN, avg: +(sum / _costN).toFixed(2), p95: +a[Math.floor(_costN * 0.95)].toFixed(2), max: +a[_costN - 1].toFixed(2) };
}

/* ── A fragment's own fire, look and hold ───────────────────────────────── */

class FragmentFire {
  constructor(token) {
    this.id = token.id; this.token = token;
    this.built = false; this.failed = 0;
    this.override = null;          // { k, flare, bright, hideMesh } from a running show
    this.released = false;         // its arrival has shown it on this client
    this.slot = -1; this.dirty = true; this.baked = new Array(BAKE_SLOTS).fill(null); this.nBaked = 0;
    this.filter = null;
  }
  held() {
    if (this.released) return false;
    const until = Number(this.token?.document?.flags?.[MODULE_ID]?.[HOLD_FLAG]);
    return Number.isFinite(until) && serverNow() < until;
  }
  build() {
    const token = this.token;
    if (!tokenReady(token)) return false;
    const D = densityFor(canvas.scene);
    const a = captureArt(token, D, true);
    if (!a) return false;
    this.D = D; this.art = a;
    // local frame: effect px, the feet at (0, 0)
    const S = placeSil(a.sil, -Math.round(a.w / 2), -a.h);
    this.sil = S;
    this.flame = makeSoulFlame(S, { gpuGlow: true });
    const e = this.flame.extent, w = e.x1 - e.x0, h = e.y1 - e.y0, ox = S.x + e.x0, oy = S.y + e.y0;
    this.frames = { back: createFrame(w, h, ox, oy), front: createFrame(w, h, ox, oy) };
    this.back = new PIXI.Container(); this.front = new PIXI.Container();
    for (const c of [this.back, this.front]) { c.eventMode = "none"; c.name = `fud-soul-fire:${this.id}`; }
    this.spBack = frameSprites(this.back, this.frames.back);
    this.backGlow = glowSprite(this.back);
    this.spFront = frameSprites(this.front, this.frames.front);
    for (const s of [this.spBack.color, this.spBack.light, this.spFront.color, this.spFront.light]) s.position.set(ox, oy);
    this.glows = Array.from({ length: 5 }, () => glowSprite(this.front));
    this.built = true;
    return true;
  }
  destroy() {
    for (const c of [this.back, this.front]) { try { c?.parent?.removeChild(c); c?.destroy({ children: true, texture: false, baseTexture: false }); } catch { /* gone */ } }
    destroySprites(this.spBack); destroySprites(this.spFront);
    try { dropFilter(this.token?.mesh, this.filter); } catch { /* gone */ }
    this.built = false;
  }
  /** The look, the hold and the position every display frame; the fire on 30 fps ticks. */
  step(now, isTick, jobs) {
    const token = this.token;
    if (!token || token.destroyed || !token.mesh) return;
    if (!this.built) {
      if (!isTick || this.failed > 90) return;
      if (!this.build()) { this.failed++; this.applyMesh(true); return; }
    }
    const ov = this.override, hide = this.held() || !!ov?.hideMesh;
    this.applyMesh(hide);
    // ride the token: where the camera draws its feet, plus its float
    const mesh = token.mesh, f2 = feet2d(this.art, this.D), d = drawn(token, f2), dy = floatDy(token);
    for (const c of [this.back, this.front]) { c.position.set(d.x, d.y + dy); c.scale.set(d.m / this.D); }
    placeBy(this.back, mesh, 0); placeBy(this.front, mesh, 1);
    const vis = mesh.visible !== false && token.visible !== false && shouldRender();
    this.back.visible = this.front.visible = vis;
    if (!vis) return;
    const k = hide && !ov ? 0 : clamp(ov?.k ?? 1, 0, 1), flare = clamp(ov?.flare ?? 0, 0, 2);
    // the soft lights follow the breath every frame (cheap)
    const t = ((now / 1000) % FLAME_LOOP + FLAME_LOOP) % FLAME_LOOP;
    const gl = this.flame.glows(t, k, flare, 1).map((g) => ({ ...g, x: g.x, y: g.y }));
    setGlow(this.backGlow, gl.find((g) => g.back));
    const fg = gl.filter((g) => !g.back);
    this.glows.forEach((s, i) => setGlow(s, fg[i]));
    // steady = the baked loop at BAKE_HZ; igniting / flaring = live at the shows' FX_HZ
    const steady = k >= 0.999 && flare <= 0.001, hz = steady ? BAKE_HZ : FX_HZ;
    const slot = Math.floor(t * hz) % Math.round(FLAME_LOOP * hz);
    // a show taking over (or letting go) changes what this slot must show, even mid-slot
    const look = `${steady ? "b" : "l"}${slot}|${k.toFixed(3)}|${flare.toFixed(3)}`;
    if (look === this.look && !this.dirty) return;
    this.slot = slot; this.look = look; this.dirty = false;
    const tt = slot / hz, key = `fire:${this.id}`;
    if (k <= 0.02) { _queue.delete(key); this.clearFire(); return; }
    if (steady && this.baked[slot]) { jobs.push({ key, run: () => this.replay(slot) }); return; }
    jobs.push({ key, run: () => this.live(tt, k, flare, steady ? slot : -1) });
  }
  applyMesh(hide) {
    const token = this.token, mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;
    if (hide) {
      this.hiding = true;
      try { mesh.alpha = 0; } catch { /* gone */ }
      holdShadow(token, 0);
    } else if (this.hiding) {
      this.hiding = false;
      showMesh(token);
    }
    const F = CMF();
    if (!F) return;
    if (!this.filter) { this.filter = new F(); this.filter.resolution = canvas.app?.renderer?.resolution ?? 1; }
    const b = this.override?.bright ?? 0;
    if (this._bright !== b) { this.filter.matrix = liftMatrix(b); this._bright = b; }
    ensureFilter(mesh, this.filter);
  }
  clearFire() {
    for (const s of [this.spBack, this.spFront]) { s.color.visible = false; s.light.visible = false; }
  }
  live(tt, k, flare, keepSlot) {
    const { back, front } = this.frames, zero = () => 0;
    clearFrame(back); clearFrame(front);
    this.flame.drawBack(painterFor(back), tt, zero, k, flare);
    this.flame.draw(painterFor(front), tt, zero, k, flare, 1);
    if (keepSlot >= 0 && !this.baked[keepSlot]) {
      this.baked[keepSlot] = [rlePack(back.color), rlePack(back.light), rlePack(front.color), rlePack(front.light)];
      if (++this.nBaked === BAKE_SLOTS) log(`soul-fx: ${this.token?.name} idle fire baked (${this.bakedBytes()} bytes)`);
    }
    this.show();
  }
  replay(slot) {
    const [bc, bl, fc, fl] = this.baked[slot], { back, front } = this.frames;
    rleUnpack(bc, back.color); rleUnpack(bl, back.light); rleUnpack(fc, front.color); rleUnpack(fl, front.light);
    this.show();
  }
  show() {
    for (const s of [this.spBack, this.spFront]) { s.color.visible = true; s.light.visible = true; upload(s.color); upload(s.light); }
  }
  bakedBytes() { return this.baked.reduce((n, b) => n + (b ? b.reduce((m, a) => m + a.byteLength, 0) : 0), 0); }
}

/** Hand the mesh back to Foundry: its own alpha (the document's), its shadow. */
function showMesh(token) {
  if (!token || token.destroyed) return;
  try { if (token.mesh) token.mesh.alpha = token.alpha ?? 1; } catch { /* gone */ }
  holdShadow(token, 1);
  try { token.renderFlags?.set?.({ refreshState: true }); } catch { /* older core */ }
}
function holdShadow(token, k) {
  try {
    const sh = shadowSpriteFor(token.id);
    if (!sh || sh.destroyed) return;
    const a = SHADOW_STYLE.alpha * k;
    if (sh.fudBase) sh.fudBase.alpha = a;
    sh.alpha = a;
  } catch { /* no shadow */ }
}

function syncFires() {
  if (!canvas?.ready) return;
  const seen = new Set();
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!isFragmentDoc(t.document)) continue;
    seen.add(t.id);
    const f = _fires.get(t.id);
    if (f && f.token !== t) { f.destroy(); _fires.delete(t.id); }
    if (!_fires.has(t.id)) _fires.set(t.id, new FragmentFire(t));
  }
  for (const [id, f] of _fires) if (!seen.has(id)) { f.destroy(); _fires.delete(id); }
  if (_fires.size) startTicker();
}
function dropAllFires() { for (const f of _fires.values()) f.destroy(); _fires.clear(); }

/* ── A show: one or more effects in one field container ─────────────────── */

const MAKERS = { tithe: makeTithe, calling: makeCalling, destroy: makeDestroy };
let _runUid = 0;

class Run {
  constructor(spec, items, D) {
    this.spec = spec; this.items = items; this.D = D; this.uid = ++_runUid;
    items.forEach((it, n) => { it.n = n; });
    this.root = new PIXI.Container();
    this.root.name = `fud-soul-fx:${spec.kind}`; this.root.eventMode = "none";
    this.root.scale.set(1 / D);
    this.t0 = _clock();
    this.end = Math.max(...items.map((it) => it.delay + it.fx.D)) + 0.1;
    this.done = new Promise((r) => { this.resolve = r; });
    this.anchor0 = new Map(this.tokens().map((t) => [t.id, this.footOf(t)]));
    this.placeRoot();
    canvas.primary.addChild(this.root);
    this.placeRoot();
  }
  tokens() { return this.items.flatMap((it) => [it.owner, it.frag]).filter((t) => t && !t.destroyed && t.mesh && !t.mesh.destroyed); }
  footOf(t) { const g = meshGeometry(t); return drawn(t, { x: g.x0 + g.w / 2, y: g.y0 + g.h }); }
  /** How far the camera has carried the tokens since the start (the mean of their own drift). */
  drift() {
    let x = 0, y = 0, n = 0;
    for (const t of this.tokens()) {
      const a = this.anchor0.get(t.id);
      if (!a) continue;
      const d = this.footOf(t);
      x += d.x - a.x; y += d.y - a.y; n++;
    }
    return n ? { x: x / n, y: y / n } : (this.lastDrift ?? { x: 0, y: 0 });
  }
  /** At the depth of the frontmost token involved, right after its mesh. */
  placeRoot() {
    const ms = this.tokens().map((t) => t.mesh);
    if (!ms.length || !canvas.primary) return;
    const front = ms.reduce((a, b) => (depthCmp(a, b) >= 0 ? a : b));
    placeBy(this.root, front, 1);
  }
  step(now, isTick, jobs) {
    const el = (now - this.t0) / 1000;
    const a = (this.lastDrift = this.drift());
    this.root.position.set(a.x, a.y);
    if (isTick) this.placeRoot();
    for (const it of this.items) {
      const local = el - it.delay;
      if (local < 0) { if (it.preHide) it.applyState({ frag: { hideMesh: true, flameK: 0 } }); continue; }
      if (isTick || !it.started) {
        it.started = true;
        // the simulation sub-steps at 1/120 s whatever the frame rate
        const target = Math.min(local, it.fx.D + 0.05);
        let n = 0;
        while (it.t + SUB_DT <= target + 1e-9 && n++ < 240) { it.fx.update(SUB_DT); it.t += SUB_DT; }
        for (const L of it.fx.layers) {
          let lay = it.dyn.get(L.id);
          if (!lay) it.dyn.set(L.id, (lay = new DynLayer(this.root)));
          jobs.push({ key: `run:${this.uid}:${it.n}:${L.id}`, run: () => lay.draw(L.bounds(), (p) => L.draw(p)) });
        }
      }
      it.applyState(it.fx.state());
    }
    if (el >= this.end) this.finish();
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    _runs.delete(this);
    for (const it of this.items) it.cleanup();
    for (const it of this.items) for (const L of it.dyn.values()) L.destroy();
    for (const k of [..._queue.keys()]) if (k.startsWith(`run:${this.uid}:`)) _queue.delete(k);
    try { this.root.parent?.removeChild(this.root); this.root.destroy({ children: true }); } catch { /* gone */ }
    this.resolve();
  }
}

function makeItem(kind, row, D, owner, frag) {
  const fragment = fieldSil(frag, D, true), ownerSil = fieldSil(owner, D, false);
  if (!fragment || !ownerSil) return null;
  // whole effect px, as the mock's bob: raw pixel writes (blendPx) drop a fractional coordinate
  // the owner floats too when it flies (Flying hover + bob) or has an idle Float: the
  // effects move its body with it (soul-fx-effects ownerFloat)
  const S = { owner: ownerSil, frag: fragment, bob: () => (frag.destroyed ? 0 : Math.round(floatDy(frag) * D)), ownerBob: () => (owner.destroyed ? 0 : Math.round(floatDy(owner) * D)) };
  const fx = MAKERS[kind](S, { merge: !!row.merge, bodyAlpha: FRAGMENT_LOOK.alpha });
  const fire = () => _fires.get(frag.id) ?? null;
  let ownerFilter = null;
  const it = {
    fx, owner, frag, delay: Math.max(0, Number(row.delay) || 0), t: 0, started: false, dyn: new Map(),
    preHide: kind === "tithe" && !row.merge,
    applyState(st) {
      const f = fire();
      if (f) {
        if (kind === "tithe" && !row.merge) f.released = true;   // this show decides now, not the hold
        f.override = { k: st.frag?.flameK ?? 1, flare: st.frag?.flare ?? 0, bright: st.frag?.bright ?? 0, hideMesh: !!st.frag?.hideMesh };
      } else if (st.frag?.hideMesh && !frag.destroyed && frag.mesh) { try { frag.mesh.alpha = 0; } catch { /* gone */ } }
      const k = st.owner?.desat ?? 0, F = CMF();
      if (F && owner?.mesh && !owner.mesh.destroyed) {
        if (k > 0.01) {
          if (!ownerFilter) { ownerFilter = new F(); ownerFilter.resolution = canvas.app?.renderer?.resolution ?? 1; }
          ownerFilter.matrix = ashMatrix(k);
          ensureFilter(owner.mesh, ownerFilter);
        } else if (ownerFilter) dropFilter(owner.mesh, ownerFilter);
      }
    },
    cleanup() {
      try { dropFilter(owner?.mesh, ownerFilter); } catch { /* gone */ }
      const f = fire();
      if (f) {
        f.override = null; f.dirty = true;
        // destroyed: it stays hidden until its token goes (the removal follows this show)
        if (kind === "destroy") { f.override = { k: 0, flare: 0, bright: 0, hideMesh: true }; setTimeout(() => { if (_fires.get(frag.id) === f && !frag.destroyed && Number(frag.actor?.system?.props?.current_hp) > 0) f.override = null; }, 4000); }
      } else if (kind === "destroy" && frag?.mesh && !frag.destroyed) { try { frag.mesh.alpha = 0; } catch { /* gone */ } }
    },
  };
  return it;
}

const _destroyRuns = new Map();   // frag tokenId -> Promise (what the external defeat waits for)

/**
 * Play a show on THIS client. Resolves when it has finished (or could not play).
 *   { kind: "tithe"|"calling"|"destroy", sceneId, items: [{ ownerTokenId, fragTokenId, merge, delay }] }
 */
export function playSoulFxLocal(spec = {}) {
  const p = (async () => {
    if (!MAKERS[spec.kind] || !canvas?.ready || typeof PIXI === "undefined" || !shouldRender()) return;
    if (spec.sceneId && canvas.scene?.id !== spec.sceneId) return;
    const rows = (spec.items ?? []).filter((r) => r?.ownerTokenId && r?.fragTokenId);
    if (!rows.length) return;
    syncFires();
    const ts = await waitTokens(rows.flatMap((r) => [r.ownerTokenId, r.fragTokenId]));
    const D = densityFor(canvas.scene), items = [];
    rows.forEach((r, i) => {
      const owner = ts[i * 2], frag = ts[i * 2 + 1];
      if (!owner || !frag) return;
      try { const it = makeItem(spec.kind, r, D, owner, frag); if (it) items.push(it); }
      catch (e) { warn(`soul-fx: "${spec.kind}" could not be built for ${frag?.name}`, e); }
    });
    if (!items.length) return;
    const run = new Run(spec, items, D);
    _runs.add(run);
    startTicker();
    // a ticker that stops (a hidden window) must not strand it; a rig's stepped clock is not real time
    const real0 = performance.now();
    const failsafe = setInterval(() => { if (_clock === REAL_CLOCK && performance.now() - real0 > (run.end + 3) * 1000) run.finish(); }, 1000);
    await run.done;
    clearInterval(failsafe);
  })().catch((e) => warn(`soul-fx: "${spec?.kind}" threw`, e));
  if (spec.kind === "destroy") for (const r of spec.items ?? []) if (r?.fragTokenId) _destroyRuns.set(r.fragTokenId, p.finally(() => _destroyRuns.delete(r.fragTokenId)));
  return p;
}

/** Durations the rules wait for, in seconds, per kind (one item, no delay). */
export const SOUL_FX_LENGTH = Object.freeze({ tithe: TITHE.END, titheMerge: TITHE.END_MERGE, calling: CALLING.END, destroy: DESTROY.END });

/**
 * GM: start a show on every client and return its clock, or null when nobody is
 * watching (the rules then run at once, as before). `at(i, s)` resolves when item
 * i reaches its own second s; `done` when the whole show is over. A REAL clock:
 * the writes follow it whether or not this window draws.
 */
export function presentSoulFx(spec) {
  try {
    if (!shouldRender() && !hasOtherViewers()) return null;
  } catch { return null; }
  try { _socket?.executeForOthers?.(ACTION_PLAY, spec); } catch (e) { warn("soul-fx: broadcast failed", e); }
  const local = shouldRender() ? playSoulFxLocal(spec) : null;
  const t0 = performance.now();
  const items = spec.items ?? [];
  const lenOf = (r) => (spec.kind === "tithe" ? (r.merge ? TITHE.END_MERGE : TITHE.END) : spec.kind === "calling" ? CALLING.END : DESTROY.END);
  const end = Math.max(0, ...items.map((r) => (Number(r.delay) || 0) + lenOf(r)));
  const until = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - performance.now())));
  return {
    at: (i, s) => until((Number(items[i]?.delay) || 0) + s),
    done: Promise.all([until(end), local ?? Promise.resolve()]).then(() => {}),
  };
}

/** For the external defeat style: the destroy show playing for this fragment on this client. */
export function awaitSoulRelease(tokenUuid) {
  const id = String(tokenUuid ?? "").split(".").pop();
  return _destroyRuns.get(id) ?? Promise.resolve();
}

/* ── Boot ───────────────────────────────────────────────────────────────── */

let _socket = null, _hooked = false;
export function initSoulFx() {
  if (!_socket) {
    try {
      if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
        _socket = socketlib.registerModule(MODULE_ID);
        _socket.register(ACTION_PLAY, (spec) => playSoulFxLocal(spec));
      } else warn("soul-fx: socketlib unavailable — the Soul Tithe show stays GM-local");
    } catch (e) { warn("soul-fx: socket registration failed", e); }
  }
  if (_hooked) return;
  _hooked = true;
  applyRateOption();
  Hooks.on("fuClientOptionChanged", ({ key } = {}) => { if (key === "fxFrameRate") applyRateOption(); });
  registerExternalDefeat("soul-release", ({ tokenUuid }) => awaitSoulRelease(tokenUuid));
  const later = () => setTimeout(() => { try { syncFires(); } catch (e) { warn("soul-fx: sync threw", e); } }, 0);
  Hooks.on("canvasReady", () => { dropAllFires(); later(); });
  Hooks.on("canvasTearDown", () => { dropAllFires(); for (const r of [..._runs]) r.finish(); });
  Hooks.on("drawToken", (t) => { if (isFragmentDoc(t?.document)) later(); });
  Hooks.on("createToken", (doc) => { if (isFragmentDoc(doc)) later(); });
  Hooks.on("updateToken", (doc, ch) => { if (isFragmentDoc(doc) || ch?.flags?.[MODULE_ID]?.soulFragment !== undefined) later(); });
  Hooks.on("deleteToken", (doc) => { const f = _fires.get(doc?.id); if (f) { f.destroy(); _fires.delete(doc.id); } });
  globalThis.__FU_SOUL_FX__ = {
    isHeld: (tokenId) => { const f = _fires.get(tokenId); return !!f && (f.held() || !!f.override?.hideMesh); },
    resetCost: () => { _costN = 0; _costAt = 0; _drawn = 0; _dropped = 0; _deferredFrames = 0; },
    /** Rigs: the two update rates (Hz). A new bake rate re-bakes every fire. */
    setRate: ({ fx, bake } = {}) => {
      if (Number(fx) > 0) FX_HZ = Number(fx);
      if (Number(bake) > 0 && Number(bake) !== BAKE_HZ) {
        BAKE_HZ = Number(bake); BAKE_SLOTS = Math.round(FLAME_LOOP * BAKE_HZ);
        for (const f of _fires.values()) { f.baked = new Array(BAKE_SLOTS).fill(null); f.nBaked = 0; f.dirty = true; }
      }
      _lastFx = -1;
      return { fx: FX_HZ, bake: BAKE_HZ, slots: BAKE_SLOTS };
    },
    /** Rigs: replace the show clock (ms; null = real time), and run one frame with no budget. */
    setClock: (fn) => { _clock = typeof fn === "function" ? fn : REAL_CLOCK; _lastFx = -1; },
    frame: (all = true) => frame(all),
    /** Rigs: make fragments behave as freshly spawned (their hold applies again). */
    __runs: () => [..._runs],
    __unrelease: (ids) => { for (const id of ids ?? []) { const f = _fires.get(id); if (f) f.released = false; } },
    status: () => ({
      rate: { fx: FX_HZ, bake: BAKE_HZ, slots: BAKE_SLOTS },
      cost: costStats(),
      fires: [..._fires.values()].map((f) => ({ id: f.id, name: f.token?.name, built: f.built, baked: f.nBaked, bytes: f.bakedBytes(), held: f.held(), override: f.override })),
      runs: [..._runs].map((r) => ({ kind: r.spec.kind, items: r.items.length, t: (_clock() - r.t0) / 1000, end: r.end })),
    }),
    play: playSoulFxLocal,
  };
  if (canvas?.ready) later();
}
