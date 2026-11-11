// The Sealing Crystal's death — the timeline the user laid out on 2026-11-10, and its particles.
//
//   1. The spin decelerates to a stop.
//   2. The crystal flashes 4 times: sudden white, easing back to its colour. Gaps 2 s, 1 s, 2 s.
//   3. 3 s later: the whole screen flashes and the cracks spread through the whole crystal.
//   4. Green flame pours out of a crack, one at a time, three times, from three cracks well apart. Each time the
//      force shoves the crystal the other way, with half a second of shake.
//   4b. The build-up (the user, 2026-11-10, mockup 11): the crystal shakes harder and harder, and a few more souls
//      tear out of other cracks, faster each time, so the explosion lands as the peak.
//   5. The screen turns white, from the crystal outward.
//   6. Just before it is fully white, the crystal shatters (it breaks along its facets) and the soul's green flame
//      explodes into particles that float up.
// After the white-out the white clears onto the arena, lit again (the intended ending, mockup 9).
//
// D = seconds since the death began. Everything here is a pure function of D (and fixed seeds), so any frame can be
// drawn on its own, as the rest of the crystal is.
import { clamp, Rng, TAU, WHITE, hex, flare } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { firePuff, ember } from "../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";

export const DEATH = {
  spin: 2.0,
  flashes: [2.0, 4.0, 5.0, 7.0],
  crack: 10.0,
  jets: [10.8, 12.0, 13.2],
  // the build-up: from `surge` the shake ramps up to the shatter, and the extra pours tear out, closer each time.
  // 3.5 s long (the user, 2026-11-10: the shaking and pouring 2 s longer before the shatter)
  surge: 13.5, pours: [14.1, 15.0, 15.7, 16.3],
  // the shatter comes early in the white-out so the player sees it (the user, 2026-11-10); the white then slowly
  // swallows the flying shards and the burst soul, and clears onto the arena, lit again (no victory screen)
  whiteFrom: 16.4, shatter: 17.0, whiteFull: 19.8, whiteHold: 20.4, whiteGone: 22.4,
  end: 28,
};
/**
 * The battle's ending (the user, 2026-11-11): when the crystal is the battle's last foe the white does NOT clear onto
 * the arena. Full white holds `holdWhite` s, then the screen fades to black over `toBlack` s and stays black: the GM's
 * battle-end prompt and the result screen run on black, and the scene change takes the black away.
 */
export const ENDING = { holdWhite: 5.0, toBlack: 1.5 };
/** Death time at which the ending's screen is fully black (the director's battle end may start). */
export const ENDING_BLACK_AT = DEATH.whiteFull + ENDING.holdWhite + ENDING.toBlack;
/** The ending's screen at death time D: the white held from full white on, and the black over it (0 → 1). */
export function endingScreen(D) {
  const held = D >= DEATH.whiteFull;
  const black = clamp((D - DEATH.whiteFull - ENDING.holdWhite) / ENDING.toBlack);
  return { white: held ? 1 : null, black: black * black * (3 - 2 * black) };
}
/** Every pour's start: the three big jets, then the build-up's extra pours. */
export const POURS = [...DEATH.jets, ...DEATH.pours];
const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3);
const smooth = (u) => { u = clamp(u); return u * u * (3 - 2 * u); };
/** 0 → 1 across the build-up, steepening (it is the run-up to the explosion). */
export const surgeAt = (D) => (D < DEATH.surge || D >= DEATH.shatter ? 0 : Math.pow((D - DEATH.surge) / (DEATH.shatter - DEATH.surge), 1.6));

/** The extra yaw the spin-down adds (the crystal stops after DEATH.spin seconds). */
export function deathSpin(D, turn) {
  const w0 = TAU / turn, u = clamp(D / DEATH.spin);
  return w0 * DEATH.spin * (u - (u * u) / 2);
}

/** Everything the page and the crystal need to know about the moment D. */
export function deathTimeline(D) {
  const T = DEATH;
  let crystalWhite = 0;
  for (const f0 of T.flashes) {
    const f = D - f0;
    if (f >= 0 && f < 0.75) crystalWhite = Math.max(crystalWhite, f < 0.05 ? 1 : 1 - easeOut((f - 0.05) / 0.7));
  }
  const fc = D - T.crack, screenFlash = fc >= 0 && fc < 0.5 ? (fc < 0.06 ? 1 : 1 - (fc - 0.06) / 0.44) : 0;
  let white = 0;
  if (D >= T.whiteFrom && D < T.whiteFull) white = Math.pow((D - T.whiteFrom) / (T.whiteFull - T.whiteFrom), 1.7);
  else if (D >= T.whiteFull && D < T.whiteHold) white = 1;
  else if (D >= T.whiteHold && D < T.whiteGone) white = 1 - smooth((D - T.whiteHold) / (T.whiteGone - T.whiteHold));
  const whiteR = clamp((D - T.whiteFrom) / (T.whiteFull - T.whiteFrom));
  let shake = 0;
  for (const j of T.jets) { const f = D - j; if (f >= 0 && f < 0.5) shake = Math.max(shake, 1 - f / 0.5); }
  // each extra pour kicks, smaller than a big jet
  for (const j of T.pours) { const f = D - j; if (f >= 0 && f < 0.3) shake = Math.max(shake, 0.6 * (1 - f / 0.3)); }
  // the build-up: a tremble that grows to the shatter's own jolt, so the explosion is its peak
  const surge = surgeAt(D);
  if (surge > 0) shake = Math.max(shake, 0.12 + 1.05 * surge);
  { const f = D - T.shatter; if (f >= 0 && f < 0.45) shake = Math.max(shake, 1.4 * (1 - f / 0.45)); }
  const jetsStarted = T.jets.filter((j) => D >= j).length;
  const label = D < T.spin ? "Spin stops" : D < T.flashes[3] + 0.75 ? "Flashing " + Math.max(1, T.flashes.filter((f) => D >= f).length) + " / 4"
    : D < T.crack ? "Silence" : D < T.jets[0] ? "Cracks spread" : D < T.surge ? "Soul pours out " + jetsStarted + " / 3"
    : D < T.shatter ? "Shaking apart" : D < T.whiteFull ? "Shatter" : D < T.whiteGone ? "White" : D < T.end ? "The seal is gone" : "Destroyed";
  // the inside of the crystal whitening through the build-up (0 → 0.9 at the shatter)
  const inner = D < T.surge || D >= T.shatter ? 0 : 0.9 * Math.pow((D - T.surge) / (T.shatter - T.surge), 1.3);
  return { crystalWhite, screenFlash, white, whiteR, shake, surge, inner, shattered: D >= T.shatter, label, done: D >= T.end };
}

