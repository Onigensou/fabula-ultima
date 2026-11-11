// ============================================================================
// Smoke cloud: the merged-billow smoke renderer for a whole-frame smoke
// (pixel-vfx-materials smoke.md §4a, lab/smoke-lab.js cloud()), the "fast" form
// the Nidhogg fall mockup drew with (tools/nidhogg-fall-mockup/fx/smoke-cloud.js
// cloudFast, copied unchanged). Pure: no DOM, no Foundry (Worker-safe).
// ============================================================================

import { mix, clamp } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

// cloudFast(): the same render as cloud() with wobble / erode / warp left out (this mockup uses none of them), for a
// whole-screen smoke frame: the box is clamped to the frame, the buffers are kept between frames instead of allocated
// (6 arrays of a full frame each frame was GC churn), and the last pass writes pixels directly (no per-pixel callback).
// Same numbers: dens / max / lit / steps, tone from L/D, warm light from F/D, lit from the blurred density's slope.
let FB = null;
export function cloudFast(p, list, R, WR, { dens = 1.4, max = 0.86, lit = 1.4, steps = true } = {}) {
  if (!list.length) return;
  const FW = p.w, FH = p.h;
  let X0 = FW, Y0 = FH, X1 = -1, Y1 = -1;
  for (const q of list) { X0 = Math.min(X0, Math.floor(q.x - q.r)); X1 = Math.max(X1, Math.ceil(q.x + q.r)); Y0 = Math.min(Y0, Math.floor(q.y - q.r)); Y1 = Math.max(Y1, Math.ceil(q.y + q.r)); }
  X0 = Math.max(0, X0 - 3); Y0 = Math.max(0, Y0 - 3); X1 = Math.min(FW - 1, X1 + 3); Y1 = Math.min(FH - 1, Y1 + 3);
  if (X1 < X0 || Y1 < Y0) return;
  const W = X1 - X0 + 1, H = Y1 - Y0 + 1, N = W * H;
  if (!FB || FB.n < N) FB = { n: N, D: new Float32Array(N), L: new Float32Array(N), F: new Float32Array(N), T: new Float32Array(N), B: new Float32Array(N) };
  const { D, L, F, T, B } = FB;
  D.fill(0, 0, N); L.fill(0, 0, N); F.fill(0, 0, N);
  for (const q of list) {
    const r = q.r, r2 = r * r, ya = Math.max(Y0, Math.floor(q.y - r)), yb = Math.min(Y1, Math.ceil(q.y + r)), xa = Math.max(X0, Math.floor(q.x - r)), xb = Math.min(X1, Math.ceil(q.x + r));
    for (let y = ya; y <= yb; y++) {
      const dy = y + 0.5 - q.y, dy2 = dy * dy, warmK = q.w * (0.5 + 0.5 * clamp(0.5 + dy / r)), row = (y - Y0) * W - X0;
      for (let x = xa; x <= xb; x++) {
        const dx = x + 0.5 - q.x, d2 = (dx * dx + dy2) / r2;
        if (d2 >= 1) continue;
        const k = Math.sqrt(1 - d2) * q.a, i = row + x;
        D[i] += k; L[i] += k * q.b; F[i] += k * warmK;
      }
    }
  }
  // box blur r 2, both ways (as cloud(): blur(blur(E, 1, 2), W, 2))
  const k5 = 1 / 5;
  for (let y = 0; y < H; y++) { const b = y * W; let acc = 0; for (let j = -2; j <= 2; j++) if (j >= 0 && j < W) acc += D[b + j]; for (let x = 0; x < W; x++) { T[b + x] = acc * k5; const a = x - 2, c = x + 3; if (a >= 0) acc -= D[b + a]; if (c < W) acc += D[b + c]; } }
  for (let x = 0; x < W; x++) { let acc = 0; for (let j = -2; j <= 2; j++) if (j >= 0 && j < H) acc += T[j * W + x]; for (let y = 0; y < H; y++) { B[y * W + x] = acc * k5; const a = y - 2, c = y + 3; if (a >= 0) acc -= T[a * W + x]; if (c < H) acc += T[c * W + x]; } }
  const n = R.length;
  for (let cy = 1; cy < H - 1; cy++) for (let cx = 1; cx < W - 1; cx++) {
    const i = cy * W + cx, d = D[i];
    if (d < 0.05) continue;
    const a0 = 1 - Math.exp(-d * dens), a = Math.min(max, steps ? Math.ceil(a0 * 6) / 6 : a0);
    if (a < (steps ? 0.15 : 0.04)) continue;
    const gy = B[i + W] - B[i - W], gx = B[i + 1] - B[i - 1];
    const up = lit ? clamp(0.5 + Math.atan((gy * 0.9 + gx * 0.35) / (B[i] * 0.16 + 0.03)) * 0.42 * lit) : 0.5;
    const w = F[i] / d, tone = (L[i] / d) * (0.3 + 0.7 * up) * (n - 1) + 0.25 + w * 1.5;
    const j = clamp(Math.round(tone), 0, n - 1), c = R[j];
    p.blendPx(X0 + cx, Y0 + cy, w > 0.03 ? mix(c, WR[j], Math.min(0.9, Math.ceil(w * 10) / 10)) : c, a);
  }
}
