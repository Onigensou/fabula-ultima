// ============================================================================
// Soul Tithe FX — the soul-fire material and the shared drawing (pure: no
// Foundry, no PIXI, no DOM; runs in bare Node for the tests).
//
// Ported from the user-approved mockup (tools/soul-tithe-fx-mock/mock/fx/,
// v12, 2026-11-09): soul-flame.js (the burning fragment, the fireball head, the
// flight, the merged puff field), soul-hand.js (fire filling a silhouette) and
// the shared helpers of soul-fx.js. The look is the mockup's; what changed is
// how it is paid for (the cutbacks the user approved):
//   - makeSoulFlame can leave its big soft glows out of the pixel buffers
//     (`gpuGlow: true`) and report them instead (`glows()`), so the runtime
//     draws them as GPU sprites and the idle fire can be baked to a loop.
//   - puffField reuses one heat buffer instead of allocating every frame.
//
// Built on the vendored pixelfx core (battle-director/pixel-entrance/pixelfx),
// the same one the pixel entrances use. Silhouettes ("sil") are plain objects:
//   { x, y, w, h, in(x, y), dist(x, y), pixels, mask, bodyTop, bodyH, soul, foot }
// in effect px, (x, y) its top-left; see makeSil.
// ============================================================================

import { fit, mix, hex, clamp, noise, noise2, rand, luma, Rng, WHITE } from "../../battle-director/pixel-entrance/pixelfx/core/index.js";
import { noiseFor, looped, drift, firePuff, lick, smokePuff, ember, flameBlade, floorLight, LAYERS } from "../../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";

// ── Palettes ────────────────────────────────────────────────────────────────

/** The soul ramp, darkest .. tint .. white (the mock's SOUL). */
export const SOUL = ["#03140b", "#0a3019", "#11522a", "#1d7d3b", "#34b04d", "#5dff6e", "#b4ffba", "#ffffff"].map(hex);
const C = SOUL;

/** Soul fire, dark -> hot. #5dff6e is the body tone; a deeper teal-green is the cool rim. */
export const SOUL_FIRE = ["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2", "#ffffff"];
const F9 = fit(SOUL_FIRE.map(hex), 9);
/** Hot-first: FH[0] white .. FH[8] darkest. */
export const FH = [...F9].reverse();
const FHB = [...FH.slice(1), FH[8]];                                 // one step cooler, for the back row
/** The colour of the fire's light. */
export const GLOW = mix(mix(FH[3], FH[4], 0.5), WHITE, 0.25);
const SMOKE = mix(hex("#5d5868"), FH[6], 0.22);                      // lilac grey, faintly green
const EMB = [FH[1], FH[2], FH[4], FH[6]], EMB_B = [FH[2], FH[3], FH[5], FH[7]];

// ── Silhouettes ─────────────────────────────────────────────────────────────

/**
 * A silhouette from a mask: { x, y } its top-left in effect px, mask a Uint8Array
 * (1 = body) of w x h, pixels its colours (Uint32 ABGR, may be null). Adds the
 * chessboard distance OUTSIDE the body (up to 5, for rings and the shell), the
 * body's top row and height, and its soul point (the chest) and feet.
 */
export function makeSil({ x, y, w, h, mask, pixels = null }) {
  const inside = (X, Y) => X >= 0 && Y >= 0 && X < w && Y < h && mask[Y * w + X] === 1;
  let top = h, bot = -1, x0 = w, x1 = -1;
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) if (mask[Y * w + X]) {
    if (Y < top) top = Y; if (Y > bot) bot = Y; if (X < x0) x0 = X; if (X > x1) x1 = X;
  }
  if (bot < 0) { top = 0; bot = h - 1; x0 = 0; x1 = w - 1; }
  const PAD = 5, dw = w + 2 * PAD, dh = h + 2 * PAD, dist = new Uint8Array(dw * dh).fill(99);
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) if (mask[Y * w + X]) dist[(Y + PAD) * dw + X + PAD] = 0;
  // two-pass chessboard transform (the mock ran five relaxation passes; same field up to 5)
  const at = (X, Y) => (X < 0 || Y < 0 || X >= dw || Y >= dh ? 99 : dist[Y * dw + X]);
  for (let Y = 0; Y < dh; Y++) for (let X = 0; X < dw; X++) {
    const i = Y * dw + X;
    if (dist[i]) dist[i] = Math.min(dist[i], 1 + Math.min(at(X - 1, Y), at(X - 1, Y - 1), at(X, Y - 1), at(X + 1, Y - 1)));
  }
  for (let Y = dh - 1; Y >= 0; Y--) for (let X = dw - 1; X >= 0; X--) {
    const i = Y * dw + X;
    if (dist[i]) dist[i] = Math.min(dist[i], 1 + Math.min(at(X + 1, Y), at(X + 1, Y + 1), at(X, Y + 1), at(X - 1, Y + 1)));
  }
  const cx = (x0 + x1 + 1) / 2;
  return {
    x, y, w, h, mask, pixels,
    in: inside,
    dist: (X, Y) => { const a = X + PAD, b = Y + PAD; return a < 0 || b < 0 || a >= dw || b >= dh ? 99 : dist[b * dw + a]; },
    bodyTop: top, bodyH: bot - top + 1,
    // the mock's chests sit 0.4 of the body down (Hina 48/118, the fragment 55/140)
    soul: [x + Math.round(cx), y + top + Math.round((bot - top + 1) * 0.4)],
    foot: [x + Math.round(cx), y + bot + 1],
  };
}

/** The same silhouette with its top-left moved to (x, y). */
export function placeSil(S, x, y) {
  const dx = x - S.x, dy = y - S.y;
  return { ...S, x, y, soul: [S.soul[0] + dx, S.soul[1] + dy], foot: [S.foot[0] + dx, S.foot[1] + dy] };
}