/** How far the pours have shoved the crystal (screen px), and its jitter. dirs: each pour's 2D direction. */
export function pushOffset(D, dirs, A, frameSeed) {
  let ox = 0, oy = 0, jit = 0;
  POURS.forEach((j, i) => {
    const f = D - j, d = dirs[i], big = i < DEATH.jets.length, k = big ? 1 : 0.4;
    if (f < 0 || !d) return;
    const amt = f < 0.15 ? easeOut(f / 0.15) : 1 - 0.35 * smooth((f - 0.15) / 0.9);
    ox -= d[0] * A * amt * k; oy -= d[1] * A * amt * 0.6 * k;
    if (f < (big ? 0.5 : 0.3)) jit = Math.max(jit, (big ? 1 : 0.7) * (1 - f / (big ? 0.5 : 0.3)));
  });
  // the build-up: the crystal itself trembles harder and harder
  const sg = surgeAt(D);
  if (sg > 0) jit = Math.max(jit, 0.25 + 1.1 * sg);
  const r = new Rng(frameSeed);
  return { ox: ox + (jit ? r.range(-1, 1) * 2.5 * jit * (A / 9) : 0), oy: oy + (jit ? r.range(-1, 1) * 1.6 * jit * (A / 9) : 0) };
}

/**
 * One pour of soul flame out of a crack: a dense burst for the first 0.7 s, then a stream that keeps pouring until
 * the shatter. i < 3: the three big jets; after that the build-up's smaller, quicker pours.
 * It is a 3D stream: every puff flies in the crystal's own axes (out of the crack along its direction, fanned sideways
 * and a little in depth, slowed by drag, lifted straight UP by its heat) and is posed with view() each frame, so the
 * stream turns with the camera. pass "back" draws the puffs (and the mouth) behind the crystal's middle, "front" the
 * rest; the crystal is painted between the two.
 *   jet = { b: the crack's beam { p, d, n }, axis: the camera's look direction when it tore out, ref: how long the
 *           crack's direction looked on the screen then }, zc = the crystal's middle depth.
 */
const n3 = ([x, y, z]) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
const x3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function drawJet(p, D, i, jet, view, cx, cy, zc, SZ, FH, pass) {
  const j0 = POURS[i], f = D - j0;
  if (f < 0 || j0 == null) return;
  const big = i < DEATH.jets.length, k = big ? 1 : 0.65, back = pass === "back";
  const d = jet.b.d, m = jet.b.p;
  // the fan: across the stream as it was first seen (perpendicular to the crack and to the camera's look then), and
  // a thinner spread in depth, so it has a body when the camera comes round to its side
  let u1 = x3(d, jet.axis);
  if (Math.hypot(...u1) < 0.2) u1 = x3(d, [0, 1, 0]);
  u1 = n3(u1);
  const u2 = n3(x3(d, u1));
  // it was tuned to its look on the screen: its speed there stays as it was, whatever the camera does next
  const vs = 1 / Math.max(0.7, jet.ref);
  // it pours at full force from the first burst until the shatter (the user, 2026-11-10: no easing off)
  const span = DEATH.shatter - j0, R = new Rng(1000 + i * 7919), N = Math.round(240 * span * k);
  for (let q = 0; q < N; q++) {
    const tb = R.next() * span;
    const sp = R.range(190, 340) * SZ * (big ? 1 : 0.85) * vs, spread = R.range(-0.3, 0.3);
    const life = R.range(0.45, 1.0) * (big ? 1 : 0.8), size = R.range(3.5, 8.5) * SZ * (big ? 1 : 0.8), frac = R.next();
    const tau = f - tb;
    if (tau < 0 || tau > life || j0 + tb > DEATH.shatter) continue;
    const h = Math.sin((q + 1) * 12.9898 + i * 78.233) * 43758.5453, spread2 = ((h - Math.floor(h)) * 2 - 1) * 0.2;
    const kd = 3.2, e = ((1 - Math.exp(-kd * tau)) / kd) * sp, lift = 0.5 * 70 * SZ * tau * tau;
    const P = view([
      m[0] + (d[0] + u1[0] * spread + u2[0] * spread2) * e,
      m[1] + (d[1] + u1[1] * spread + u2[1] * spread2) * e - lift,
      m[2] + (d[2] + u1[2] * spread + u2[2] * spread2) * e,
    ]);
    if ((P[2] < zc) !== back) continue;
    firePuff(p, cx + P[0], cy + P[1], 1 - tau / life, size, frac, FH, 0.22);
  }
  // the mouth: white-hot where it tears out, a hot glow that stays while it pours; on the side the crack faces
  const M = view(m), facing = view(jet.b.n)[2] >= 0;
  if (facing === back) return;
  const mx = cx + M[0], my = cy + M[1];
  p.glow(mx, my, 22 * SZ * k, FH[1], 0.8);
  if (f < 0.12) p.glow(mx, my, 30 * SZ * k, WHITE, 0.9 * (1 - f / 0.12));
  p.px(mx, my, WHITE);
}

