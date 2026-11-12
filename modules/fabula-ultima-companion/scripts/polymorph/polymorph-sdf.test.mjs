// node polymorph-sdf.test.mjs — silhouette distance fields + morph blend.
import assert from "node:assert/strict";
import { signedField, paintBlend, maskFromRGBA } from "./polymorph-sdf.js";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("ok", name); };

const W = 40, H = 40;
const rect = (x0, y0, x1, y1) => { const m = new Uint8Array(W * H); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1; return m; };
const count = (m) => m.reduce((a, b) => a + b, 0);

t("field sign: negative inside, positive outside", () => {
  const f = signedField(rect(10, 10, 30, 30), W, H);
  assert.ok(f[20 * W + 20] < 0);
  assert.ok(f[0] > 0);
  assert.ok(Math.abs(f[20 * W + 9] - 0.5) < 1e-6);   // one cell outside the left edge
});

t("field distance is Euclidean", () => {
  const m = new Uint8Array(W * H); m[0] = 1;
  const f = signedField(m, W, H);
  assert.ok(Math.abs(f[3 * W + 4] - (5 - 0.5)) < 1e-6);
});

t("t=0 paints A, t=1 paints B exactly", () => {
  const A = rect(5, 5, 15, 35), B = rect(10, 20, 38, 35);
  const fa = signedField(A, W, H), fb = signedField(B, W, H);
  const px = new Uint8ClampedArray(W * H * 4);
  assert.equal(paintBlend(fa, fb, 0, px), count(A));
  assert.equal(paintBlend(fa, fb, 1, px), count(B));
});

t("mid-morph is a blend, not empty and not the union", () => {
  const A = rect(5, 5, 15, 35), B = rect(10, 20, 38, 35);
  const fa = signedField(A, W, H), fb = signedField(B, W, H);
  const px = new Uint8ClampedArray(W * H * 4);
  const mid = paintBlend(fa, fb, 0.5, px);
  assert.ok(mid > 0);
  assert.ok(mid < count(A) + count(B));
});

t("empty mask is far outside (morph from nothing grows B)", () => {
  const f = signedField(new Uint8Array(W * H), W, H);
  assert.ok(f.every((v) => v > 10));
});

t("maskFromRGBA thresholds alpha", () => {
  const px = new Uint8ClampedArray(4 * 3); px[3] = 0; px[7] = 200; px[11] = 100;
  assert.deepEqual([...maskFromRGBA(px, 3, 1)], [0, 1, 0]);
});

console.log(`polymorph-sdf: ${pass}/${pass} passed`);
