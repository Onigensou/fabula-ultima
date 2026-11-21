// ============================================================================
// Smoke cloud: the merged-billow smoke renderer for a whole-frame smoke
// (pixel-vfx-materials smoke.md §4a, lab/smoke-lab.js cloud()), the "fast" form
// the Nidhogg fall mockup drew with (tools/nidhogg-fall-mockup/fx/smoke-cloud.js
// cloudFast). Updated 2026-11-15 to the return mockup v17 cloudFast
// (tools/nidhogg-return-mockup/fx/smoke-cloud.js): three pixel-exact speedups (per-row chord bounds, density-only
// stamping of b 0 / w 0 lobes, the no-tone R[0] shortcut) and blendPx inlined; the fall renders identically.
// Pure: no DOM, no Foundry (Worker-safe).
// ============================================================================

import { mix, clamp } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

// cloudFast(): the same render as cloud() with wobble / erode / warp left out (this mockup uses none of them), for a
// whole-screen smoke frame: the box is clamped to the frame, the buffers are kept between frames instead of allocated
// (6 arrays of a full frame each frame was GC churn), and the last pass writes pixels directly (no per-pixel callback).
// Same numbers: dens / max / lit / steps, tone from L/D, warm light from F/D, lit from the blurred density's slope.
// Smoke perf pass (2026-11-16), each one pixel-identical (smoke-cloud.test.mjs + the replays' frame hashes):
//   - blendPixel: an EMPTY destination (alpha 0) takes the colour at alpha a as it is (the general formula's k = 1)
//   - steps mode: the step of 1 - exp(-d dens) read off precomputed density thresholds (stepCuts), no exp a pixel
//   - a BAND: o.frameH = the whole frame's height while p's frame holds only some of its rows (p.oy, p.h): the box is
//     still the whole frame's, and only the band's rows are painted, so each band's pixels are the whole frame's
//     (fall-painter.js bands). 2026-11-16 (fall 60 fps pass): a band works out only the rows it reads, from 3 above
//     its first row (the tone reads the blur one row up, the blur reaches 2 more) instead of from the box's top: a
//     pixel's density is its own lobes' sum in lobe order whatever rows are worked out, and the column blur's running
//     sum is started at the band's first blurred row from its 5 rows, the same window. The running sum's rounding
//     COULD differ from one started at the top, but the sums are of float32 values in doubles (exact while their
//     exponents are close) stored back as float32: measured 0 pixels differing over both real falls in every split
//     and the random smokes of smoke-cloud.test.mjs, which checks it. The lower band no longer redoes the upper's work.
//   - p.markC (box-frame.js BoxPainter): the box written, so the frame is cleared / premultiplied only there
let FB = null;
const newFB = (n) => ({ n, D: new Float32Array(n), L: new Float32Array(n), F: new Float32Array(n), T: new Float32Array(n), B: new Float32Array(n) });
/** Size the cloud's buffers for n pixels now (a Worker's warm-up), so a growing smoke does not re-allocate them. */
export function reserveCloud(n) { if (!FB || FB.n < n) FB = newFB(n); }

/**
 * The density step thresholds of steps mode: cut[k] = the smallest float32 density d with ceil((1 - exp(-d dens)) * 6)
 * >= k (k 1..6), by bisection over float32 bit patterns. The densities ARE float32 (FB.D is a Float32Array), so a
 * pixel's step is the number of cuts at or under its density: the integer the exp gave, for every float32 d, as long
 * as that step only grows with d (checked over EVERY float32 density up to 2 / dens for the two dens in use,
 * smoke-cloud.test.mjs; past 2 / dens it is 6 whatever exp's last bit, since exp(-2) < 1/6 by far).
 */
const CUTS = new Map();
const F32 = new Float32Array(1), I32 = new Int32Array(F32.buffer);
/** The step the exp gives (the original arithmetic). */
export const stepOf = (d, dens) => Math.ceil((1 - Math.exp(-d * dens)) * 6);
export function stepCuts(dens) {
  let c = CUTS.get(dens);
  if (c) return c;
  const bitsOf = (v) => { F32[0] = v; return I32[0]; }, valOf = (b) => { I32[0] = b; return F32[0]; };
  let top = 1;
  while (stepOf(top, dens) < 6 && top < 1e30) top *= 2;
  c = new Float64Array(7);
  for (let k = 1; k <= 6; k++) {
    if (stepOf(0, dens) >= k) { c[k] = 0; continue; }
    let lo = 0, hi = bitsOf(top);   // stepOf(valOf(lo)) < k <= stepOf(valOf(hi))
    while (hi - lo > 1) { const m = lo + ((hi - lo) >> 1); if (stepOf(valOf(m), dens) >= k) hi = m; else lo = m; }
    c[k] = valOf(hi);
  }
  CUTS.set(dens, c);
  return c;
}
/** The step (0..6) of a float32 density d by the cuts (= stepOf(d, dens) for every float32 d the test covers). */
export const stepAt = (d, c) => (d >= c[4] ? (d >= c[6] ? 6 : d >= c[5] ? 5 : 4) : d >= c[2] ? (d >= c[3] ? 3 : 2) : d >= c[1] ? 1 : 0);