// ------------------------------------------------------------------------------------------------ the shatter
// The crystal breaks into real 3D pieces (the user, 2026-11-10, mockup 11, options 1–3):
//   1. Every piece is a thin slab of red glass (a convex mesh: the outer face, a slightly smaller inner face, the
//      break faces round its sides), tumbling about its own random axis and relit every frame by the crystal's one
//      light: pale when it faces the light, deep red turned away, pale edges, a white glint when it mirrors the light
//      at the eye. Built like the ice shape library (ice.md §4g: cull, stepped ramp, 1 px rim stamped from the hull,
//      edges, dashed back edges, glint).
//   2. Size and shape variety: each facet breaks into 2–5 pieces along straight cuts at random points (triangles,
//      quads, slivers, big and small), plus many small chips and a fine red glitter dust.
//   3. Glass with the soul's light dying in it: the break faces and their edges (the inside of the crystal, where the
//      soul was) glow soul green just after the burst and cool to plain red as the pieces drift up.
const R8 = (c) => c & 255, G8 = (c) => (c >>> 8) & 255, B8 = (c) => (c >>> 16) & 255;
const pack = (r, g, b, a = 255) => ((a & 255) << 24) | ((clamp(b, 0, 255) | 0) << 16) | ((clamp(g, 0, 255) | 0) << 8) | (clamp(r, 0, 255) | 0);
const lerpC = (a, b, t) => pack(R8(a) + (R8(b) - R8(a)) * t, G8(a) + (G8(b) - G8(a)) * t, B8(a) + (B8(b) - B8(a)) * t);
const nrm = ([x, y, z]) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mean = (P) => mul(P.reduce(add, [0, 0, 0]), 1 / P.length);
const area3 = (P) => { let s = [0, 0, 0]; for (let i = 1; i < P.length - 1; i++) s = add(s, cross(sub(P[i], P[0]), sub(P[i + 1], P[0]))); return Math.hypot(...s) / 2; };
const LIGHT = nrm([-0.6, -0.8, 0.6]), HALF = nrm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
const hash = (x, y) => ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000) / 1000;

function hull2(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], hi = [];
  for (const q of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = P.length - 1; i >= 0; i--) { const q = P[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
/** Fill a convex polygon by scanlines (pixel centres inside), one span a row: much cheaper than a bounding-box scan
 *  for the thin, turned slivers a shatter is made of. */
function fillConvex(W, H, pts, fn) {
  let y0 = Infinity, y1 = -Infinity;
  for (const q of pts) { if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
  const ya = Math.max(0, Math.ceil(y0 - 0.5)), yb = Math.min(H - 1, Math.floor(y1 - 0.5)), n = pts.length;
  for (let y = ya; y <= yb; y++) {
    const py = y + 0.5;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] <= py && b[1] > py) || (b[1] <= py && a[1] > py)) {
        const x = a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
        if (x < xl) xl = x;
        if (x > xr) xr = x;
      }
    }
    const xa = Math.max(0, Math.ceil(xl - 0.5)), xb = Math.min(W - 1, Math.floor(xr - 0.5));
    for (let x = xa; x <= xb; x++) fn(x, y);
  }
}
function seg(x0, y0, x1, y1, fn) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, n = 0;
  for (;;) { fn(x0, y0, n++); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
}

/** A thin convex slab cut from the crystal's surface polygon `poly` (object space), its outer face on the surface. */
function slab(R, poly, n, centre, kind) {
  const m = poly.length, c = mean(poly), size = Math.sqrt(area3(poly)), chip = kind === "chip";
  const th = chip ? R.range(0.8, 1.5) : clamp(size * R.range(0.12, 0.2), 1.6, 5), taper = chip ? 0.85 : R.range(0.72, 0.9);
  const v = [...poly.map((q) => sub(q, c)), ...poly.map((q) => add(mul(sub(q, c), taper), mul(n, -th)))];
  const f = [{ i: [...Array(m).keys()], k: 0 }, { i: [...Array(m).keys()].map((s) => m + s), k: 1 }];
  for (let s = 0; s < m; s++) { const s1 = (s + 1) % m; f.push({ i: [s, s1, m + s1, m + s], k: 2 }); }
  // outward from the crystal's centre, bent a little; small pieces fly faster and further
  const out = nrm(sub(c, centre)), d = nrm(add(out, [R.range(-0.45, 0.45), R.range(-0.45, 0.45), R.range(-0.45, 0.45)]));
  const sp = chip ? R.range(130, 300) : R.range(60, 200) * clamp(16 / size, 0.75, 1.7);
  const sgn = R.next() < 0.5 ? -1 : 1;
  return {
    c, v, f, d, sp, size, chip, kd: chip ? 2.8 : 2.2,
    axis: nrm([R.range(-1, 1), R.range(-1, 1), R.range(-1, 1)]),
    w0: sgn * R.range(3, 8) * (chip ? 1.6 : 1) * clamp(14 / size, 0.6, 1.5),  // the burst's spin, slowed by drag
    w1: sgn * R.range(0.5, 1.4) * (chip ? 1.8 : 1),                          // the slow tumble as it drifts up
    life: chip ? R.range(1.8, 3.6) : R.range(3.2, 5),
    g: chip ? R.range(0.9, 1.4) : R.range(0.6, 1.1),
    ph: R.range(0, 6.3), glowT: R.range(0.8, 1.5),
  };
}

