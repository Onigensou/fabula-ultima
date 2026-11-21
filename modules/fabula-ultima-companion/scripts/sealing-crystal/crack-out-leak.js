// ============================================================================
// Nidhogg's battle opening, beat 1: the LEAK (pure: no DOM, no Foundry; Worker-safe, Node-testable).
// Ported 1:1 from the approved mockup v3 (tools/nidhogg-opening-mockup/fx/leak-smoke.js, 2026-11-19; the user took its
// defaults 2026-11-20: 5 first points, 3.6 s from the first leak to black, the dither edge as it is, purple smoke tops).
// The body below is the mockup's; the imports point at the game's copies of the pixelfx core and the cloud renderer
// (smoke-cloud.js cloudFast: the same pixels as the mockup's, faster), and draw() may paint a BAND of rows (2026-11-20:
// the leak is painted by two painters on two Workers; a whole-frame painter runs the mockup's loops). crack-out.test.mjs
// checks both against the mockup.
// It is painted in a Worker (crack-out-painter.js, crystal-worker.js "crackout"); the host is nidhogg-crack-out.js.
// ============================================================================
//
// Beat 1 of Nidhogg's battle opening: the screen cracks as usual, but instead of breaking, black smoke leaks out of
// the cracks until the screen is black (the user, 2026-11-19).
//
// The source (pixel-vfx-materials shared rule 6): the dark is BEHIND the glass, and the cracks are the only way out.
// So every particle leaves from a crack line. A few points along the main cracks open first; from each the leak runs
// along the crack lines (graph distance over the crack network, so it follows the cracks rather than jumping between
// them), and every stretch of crack it reaches starts to breathe out smoke. The crack line itself goes black first
// (the dark seeping into it), the smoke billows out of it, thrown off the crack sideways, slowed by drag, swelling
// as it slows and rising a little (smoke.md §6); later puffs are bigger and thicker, so it thickens as it spreads.
// Behind the billows a black veil fills in from the cracks, so the screen ends truly black. As the field's light is
// shut out the smoke loses its lit crowns too (it is lit by the field around it, smoke.md §1): the last of it is
// black on black.
//
// Register: merged billow (smoke.md §2), drawn with the return mockup's cloud renderer (fx/smoke-cloud.js cloudFast,
// unchanged) in its smoke ramp, so it is the same family as the smoke in his return. Everything is a function of
// the page time T, so the timeline can scrub it.
import { Rng, hex, clamp, noise2 } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { cloudFast as cloud } from "./smoke-cloud.js";

// black with his green in the darks, the crowns catching the field's cool purple light (the return mockup's ramp is
// green-lit by the Great Seal; this ground is the Underground Area's purple)
export const SMOKE = ["#000000", "#030404", "#070909", "#0d1010", "#141719", "#1d1f25", "#282a33", "#34343f"].map(hex);
const BLACK = SMOKE[0] || hex("#000000");
const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };

/**
 * makeLeak({ geo, W, H, PX, seeds, start, black, seed })
 *   geo   the crack geometry from shatter-crack.js buildGeometry() (screen px)
 *   W, H  the effect buffer (effect px); PX screen px per effect px
 *   seeds how many points open first; start = the first one opens (page s); black = the screen is black by (page s)
 * -> { draw(pVeil, pSmoke, T), seedsAt: [{x, y, t}], arriveMax, P }
 */