/** Pixels just outside a silhouette (the rim), as [x, y] local px. */
export function rimOf(A) {
  const out = [];
  for (let y = -1; y <= A.h; y++)
    for (let x = -1; x <= A.w; x++)
      if (!A.in(x, y) && (A.in(x - 1, y) || A.in(x + 1, y) || A.in(x, y - 1) || A.in(x, y + 1))) out.push([x, y]);
  return out;
}

/** Each row's left and right body edge (null where empty). */
export function rowsOf(A) {
  return Array.from({ length: A.h }, (_, y) => { let a = -1, b = -1; for (let x = 0; x < A.w; x++) if (A.in(x, y)) { if (a < 0) a = x; b = x; } return a < 0 ? null : [a, b]; });
}

/** Chessboard depth of every body pixel from the outside (1 = edge pixel). */
export function insideDist(sil) {
  const W = sil.w, H = sil.h, d = new Uint8Array(W * H);
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = sil.in(x, y) ? Math.min(255, 1 + Math.min(at(x - 1, y), at(x - 1, y - 1), at(x, y - 1), at(x + 1, y - 1))) : 0;
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (d[i]) d[i] = Math.min(d[i], 1 + Math.min(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1))); }
  return d;
}

/** Distance through a silhouette (8-neighbour, diagonal 1.41) from a set of seed pixels. */
export function bfsFrom(sil, seeds) {
  const g = new Float32Array(sil.w * sil.h).fill(1e9), q = [];
  for (const [x, y] of seeds) if (sil.in(x, y) && g[y * sil.w + x] > 0) { g[y * sil.w + x] = 0; q.push(x, y); }
  for (let h = 0; h < q.length; h += 2) {
    const x = q[h], y = q[h + 1], v = g[y * sil.w + x];
    for (const [dx, dy, c] of N8) {
      const X = x + dx, Y = y + dy;
      if (!sil.in(X, Y) || g[Y * sil.w + X] <= v + c) continue;
      g[Y * sil.w + X] = v + c; q.push(X, Y);
    }
  }
  return g;
}
const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.41], [-1, 1, 1.41], [1, -1, 1.41], [-1, -1, 1.41]];

// ── Shared drawing (soul-fx.js) ─────────────────────────────────────────────

/** Crackling rim: rim pixels lit at random per 30 fps frame. dy: the silhouette's lift. */
export function crackle(p, A, rim, k, t, dy = 0, hot = 0.5) {
  if (k <= 0) return;
  const f = Math.floor(t * 30);
  for (const [x, y] of rim) {
    const r = rand(x, y, f);
    if (r < 0.75 * k) p.px(A.x + x, A.y + y + dy, rand(x, y, 7, f) < hot * k ? C[6] : C[5]);
  }
}

const edgeCache = new WeakMap();
/** A silhouette's own edge pixels, shifted (an afterimage drawn as an outline). */
export function outlineAt(p, A, dx, c, a, dy = 0) {
  let e = edgeCache.get(A.mask);
  if (!e) {
    e = [];
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) if (A.in(x, y) && (!A.in(x - 1, y) || !A.in(x + 1, y) || !A.in(x, y - 1) || !A.in(x, y + 1))) e.push([x, y]);
    edgeCache.set(A.mask, e);
  }
  for (const [x, y] of e) p.dot(A.x + x + dx, A.y + y + dy, c, a);
}

/** The soul ramp step for a pixel's value (how the fragment looks). */
export const ghostCol = (l) => (l > 0.66 ? C[6] : l > 0.42 ? C[5] : l > 0.24 ? C[4] : C[3]);

/** A silhouette redrawn in soul green by its own values, shifted. */
export function ghost(p, A, dx, a = 1, dy = 0) {
  for (let y = 0; y < A.h; y++)
    for (let x = 0; x < A.w; x++) {
      if (!A.in(x, y)) continue;
      p.dot(A.x + x + dx, A.y + y + dy, ghostCol(luma(A.pixels[y * A.w + x])), a);
    }
}

/** Soft light over a silhouette (its own glow), k 0..1. */
export function bodyLight(p, A, k, c = C[5], dy = 0) {
  if (k <= 0.004) return;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) if (A.in(x, y)) p.light(A.x + x, A.y + y + dy, c, k);
}

/** Aura: outline rings 1..n px outside a silhouette. */
export function aura(p, A, n, k, t, dy = 0) {
  if (k <= 0 || n < 0.5) return;
  const f = Math.floor(t * 30), N = Math.ceil(n);
  for (let y = -4; y < A.h + 4; y++)
    for (let x = -4; x < A.w + 4; x++) {
      const d = A.dist(x, y);
      if (d < 1 || d > N) continue;
      const fall = clamp(n - d + 1) * k, c = d === 1 ? C[5] : d === 2 ? C[4] : C[3];
      if (d > 1 && rand(x, y, f >> 1) > 0.55 + 0.2 * fall) continue;
      p.dot(A.x + x, A.y + y + dy, c, fall);
      if (d === 1) p.light(A.x + x, A.y + y + dy, C[5], 0.35 * fall);
    }
}

export const noise2v = (x, t) => Math.sin(x * 0.37 + t * 7) * 0.5 + Math.sin(x * 0.13 - t * 3.1) * 0.5;

// ── Fire filling a silhouette (soul-hand.js) ────────────────────────────────

const GLOW_K = 0.05;
let _sfA = new Float32Array(64), _sfB = new Float32Array(64);

/**
 * Every body pixel can be a heat source (src 0..1); the heat rises and spreads
 * (each row takes the decayed, sideways-blurred heat of the row under it), cut by
 * a noise field that scrolls upward, so flames climb off whatever burns and merge
 * into one body. o.lift: how far the flames climb (px); o.seed; o.light; o.cool
 * 0..1 drops the hottest bands; o.skip(x, y).
 */