/**
 * Blend colour c over the pixel d at alpha a (0.004 < a <= 1): p.blendPx's arithmetic. An empty destination (alpha
 * byte 0) gives oa = a, k = a / a = 1, k1 = 0, so every channel is c's own and the alpha byte (a * 255) & 255: the
 * same bits without the divide. So does a = 1 over anything (oa = 1 + da * 0 = 1, k = 1): the fall's engulfed smoke, where
 * the steps reach 6/6 (smoke-cloud.test.mjs checks both against the general formula).
 */
export function blendPixel(d, c, a) {
  if (a === 1 || (d >>> 24) === 0) return (((a * 255) & 255) << 24) | (c & 0xffffff);
  const da = (d >>> 24) / 255, oa = a + da * (1 - a), k = a / oa, k1 = 1 - k;
  return (((oa * 255) & 255) << 24) | (((((c >>> 16) & 255) * k + ((d >>> 16) & 255) * k1) & 255) << 16)
    | (((((c >>> 8) & 255) * k + ((d >>> 8) & 255) * k1) & 255) << 8) | ((((c & 255) * k + (d & 255) * k1) & 255));
}

// the tone's slope factor (0.3 + 0.7 up) at up = 0 and up = 1, as the tone works it out
const UP0 = 0.3 + 0.7 * 0, UP1 = 0.3 + 0.7 * 1;
export function cloudFast(p, list, R, WR, { dens = 1.4, max = 0.86, lit = 1.4, steps = true, frameH = null } = {}) {
  if (!list.length) return;
  const FW = p.w, FH = frameH ?? p.h;
  let X0 = FW, Y0 = FH, X1 = -1, Y1 = -1;
  for (const q of list) { X0 = Math.min(X0, Math.floor(q.x - q.r)); X1 = Math.max(X1, Math.ceil(q.x + q.r)); Y0 = Math.min(Y0, Math.floor(q.y - q.r)); Y1 = Math.max(Y1, Math.ceil(q.y + q.r)); }
  X0 = Math.max(0, X0 - 3); Y0 = Math.max(0, Y0 - 3); X1 = Math.min(FW - 1, X1 + 3); Y1 = Math.min(FH - 1, Y1 + 3);
  if (X1 < X0 || Y1 < Y0) return;
  const W = X1 - X0 + 1, H = Y1 - Y0 + 1, N = W * H;
  // the rows painted (box rows: the whole frame's 1..H-2, cut to the band) and the rows worked out for them: the tone
  // reads the blurred density one row either side, the column blur's running sums run from the box's top down
  const RY0 = frameH == null ? 0 : p.oy, RY1 = frameH == null ? FH - 1 : p.oy + p.h - 1;
  const cyA = Math.max(1, RY0 - Y0), cyB = Math.min(H - 2, RY1 - Y0);
  if (cyB < cyA) return;
  const HS = Math.min(H, cyB + 4), NS = HS * W, yEndV = Math.min(H - 1, cyB + 1), YS1 = Y0 + HS - 1;
  // a band: only its rows and the 3 above (box rows RS..; the column blur from CY0, the row above the band's first)
  const RS = frameH == null ? 0 : Math.max(0, cyA - 3), CY0 = frameH == null ? 0 : Math.max(0, cyA - 1), YS0 = Y0 + RS;
  // (grown straight to the whole frame: a smoke growing frame by frame re-allocated these 5 arrays each time, GC spikes
  // in a fresh Worker; each frame zeroes what it uses, so the size changes no pixel)
  if (!FB || FB.n < N) FB = newFB(Math.max(N, FW * FH));
  const { D, L, F, T, B } = FB;
  D.fill(0, RS * W, NS); L.fill(0, RS * W, NS); F.fill(0, RS * W, NS);
  for (const q of list) {
    const r = q.r, r2 = r * r, ya = Math.max(YS0, Math.floor(q.y - r)), yb = Math.min(YS1, Math.ceil(q.y + r)), xa = Math.max(X0, Math.floor(q.x - r)), xb = Math.min(X1, Math.ceil(q.x + r));
    // a lobe with no tone and no warm light (b 0, w 0: smoke not yet thrown) adds only density; L and F would get + 0
    const dOnly = q.b === 0 && q.w === 0;
    for (let y = ya; y <= yb; y++) {
      const dy = y + 0.5 - q.y, dy2 = dy * dy, warmK = q.w * (0.5 + 0.5 * clamp(0.5 + dy / r)), row = (y - Y0) * W - X0;
      if (dy2 >= r2) continue;
      // only the row's chord (+1 px each side, so the exact test below still decides every edge pixel)
      const hw = Math.sqrt(r2 - dy2) + 1, x0 = Math.max(xa, Math.floor(q.x - 0.5 - hw)), x1 = Math.min(xb, Math.ceil(q.x - 0.5 + hw));
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - q.x, d2 = (dx * dx + dy2) / r2;
        if (d2 >= 1) continue;
        const k = Math.sqrt(1 - d2) * q.a, i = row + x;
        D[i] += k;
        if (!dOnly) { L[i] += k * q.b; F[i] += k * warmK; }
      }
    }
  }
  // box blur r 2, both ways (as cloud(): blur(blur(E, 1, 2), W, 2))
  const k5 = 1 / 5;
  for (let y = RS; y < HS; y++) { const b = y * W; let acc = 0; for (let j = -2; j <= 2; j++) if (j >= 0 && j < W) acc += D[b + j]; for (let x = 0; x < W; x++) { T[b + x] = acc * k5; const a = x - 2, c = x + 3; if (a >= 0) acc -= D[b + a]; if (c < W) acc += D[b + c]; } }
  for (let x = 0; x < W; x++) { let acc = 0; for (let j = CY0 - 2; j <= CY0 + 2; j++) if (j >= 0 && j < H) acc += T[j * W + x]; for (let y = CY0; y <= yEndV; y++) { B[y * W + x] = acc * k5; const a = y - 2, c = y + 3; if (a >= 0) acc -= T[a * W + x]; if (c < H) acc += T[c * W + x]; } }
  const n = R.length;
  // p.blendPx(), inlined (the same arithmetic, without a closure a pixel)
  const PC = p.C, PW = p.w, PH = p.h, POX = p.ox, POY = p.oy, PFADE = p.fade;
  p.markC?.(X0 + 1, Y0 + cyA, X1 - 1, Y0 + cyB);
  const put = (sx, sy, c, a) => {
    a *= PFADE;
    if (!c || a <= 0.004) return;
    const x = sx - POX, y = sy - POY;
    if (x < 0 || y < 0 || x >= PW || y >= PH) return;
    const i = y * PW + x;
    PC[i] = blendPixel(PC[i], c, a);
  };
  const cut = steps ? stepCuts(dens) : null, AV = [0, 1, 2, 3, 4, 5, 6].map((s) => Math.min(max, s / 6)), MIX = new Array(n * 10);
  for (let cy = cyA; cy <= cyB; cy++) for (let cx = 1; cx < W - 1; cx++) {
    const i = cy * W + cx, d = D[i];
    if (d < 0.05) continue;
    let a;
    if (cut) {
      a = AV[stepAt(d, cut)];
      if (a < 0.15) continue;
    } else {
      a = Math.min(max, 1 - Math.exp(-d * dens));
      if (a < 0.04) continue;
    }
    // no tone and no warm light here (only smoke not yet thrown): the tone is 0.25 whatever the slope, so the darkest
    // colour, and the slope (an atan a pixel) need not be worked out
    if (L[i] === 0 && F[i] === 0) { put(X0 + cx, Y0 + cy, R[0], a); continue; }
    const w = F[i] / d, ld = L[i] / d;
    // the colour index only: tone grows with the slope term up (0..1, clamped), and every step of it (x, +, round,
    // clamp) keeps that order in floating point too, so where up = 0 and up = 1 give the same index that IS the index,
    // and the slope (an atan) need not be worked out (60 fps pass, 2026-11-17; the same pixels: the replays + the test)
    let j = clamp(Math.round(ld * UP0 * (n - 1) + 0.25 + w * 1.5), 0, n - 1);
    if (!lit || j !== clamp(Math.round(ld * UP1 * (n - 1) + 0.25 + w * 1.5), 0, n - 1)) {
      const gy = B[i + W] - B[i - W], gx = B[i + 1] - B[i - 1];
      const up = lit ? clamp(0.5 + Math.atan((gy * 0.9 + gx * 0.35) / (B[i] * 0.16 + 0.03)) * 0.42 * lit) : 0.5;
      j = clamp(Math.round(ld * (0.3 + 0.7 * up) * (n - 1) + 0.25 + w * 1.5), 0, n - 1);
    }
    // the warm light's mix by its tenth (q 1..9): the same mix(), once per (index, tenth) a call
    if (w > 0.03) {
      const q = Math.min(9, Math.ceil(w * 10)), mi = j * 10 + q;
      let m = MIX[mi];
      if (m === undefined) m = MIX[mi] = mix(R[j], WR[j], Math.min(0.9, q / 10));
      put(X0 + cx, Y0 + cy, m, a);
    } else put(X0 + cx, Y0 + cy, R[j], a);
  }
}