/** The crystal broken up, once per mesh: facet pieces, chips, glitter (object space). */
const FRACTURES = new WeakMap();
function fracture(mesh) {
  let FR = FRACTURES.get(mesh);
  if (FR) return FR;
  const R = new Rng(9001), V = mesh.v, centre = mean(V);
  const tris = mesh.f.map((idx) => idx.map((i) => V[i]));
  const areas = tris.map(area3), maxA = Math.max(...areas);
  const normal = (tri) => { let n = nrm(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))); if (dot(n, sub(mean(tri), centre)) < 0) n = mul(n, -1); return n; };
  const slabs = [];
  tris.forEach((tri, fi) => {
    const n = normal(tri), k = clamp(Math.round(1.3 + 3.2 * (areas[fi] / maxA) + R.range(-0.8, 0.8)), 2, 5);
    const polys = [tri];
    while (polys.length < k) {
      // the biggest piece breaks next, along a straight cut between two of its edges
      let bi = 0, ba = -1;
      polys.forEach((q, i) => { const A = area3(q); if (A > ba) { ba = A; bi = i; } });
      const q = polys.splice(bi, 1)[0], m = q.length;
      const i = Math.floor(R.next() * m), j = (i + 1 + Math.floor(R.next() * (m - 1))) % m;
      const A = lerp3(q[i], q[(i + 1) % m], R.range(0.22, 0.78)), B = lerp3(q[j], q[(j + 1) % m], R.range(0.22, 0.78));
      const p1 = [A], p2 = [B];
      for (let s = (i + 1) % m; ; s = (s + 1) % m) { p1.push(q[s]); if (s === j) break; }
      p1.push(B);
      for (let s = (j + 1) % m; ; s = (s + 1) % m) { p2.push(q[s]); if (s === i) break; }
      p2.push(A);
      polys.push(p1, p2);
    }
    for (const q of polys) slabs.push(slab(R, q, n, centre, "piece"));
  });
  // chips: small irregular triangles knocked off anywhere on the surface
  for (let k = 0; k < 90; k++) {
    const tri = tris[Math.floor(R.next() * tris.length)], n = normal(tri);
    let a = R.next(), b = R.next(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const P = add(tri[0], add(mul(sub(tri[1], tri[0]), a), mul(sub(tri[2], tri[0]), b)));
    const u = nrm(sub(tri[1], tri[0])), w = cross(n, u), s = R.range(1.4, 3.8), a0 = R.range(0, TAU);
    const poly = [0, 1, 2].map((q) => { const an = a0 + (q / 3) * TAU + R.range(-0.5, 0.5), rr = s * R.range(0.6, 1.2); return add(P, add(mul(u, Math.cos(an) * rr), mul(w, Math.sin(an) * rr))); });
    slabs.push(slab(R, poly, n, centre, "chip"));
  }
  // glitter dust: single motes from all through the crystal
  const dust = [];
  for (let k = 0; k < 160; k++) {
    const tri = tris[Math.floor(R.next() * tris.length)];
    let a = R.next(), b = R.next(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const P = add(tri[0], add(mul(sub(tri[1], tri[0]), a), mul(sub(tri[2], tri[0]), b)));
    const c = lerp3(centre, P, R.range(0.25, 1));
    dust.push({ c, d: nrm(add(nrm(sub(c, centre)), [R.range(-0.6, 0.6), R.range(-0.6, 0.6), R.range(-0.6, 0.6)])), sp: R.range(40, 220), kd: R.range(2.6, 3.6), life: R.range(1.4, 4.2), g: R.range(1.0, 1.6), ph: R.range(0, 6.3), cut: R.next() });
  }
  // where the white burst leaves from: all through the crystal's shape, most of it near the surface
  const burst = [];
  for (let k = 0; k < 1024; k++) {
    const tri = tris[Math.floor(R.next() * tris.length)];
    let a = R.next(), b = R.next(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const P = add(tri[0], add(mul(sub(tri[1], tri[0]), a), mul(sub(tri[2], tri[0]), b)));
    const c = lerp3(centre, P, Math.pow(R.range(0.15, 1), 0.5));
    burst.push({ c, d: nrm(add(nrm(sub(c, centre)), [R.range(-0.35, 0.35), R.range(-0.35, 0.35), R.range(-0.35, 0.35)])) });
  }
  FR = { slabs, dust, centre, burst };
  FRACTURES.set(mesh, FR);
  return FR;
}

/** Rotate v about the unit axis k by angle a (Rodrigues). */
function rot(v, k, ca, sa) {
  const kv = cross(k, v), kd = dot(k, v) * (1 - ca);
  return [v[0] * ca + kv[0] * sa + k[0] * kd, v[1] * ca + kv[1] * sa + k[1] * kd, v[2] * ca + kv[2] * sa + k[2] * kd];
}

/**
 * The shatter. S = { mesh, view (object → view space, rotation only), cx, cy (screen of the object origin) }.
 * fX, fY: the soul's centre on screen.
 */
export function drawShatter(p, C, W, H, D, S, fX, fY, SZ, K, FH, fillPoly) {
  // IMPACT (11p): a hit-stop. The first frames HOLD (the hero frame stays up while the screen flashes), then
  // everything runs on from there.
  const f0 = D - DEATH.shatter, f = S.impact ? (f0 < IMPACT.hold ? 0.012 : f0 - IMPACT.hold + 0.012) : f0;
  // after the burst, shards and soul alike are carried UP by one shared updraft (the user, 2026-11-10: both float
  // up after the explosion). One field for every piece (shared rule 2): the same lift curve and the same slow sway,
  // each piece only scaling it, so the cloud rises as one.
  const lift = (g) => (SZ * 34 * Math.pow(Math.max(0, f - 0.45), 1.25)) * g;
  const sway = (ph) => SZ * 7 * Math.sin(f * 0.9 + ph * 0.35) * clamp((f - 0.45) / 1.2);
  const FR = fracture(S.mesh), view = S.view;
  // blend c over what is there with coverage a (an empty pixel keeps the alpha, so the glass shows the scene behind)
  const put = (i, c, a) => {
    const b = C[i];
    if (a >= 1) { C[i] = c; return; }
    if (!(b >>> 24)) { C[i] = (c & 0xffffff) | (Math.round(a * 255) << 24); return; }
    const k = Math.round(a * 256), j = 256 - k;
    C[i] = 0xff000000 | (((((b >>> 16) & 255) * j + ((c >>> 16) & 255) * k) >> 8) << 16) | (((((b >>> 8) & 255) * j + ((c >>> 8) & 255) * k) >> 8) << 8) | (((b & 255) * j + (c & 255) * k) >> 8);
  };
  // the soul's light dying in the glass: stepped, green → red (pixel steps, not a smooth fade)
  const soulTint = (gk, base) => (gk > 0.72 ? FH[2] : gk > 0.5 ? FH[3] : gk > 0.32 ? FH[4] : gk > 0.14 ? lerpC(FH[5], base, 0.45) : base);

  soulParts(p, f, fX, fY, SZ, FH, lift, sway, 0);   // the burst and half the embers: behind the glass
  if (S.impact) impact(p, f, f0, S, FR, fX, fY, SZ, FH, 0);
  else whiteBurst(p, f, S, FR, fX, fY, SZ, S.burstN ?? 1200, 0);  // the soul's white flame bursting free: half behind the pieces

  // pose every live piece, then draw far to near
  const live = [];
  for (const s of FR.slabs) {
    if (f > s.life) continue;
    const e = (1 - Math.exp(-s.kd * f)) / s.kd, dv = view(s.d);
    let hx = dv[0], hy = dv[1], hl = Math.hypot(hx, hy);
    // a piece flying straight at the camera would barely move on screen: give every piece some sideways travel
    if (hl < 0.5) { if (hl < 1e-3) { hx = Math.cos(s.ph); hy = Math.sin(s.ph); hl = 1; } hx *= 0.5 / hl; hy *= 0.5 / hl; }
    const go = s.sp * SZ * e, c0 = view(s.c);
    const bx = S.cx + c0[0] + hx * go + sway(s.ph), by = S.cy + c0[1] + hy * go - lift(s.g), bz = c0[2] + dv[2] * go;
    const ang = s.w0 * e + s.w1 * Math.max(0, f - 0.3), ca = Math.cos(ang), sa = Math.sin(ang), sc = 1 - 0.25 * (f / s.life);
    const w = s.v.map((v) => view(mul(rot(v, s.axis, ca, sa), sc)));
    live.push({ s, w, bx, by, z: bz, fade: clamp((s.life - f) / (s.life * 0.4)) });
  }
  live.sort((a, b) => a.z - b.z);
  for (const L of live) drawPiece(p, C, W, H, L, f, K, FH, fillConvex, put, soulTint);

  // glitter dust: single red motes that twinkle as they turn, riding the same updraft
  for (const m of FR.dust) {
    if (f > m.life || m.cut > clamp((m.life - f) / (m.life * 0.5))) continue;
    const e = (1 - Math.exp(-m.kd * f)) / m.kd, dv = view(m.d), c0 = view(m.c), go = m.sp * SZ * e;
    const x = Math.round(S.cx + c0[0] + dv[0] * go + sway(m.ph) + SZ * 2 * Math.sin(f * 2.1 + m.ph)), y = Math.round(S.cy + c0[1] + dv[1] * go - lift(m.g));
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const tw = Math.sin(f * 13 + m.ph * 7);
    C[y * W + x] = f < 0.12 ? WHITE : tw > 0.88 ? K(7) : tw > 0.2 ? K(5) : K(3);
  }

  if (S.impact) impact(p, f, f0, S, FR, fX, fY, SZ, FH, 1);
  else whiteBurst(p, f, S, FR, fX, fY, SZ, S.burstN ?? 1200, 1);  // ... and half in front
  soulParts(p, f, fX, fY, SZ, FH, lift, sway, 1);   // the other half of the embers: in front
  if (!S.impact && f < 0.2) { p.glow(fX, fY, 90 * SZ, WHITE, 0.7 * (1 - f / 0.2)); p.glow(fX, fY, 50 * SZ, FH[1], 0.5 * (1 - f / 0.2)); }
}

function drawPiece(p, C, W, H, L, f, K, FH, fillPoly, put, soulTint) {
  const { s, w, bx, by } = L, scr = w.map(([x, y]) => [bx + x, by + y]);
  const keep = L.fade >= 1 ? () => true : (x, y) => hash(x, y) < L.fade;
  const hull = hull2(scr);
  // the first instant: every piece white-hot
  if (f < 0.06) { fillPoly(W, H, hull, (x, y) => { C[y * W + x] = WHITE; }); return; }
  const gk = Math.pow(clamp(1 - f / s.glowT), 1.3);
  // the slab's centre in view space, to turn every face normal outward
  let mx = 0, my = 0, mz = 0;
  for (const v of w) { mx += v[0]; my += v[1]; mz += v[2]; }
  mx /= w.length; my /= w.length; mz /= w.length;
  const faces = [];
  for (const F of s.f) {
    const P = F.i.map((i) => w[i]), [a, b, c] = P;
    let n = nrm(cross(sub(b, a), sub(c, a)));
    const fc = mean(P);
    if (dot(n, [fc[0] - mx, fc[1] - my, fc[2] - mz]) < 0) n = mul(n, -1);
    const lit = Math.max(0, dot(n, LIGHT)), spec = dot(n, HALF);
    faces.push({ k: F.k, idx: F.i, front: n[2] > 0.02, lit, spec, cx: bx + fc[0], cy: by + fc[1] });
  }
  const big = !s.chip && s.size > 9;
  // 1. the rim: the hull's outline stamped one pixel out each way (ice.md §4g). Only the outline: the front faces
  //    cover the inside, and a filled dark hull under them would stop the glass being see-through. The tiniest
  //    chips go without.
  if (!s.chip || s.size > 2.6) {
    const rim = K(0);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      for (let q = 0; q < hull.length; q++) {
        const [x0, y0] = hull[q], [x1, y1] = hull[(q + 1) % hull.length];
        seg(x0 + dx, y0 + dy, x1 + dx, y1 + dy, (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H && keep(x, y)) C[y * W + x] = rim; });
      }
  }
  // 2. the front faces: the outer face is red glass under the one light; the break faces carry the dying soul light
  for (const F of faces) {
    if (!F.front) continue;
    const pts = F.idx.map((i) => scr[i]), step = clamp(Math.round(1 + Math.pow(F.lit, 1.3) * 6.2), 1, 7);
    if (F.k === 0) {
      const glint = F.spec > 0.985, col = glint ? WHITE : K(step);
      // lit glass mirrors the room (more opaque); turned away it lets what is behind show through
      const a = s.chip || glint ? 1 : clamp(0.55 + 0.45 * F.lit);
      fillPoly(W, H, pts, (x, y) => {
        if (!keep(x, y)) return;
        put(y * W + x, !glint && step >= 5 && ((x * 73856093) ^ (y * 19349663)) % 997 < 30 ? K(7) : col, a);
      });
    } else if (F.k === 1) {
      // the inner face (it faced the soul): glass like the outer one, only warmed by the soul for a moment
      const base = K(clamp(step - 1, 1, 6)), col = gk > 0.55 ? lerpC(base, FH[4], 0.35) : base, a = s.chip ? 1 : clamp(0.55 + 0.45 * F.lit);
      fillPoly(W, H, pts, (x, y) => { if (keep(x, y)) put(y * W + x, col, a); });
    } else {
      // the thin break faces round the sides: the soul's light caught in the fresh breaks
      const base = K(clamp(step - 1, 1, 6)), col = soulTint(gk, base);
      fillPoly(W, H, pts, (x, y) => { if (keep(x, y)) put(y * W + x, col, 0.9); });
    }
  }
  // 3. back edges through the glass, dashed (painted transparency), on the big pieces
  if (big)
    for (const F of faces) {
      if (F.front) continue;
      for (let q = 0; q < F.idx.length; q++) {
        const [x0, y0] = scr[F.idx[q]], [x1, y1] = scr[F.idx[(q + 1) % F.idx.length]];
        seg(x0, y0, x1, y1, (x, y, n) => { if (n % 2 || x < 0 || y < 0 || x >= W || y >= H || !keep(x, y)) return; const i = y * W + x; C[i] = lerpC(C[i], K(5), 0.45); });
      }
    }
  // 4. edges: the break edges glow with the soul (green, cooling to red); the outer face's are pale where lit
  const edge = (F, col) => {
    for (let q = 0; q < F.idx.length; q++) {
      const [x0, y0] = scr[F.idx[q]], [x1, y1] = scr[F.idx[(q + 1) % F.idx.length]];
      seg(x0, y0, x1, y1, (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H && keep(x, y)) C[y * W + x] = col; });
    }
  };
  if (!s.chip || s.size > 2.6) {
    for (const F of faces) if (F.front && F.k !== 0) edge(F, gk > 0.5 ? FH[1] : gk > 0.2 ? FH[3] : gk > 0.08 ? lerpC(FH[4], K(5), 0.5) : K(4));
    for (const F of faces) if (F.front && F.k === 0) edge(F, F.lit > 0.68 ? K(7) : F.lit > 0.4 ? K(6) : K(2));
  }
  // 5. a glint that sparkles as it turns through the light; the soul's light still in the big pieces
  for (const F of faces)
    if (F.front && F.k === 0 && F.spec > 0.95 && F.spec <= 0.985 && s.size > 5) {
      const x = Math.round(F.cx), y = Math.round(F.cy);
      for (const [dx, dy, c] of [[0, 0, WHITE], [1, 0, K(7)], [-1, 0, K(7)], [0, 1, K(6)], [0, -1, K(6)]]) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H) C[Y * W + X] = c; }
    }
  if (s.size > 14 && gk > 0.05) p.glow(bx, by, s.size * 0.6, FH[4], 0.22 * gk * L.fade);
}