export function silFire(p, sil, ox, oy, tt, src, o = {}) {
  const L = o.lift ?? 26, PAD = 8, W = sil.w + PAD * 2, seed = o.seed ?? 11, light = o.light ?? 1;
  const cool = o.cool ?? 0;
  if (_sfA.length < W) { _sfA = new Float32Array(W * 2); _sfB = new Float32Array(W * 2); }
  let prev = _sfA, cur = _sfB;
  prev.fill(0, 0, W); cur.fill(0, 0, W);
  for (let y = sil.h + 1; y >= -L - 4; y--) {
    let any = false;
    for (let i = 0; i < W; i++) {
      const x = i - PAD, s = sil.in(x, y) ? src(x, y) : 0;
      const n1 = noise2(x * 0.3, (y + tt * 80) * 0.2, seed), off = n1 > 0.3 ? 1 : n1 < -0.3 ? -1 : 0;
      const j = Math.min(W - 1, Math.max(0, i + off)), a = prev[j], b = j > 0 ? prev[j - 1] : 0, c = j < W - 1 ? prev[j + 1] : 0;
      const loss = (1.7 / L) * (0.25 + 1.5 * (0.5 + 0.5 * noise2(x * 0.45 + 3, (y + tt * 95) * 0.3, seed + 3)));
      const v0 = Math.max(s, 0.7 * a + 0.15 * b + 0.15 * c - loss);
      cur[i] = v0;
      if (v0 < 0.06) continue;
      any = true;
      if (o.skip && o.skip(x, y)) continue;
      const v = v0 * (1 - 0.35 * cool);
      if (v < 0.11) continue;
      if (v < 0.22 && noise2(x * 0.7, (y + tt * 60) * 0.5, seed + 7) > 0.25) continue;
      const col = v > 0.86 ? FH[0] : v > 0.7 ? FH[1] : v > 0.52 ? FH[2] : v > 0.36 ? FH[3] : v > 0.24 ? FH[4] : v > 0.17 ? FH[5] : FH[6];
      p.px(ox + x, oy + y, col);
      if (v > 0.36 && light > 0) p.light(ox + x, oy + y, FH[3], GLOW_K * light);
    }
    const t = prev; prev = cur; cur = t;
    if (!any && y < 0) break;
  }
}

// ── The burning fragment (soul-flame.js makeSoulFlame) ──────────────────────

/**
 * The fragment BURNS: a short crown of real tongues on its up-facing edges, side
 * licks, a burning shell round the outline (one heat field), a cooler back row,
 * the flow (puffs, licks, embers, a lilac plume), and its light.
 *   drawBack(p, t, bobAt, k, flare)  behind the sprite
 *   draw(p, t, bobAt, k, flare, glowK) in front of it
 * t: clock; bobAt(t): its hover offset then; k 0..1 how lit; flare 0..1 absorbing.
 * setWind(w, t) / setOrigin(x, t): change the breeze / move the fire while it burns (t = the clock you
 *   draw with). o.motion: a makeFlameMotion() to share that history between flames that take over from
 *   one another; o.trailPad: extra px of frame round it for the trail a moving fire leaves.
 * o.cover: the fire burns ON the silhouette instead of round it (a fire bed over its
 * pixels, tongues and licks drawn across it). Off by default (a body hides its pixels).
 * o.gpuGlow: leave the big soft glows (wash, column, body, floor pool) out of the
 * pixel buffers; glows(t, k, flare, glowK) lists them for the runtime to draw.
 * Loops every LOOP seconds (all of it is a function of t % LOOP).
 */