export function makeLeak({ geo, W, H, PX, seeds = 5, start, black, seed = 11 }) {
  const P = {
    gap: 4,            // effect px between emitters along a crack
    stagger: 0.22,     // s between the first points opening
    spread: 0,         // effect px / s the leak runs along the cracks (set below so it reaches everywhere in time)
    burst: 7,          // puffs per emitter
    every: [0.22, 0.42],
    veilFrom: 0.45,    // the black veil starts behind the smoke at this share of the way to black (the smoke carries the first half)
    veilFade: 0.25,    // s for a veil pixel to go from clear to black
  };
  const R = new Rng(seed);
  // ---- the crack network as nodes every P.gap effect px (main cracks and rings; rays and hairlines are too fine to leak)
  const nodes = [], edges = [];
  const link = (a, b, d) => { edges[a].push([b, d]); edges[b].push([a, d]); };
  for (const s of geo.strokes) {
    if (s.kind !== "main" && s.kind !== "ring") continue;
    let prev = -1, carry = 0;
    for (let i = 0; i + 1 < s.pts.length; i++) {
      const a = s.pts[i], b = s.pts[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y) / PX;
      const nx = -(b.y - a.y) / (L * PX || 1), ny = (b.x - a.x) / (L * PX || 1);
      for (let d = i === 0 ? 0 : carry; d <= L; d += P.gap) {
        const k = L ? d / L : 0, x = (a.x + (b.x - a.x) * k) / PX, y = (a.y + (b.y - a.y) * k) / PX;
        const w = (s.width[i] + (s.width[i + 1] - s.width[i]) * k) / PX;
        nodes.push({ x, y, nx, ny, w, main: s.kind === "main" }); edges.push([]);
        const id = nodes.length - 1;
        if (prev >= 0) link(prev, id, Math.hypot(x - nodes[prev].x, y - nodes[prev].y));
        prev = id;
        carry = d + P.gap - L;
      }
    }
  }
  // junctions: nodes of different strokes that touch (cracks meet in T-joints and at the crushed ring)
  {
    const cell = 3, grid = new Map(), key = (x, y) => ((x / cell) | 0) + "," + ((y / cell) | 0);
    nodes.forEach((n, i) => { const k = key(n.x, n.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    nodes.forEach((n, i) => {
      for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) {
        for (const j of grid.get(key(n.x + gx * cell, n.y + gy * cell)) || []) {
          if (j <= i) continue;
          const d = Math.hypot(nodes[j].x - n.x, nodes[j].y - n.y);
          if (d < 3.2 && !edges[i].some(([b]) => b === j)) link(i, j, d);
        }
      }
    });
  }
  // ---- the first points: on main cracks, away from the impact and off the screen's edge, spread out (farthest-point)
  const I = { x: geo.I.x / PX, y: geo.I.y / PX }, U = geo.U / PX;
  const cand = nodes.map((n, i) => i).filter((i) => {
    const n = nodes[i], d = Math.hypot(n.x - I.x, n.y - I.y);
    return n.main && d > 0.2 * U && d < 0.85 * U && n.x > 30 && n.y > 24 && n.x < W - 30 && n.y < H - 24;
  });
  const picked = [cand[Math.floor(cand.length * 0.37)]];
  while (picked.length < Math.min(seeds, cand.length)) {
    let best = -1, bd = -1;
    for (const i of cand) {
      let dm = Infinity;
      for (const j of picked) dm = Math.min(dm, Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y));
      dm *= 0.8 + 0.4 * noise2(nodes[i].x * 0.05, nodes[i].y * 0.05, 3);   // not a perfect lattice
      if (dm > bd) { bd = dm; best = i; }
    }
    picked.push(best);
  }
  // ---- Dijkstra over the network from every first point at once (its graph distance), a tiny binary heap
  const dist = new Float64Array(nodes.length).fill(Infinity), heap = [];
  const push = (i, d) => { heap.push([d, i]); let c = heap.length - 1; while (c) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  // a point opening later counts as extra distance, so each node takes the earliest arrival over all points
  picked.forEach((i, k) => { const d0 = k * P.stagger * 100; if (d0 < dist[i]) { dist[i] = d0; push(i, d0); } });
  while (heap.length) {
    const [d, i] = pop(); if (d > dist[i]) continue;
    for (const [j, w] of edges[i]) { const nd = d + w; if (nd < dist[j]) { dist[j] = nd; push(j, nd); } }
  }
  // islands the network never reached (a ring not touching anything): they leak from the nearest reached node
  let dmax = 0;
  for (let i = 0; i < nodes.length; i++) if (isFinite(dist[i])) dmax = Math.max(dmax, dist[i]);
  for (let i = 0; i < nodes.length; i++) if (!isFinite(dist[i])) dist[i] = dmax;
  // the leak reaches the last crack at 60 % of the way to black, then the smoke and the veil finish the job
  const span = black - start, reachBy = 0.6 * span;
  // dist was in "px" with each later point's stagger as 100 px per s: convert so the farthest node arrives at reachBy.
  // The run gathers speed as it goes (arrival ~ distance^0.6: slow near the first points, quick far out), so each first
  // point leaks on its own for a moment, then it spreads.
  const arrive = new Float32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const k = dist[i] / dmax;
    arrive[i] = start + reachBy * Math.pow(k, 0.6) + 0.12 * (noise2(nodes[i].x * 0.08, nodes[i].y * 0.08, 9) - 0.5);
  }
  picked.forEach((i, k) => { arrive[i] = start + k * P.stagger; });
  // ---- the puffs: born at their node over the few tenths after the leak reaches it, thrown off the crack sideways
  const puffs = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    // how hard this spot leaks: a few spots along each crack gush, the stretches between only seep (so the smoke comes
    // out of POINTS along the cracks, not as an even rope); the first points gush hardest
    const gush = picked.includes(i) ? 2.4 : 0.25 + 1.25 * Math.pow(clamp(noise2(n.x * 0.06, n.y * 0.06, 31) * 1.15), 2.2);
    let tb = arrive[i] + R.range(0, 0.08);
    const count = Math.max(2, Math.round(P.burst * (0.45 + 0.55 * gush)));
    for (let k = 0; k < count; k++) {
      const g = clamp((tb - start) / span);                    // how far into the leak: later puffs are bigger and thicker
      const side = R.next() < 0.5 ? -1 : 1;
      puffs.push({
        n, tb, side,
        v0: R.range(4, 22) * (0.6 + 1.6 * g) * (0.6 + 0.5 * gush) * (n.main ? 1 : 0.7),
        along: R.range(-4, 4),
        r0: R.range(1.5, 2.5), r1: (R.range(5, 9) + g * R.range(14, 26)) * (0.55 + 0.45 * gush) * (n.main ? 1 : 0.75),
        grow: R.range(0.5, 1.0), rise: R.range(2, 5) * (0.6 + g),
        a: R.range(0.7, 1.0), b: R.range(0.3, 0.7), ph: R.range(0, 6.28),
      });
      tb += R.range(P.every[0], P.every[1]) * (1 - 0.35 * g) / (0.6 + 0.4 * gush);
    }
  }
  // ---- the veil: per effect pixel, when the black arrives (the nearest leaking crack's arrival + lag + its distance),
  // remapped so the farthest pixel is black by `black`. Crack pixels themselves go black almost at once (the seep).
  const tv = new Float32Array(W * H).fill(Infinity), seep = new Float32Array(W * H).fill(Infinity);
  const VV = 34;   // effect px / s the veil grows out from a crack (before the remap)
  {
    // a chamfer-style two-pass sweep would be faster; brute force over a coarse grid of nodes is fine at load
    const near = nodes.map((n, i) => i);
    for (const i of near) {
      const n = nodes[i], t0 = arrive[i], R2 = 4;
      for (let y = Math.max(0, Math.floor(n.y - R2)); y <= Math.min(H - 1, Math.ceil(n.y + R2)); y++)
        for (let x = Math.max(0, Math.floor(n.x - R2)); x <= Math.min(W - 1, Math.ceil(n.x + R2)); x++) {
          const d = Math.hypot(x + 0.5 - n.x, y + 0.5 - n.y);
          // the crack line goes black at once, then the black widens round it (to ~2.4 effect px over ~0.8 s)
          if (d <= 2.4) { const j = y * W + x; seep[j] = Math.min(seep[j], t0 + 0.05 + Math.max(0, d - Math.max(0.7, n.w * 0.8)) * 0.45); }
        }
    }
    // distance sweep: tv(p) = min over nodes (arrive + lag + d / VV), by a two-pass 8-neighbour propagation (approx.)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], x = Math.min(W - 1, Math.max(0, Math.round(n.x - 0.5))), y = Math.min(H - 1, Math.max(0, Math.round(n.y - 0.5)));
      tv[y * W + x] = Math.min(tv[y * W + x], arrive[i]);
    }
    const D1 = 1 / VV, D2 = Math.SQRT2 / VV;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const j = y * W + x; let v = tv[j];
        if (x > 0) v = Math.min(v, tv[j - 1] + D1);
        if (y > 0) { v = Math.min(v, tv[j - W] + D1); if (x > 0) v = Math.min(v, tv[j - W - 1] + D2); if (x < W - 1) v = Math.min(v, tv[j - W + 1] + D2); }
        tv[j] = v;
      }
      for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const j = y * W + x; let v = tv[j];
        if (x < W - 1) v = Math.min(v, tv[j + 1] + D1);
        if (y < H - 1) { v = Math.min(v, tv[j + W] + D1); if (x < W - 1) v = Math.min(v, tv[j + W + 1] + D2); if (x > 0) v = Math.min(v, tv[j + W - 1] + D2); }
        tv[j] = v;
      }
    }
    let vmax = 0, vmin = Infinity;
    for (let j = 0; j < W * H; j++) { vmax = Math.max(vmax, tv[j]); vmin = Math.min(vmin, tv[j]); }
    const lo = start + P.veilFrom * span, hi = black - P.veilFade;
    // remap by RANK onto [lo, hi], so the black covers the screen at an even pace: the crack lines' surroundings
    // first, the far patches last (a plain remap blacked out most of it at once: most pixels lie near some crack)
    const ord = new Float32Array(W * H);
    for (let j = 0; j < W * H; j++) ord[j] = tv[j] + 0.25 * (noise2((j % W) * 0.045, ((j / W) | 0) * 0.045, 21) - 0.5);
    const sorted = Float32Array.from(ord).sort(), rankOf = (v) => { let a = 0, b = sorted.length; while (a < b) { const m = (a + b) >> 1; if (sorted[m] < v) a = m + 1; else b = m; } return a / sorted.length; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const j = y * W + x, k = rankOf(ord[j]);
      const rag = 0.04 * (noise2(x * 0.16, y * 0.16, 22) - 0.5);
      tv[j] = Math.min(hi, lo + (hi - lo) * clamp(k + rag));
    }
  }
  const veilA = (j, T) => clamp((T - tv[j]) / P.veilFade);
  // how much of the field's light is left on screen (the smoke's crowns lose it as the veil closes)
  let coverT = -1, cover = 0;
  const coverAt = (T) => {
    if (T === coverT) return cover;
    let s = 0, n = 0;
    for (let j = 0; j < W * H; j += 37) { s += veilA(j, T); n++; }
    coverT = T; cover = s / n; return cover;
  };

  function draw(pVeil, pSmoke, T) {
    if (T < start - 0.01) return;
    // the veil + the seep, dithered in four steps (as the return mockup's veil)
    // (game port, 2026-11-20: a painter may hold only a BAND of the frame's rows, pVeil.oy .. oy + h, full width; the
    // veil then visits only those rows, and the smoke is painted in them by cloudFast's band mode (frameH). A painter of
    // the whole frame (oy 0, h H) runs exactly the mockup's loops; crack-out.test.mjs checks bands joined = whole.)
    const C = pVeil.C, OY = pVeil.oy | 0, ry0 = Math.max(0, OY), ry1 = Math.min(H, OY + pVeil.h), off = OY * W;
    for (let y = ry0; y < ry1; y++) for (let x = 0; x < W; x++) {
      const j = y * W + x;
      let a = veilA(j, T);
      if (T > seep[j]) a = Math.max(a, clamp((T - seep[j]) / 0.18));
      if (a <= 0) continue;
      const q = Math.round(a * 4) / 4;
      if (q >= 1 || (q > 0 && q > BAY[((y & 3) << 2) | (x & 3)])) C[j - off] = BLACK;
    }
    // the smoke
    const lightLeft = 1 - smooth(0.35, 0.97, coverAt(T));
    const list = [];
    for (const q of puffs) {
      const age = T - q.tb; if (age <= 0) continue;
      const n = q.n, drag = 1.6, s = (q.v0 * (1 - Math.exp(-drag * age))) / drag;
      const wind = 4 * (noise2(T * 0.35, n.y * 0.02, 5) - 0.5) * age;   // one shared wind for every puff
      const x = n.x + n.nx * s * q.side + n.ny * q.along * (1 - Math.exp(-age)) + wind + 1.2 * Math.sin(q.ph + age * 1.7) * Math.min(1, age);
      const y = n.y + n.ny * s * q.side - n.nx * q.along * (1 - Math.exp(-age)) - q.rise * age;
      const r = q.r0 + (q.r1 - q.r0) * (1 - Math.exp(-age / q.grow));
      if (x + r < 0 || y + r < 0 || x - r >= W || y - r >= H) continue;
      // black on black: skip a puff whose every corner and centre is under a fully black veil once no light is left
      const xi = Math.min(W - 1, Math.max(0, x | 0)), yi = Math.min(H - 1, Math.max(0, y | 0));
      const vC = veilA(yi * W + xi, T);
      if (vC >= 1) {   // (over a full veil a puff's tone is at most SMOKE[1]: invisible on black)
        const x0 = Math.max(0, (x - r) | 0), x1 = Math.min(W - 1, (x + r) | 0), y0 = Math.max(0, (y - r) | 0), y1 = Math.min(H - 1, (y + r) | 0);
        if (veilA(y0 * W + x0, T) >= 1 && veilA(y0 * W + x1, T) >= 1 && veilA(y1 * W + x0, T) >= 1 && veilA(y1 * W + x1, T) >= 1) continue;
      }
      // its crown keeps the field's light while the field shows round it; young smoke a little lighter
      const b = q.b * (1 - 0.45 * clamp(age / 2.2)) * lightLeft * (1 - 0.8 * vC);
      list.push({ x, y, r, a: q.a * (age < 0.12 ? age / 0.12 : 1), b, w: 0 });
    }
    const banded = (pSmoke.oy | 0) !== 0 || pSmoke.h !== H;
    cloud(pSmoke, list, SMOKE, SMOKE, banded ? { dens: 2.6, max: 1, lit: 1.2, steps: true, frameH: H } : { dens: 2.6, max: 1, lit: 1.2, steps: true });
    return list.length;
  }
  return { draw, seedsAt: picked.map((i) => ({ x: nodes[i].x, y: nodes[i].y, t: arrive[i] })), nodes: nodes.length, puffs: puffs.length, P, veilA };
}