/** The soul explodes: hot puffs first, then embers that drift up for seconds. pass 0: puffs + even embers; 1: odd. */
function soulParts(p, f, fX, fY, SZ, FH, lift, sway, pass) {
  const E = new Rng(777), EMB = [FH[0], FH[1], FH[3], FH[5]];
  for (let k = 0; k < 170; k++) {
    const a = E.range(0, TAU), sp = E.range(40, 230) * SZ, life = E.range(3.5, 8), kd = E.range(2, 3.2), g = E.range(0.9, 1.5);
    const sz = E.next() < 0.3 ? 2 : E.range(1, 1.6), ph = E.range(0, 6.3), big = k < 70, psize = E.range(4, 10) * SZ, frac = E.next();
    if (f > life) continue;
    const e = (1 - Math.exp(-kd * f)) / kd;
    const x = fX + Math.cos(a) * sp * e + sway(ph) + 2 * SZ * Math.sin(f * 2.3 + ph), y = fY + Math.sin(a) * sp * e - lift(g);
    if (big && f < 0.8) { if (pass === 0) firePuff(p, x, y, 1 - f / 0.8, psize, frac, FH, 0.3); }
    else if (k % 2 === pass) ember(p, x, y, 1 - f / life, sz, EMB, f * 30 + ph);
  }
}

