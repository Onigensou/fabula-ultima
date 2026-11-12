// ============================================================================
// Polymorph — silhouette distance fields (pure, no Foundry; tested offline).
//
// A white-silhouette MORPH between any two sprites, with no per-pair setup:
// each silhouette becomes a SIGNED DISTANCE FIELD (negative inside, positive
// outside, in pixels); a frame of the morph is the zero line of the blended
// field (1 - t)·A + t·B. Shapes flow into each other instead of cross-fading.
// Exact Euclidean distance transform: Felzenszwalb & Huttenlocher (2012), 1-D
// lower envelope of parabolas applied to rows, then columns.
// ============================================================================

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared distance from every cell to the nearest cell where `feature[i]` is true. */
function edt2d(feature, w, h) {
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = feature[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1), v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  return g;
}

/**
 * Signed distance field of a mask (Uint8 / boolean per cell, true = inside).
 * Negative inside, positive outside, in cells. An empty mask is "far outside".
 */
export function signedField(mask, w, h) {
  const inside = new Uint8Array(w * h), outside = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) { const m = mask[i] ? 1 : 0; inside[i] = m; outside[i] = 1 - m; if (m) any = true; }
  const out = new Float32Array(w * h);
  if (!any) { out.fill(Math.hypot(w, h)); return out; }
  const toInside = edt2d(inside, w, h);    // for outside cells: distance to the shape
  const toOutside = edt2d(outside, w, h);  // for inside cells: distance to the edge
  for (let i = 0; i < w * h; i++) out[i] = inside[i] ? -(Math.sqrt(toOutside[i]) - 0.5) : Math.sqrt(toInside[i]) - 0.5;
  return out;
}

/** Alpha mask from RGBA pixels (alpha > cut). */
export function maskFromRGBA(data, w, h, cut = 110) {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = data[i * 4 + 3] > cut ? 1 : 0;
  return m;
}

/**
 * Paint one morph frame into `rgba` (white, soft 1-cell edge): the zero line of
 * (1 - t)·A + t·B. Returns the number of covered cells (for tests).
 */
export function paintBlend(A, B, t, rgba, soft = 0.9) {
  const n = A.length, s = 1 - t;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const dd = s * A[i] + t * B[i];
    let a = 0.5 - dd / (2 * soft);
    a = a <= 0 ? 0 : a >= 1 ? 1 : a;
    const j = i * 4;
    rgba[j] = 255; rgba[j + 1] = 255; rgba[j + 2] = 255; rgba[j + 3] = Math.round(a * 255);
    if (a > 0.5) covered++;
  }
  return covered;
}