export const FLAME_LOOP = 2;
/** A value over time, sampled each frame: at(t) interpolates, int(t) integrates (both linear). Keeps 3 s. */
function timeTrack() {
  const h = [];   // [t, v, integral of v from the first entry to t]
  const find = (tau) => { let lo = 0, hi = h.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (h[m][0] <= tau) lo = m; else hi = m - 1; } return lo; };
  return {
    get size() { return h.length; },
    clear() { h.length = 0; },
    push(t, v) {
      if (h.length && t < h[h.length - 1][0]) h.length = 0;   // the clock went back: start over
      const q = h[h.length - 1];
      if (q && t === q[0]) { q[1] = v; return; }
      h.push([t, v, q ? q[2] + (q[1] + v) / 2 * (t - q[0]) : 0]);
      while (h.length > 2 && h[1][0] < t - 3) h.shift();   // particles live under 3 s
    },
    at(tau) {
      if (tau <= h[0][0]) return h[0][1];
      const i = find(tau), a = h[i], b = h[i + 1];
      return b ? a[1] + (b[1] - a[1]) * (tau - a[0]) / (b[0] - a[0]) : a[1];
    },
    int(tau) {
      if (tau <= h[0][0]) return h[0][1] * (tau - h[0][0]);
      const i = find(tau), a = h[i], b = h[i + 1];
      const v = b ? a[1] + (b[1] - a[1]) * (tau - a[0]) / (b[0] - a[0]) : a[1];
      return a[2] + (a[1] + v) / 2 * (tau - a[0]);
    },
  };
}
/** The wind and place history of a moving flame; pass as o.motion to share it between flames. */
export function makeFlameMotion() { return { wind: timeTrack(), origin: timeTrack() }; }
export function makeSoulFlame(F, o = {}) {
  const D = FLAME_LOOP, NL = noiseFor(D), S = o.seed ?? 4, gpuGlow = !!o.gpuGlow, SMOKY = o.smoke !== false, COVER = !!o.cover;
  // o.wind: a steady breeze, + = to the right (0 = none, ~1 = strong). Leans the tongues and carries the licks, puffs and embers.
  // The wind and the place can change while it burns (o.motion, shared between flames that take over from
  // one another). setWind(w, t): tongues lean with the wind NOW; a puff, lick or ember is carried by the wind
  // AVERAGED over its own life, so a change never makes the particles jump. setOrigin(x, t): where the
  // silhouette sits along x (screen px); what is already in the air stays where it was let go, so a moving
  // fire leaves its licks and embers behind it. Steady wind, no origin set: draws exactly as before.
  const MO = o.motion ?? makeFlameMotion();
  let WIND = Number(o.wind) || 0, PULL = Math.max(0, 1 - Math.abs(WIND) * 0.8);   // the wind wins over the draw to the centre
  const windOver = (t, age) => (MO.wind.size && age > 1e-3 ? (MO.wind.int(t) - MO.wind.int(t - age)) / age : WIND);
  const leftBehind = (t, age) => (MO.origin.size && age > 0 ? MO.origin.at(t) - MO.origin.at(t - age) : 0);
  function setWind(w, t) {
    WIND = Number(w) || 0; PULL = Math.max(0, 1 - Math.abs(WIND) * 0.8);
    if (t == null) MO.wind.clear(); else MO.wind.push(t, WIND);
  }
  function setOrigin(x, t) { MO.origin.push(t, x); }
  const PAD = 40 + Math.max(0, o.trailPad ?? 0);   // how far round the silhouette it can draw (more for a moving fire's trail)
  const K = o.k ?? 1.8;
  const LIFT = o.lift ?? 15 * K;
  const GX0 = -18, GY0 = -64, GW = F.w + 36, GH = F.h + 70;
  const heat = new Float32Array(GW * GH);
  const add = (x, y, v) => {
    const i = x - GX0, j = y - GY0;
    if (i < 0 || j < 0 || i >= GW || j >= GH || v <= 0) return;
    const q = j * GW + i;
    heat[q] = 1 - (1 - heat[q]) * (1 - Math.min(1, v));
  };
  let minX = 1e9, maxX = -1e9;
  const topAt = new Map();
  for (let x = 0; x < F.w; x++)
    for (let y = 0; y < F.h; y++)
      if (F.in(x, y) && !F.in(x, y - 1)) { if (!topAt.has(x)) topAt.set(x, []); topAt.get(x).push(y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  const top = F.bodyTop, bh = F.bodyH, cxF = (minX + maxX) / 2;
  const tongueList = (step, off, hMul, wMul) => {
    const out = [];
    for (let x0 = minX + off; x0 <= maxX; x0 += step) {
      let best = null;
      for (let x = x0; x < x0 + step && x <= maxX; x++) for (const y of topAt.get(x) ?? []) if (!best || y < best[1]) best = [x, y];
      if (!best) continue;
      const v = (best[1] - top) / bh, env = 0.2 + 0.8 * Math.pow(1 - clamp(v), 1.6);
      if (v > 0.8) continue;
      out.push({ bx: best[0] + 0.5, by: best[1] + 1, env, w: (1.5 + 1.3 * env) * wMul * K * 0.8, hMul, n: out.length * 13 + off * 7 + 5 });
    }
    return out;
  };
  const FRONT_T = tongueList(5, 0, 1, 1), BACK_T = tongueList(7, 3, 1.3, 1.1);
  for (let y = top + 18; y < top + bh * 0.82; y += 11) {
    let l = -1, r = -1;
    for (let x = 0; x < F.w; x++) if (F.in(x, y)) { if (l < 0) l = x; r = x; }
    if (l < 0) continue;
    const env = 0.22 + 0.2 * (1 - (y - top) / bh);
    FRONT_T.push({ bx: l - 0.5, by: y + 2, env, w: 1.6 * K * 0.8, hMul: 1, n: 900 + y * 3 });
    FRONT_T.push({ bx: r + 1.5, by: y + 2, env, w: 1.6 * K * 0.8, hMul: 1, n: 1700 + y * 3 });
  }
  const fuel = [];
  for (const [x, ys] of topAt) for (const y of ys) if ((y - top) / bh < 0.7) fuel.push([x + 0.5, y, 0.25 + 0.75 * Math.pow(1 - (y - top) / bh, 1.5)]);
  if (!fuel.length) fuel.push([cxF, top, 1]);
  const shellUp = new Float32Array(GW * GH).fill(-1), shellD = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const x = i + GX0, y = j + GY0, d = F.dist(x, y);
      if (d < 1 || d > 4) continue;
      let below = false, side = false;
      for (let k = 1; k <= 4 && !below; k++) below = F.in(x, y + k);
      for (let k = 1; k <= 3 && !side; k++) side = F.in(x - k, y) || F.in(x + k, y);
      shellUp[j * GW + i] = below ? 1 : side ? 0.55 : 0.12;
      shellD[j * GW + i] = d;
    }

  const fla = (tt) => 0.74 + 0.16 * NL(tt, 7.3, S + 1) + 0.1 * NL(tt, 19, S + 2);
  const lean = (tt) => NL(tt, 0.67, S + 90) * 0.12 + WIND;
  const height = (q, tt, s, m) => {
    const n = q.n + s, leap = Math.max(0, NL(tt, 2.6, n + 70) - 0.55) * 1.4, h = 2 + LIFT * q.env * q.hMul;
    return (h + 0.25 * h * NL(tt, 3.3, n) + h * leap) * (0.9 + 0.1 * fla(tt)) * m;
  };
  const sweep = (q, tt, h, s) => NL(tt, 2.2, q.n + s + 40) * (1 + h * 0.08) + lean(tt) * h * 0.9 - clamp((q.bx - cxF) * 0.08, -2.5, 2.5) * PULL;
  const tip = (q, tt, s, m) => { const h = height(q, tt, s, m); return [q.bx + sweep(q, tt, h, s) * K * 0.85, q.by - h * 0.88 + 2, h]; };
  const centreW = (x) => 1 - 0.35 * Math.pow(Math.min(1, Math.abs(x - cxF) / (F.w * 0.6)), 1.5);

  function body(p, tt, list, s, ramp, m, by, kShell) {
    heat.fill(0);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const up = shellUp[j * GW + i];
        if (up < 0) continue;
        const x = i + GX0, y = j + GY0, d = shellD[j * GW + i];
        const sh = (1.2 + 2.6 * up + 0.8 * NL(tt, 9, s + 5, x * 0.7 + y * 1.3)) * kShell;
        if (d > sh) continue;
        const rise = up < 1 ? 0.65 + 0.6 * NL(tt, 6, s + 9, (y + tt * 45) * 0.22 + x * 0.4) : 1;
        add(x, y, (0.26 + 0.42 * up) * (1 - (d - 1) / (sh + 0.5)) * centreW(x) * rise);
      }
    // o.cover: a flickering fire bed on the silhouette itself
    if (COVER) for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) if (F.in(x, y)) add(x, y, (0.42 + 0.3 * NL(tt, 9, s + 13, x * 0.8 + (y + tt * 40) * 0.6)) * centreW(x));
    for (const q of list) {
      const h = height(q, tt, s, m), sx = sweep(q, tt, h, s), n = q.n + s;
      if (h < 1) continue;
      for (let r = -2; r <= h; r++) {
        const u = Math.max(0, r) / Math.max(1, h);
        const half = q.w * Math.pow(1 - u, 0.85) * Math.min(1, (r + 3.5) / (3.5 * K)) + NL(tt, 9, n, r * 0.45 / K) * 0.7;
        if (half < 0.3) continue;
        const cx = q.bx + sx * K * u * u + NL(tt, 4, n + 7, r * 0.2 / K) * u * (1.1 + h * 0.04) * K, y = Math.round(q.by - r);
        for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
          const across = 1 - Math.abs(x + 0.5 - cx) / half;
          if (across > 0) add(x, y, Math.pow(across, 0.7) * (0.25 + 0.75 * Math.pow(1 - u, 1.2)) * centreW(x));
        }
      }
    }
    const at = (i, j) => (i < 0 || j < 0 || i >= GW || j >= GH ? 0 : heat[j * GW + i]);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const v = heat[j * GW + i];
        if (v < 0.06) continue;
        const x = i + GX0, y = j + GY0;
        if (!COVER && F.in(x, y)) continue;
        if (v < 0.2 && NL(tt, 8, s + 61, x * 0.9 + (y + tt * 30) * 0.7) > 0.3) continue;
        const edge = at(i, j - 1) < 0.06 || at(i - 1, j) < 0.06 || at(i + 1, j) < 0.06;
        const c = edge ? ramp[6] : v > 0.86 ? ramp[0] : v > 0.66 ? ramp[1] : v > 0.48 ? ramp[2] : v > 0.32 ? ramp[3] : v > 0.18 ? ramp[4] : ramp[5];
        p.px(F.x + x, F.y + y + by, c);
      }
  }
  function flow(p, t, bobAt, back, m, flare) {
    const tt = t % D, list = back ? BACK_T : FRONT_T, s = back ? S + 50 : S, HH = back ? FHB : FH, E = back ? EMB_B : EMB;
    const Wx = (x, age = 0) => F.x + x - leftBehind(t, age), Wy = (y, age) => F.y + y + bobAt(t - age);
    const DRAW_IN = 0.9, KV = Math.sqrt(K) * 1.1;
    const puff = (z, age, x0, y0) => {
      const [x, y, vx, vy] = drift(x0 + z.ox, y0 + z.oy, z.vx + windOver(t, age) * z.wx - (x0 - cxF) * DRAW_IN, z.vy, Math.min(age, z.fire), 0, -95 * KV, 5, 3.2);
      if (age < z.fire) return firePuff(p, Wx(x, age), Wy(y, age), 1 - age / z.fire, z.sz, z.f, HH);
      if (!SMOKY || !z.smokes || age - z.fire > z.sl) return;
      const [sx, sy] = drift(x, y, vx * 0.6, vy * 0.6 - 6, age - z.fire, 3, -16, 1.6, 1.2);
      smokePuff(p, Wx(sx, age), Wy(sy, age), 1 - (age - z.fire) / z.sl, z.sz * 0.75, SMOKE);
    };
    const mk = (r, env) => {
      const fire = r.range(0.14, 0.3), smokes = r.chance(0.45);
      return { back: r.chance(0.4), fire, smokes, sl: r.range(0.8, 1.3), ox: r.range(-1, 1) * K, oy: r.range(0, 3) * K, vx: r.range(-4, 4) * KV, wx: 45 * KV, vy: -r.range(15, 30) * KV, sz: r.range(0.8, 1.6) * (0.8 + 0.6 * env) * K * 1.1, f: r.next(), life: fire + (smokes ? 1.3 : 0), g: r.next() };
    };
    const gate = (z) => z.g < 0.5 || z.g < 0.5 + 0.5 * flare;
    looped(tt, D, Math.round(list.length * 8 * D * 1.6), s + 200, (r, j) => ({ ...mk(r, list[j % list.length].env), q: list[j % list.length] }), (z, age) => {
      if (z.back !== back || !gate(z)) return;
      const [tx, ty] = tip(z.q, tt - age, s, m);
      puff(z, age, tx, ty);
    });
    looped(tt, D, Math.round(36 * D * 1.6), s + 240, (r) => { const f = fuel[Math.floor(r.next() * fuel.length)]; return { ...mk(r, f[2]), x0: f[0], y0: f[1] - 1 }; }, (z, age) => {
      if (z.back !== back || !gate(z)) return;
      puff(z, age, z.x0, z.y0);
    });
    looped(tt, D, list.length * 8, s + 220, (r, j) => ({ q: list[j % list.length], back: r.chance(0.4), vx: r.range(-3, 3) * KV, wx: 30 * KV, vy: -r.range(12, 22) * KV, sz: r.range(0.9, 1.5) * (0.7 + 0.5 * list[j % list.length].env) * K, life: 0.26 }), (z, age) => {
      if (z.back !== back) return;
      const [tx, ty] = tip(z.q, tt - age, s, m), lx = tx + (z.vx + windOver(t, age) * z.wx) * age, ly = ty - 2 + z.vy * age;
      if (!back && !COVER && F.in(Math.round(lx), Math.round(ly))) return;
      lick(p, Wx(lx, age), Wy(ly, age), 1 - age / z.life, z.sz, HH);
    });
    if (back && SMOKY) looped(tt, D, 12 * D, s + 300, (r) => ({ x: cxF + r.range(-6, 6), y: top - LIFT * 0.7 - r.range(0, 8), vx: r.range(-2, 2), vy: -r.range(10, 17), life: r.range(1.6, 2.4), sz: r.range(2.4, 3.6) * K }), (z, age) => {
      const [x, y] = drift(z.x, z.y, z.vx * KV, z.vy * KV, age, 4, -20 * KV, 1.6, 1);
      smokePuff(p, Wx(x + NL(tt - age, 0.5, s + 60) * (2 + 3 * age), age), Wy(y, age), 1 - age / z.life, z.sz, SMOKE, false, 0.8);
    });
    looped(tt, D, 14 * D, s + 500, (r) => { const f = fuel[Math.floor(r.next() * fuel.length)]; return { x: f[0], back: r.chance(0.4), y: f[1] - r.range(2, 10), vx: r.range(-15, 15), wx: 60, vy: -r.range(25, 55), life: r.range(1, 1.9), sz: r.chance(0.15) ? 2 : r.range(1, 1.6), a: r.range(0, 6.3), b: r.range(0, 6.3) }; }, (z, age) => {
      if (z.back !== back) return;
      const [x, y] = drift(z.x, z.y, z.vx + windOver(t, age) * z.wx, z.vy, age, 0, -30, 1.6, 1.6);
      if (!back && !COVER && F.in(Math.round(x), Math.round(y))) return;
      ember(p, Wx(x + 7 * (Math.sin(age * 2.3 + z.a) - Math.sin(z.a)), age), Wy(y + 2 * (Math.sin(age * 3 + z.b) - Math.sin(z.b)), age), 1 - age / z.life, z.sz, E, age * 40 + z.a);
    });
  }
  /** Keep the bloom off the body: its own pixels carry its brightness. */
  function dimLightOnBody(p, by, k = 0.35) {
    for (let y = 0; y < F.h; y++)
      for (let x = 0; x < F.w; x++) {
        if (!F.in(x, y)) continue;
        const sx = F.x + x - p.ox, sy = F.y + y + by - p.oy;
        if (sx < 0 || sy < 0 || sx >= p.w || sy >= p.h) continue;
        const q = sy * p.w + sx, l = p.L[q];
        if (!l) continue;
        p.L[q] = (l & 0xff000000) | (Math.round(((l >>> 16) & 255) * k) << 16) | (Math.round(((l >>> 8) & 255) * k) << 8) | Math.round((l & 255) * k);
      }
  }
  /**
   * The big soft glows, as data: [{ kind: "glow"|"pool", x, y, r, ry?, k, c, back? }]
   * in effect px (the silhouette's frame, bob not included). What the mock painted
   * with p.glow / floorLight; the runtime draws them as GPU sprites.
   */
  function glows(t, k = 1, flare = 0, glowK = 1) {
    if (k <= 0.02) return [];
    const tt = t % D, fl = fla(tt), lx = lean(tt) * 12;
    const L = fl * k * (1 + 0.9 * flare) * glowK, colTop = F.y + top - LIFT * 0.4;
    const out = [{ kind: "glow", back: true, x: F.x + cxF + lx, y: F.y + top + bh * 0.25, r: 70, k: 0.16 * fl * k * (1 + flare), c: GLOW }];
    for (const [dx, kk] of [[-8, 0.85], [0, 1], [8, 0.85]]) out.push({ kind: "glow", x: F.x + cxF + dx + lx, y: colTop, r: 46, k: 0.2 * kk * L, c: GLOW });
    out.push({ kind: "glow", x: F.x + cxF, y: F.y + top + bh * 0.45, r: 64, k: 0.14 * L, c: GLOW });
    out.push({ kind: "pool", x: F.foot[0], y: F.y + F.h - 5, r: 46, ry: 8, k: 0.32 * L, c: GLOW });
    return out;
  }
  return {
    D, glows, dimLightOnBody, setWind, setOrigin,
    /** Where it can draw, local to the silhouette's top-left (for sizing frames). */
    extent: { x0: -PAD, y0: -Math.ceil(LIFT * 2 + 150), x1: F.w + PAD, y1: F.h + 16 },
    drawBack(p, t, bobAt, k = 1, flare = 0) {
      if (k <= 0.02) return;
      const tt = t % D, by = bobAt(t), m = k * (1 + 0.8 * flare), fl = fla(tt), lx = lean(tt) * 12;
      if (!gpuGlow) p.glow(F.x + cxF + lx, F.y + top + bh * 0.25 + by, 70, GLOW, 0.16 * fl * k * (1 + flare));
      flow(p, t, bobAt, true, m, flare);
      body(p, tt, BACK_T, S + 50, FHB, m, by, 0);
    },
    draw(p, t, bobAt, k = 1, flare = 0, glowK = 1) {
      if (k <= 0.02) return;
      const tt = t % D, by = bobAt(t), m = k * (1 + 0.8 * flare), fl = fla(tt), lx = lean(tt) * 12;
      body(p, tt, FRONT_T, S, FH, m, by, Math.min(1.4, k * (1 + 0.4 * flare)));
      flow(p, t, bobAt, false, m, flare);
      if (!gpuGlow) {
        const L = fl * k * (1 + 0.9 * flare) * glowK, colTop = F.y + top - LIFT * 0.4 + by;
        for (const [dx, kk] of [[-8, 0.85], [0, 1], [8, 0.85]]) p.glow(F.x + cxF + dx + lx, colTop, 46, GLOW, 0.2 * kk * L);
        p.glow(F.x + cxF, F.y + top + bh * 0.45 + by, 64, GLOW, 0.14 * L);
        floorLight(p, F.foot[0], F.y + F.h - 5, 46, 8, GLOW, 0.32 * L);
      }
      dimLightOnBody(p, by);
    },
  };
}