// ------------------------------------------------------------------------------------------------ the white burst
// The moment the seal breaks, the soul's flame bursts out WHITE (the user, 2026-11-10): a massive burst of flame
// puffs, the same particles and motion as the pours before it (speed, drag, the heat lifting them). It leaves from
// the WHOLE crystal at once, not from a point at its centre (the user, 2026-11-10): every puff starts somewhere in
// the crystal's shape (most near its surface, where the glass gave way) and flies outward from the centre through
// that point, so the first frames are the crystal's own diamond turned to white fire, swelling out. Each puff is born
// white-hot and holds white through most of its life before it cools into the soul's green. Half are drawn behind the
// flying pieces and half in front, so the burst has depth among them. n: how many puffs (the page compares counts).
const WB = ["#ffffff", "#ffffff", "#ffffff", "#f2ffef", "#dcffd2", "#a6ff9c", "#5dff6e", "#3cd66c", "#22a86c"].map(hex);
function whiteBurst(p, f, S, FR, fX, fY, SZ, n, pass) {
  if (f < 0 || f > 1.7 || !n) return;
  const R = new Rng(31337), view = S.view, B = FR.burst;
  for (let k = 0; k < n; k++) {
    const o = B[k % B.length];
    // hard in the first instant, tailing off over half a second
    const tb = 0.5 * Math.pow(R.next(), 1.4);
    const sp = R.range(220, 620) * SZ * (1 - 0.35 * tb / 0.5);
    const life = R.range(0.55, 1.15), size = R.range(4, 10) * SZ, frac = R.next(), jx = R.range(-2, 2), jy = R.range(-2, 2);
    if ((k & 1) !== pass) continue;
    const tau = f - tb;
    if (tau < 0 || tau > life) continue;
    const c0 = view(o.c), dv = view(o.d);
    let hx = dv[0], hy = dv[1], hl = Math.hypot(hx, hy);
    // a puff leaving the face toward the camera still has to spread on screen
    if (hl < 0.45) { if (hl < 1e-3) { hx = 1; hy = 0; hl = 1; } hx *= 0.45 / hl; hy *= 0.45 / hl; }
    const kd = 3.2, e = (1 - Math.exp(-kd * tau)) / kd;
    const x = S.cx + c0[0] + jx + hx * sp * e, y = S.cy + c0[1] + jy + hy * sp * e - 0.5 * 70 * SZ * tau * tau;
    firePuff(p, x, y, 1 - tau / life, size, frac, WB, 0.12);
  }
  if (pass === 1) { if (f < 0.12) p.glow(fX, fY, 60 * SZ, WHITE, 0.8 * (1 - f / 0.12)); if (f < 0.6) p.glow(fX, fY, 40 * SZ, WB[3], 0.7 * (1 - f / 0.6)); }
}