// ── The fireball head ───────────────────────────────────────────────────────

/** A churning ball, white at the heart, stretched back into a teardrop against (vx, vy), a crisp hot
 *  leading rim, flame blades swept back. k scales it (0..1, forming); K the part scale. */
export function fireHead(p, x, y, vx, vy, tt, k, K = 2.2, R0 = 4.6 * K * 0.8, blades = 1) {
  const sp = Math.hypot(vx, vy) || 1, ux = vx / sp, uy = vy / sp, ph = tt * 3, r0 = R0;
  const N = (rate, seed = 0, off = 0) => noise(tt * rate + off, seed);
  if (blades > 0)
    BLADES.forEach(([len, w, dy], i) => {
      const n = 97 + i * 17, Ln = len * K * k * blades * (0.82 + 0.25 * N(4, n)) * (1 + 0.3 * Math.max(0, N(2.4, n + 3)));
      flameBlade(p, x + dy * K * 0.4 * uy, y - dy * K * 0.4 * ux, -ux, -uy, Ln, w * K * 0.8 * k, (N(3, n + 5) * 2 + dy) * K, N, n, FH, LAYERS, 0.6, 1.1 * K);
    });
  p.shade(x - r0 * 3, y - r0 * 3, x + r0 * 3, y + r0 * 3, (px, py, out) => {
    const dx = px - x, dy = py - y, d = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    const back = Math.max(0, -(dx * ux + dy * uy) / (d || 1));
    const bump = 0.55 * noise(th * 1.4 + ph * 9, 3) + 0.35 * noise(th * 0.8 - ph * 10, 4);
    const rim = r0 * k * (1 + 0.7 * back * back) + bump * Math.min(1, k * 2);
    if (d > rim) return;
    const swirl = noise2(th * 1.6 - ph * 10 + d * 0.45, ph, 5);
    const h = 1 - d / rim + 0.24 * swirl + 0.12 * (1 - back);
    if (rim - d < 1 && back < 0.3) return FH[3];
    out.k = 0;
    return FH[h > 0.8 ? 0 : h > 0.64 ? 1 : h > 0.46 ? 2 : h > 0.3 ? 3 : h > 0.15 ? 4 : 5];
  });
}
const BLADES = [[17, 3.4, 0], [12, 3.0, -1.6], [11, 3.0, 1.6]];

// ── The flight: Flame A, the fireball with a merged puff tail ───────────────

/**
 * path(tt) -> [x, y] for tt in [t0, t1]; it arrives at t1. floorY(u): the floor under
 * it (0 at the start, 1 at the end), for the light pool. sinkTo(): where its tail is
 * drawn in after it arrives. bounds(): where it is drawing now, or null.
 */
export function makeFlight(path, t0, t1, o = {}) {
  const R = new Rng(o.seed ?? 31), parts = [];
  const K = o.k ?? 2.2, R0 = (o.radius ?? 4.6) * K * 0.8, KV = Math.sqrt(K);
  let t = 0;
  const velAt = (tt) => { const a = path(Math.max(t0, tt - 0.01)), b = path(Math.min(t1, tt + 0.01)); const dt = Math.min(t1, tt + 0.01) - Math.max(t0, tt - 0.01) || 0.01; return [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt]; };
  const amb = (tt) => noise(tt * 0.67, 90) * 0.12;
  return {
    update(dt) {
      t += dt;
      if (t >= t0 && t < t1) {
        const [x, y] = path(t), [vx, vy] = velAt(t);
        for (let n = 0; n < 2; n++) if (R.chance((280 * dt) / 2))
          parts.push({ kind: "puff", x: x + R.range(-2, 2) * K, y: y + R.range(-2, 2) * K, vx: vx * 0.2 + R.range(-10, 10) * KV, vy: vy * 0.2 - R.range(0, 18) * KV, age: 0, life: R.range(0.18, 0.42), s: R.range(1.4, 2.8) * K, f: R.next(), smokes: R.chance(0.28), sl: R.range(0.45, 0.8) });
        if (R.chance(16 * dt)) parts.push({ kind: "ember", x, y, vx: vx * 0.35 + R.range(-15, 15), vy: vy * 0.35 - R.range(10, 40), age: 0, life: R.range(0.6, 1.3), s: R.chance(0.2) ? 2 : 1, a: R.range(0, 6.3) });
      }
      const sinkP = o.sinkTo && t >= t1 ? o.sinkTo() : null;
      for (let k = parts.length - 1; k >= 0; k--) {
        const q = parts[k];
        q.age += dt;
        if (sinkP && q.kind === "ember") q.age += dt * 4;
        else if (sinkP && !q.smoke) { q.vx += (sinkP[0] - q.x) * 26 * dt; q.vy += (sinkP[1] - q.y) * 26 * dt; q.age += dt * 1.2; }
        if (q.kind === "puff" && !q.smoke && q.age > q.life) {
          if (!q.smokes) { parts.splice(k, 1); continue; }
          q.smoke = true; q.age = 0; q.life = q.sl;
        }
        if (q.age > q.life) { parts.splice(k, 1); continue; }
        const [ay, kx, ky] = q.smoke ? [-20, 1.6, 1.2] : q.kind === "ember" ? [-30, 1.6, 1.6] : [-70, 4.5, 3];
        q.vx += (amb(t) * 30 - q.vx) * kx * dt; q.vy += ay * KV * dt - q.vy * ky * dt;
        q.x += q.vx * dt; q.y += q.vy * dt;
      }
    },
    live() { return t < t1 || parts.length > 0; },
    bounds() {
      const b = newBox();
      for (const q of parts) growBox(b, q.x, q.y, q.s * 3 + 4);
      if (t >= t0 && t < t1) {
        const [x, y] = path(t), u = (t - t0) / (t1 - t0);
        growBox(b, x, y, 30 * K + 4);
        if (o.floorY) { const fy = o.floorY(u); if (fy - y < 220) { growBox(b, x - 42, fy - 9, 0); growBox(b, x + 42, fy + 9, 0); } }
      }
      return b.x0 <= b.x1 ? b : null;
    },
    draw(p) {
      const flying = t >= t0 && t < t1;
      for (const q of parts) if (q.smoke) smokePuff(p, q.x, q.y, 1 - q.age / q.life, q.s * 1.1, SMOKE, false, 0.5);
      puffField(p, parts, t);
      for (const q of parts) {
        if (q.smoke || q.kind === "puff") continue;
        ember(p, q.x + 4 * (Math.sin(q.age * 2.3 + q.a) - Math.sin(q.a)), q.y, 1 - q.age / q.life, q.s, EMB, q.age * 40 + q.a);
      }
      if (flying) {
        const [x, y] = path(t), [vx, vy] = velAt(t), u = (t - t0) / (t1 - t0);
        const k = Math.min(1, (o.k0 ?? 0.55) + u * 3);
        fireHead(p, x, y, vx, vy, t, k, K, R0);
        const fl = 0.85 + 0.15 * noise(t * 9, 7);
        p.glow(x, y, 30 * K, GLOW, 0.4 * fl);
        p.glow(x, y, 10 * K, FH[1], 0.22 * fl);
        if (o.floorY) { const fy = o.floorY(u), hgt = Math.max(0, fy - y); floorLight(p, x, fy, 40, 7, GLOW, 0.42 * fl * clamp(1 - hgt / 220)); }
        const RR = R0 * 2;
        for (let yy = Math.floor(y - RR); yy <= y + RR; yy++) for (let xx = Math.floor(x - RR); xx <= x + RR; xx++) {
          const sx = xx - p.ox, sy = yy - p.oy;
          if (sx < 0 || sy < 0 || sx >= p.w || sy >= p.h || Math.hypot(xx - x, yy - y) > RR) continue;
          const q = sy * p.w + sx, L = p.L[q];
          if ((p.C[q] >>> 24) < 200 || !L) continue;
          p.L[q] = (L & 0xff000000) | (Math.round(((L >>> 16) & 255) * 0.4) << 16) | (Math.round(((L >>> 8) & 255) * 0.4) << 8) | Math.round((L & 255) * 0.4);
        }
      }
    },
  };
}