// ------------------------------------------------------------------------------------------------ the impact (11p)
// The user (2026-11-10): "the green soul flame burst is too weak". What made it weak: the puffs flew only 1.5-2.5
// crystal radii and were white for most of their life (the green came last), and the moment had no beats. After
// the stock big explosion (pixelfx fx/explosions/big-explosion.js: a white hero frame, a dome that cools, a starburst
// flare, a fast shock ring, ~80 sparks, light thrown over everything) and the impact frame (whole-frame beats):
//   - hit-stop: the hero frame holds IMPACT.hold s (drawShatter);
//   - hero frame: the crystal's whole volume a white-hot ball with a soul-green rim, cooling down the ramp;
//   - a starburst flare; two shock rings in the crystal's girdle plane, in 3D (seen from below they are ellipses,
//     the far half behind the pieces);
//   - the soul flame: a MASS of puffs (the pours' particle; memory: a flame burst = puffs), twice as far and fast,
//     born white and turning SOUL GREEN almost at once, so the burst reads green; plus a fast thin outer front;
//   - soul sparks: fast streaks in every direction, falling a little, gone in half a second (violence, punctuation).
// The page adds the dip before it, the full-screen flash, the arena lit green, and a harder shake.
export const IMPACT = { hold: 0.07 };
// born white, green almost at once, down to the soul's dark teal (hot first, as firePuff reads a ramp)
const IG = ["#ffffff", "#e9ffe4", "#b8ffad", "#7dff7e", "#5dff6e", "#3cd66c", "#22a86c", "#178066", "#11524a"].map(hex);
const FLARE_RAMP = ["#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#ffffff"];
const outCubic = (u) => 1 - Math.pow(1 - clamp(u), 3);
function impact(p, f, f0, S, FR, fX, fY, SZ, FH, pass) {
  const view = S.view, M = S.mesh, coreY = (M.bot - M.top) / 2 + 0.1 * (M.top + M.bot), zc = view([0, coreY, 0])[2];
  const back = pass === 0, side = (z) => (z < zc) === back;
  // 1. the soul flame: a dense core of fat puffs and a fast thin front, leaving from the whole crystal
  if (f < 2.2) {
    const R = new Rng(424242), B = FR.burst, n = S.burstN ?? 1200;
    for (let k = 0; k < n * 1.3; k++) {
      const o = B[k % B.length], front = k >= n;
      const tb = (front ? 0.08 : 0.32) * Math.pow(R.next(), 1.6);
      // most of the flame stays dense near the crystal, a few puffs fly far: a hot core that thins outward
      const sp = (front ? R.range(900, 1500) : 220 + 760 * Math.pow(R.next(), 1.8)) * SZ * (1 - 0.3 * tb / 0.32);
      const life = front ? R.range(0.3, 0.55) : R.range(0.6, 1.2), size = (front ? R.range(3, 5) : R.range(4, 10)) * SZ;
      const frac = R.next(), jx = R.range(-2, 2), jy = R.range(-2, 2), kd = front ? 3.4 : 3.0;
      const tau = f - tb;
      if (tau < 0 || tau > life) continue;
      const c0 = view(o.c), dv = view(o.d), e = ((1 - Math.exp(-kd * tau)) / kd) * sp;
      const z = c0[2] + dv[2] * e;
      if (!side(z)) continue;
      let hx = dv[0], hy = dv[1], hl = Math.hypot(hx, hy);
      if (hl < 0.45) { if (hl < 1e-3) { hx = 1; hy = 0; hl = 1; } hx *= 0.45 / hl; hy *= 0.45 / hl; }
      const x = S.cx + c0[0] + jx + hx * e, y = S.cy + c0[1] + jy + hy * e - 0.5 * 70 * SZ * tau * tau;
      firePuff(p, x, y, 1 - tau / life, size * (1 + 0.5 * Math.max(0, 1 - tau / 0.2)), frac, IG, 0.16);
    }
  }
  // 2. two shock rings in the girdle plane (3D: posed with the crystal, the far half behind the pieces)
  const ring = (t0, dur, r1, th0, cols) => {
    const u = (f - t0) / dur;
    if (u < 0 || u >= 1) return;
    const r = M.r * (0.6 + r1 * outCubic(u)), th = Math.max(1, th0 * (1 - u)), a = Math.min(1, (1 - u) * 1.7);
    const col = u < 0.22 ? cols[0] : u < 0.5 ? cols[1] : cols[2];
    const n = Math.ceil(r * TAU * 0.9);
    for (let j = 0; j < n; j++) {
      const an = (j / n) * TAU, ca = Math.cos(an), sa = Math.sin(an);
      for (let o = 0; o <= th; o += 0.8) {
        const q = view([ca * (r - o), coreY, sa * (r - o)]);
        if (!side(q[2])) continue;
        p.dot(S.cx + q[0], S.cy + q[1], o < th * 0.35 ? cols[0] : col, a);
      }
    }
  };
  ring(0, 0.55, 5.2, 7, [WHITE, FH[1], FH[3]]);
  ring(0.07, 0.75, 3.3, 4, [FH[1], FH[2], FH[4]]);
  // 3. soul sparks: fast streaks every way, falling a little
  {
    const R = new Rng(9090);
    for (let k = 0; k < 120; k++) {
      const u1 = R.range(-1, 1), a = R.range(0, TAU), s = Math.sqrt(1 - u1 * u1), d = [s * Math.cos(a), u1, s * Math.sin(a)];
      const sp = R.range(700, 1500) * SZ, life = R.range(0.25, 0.7), kd = 3;
      if (f > life) continue;
      const at = (tt) => { const e = ((1 - Math.exp(-kd * tt)) / kd) * sp; return view([d[0] * e, coreY + d[1] * e + 220 * SZ * tt * tt, d[2] * e]); };
      const q1 = at(f), q0 = at(Math.max(0, f - 0.03));
      if (!side(q1[2])) continue;
      const age = f / life;
      p.line(S.cx + q0[0], S.cy + q0[1], S.cx + q1[0], S.cy + q1[1], age < 0.3 ? WHITE : age < 0.6 ? FH[1] : FH[3], age < 0.75 ? 1 : (1 - age) * 4);
    }
  }
  if (back) return;
  // 4. the hero frame: the whole crystal a white-hot ball with a soul-green rim, cooling down the ramp
  const HR = M.r * 1.45;
  if (f0 < IMPACT.hold + 0.02) { p.circle(fX, fY, HR + 2, FH[2]); p.circle(fX, fY, HR, WHITE); p.glow(fX, fY, HR * 2.6, WHITE, 0.9); }
  else if (f < 0.1) { const k = (f - 0.012) / 0.088, r = HR * (1 - 0.45 * k); p.circle(fX, fY, r + 1.5, FH[3], 1 - k); p.circle(fX, fY, r, k < 0.5 ? FH[0] : FH[1], 1 - k); }
  // 5. the starburst flare
  if (f < 0.3) flare(p, fX, fY, 210 * SZ * Math.pow(1 - f / 0.3, 1.4), 1 - f / 0.3, FLARE_RAMP);
  if (f < 0.5) p.glow(fX, fY, 120 * SZ, FH[1], 0.8 * (1 - f / 0.5));
}