// ── Flame puffs as one merged body ──────────────────────────────────────────

let _heat = new Float32Array(4096);

/** Each puff adds heat falling off over its radius, hotter while young; overlaps combine 1 - prod(1 - h). */
export function puffField(p, parts, t) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
  for (const q of parts) {
    if (q.smoke || q.kind !== "puff") continue;
    const r = q.s * 1.8;
    x0 = Math.min(x0, q.x - r); x1 = Math.max(x1, q.x + r); y0 = Math.min(y0, q.y - r * 3); y1 = Math.max(y1, q.y + r);
    any = true;
  }
  if (!any) return;
  // only the part of the field inside this frame is ever drawn
  x0 = Math.max(Math.floor(x0), p.ox - 1); y0 = Math.max(Math.floor(y0), p.oy - 1);
  x1 = Math.min(Math.ceil(x1), p.ox + p.w); y1 = Math.min(Math.ceil(y1), p.oy + p.h);
  if (x1 < x0 || y1 < y0) return;
  const W = x1 - x0 + 1, Hh = y1 - y0 + 1, n = W * Hh;
  if (_heat.length < n) _heat = new Float32Array(Math.ceil(n * 1.5));
  const heat = _heat;
  heat.fill(0, 0, n);
  for (const q of parts) {
    if (q.smoke || q.kind !== "puff") continue;
    const u = q.age / q.life, k = 1 - u, r = q.s * (0.85 + 0.75 * Math.min(1, u * 6)) * (1 - 0.4 * u), hot = 0.9 * Math.pow(k, 1.5) * (0.8 + 0.2 * q.f);
    const up = 1.3 + 1.6 * u, lean = noise(t * 3 + q.f * 50, 21) * 0.6;
    const ya = Math.max(Math.floor(q.y - r * up), y0), yb = Math.min(q.y + r, y1);
    const xa = Math.max(Math.floor(q.x - r - r * up * 0.6), x0), xb = Math.min(q.x + r + r * up * 0.6, x1);
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const above = y < q.y ? (q.y - y) / (r * up) : 0;
        const dx = (x + 0.5 - q.x - lean * above * r) / (r * (1 - 0.7 * above)), dy = (y + 0.5 - q.y) / (y < q.y ? r * up : r), d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        const v = Math.pow(1 - d, 0.8) * hot, i = (y - y0) * W + (x - x0);
        heat[i] = 1 - (1 - heat[i]) * (1 - v);
      }
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= Hh ? 0 : heat[j * W + i]);
  // the mock's noise ran on the field's own (i, j); world-anchored here so a clipped field reads the same
  for (let j = 0; j < Hh; j++)
    for (let i = 0; i < W; i++) {
      const v = heat[j * W + i];
      if (v < 0.07) continue;
      if (v < 0.2 && noise2((i + x0) * 0.8, (j + y0 + t * 40) * 0.6, 77) > 0.2) continue;
      const edge = at(i, j - 1) < 0.07 || at(i - 1, j) < 0.07 || at(i + 1, j) < 0.07 || at(i, j + 1) < 0.07;
      p.px(i + x0, j + y0, edge ? FH[6] : v > 0.82 ? FH[0] : v > 0.66 ? FH[1] : v > 0.48 ? FH[2] : v > 0.33 ? FH[3] : v > 0.2 ? FH[4] : FH[5]);
      if (v > 0.33) p.light(i + x0, j + y0, GLOW, 0.06);
    }
}

/** Bounds of puffs (merged field and smoke). */
export function puffBounds(b, parts) {
  for (const q of parts) growBox(b, q.x, q.y, (q.s ?? 2) * 5 + 3);
  return b;
}

// ── Boxes ───────────────────────────────────────────────────────────────────

export const newBox = () => ({ x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
export function growBox(b, x, y, r = 0) {
  if (x - r < b.x0) b.x0 = x - r; if (y - r < b.y0) b.y0 = y - r;
  if (x + r > b.x1) b.x1 = x + r; if (y + r > b.y1) b.y1 = y + r;
  return b;
}
export function silBox(b, S, dx = 0, dy = 0, mx = 0, up = 0, down = 0) {
  growBox(b, S.x + dx - mx, S.y + dy - up, 0);
  growBox(b, S.x + dx + S.w + mx, S.y + dy + S.h + down, 0);
  return b;
}
export const boxOk = (b) => (b && b.x0 <= b.x1 && b.y0 <= b.y1 ? b : null);
