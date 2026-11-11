// The Sealing Crystal (Nidhogg fight) — the 3D pixel crystal renderer, ported 1:1 from the approved mockup v33
// (claude.ai/artifact/SurCgqU1jF6b5inTc2bQ6o, fx/crystal.js). Pure: no DOM, no Foundry, so it runs in a Worker
// (crystal-worker.js) and in Node tests. The in-game host is crystal-runtime.js.
//
// A real 3D faceted solid, posed every frame and painted in pixels, after the pixel-vfx-materials ice sheet
// (materials/ice.md §4g, lab/ice-shapes.js drawSolid): one key light from the upper left, each facet one step of an
// 8-step ramp, a 1 px dark rim stamped from the hull, pale edges on lit facets, glitter, a white flash on a facet
// that mirrors the light at the eye, dashed back edges for "see-through".
//
// What is new here:
//   - Red glass with a soul inside. The front faces are GLASS over what is behind them: the inner walls (back faces,
//     lit green near the flame) and Nidhogg's soul fire. Over the fire the glass lets more through, so the green
//     flame reads clearly inside the red.
//   - The soul fire is the stock fire `burn()` (fire.md: real tongues, licks, embers, its own light) in the Soul
//     Tithe soul-fire ramp, burning from a core low in the crystal (fire.md §1: start from the source), sealed in:
//     no smoke, clipped to the inside of the hull.
//   - It turns about its VERTICAL axis (the user, 2026-11-10: "rotate horizontally"); the light stays put, so only
//     the light moves across the facets (ice.md short version 5).
//   - Cracks live ON the surface in object space, so they turn with the crystal. They glow green: the soul leaking.
//   - Shape: a diamond (the suit), pointed top and bottom, asymmetric (the user, 2026-11-10).
import { hex, mix, clamp, Rng, TAU, WHITE, createFrame, clearFrame, painterFor, sparkle } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { ember } from "../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";
import { makeSoulBallFire } from "./soul-ball-fire.js";
import { DEATH, POURS, deathSpin, deathTimeline, pushOffset, drawJet, drawShatter } from "./crystal-death.js";

// dark -> light. Darks lean to maroon-violet, lights to coral and a warm white (ice.md §6: the ramp spans the whole
// value range and shifts hue along it, so it holds on dark and bright ground alike).
export const RED = ["#12030b", "#2c0614", "#540a1c", "#861126", "#b91d31", "#e2414b", "#ff8c86", "#ffe2d4"].map(hex);
// the Soul Tithe soul fire, dark -> hot (soul-fx-lib.js SOUL_FIRE)
const SOUL_FIRE = ["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2", "#ffffff"].map(hex);
const FH = [...SOUL_FIRE].reverse(); // hot-first

const norm = ([x, y, z]) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
const LIGHT = norm([-0.6, -0.8, 0.6]);
const HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
const R8 = (c) => c & 255, G8 = (c) => (c >>> 8) & 255, B8 = (c) => (c >>> 16) & 255;
const pack = (r, g, b, a = 255) => ((a & 255) << 24) | ((clamp(b, 0, 255) | 0) << 16) | ((clamp(g, 0, 255) | 0) << 8) | (clamp(r, 0, 255) | 0);
const lerpC = (a, b, t) => pack(R8(a) + (R8(b) - R8(a)) * t, G8(a) + (G8(b) - G8(a)) * t, B8(a) + (B8(b) - B8(a)) * t);

// ------------------------------------------------------------------------------------------------ the mesh
/**
 * A diamond, pointed top and bottom, built from three twisted rings (upper crown, girdle, lower pavilion) and two
 * apexes. Each ring is turned half a step from the next, so the bands between them are triangles (crystal facets,
 * not a smooth cone: ice.md §4g "shard"). Radii and heights are jittered and the apexes sit off the axis, so no two
 * sides match. y is down; the girdle is just above the middle, so the top point is the longer one.
 */
export function crystalMesh(seed = 11, o = {}) {
  const R = new Rng(seed), n = o.n ?? 9, top = o.top ?? 150, bot = o.bot ?? 98, gr = o.r ?? 74, sc = gr / 34;
  const ring = (y, r, tw, jit, yj) => Array.from({ length: n }, (_, k) => {
    const a = (k / n) * TAU + tw + R.range(-jit, jit), rr = r * R.range(0.82, 1.12);
    return [Math.cos(a) * rr, y + R.range(-yj, yj), Math.sin(a) * rr];
  });
  const up = ring(-top * 0.42, gr * 0.62, Math.PI / n, 0.14, 3 * sc);
  const gd = ring(-3 * sc, gr, 0, 0.1, 3.5 * sc);
  const lo = ring(bot * 0.4, gr * 0.52, Math.PI / n, 0.14, 2.5 * sc);
  const T = [R.range(2.5, 6) * sc * (R.next() < 0.5 ? -1 : 1), -top, R.range(-3, 3) * sc];
  const B = [R.range(1, 4) * sc * (R.next() < 0.5 ? -1 : 1), bot, R.range(-2, 2) * sc];
  const v = [...up, ...gd, ...lo, T, B], U = 0, Gd = n, L = 2 * n, TI = 3 * n, BI = 3 * n + 1, f = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    f.push([TI, U + k, U + j]);
    f.push([Gd + k, Gd + j, U + k], [U + k, U + j, Gd + j]);
    f.push([Gd + k, Gd + j, L + k], [L + k, L + j, Gd + j]);
    f.push([BI, L + k, L + j]);
  }
  // the centre used to orient normals outward and to project crack points onto the surface
  const mesh = { v, f, top, bot, n, r: gr };
  mesh.beams = [];
  mesh.cracks = makeCracks(mesh, R);
  return mesh;
}

// ray from (0, y, 0) along (dx, 0, dz) against the mesh: the surface point and its face
function surfaceAt(mesh, theta, y) {
  const o = [0, y, 0], d = [Math.cos(theta), 0, Math.sin(theta)];
  let best = null;
  for (let fi = 0; fi < mesh.f.length; fi++) {
    const [a, b, c] = mesh.f[fi].map((i) => mesh.v[i]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-9) continue;
    const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]], u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const w = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (w < -1e-6 || u + w > 1 + 1e-6) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (t > 0 && (!best || t < best.t)) best = { t, fi, p: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t] };
  }
  return best;
}
/**
 * Cracks for the three damage stages (75 / 50 / 25 % HP). Each stage adds an impact hub with jagged cracks
 * radiating from it, walked across the surface in (angle, height) and projected onto the mesh, so they cross
 * facet edges and turn with the crystal. A crack is a list of surface points; it reveals from its hub outward.
 */
function makeCracks(mesh, R) {
  const stages = [], r0 = mesh.r * 0.85, yLo = -mesh.top * 0.85, yHi = mesh.bot * 0.8;
  const walk = (th, y, dir, steps, wob) => {
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const hit = surfaceAt(mesh, th, clamp(y, yLo, yHi));
      if (hit) pts.push(hit.p);
      const a = dir + R.range(-wob, wob);
      th += (Math.cos(a) * 3) / r0;
      y += Math.sin(a) * 3;
    }
    return pts;
  };
  // each stage: impact hubs SPREAD round the whole crystal (the user, 2026-11-10: "start from multiple points ...
  // spread out so it can always be seen"), so whichever way it has turned, some of every stage faces the camera.
  // Hubs sit evenly round the circumference (jittered), each stage turned half a gap from the last so the stages
  // interleave, and alternate between the upper crown and the lower half. 4 / 5 / 6 hubs, 4-5 cracks each.
  const HUBS = [4, 5, 6, 8];               // the 4th set is the death: cracks through the whole crystal
  for (let s = 0; s < HUBS.length; s++) {
    const list = [], nh = HUBS[s], turn = R.range(0, TAU);
    for (let h = 0; h < nh; h++) {
      const th0 = turn + ((h + 0.5 * s) / nh) * TAU + R.range(-0.25, 0.25) * (TAU / nh) * 0.5;
      const fy = h % 2 ? R.range(0.05, 0.45) : -R.range(0.05, 0.55);
      const y0 = fy < 0 ? fy * mesh.top : fy * mesh.bot, n = 4 + (R.next() < 0.5 ? 1 : 0);
      const hubCracks = [];
      for (let c = 0; c < n; c++) {
        const dir = (c / n) * TAU + R.range(-0.35, 0.35), len = R.range(16, 34) * (1 + s * 0.35) * (mesh.r / 46);
        const pts = walk(th0, y0, dir, Math.round(len / 3), 0.75);
        if (pts.length > 1) { list.push(pts); hubCracks.push(pts); }
        // one or two branches peeling off along the way
        for (let b = 0; b < 2; b++) {
          if (pts.length < 4 || R.next() > 0.7 - b * 0.25) continue;
          const m = Math.floor(pts.length * R.range(0.3, 0.75)), q = pts[m];
          const bp = walk(Math.atan2(q[2], q[0]), q[1], dir + (R.next() < 0.5 ? 1 : -1) * R.range(0.5, 1.1), Math.round(R.range(3, 6) * (1 + s * 0.3) * (mesh.r / 46)), 0.6);
          if (bp.length > 1) list.push(bp);
        }
      }
      const soulY = (mesh.bot - mesh.top) / 2 + 0.1 * (mesh.top + mesh.bot);
      (mesh.beams[s] ??= []);
      const hub = beamAt(mesh, [Math.cos(th0), clamp(y0, yLo, yHi), Math.sin(th0)], soulY, true);
      if (hub) mesh.beams[s].push(hub);
      for (const k of [0, 2]) {
        const cr = hubCracks[k];
        if (!cr || cr.length < 3) continue;
        const b = beamAt(mesh, cr[Math.floor(cr.length * 0.6)], soulY, false);
        if (b) mesh.beams[s].push(b);
      }
    }
    stages.push(list);
  }
  return stages;
}
// the outward normal of the surface at a point (the face it lies on), and the beam direction there: mostly the
// normal, partly straight out from the soul, so the light reads as the soul's own light escaping through the crack
function beamAt(mesh, q, soulY, main) {
  const th = Math.atan2(q[2], q[0]), hit = surfaceAt(mesh, th, q[1]);
  if (!hit) return null;
  const [a, b, c] = mesh.f[hit.fi].map((i) => mesh.v[i]);
  let n = norm([(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]);
  if (n[0] * hit.p[0] + n[2] * hit.p[2] < 0) n = n.map((v) => -v);
  const r = norm([hit.p[0], hit.p[1] - soulY, hit.p[2]]);
  return { p: hit.p, n, d: norm([0.55 * n[0] + 0.45 * r[0], 0.55 * n[1] + 0.45 * r[1], 0.55 * n[2] + 0.45 * r[2]]), main };
}

// ------------------------------------------------------------------------------------------------ raster helpers
function fillTri(W, H, a, b, c, fn) {
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-6) return;
  const sg = area > 0 ? 1 : -1;
  // Each edge test is linear in px along a row: w = A * px + B. Solve the three for the row's inside span and only
  // test that span (+-1 px, so float error can never drop a pixel the exact test below would keep). Same pixels as
  // testing the whole bounding box, which a long thin diagonal (a beam) made ~10x larger than the triangle.
  const A0 = -(c[1] - b[1]) * sg, A1 = -(a[1] - c[1]) * sg, A2 = -(b[1] - a[1]) * sg;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    let lo = x0, hi = x1;
    const B0 = (b[0] * (c[1] - py) - (b[1] - py) * c[0]) * sg, B1 = (c[0] * (a[1] - py) - (c[1] - py) * a[0]) * sg, B2 = (a[0] * (b[1] - py) - (a[1] - py) * b[0]) * sg;
    let empty = false;
    for (const [A, B] of [[A0, B0], [A1, B1], [A2, B2]]) {
      if (A > 1e-12) lo = Math.max(lo, Math.floor(-B / A - 0.5) - 1);
      else if (A < -1e-12) hi = Math.min(hi, Math.ceil(-B / A - 0.5) + 1);
      else if (B < -1e-9) { empty = true; break; }
    }
    if (empty) continue;
    for (let x = lo; x <= hi; x++) {
      const px = x + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) * sg;
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) * sg;
      const w2 = ((a[0] - px) * (b[1] - py) - (a[1] - py) * (b[0] - px)) * sg;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) fn(x, y);
    }
  }
}
function fillPoly(W, H, pts, fn) { for (let i = 1; i < pts.length - 1; i++) fillTri(W, H, pts[0], pts[i], pts[i + 1], fn); }
function line(x0, y0, x1, y1, fn) {
  x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1); y1 = Math.floor(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, i = 0;
  for (;;) {
    fn(x0, y0, i++);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function hullOf(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], hi = [];
  for (const q of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of P.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
// signed distance to a convex polygon's inside (positive inside). insideOf(hull) precomputes the edges once, so the
// per-pixel test is a handful of multiply-adds.
function insideOf(hull) {
  const n = hull.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = hull[i], b = hull[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sg = area > 0 ? 1 : -1, E = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
    E[i * 4] = a[0]; E[i * 4 + 1] = a[1]; E[i * 4 + 2] = (-sg * ey) / L; E[i * 4 + 3] = (sg * ex) / L;
  }
  return (x, y) => {
    let m = Infinity;
    for (let i = 0; i < n * 4; i += 4) { const d = (x - E[i]) * E[i + 2] + (y - E[i + 1]) * E[i + 3]; if (d < m) m = d; }
    return m;
  };
}

// ------------------------------------------------------------------------------------------------ the crystal
/**
 * makeCrystal(W, H): a renderer for a W x H effect-pixel frame. draw(t, st) paints into .frame (pixelfx frame:
 * color with alpha + additive light) and returns it.
 * st: { mesh, cx, floorY, turn (s per turn), pitch, glass (0..1), flameSee (0..1), stage (0..3), stageT (time the
 *       newest stage appeared), hitT (time of the last hit), hitSide (-1 | 1), backEdges, flameK (1 = normal) }
 */
export function makeCrystal(W, H) {
  const frame = createFrame(W, H), fire = createFrame(W, H);
  const flameMask = new Uint8Array(W * H);
  // Nidhogg's soul: a burning orb with its fire merged into one body (soul-ball-fire.js)
  const soulOpts = { r: 19, seed: 4, rage: 1 }, soul = makeSoulBallFire(soulOpts);
  const jetCache = { key: null, list: [] };
  const hullMask = new Uint8Array(W * H), bins = 720, prof = new Float32Array(bins), plen = new Float32Array(bins), pid = new Int16Array(bins);

  function draw(t, st) {
    clearFrame(frame); clearFrame(fire); flameMask.fill(0);
    const C = frame.color, Lb = frame.light, p = painterFor(frame);
    const M = st.mesh, K = (i) => RED[clamp(i, 0, 7)];
    const since = (t0) => (t0 == null ? 99 : t - t0);
    const hitA = since(st.hitT);
    const shake = hitA < 0.26 ? Math.round(Math.sin(hitA * 90) * (1 - hitA / 0.26) * 2.2) * (st.hitSide ?? 1) : 0;
    const D = st.deathT == null ? null : t - st.deathT, tl = D == null ? null : deathTimeline(D), turn = st.turn ?? 12;
    // the build-up whitens everything inside (walls, soul fire, the light leaking from the cracks); the front glass
    // still goes over it at the same "soul shows through" share
    const inner = tl ? tl.inner : 0, crackC = inner > 0 ? lerpC(FH[2], WHITE, inner) : FH[2];
    const bob = Math.round(2 * Math.sin((t * TAU) / 3.2) * (D == null ? 1 : Math.max(0, 1 - D / DEATH.spin)));
    // camYaw / camPitch: the battle camera's swing, so the crystal is seen from where the camera stands
    const yaw = (D == null ? (t / turn) * TAU : (st.deathT / turn) * TAU + deathSpin(D, turn)) + (st.camYaw ?? 0), pitch = (st.pitch ?? -0.2) + (st.camPitch ?? 0);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const view = ([x, y, z]) => {
      const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;           // yaw about the vertical axis
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;              // pitch: seen a little from above
      return [x1, y2, z2];
    };
    // the pours of the death. Each one tears out of a crack facing the camera AT THE MOMENT IT TEARS OUT (the camera
    // is moving from 10.8 s: st.camAt(D) gives its yaw / pitch then), far from the cracks already pouring; from then on
    // it is a 3D crack on the crystal, and its flame is a 3D stream (crystal-death.js drawJet), so it turns with the
    // camera like everything else. The first three come from main cracks, the build-up's extra pours from any crack.
    let jets = null;
    if (D != null) {
      const key = st.deathT + ":" + M.v.length + ":" + (st.camKey ?? "");
      if (jetCache.key !== key) {
        const spinEnd = (st.deathT / turn) * TAU + deathSpin(99, turn), pitch0 = st.pitch ?? -0.2;
        // camAt(d) (a function, the mockup) or camPoses[k] (data, one per pour: what a Worker can be sent)
        const poseAt = (d, k) => {
          const c = (st.camAt ? st.camAt(d) : st.camPoses?.[k]) ?? { yaw: 0, pitch: 0 }, yf = spinEnd + c.yaw, pf = pitch0 + c.pitch;
          const cf = Math.cos(yf), sf = Math.sin(yf), cq = Math.cos(pf), sq = Math.sin(pf);
          const vf = ([x, y, z]) => { const x1 = x * cf + z * sf, z1 = -x * sf + z * cf; return [x1, y * cq - z1 * sq, y * sq + z1 * cq]; };
          // the direction the camera looks from, in the crystal's own axes (the inverse pose of +z)
          return { vf, axis: [-cq * sf, sq, cq * cf] };
        };
        const beamsMain = M.beams.flat().filter((bm) => bm.main), beamsAll = M.beams.flat();
        const pick = [];
        for (let k = 0; k < POURS.length; k++) {
          const { vf, axis } = poseAt(POURS[k], k);
          const posed = (list) => list.map((bm) => ({ b: bm, P: vf(bm.p), Dv: vf(bm.d), Nv: vf(bm.n), axis }));
          let pool;
          if (k < DEATH.jets.length) {
            const all = posed(beamsMain);
            pool = all.filter((c) => c.Nv[2] > 0.15 && Math.hypot(c.Dv[0], c.Dv[1]) > 0.55);
            if (pool.length < 3) pool = all.filter((c) => c.Nv[2] > 0);
          } else {
            const more = posed(beamsAll).filter((c) => c.Nv[2] > 0.1 && Math.hypot(c.Dv[0], c.Dv[1]) > 0.4);
            pool = more.length >= DEATH.pours.length ? more : posed(beamsMain);
          }
          let best = null;
          if (!pick.length) { for (const c of pool) if (!best || c.Nv[2] > best.Nv[2]) best = c; }
          else {
            // far from every crack already pouring, measured on the screen as the camera sees it now
            let bd = -1;
            const prev = pick.map((q) => vf(q.b.p));
            for (const c of pool) {
              if (pick.some((q) => q.b === c.b)) continue;
              const dd = Math.min(...prev.map((P) => Math.hypot(P[0] - c.P[0], P[1] - c.P[1])));
              if (dd > bd) { bd = dd; best = c; }
            }
          }
          if (!best) break;
          pick.push(best);
        }
        jetCache.key = key;
        // ref: how long the crack's direction looked on the screen when it tore out (the pour's speed is set by that)
        jetCache.list = pick.map((c) => ({ b: c.b, axis: c.axis, ref: Math.hypot(c.Dv[0], c.Dv[1]) || 1 }));
      }
      jets = jetCache.list;
    }
    const push = D == null ? { ox: 0, oy: 0 } : pushOffset(D, jets.map((j) => { const v = view(j.b.d); return [v[0] / j.ref, v[1] / j.ref]; }), 9 * (M.r / 74), Math.floor(t * 60));
    const cx = st.cx + shake + push.ox, cy = st.floorY - 18 - M.bot + bob + push.oy;
    const w = M.v.map(view), scr = w.map(([x, y]) => [cx + x, cy + y]);
    let mcx = 0, mcy = 0, mcz = 0;
    for (const v of w) { mcx += v[0]; mcy += v[1]; mcz += v[2]; }
    mcx /= w.length; mcy /= w.length; mcz /= w.length;
    const faces = M.f.map((idx, fi) => {
      const [a, b, c] = idx.map((i) => w[i]);
      let nn = norm([(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]);
      const fx = (a[0] + b[0] + c[0]) / 3, fy = (a[1] + b[1] + c[1]) / 3, fz = (a[2] + b[2] + c[2]) / 3;
      if (nn[0] * (fx - mcx) + nn[1] * (fy - mcy) + nn[2] * (fz - mcz) < 0) nn = nn.map((v) => -v);
      const lit = Math.max(0, nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2]);
      const spec = nn[0] * HALF[0] + nn[1] * HALF[1] + nn[2] * HALF[2];
      return { fi, pts: idx.map((i) => scr[i]), z: fz, nz: nn[2], n: nn, a, front: nn[2] > 0.02, lit, spec, cx: cx + fx, cy: cy + fy };
    });
    const hull = hullOf(scr), inside = insideOf(hull);
    const white = hitA < 0.034;

    // 0. under it: its shadow on the floor and the red light it throws there
    const fy = st.floorY;
    const SRX = Math.round(M.r * 0.8), SRY = Math.max(5, Math.round(M.r * 0.12));
    const floorOn = st.floorClip !== false;   // in the dark void there is no floor: no shadow, no light pool on it
    if (floorOn) for (let y = -SRY; y <= SRY; y++) for (let x = -SRX; x <= SRX; x++) {
      const d = (x / SRX) ** 2 + (y / (SRY + 0.5)) ** 2;
      if (d > 1) continue;
      const a = d < 0.45 ? 0.42 : 0.24;
      const i = (fy + y) * W + (Math.round(st.cx) + x);
      if (i >= 0 && i < C.length) C[i] = pack(8, 2, 6, Math.round(a * 255));
    }
    const stage = D == null ? (st.stage ?? 0) : D >= DEATH.crack ? 4 : Math.max(3, st.stage ?? 0);
    const stageT = D == null ? st.stageT : D >= DEATH.crack ? st.deathT + DEATH.crack : (st.stage ?? 0) >= 3 ? st.stageT : -1e9;
    const flameK = (st.flameK ?? 1) * (1 + stage * 0.12) * (1 + 0.6 * Math.max(0, 1 - hitA / 0.6));
    // reveal (the slow unveil after the dragon falls): 0 = only the soul, faint, through dark glass nobody can see;
    // facets catch the light one by one (each at its own threshold), then the edges, the glints, the red aura and,
    // last, the beams from the cracks. 1 (the default) draws the crystal exactly as before.
    const rv = clamp(st.reveal ?? 1), facetK = (fi) => (rv >= 1 ? 1 : clamp((rv - (((fi * 2654435761) >>> 0) % 1000) / 1000 * 0.55) / 0.45));
    // opaque (mockup 5b, the user 2026-11-11: "unveil the crystal in a non-transparent state, then, with a few flashes
    // of light passing through, show the content"): 0..1, how much of the inside the glass hides (1 = solid red gem,
    // no soul, no light from inside). sweep { pos (-0.15..1.15 across the hull), k, dir (+1 from the upper left, -1
    // from the lower right), before, after }: a band of light crossing the crystal; behind it the glass is `after`
    // clear, ahead of it still `before`. Defaults (opaque 0, no sweep) draw the crystal exactly as before.
    // The sweep runs through the crystal in 3D (the user, 2026-11-11: a flat stripe "doesn't consider the shape of
    // the crystal, it looks cheap"): a plane of light moving along SWD; on each facet the line sits where that plane
    // meets the facet, so it bends at every facet edge, plus a small kink by the facet's tilt (the glass refracting
    // it). Facets that face the light catch it brighter, a facet flushes as a line crosses it, and its edges flare.
    // sweep { pos, k, before, after, lines: [{ o: offset behind the lead, w: width x, k: strength }] }.
    const sw = st.sweep ?? null, op0 = clamp(st.opaque ?? 0), opOn = !!sw || op0 > 0;
    const SWD = norm([1, 0.62, 0.55]);
    let su0 = 1e9, su1 = -1e9;
    if (sw) for (const v of w) { const d = v[0] * SWD[0] + v[1] * SWD[1] + v[2] * SWD[2]; su0 = Math.min(su0, d); su1 = Math.max(su1, d); }
    const uOf = (X, Y, Z) => (X * SWD[0] + Y * SWD[1] + Z * SWD[2] - su0) / (su1 - su0 || 1);
    const sAt = (x, y) => uOf(x - cx, y - cy, mcz);                    // flat (no facet): for the light leaking from inside
    const uFace = (f, x, y) => {
      const X = x - cx, Y = y - cy, n = f.n, Z = f.a[2] - (n[0] * (X - f.a[0]) + n[1] * (Y - f.a[1])) / (n[2] || 1);
      return uOf(X, Y, Z) + 0.035 * (n[0] * 0.8 - n[1] * 0.5);
    };
    const LN = sw ? sw.lines ?? [{ o: 0, w: 1, k: 1 }] : [];
    const passedU = (u) => { let n = 0; for (const l of LN) n += clamp((sw.pos - l.o - u) / 0.04 + 0.5); return n / LN.length; };
    const opU = (u) => (!sw ? op0 : sw.before + (sw.after - sw.before) * passedU(u));
    const opAt = (x, y) => opU(sAt(x, y));
    const opG = sw ? opU(0.5) : op0;
    // the nearest line to u: { d (distance / its width), k }
    const nearLine = (u) => { let d = 9, k = 0; for (const l of LN) { const dj = Math.abs(u - (sw.pos - l.o)) / l.w; if (dj < d) { d = dj; k = l.k; } } return { d, k }; };
    if (floorOn) {
      p.glow(st.cx, fy, M.r * 1.2, RED[4], 0.22);
      p.glow(st.cx, fy - 2, M.r * 0.55, FH[4], 0.10 * flameK);
    }

    const core = view([0, (M.bot - M.top) / 2 + 0.1 * (M.top + M.bot), 0]), fX = cx + core[0], fY = cy + core[1];
    if (tl && tl.shattered) {
      drawShatter(p, C, W, H, D, { mesh: M, view, cx, cy, burstN: st.burstN ?? 1200, impact: st.impact ?? true }, fX, fY, M.r / 74, K, FH, fillPoly);
      return frame;
    }

    // 0b. the pours' flame BEHIND the crystal (a crack on the far side, or the part of a stream that has gone behind
    //     it): drawn first, so the crystal covers it; its light shows through the glass only faintly
    if (tl && jets) {
      let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
      for (const [x, y] of hull) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      bx0 = Math.max(0, Math.floor(bx0)); by0 = Math.max(0, Math.floor(by0)); bx1 = Math.min(W - 1, Math.ceil(bx1)); by1 = Math.min(H - 1, Math.ceil(by1));
      const bw = bx1 - bx0 + 1, before = new Uint32Array(bw * Math.max(0, by1 - by0 + 1));
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) before[(y - by0) * bw + x - bx0] = Lb[y * W + x];
      jets.forEach((j, i) => drawJet(p, D, i, j, view, cx, cy, mcz, M.r / 74, FH, "back"));
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        if (inside(x + 0.5, y + 0.5) < 0) continue;
        const i = y * W + x, o = before[(y - by0) * bw + x - bx0], n = Lb[i];
        if (n === o) continue;
        const k = 0.3, ch = (sh) => (((o >>> sh) & 255) + ((((n >>> sh) & 255) - ((o >>> sh) & 255)) * k)) | 0;
        Lb[i] = (255 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0);
      }
    }

    // 1. the rim: the hull stamped one pixel out each way (ice.md §4g)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) fillPoly(W, H, hull.map(([x, y]) => [x + dx, y + dy]), (x, y) => (C[y * W + x] = K(0)));
    if (white) { fillPoly(W, H, hull, (x, y) => (C[y * W + x] = WHITE)); return frame; }

    // 2. the inner walls (back faces), seen through the front glass, lit green round the soul
    // the soul sits at the crystal's centre (the user, 2026-11-10). The orb sits a little below the midpoint of the
    // two points, so the orb AND the flames rising off it are centred together.
    const back = faces.filter((f) => !f.front).sort((a, b) => a.z - b.z);
    for (const f of back) {
      const inLit = Math.max(0, -(f.nz)) * 0.25 + f.lit * 0.25;
      const base = rv < 1 ? lerpC(K(0), K(1 + Math.round(inLit * 3)), rv) : K(1 + Math.round(inLit * 3));
      fillPoly(W, H, f.pts, (x, y) => {
        const d = Math.hypot(x - fX, (y - fY + 14) * 0.75), g = clamp(1 - d / (M.r * 1.15)) * 0.6 * Math.min(1.4, flameK) * (0.45 + 0.55 * rv);
        const c0 = g > 0.04 ? lerpC(base, FH[5], g * g) : base;
        // the build-up: the inside turns white, strongest round the soul
        C[y * W + x] = inner > 0 ? lerpC(c0, WHITE, inner * (0.55 + 0.45 * clamp(1 - d / (M.r * 1.4)))) : c0;
      });
    }

    // 3. the soul fire, sealed inside: the merged ball fire, clipped to the inside of the hull. A hit or a new crack
    //    stage makes it rage for a moment.
    const fp = painterFor(fire);
    fp.place(fX, fY);
    let deathRage = 1;
    if (tl) { deathRage += 0.9 * tl.crystalWhite; for (const j of DEATH.jets) { const f = D - j; if (f >= 0 && f < 0.8) deathRage += 0.7 * (1 - f / 0.8); } for (const j of DEATH.pours) { const f = D - j; if (f >= 0 && f < 0.5) deathRage += 0.5 * (1 - f / 0.5); } if (D >= DEATH.crack) deathRage += 0.35; deathRage += 0.9 * (tl.surge ?? 0); }
    soulOpts.rage = (st.rage ?? 1) * (1 + 0.1 * Math.min(3, stage)) * (1 + 0.45 * Math.max(0, 1 - hitA / 0.7)) * deathRage;
    soul.draw(fp, t, Math.min(1.6, flameK) * (0.45 + 0.55 * rv));
    const FC = fire.color, FL = fire.light;
    const FX0 = Math.max(0, Math.floor(fX - 90)), FX1 = Math.min(W - 1, Math.ceil(fX + 90)), FY0 = Math.max(0, Math.floor(fY - 170)), FY1 = Math.min(H - 1, Math.ceil(fY + 60));
    for (let y = FY0; y <= FY1; y++) for (let x = FX0; x <= FX1; x++) {
      const i = y * W + x, c = FC[i];
      if (FL[i]) Lb[i] = addL(Lb[i], FL[i], 0.85 * (0.35 + 0.65 * rv) * (opOn ? 1 - 0.95 * opAt(x, y) : 1));
      if (!c || (c >>> 24) < 128) continue;
      if (inside(x + 0.5, y + 0.5) < 3) continue;
      C[i] = inner > 0 ? lerpC(c, WHITE, inner * 0.9) : c; flameMask[i] = 1;
    }

    // 4. the front faces: red glass over the walls and the fire, far to near
    const glass = st.glass ?? 0.78, see = st.flameSee ?? 0.6;
    const front = faces.filter((f) => f.front).sort((a, b) => a.z - b.z);
    const lift = hitA < 0.16 ? 2 : hitA < 0.3 ? 1 : 0;
    for (const f of front) {
      const step = clamp(Math.round(1 + Math.pow(f.lit, 1.6) * 5.2) + lift, 1, lift ? 7 : 6);
      const [g0, g1, g2] = f.pts, farea = Math.abs((g1[0] - g0[0]) * (g2[1] - g0[1]) - (g1[1] - g0[1]) * (g2[0] - g0[0])) / 2;
      // a mirror flash whitens a small facet; on a big one it is a pale sheen, or the crystal shows a white slab
      const flash = f.spec > 0.985 && farea <= 260, sheen = f.spec > 0.985 && farea > 260;
      const fk = facetK(f.fi), col0 = flash && fk > 0.9 ? WHITE : sheen ? K(6) : K(step), col = col0;
      // lit facets mirror more of the room (more opaque); deep ones show more of the inside
      const a = clamp(glass * (0.6 + 0.4 * f.lit) + (flash ? 1 : 0));
      const [q0, q1, q2] = f.pts, area = Math.abs((q1[0] - q0[0]) * (q2[1] - q0[1]) - (q1[1] - q0[1]) * (q2[0] - q0[0])) / 2;
      const big = !flash && area > 260, Rf = Math.sqrt(area);
      fillPoly(W, H, f.pts, (x, y) => {
        const i = y * W + x, below = C[i];
        let c = col;
        if (big) {
          const d = x - f.cx + (y - f.cy) * 0.8;
          if (step >= 3 && y < f.cy && (Math.abs(d + Rf * 0.42) < 0.7 || Math.abs(d + Rf * 0.24) < 0.5)) c = K(Math.min(7, step + 2));
        }
        if (!flash && step >= 5 && ((x * 73856093) ^ (y * 19349663)) % 997 < 26) c = K(7);
        if (fk < 1) c = lerpC(K(0), c, fk);   // the unveil: unlit facets stay dark glass
        const op = opOn ? (sw ? opU(uFace(f, x + 0.5, y + 0.5)) : op0) : 0;
        if (flameMask[i]) {
          // over the soul: the glass tints it, but lets the green through (unless it is opaque)
          const k = a * (1 - see);
          C[i] = lerpC(below, c, k + (1 - k) * op);
        } else C[i] = lerpC(below, c, a + (1 - a) * op);
      });
    }

    // 5. back edges through the glass, dashed (painted transparency, ice.md §4g)
    if (st.backEdges !== false && rv > 0.6 && opG < 0.5)
      for (const f of back)
        for (let k = 0; k < 3; k++) {
          const [x0, y0] = f.pts[k], [x1, y1] = f.pts[(k + 1) % 3];
          line(x0, y0, x1, y1, (x, y, n) => { if (n % 2 || x < 0 || y < 0 || x >= W || y >= H) return; const i = y * W + x; if (!flameMask[i]) C[i] = lerpC(C[i], K(5), 0.45); });
        }

    // 6. cracks: on the surface, turning with it, glowing with the soul (newest stage draws in from its hub)
    const shown = Math.min(M.cracks.length, stage);
    for (let s = 0; s < shown; s++) {
      const rev = s === shown - 1 ? clamp(since(stageT) / 0.35) : 1;
      for (const crack of M.cracks[s]) {
        const n = Math.max(2, Math.ceil(crack.length * rev));
        for (let k = 0; k < n - 1; k++) {
          const a = view(crack[k]), b = view(crack[k + 1]);
          if (a[2] < mcz - 2 || b[2] < mcz - 2) continue;             // on the far side: hidden
          const ax = cx + a[0], ay = cy + a[1], bx = cx + b[0], by = cy + b[1];
          line(ax + 1, ay + 1, bx + 1, by + 1, (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) C[y * W + x] = K(0); });
          line(ax, ay, bx, by, (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) C[y * W + x] = s === shown - 1 && rev < 1 ? WHITE : crackC; });
          p.glowLine(ax, ay, bx, by, 4, FH[4], 0.1 * Math.min(1.5, flameK));
        }
      }
    }

    // 7. edges: pale on lit facets, quiet on deep ones
    for (const f of front)
      for (let k = 0; k < 3; k++) {
        if (facetK(f.fi) < 0.5) break;
        const [x0, y0] = f.pts[k], [x1, y1] = f.pts[(k + 1) % 3];
        const c = f.lit > 0.75 ? K(7) : f.lit > 0.5 ? K(6) : f.lit > 0.28 ? K(5) : K(2);
        line(x0, y0, x1, y1, (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) C[y * W + x] = c; });
      }
    // the outer silhouette stays dark (the rim), so redraw the hull edge
    for (let k = 0; k < hull.length; k++) {
      const [x0, y0] = hull[k], [x1, y1] = hull[(k + 1) % hull.length];
      line(x0, y0, x1, y1, (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) C[y * W + x] = K(1); });
    }
    // 7b. the sweep, facet by facet (see SWD above): stepped white core / pale red / red, scaled by how much the facet
    // faces the light; the facet flushes as a line nears it; then its edges flare where a line crosses them
    if (sw && sw.k > 0.01) {
      for (const f of front) {
        const kf = sw.k * (0.3 + 0.7 * clamp(0.55 * f.lit + 0.45 * f.nz)), cl = nearLine(uFace(f, f.cx, f.cy)), flush = kf * cl.k * 0.28 * clamp(1 - cl.d * 0.02 / 0.1);
        fillPoly(W, H, f.pts, (x, y) => {
          const i = y * W + x, L = nearLine(uFace(f, x + 0.5, y + 0.5)), d = L.d, k = kf * L.k;
          if (flush > 0.03) C[i] = lerpC(C[i], K(6), Math.round(flush * 8) / 8);
          if (d < 0.02) { C[i] = lerpC(C[i], WHITE, 0.85 * k); Lb[i] = addL(Lb[i], WHITE, 0.3 * k); }
          else if (d < 0.045) { C[i] = lerpC(C[i], K(7), 0.6 * k); Lb[i] = addL(Lb[i], RED[6], 0.15 * k); }
          else if (d < 0.08) C[i] = lerpC(C[i], K(6), 0.3 * k);
        });
      }
      for (const f of front)
        for (let e = 0; e < 3; e++) {
          const [x0, y0] = f.pts[e], [x1, y1] = f.pts[(e + 1) % 3];
          line(x0, y0, x1, y1, (x, y) => {
            if (x < 0 || y < 0 || x >= W || y >= H) return;
            const L = nearLine(uFace(f, x + 0.5, y + 0.5));
            if (L.d < 0.1) { const i = y * W + x, k = sw.k * L.k * (1 - L.d / 0.1); C[i] = lerpC(C[i], WHITE, 0.9 * k); Lb[i] = addL(Lb[i], RED[6], 0.35 * k); }
          });
        }
    }
    // 8. glints, and the light it gives off: a faint red halo and the soul's green through it
    for (const f of front) if (rv > 0.85 && f.spec > 0.95 && f.spec <= 0.985) sparkle(p, f.cx, f.cy, Math.round(2 + (f.spec - 0.95) * 80), RED[6], RED[5], 0.35);
    // the apex catches the light when it faces it
    p.glow(cx, cy, 46, RED[4], 0.08 * rv);
    // the build-up: white light swelling inside, from the soul out to the walls. Light adds over the glass, so the
    // glass and the "soul shows through" share stay as they are; banded into steps so it stays pixel art.
    if (inner > 0) {
      const RW = M.r * 1.5;
      fillPoly(W, H, hull, (x, y) => {
        const d = Math.hypot(x - fX, (y - fY) * 0.8) / RW, k = inner * (d < 0.35 ? 0.55 : d < 0.65 ? 0.36 : d < 1 ? 0.2 : 0.1);
        Lb[y * W + x] = addL(Lb[y * W + x], WHITE, k);
      });
    }
    if (tl && tl.crystalWhite > 0.01) {
      const k = tl.crystalWhite;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) fillPoly(W, H, hull.map(([x, y]) => [x + dx, y + dy]), (x, y) => { const i = y * W + x; C[i] = lerpC(C[i], WHITE, k); });
      p.glow(fX, fY, M.r * 2.2, WHITE, 0.35 * k);
    }
    // 9. its light. Additive, banded into a few steps so it reads as pixel art.
    //    Rays come FROM THE CRACKS (the user, 2026-11-10): the soul's light escaping through the wounds, so an
    //    intact crystal has none and every damage stage adds more. Each beam is a cone in 3D: it leaves its crack
    //    along the surface normal (bent a little straight out from the soul), and is posed with the crystal every
    //    frame, so it swings round as the crystal turns, foreshortens as it points at the camera (and widens and
    //    brightens, since we look down it), and on the far side the crystal itself hides it.
    const rays = st.rays ?? 1, glowOn = st.glow !== false, fl = 0.85 + 0.15 * Math.sin(t * 7.3) * Math.sin(t * 2.9 + 1);
    if (rays > 0 || glowOn) {
      hullMask.fill(0);
      fillPoly(W, H, hull, (x, y) => (hullMask[y * W + x] = 1));
    }
    if (rays > 0 && stage > 0) {
      const str = (rays > 1 ? 1.25 : 0.8) * Math.min(1.4, 0.85 + 0.15 * (st.rage ?? 1)), rcol = st.rayColor ?? "green";
      const G = lerpC(mix(FH[2], FH[3], 0.5), WHITE, inner * 0.7), Rd = RED[5], SZ = M.r / 74, stream = st.rayMotion === "stream";
      const breath = 0.95 + 0.05 * Math.sin(t * TAU * 0.4);      // a slow, slight breath in brightness only
      // during the death's jets the beams step back, so the soul pouring out is what reads
      const beamDim = D != null && D >= DEATH.jets[0] - 0.3 ? 0.5 : 1;
      for (let s = 0; s < shown; s++) {
        // birth: the beams BURST out of the new cracks (the user, 2026-11-10: faster) — 0.1 s to full length with a
        // little overshoot, and a white-hot flash that fades over 0.3 s
        const age = s === shown - 1 ? since(stageT) : 99, gr0 = clamp((age - 0.06) / 0.1);
        const grow = gr0 * (1 + 0.14 * Math.max(0, 1 - Math.abs(age - 0.16) / 0.12)), burst = 1 + 1.3 * Math.max(0, 1 - (age - 0.06) / 0.3);
        if (grow <= 0) continue;
        for (const bm of M.beams[s] ?? []) {
          const P = view(bm.p), Dv = view(bm.d), Nv = view(bm.n), behind = Nv[2] < 0;
          const sx = cx + P[0], sy = cy + P[1];
          const L = M.r * (bm.main ? 2.7 : 1.6) * (rays > 1 ? 1.25 : 1) * grow;     // rigid: no idle sway or pumping
          const ex = sx + Dv[0] * L, ey = sy + Dv[1] * L, len = Math.hypot(ex - sx, ey - sy);
          const toward = Math.max(0, Dv[2]);
          const w0 = (bm.main ? 2.6 : 1.3) * SZ, w1 = (bm.main ? 15 : 7) * SZ * (1 + 0.7 * toward);
          const I = (bm.main ? 1 : 0.6) * (0.6 + 0.5 * toward) * breath * str * Math.min(burst, 2.2) * beamDim * clamp((rv - 0.55) / 0.45) * (1 - opG);
          if (len >= 2) {
            const ax = (ex - sx) / len, ay = (ey - sy) / len, nx = -ay, ny = ax;
            const quad = [[sx + nx * w0, sy + ny * w0], [ex + nx * w1, ey + ny * w1], [ex - nx * w1, ey - ny * w1], [sx - nx * w0, sy - ny * w0]];
            fillPoly(W, H, quad, (x, y) => {
              if (st.floorClip !== false && y > st.floorY + 3) return; // a beam aimed down stops at the floor (none in the dark void)
              const qx = x + 0.5 - sx, qy = y + 0.5 - sy, u = (qx * ax + qy * ay) / len;
              if (u < 0 || u > 1) return;
              const v = Math.abs(qx * nx + qy * ny) / (w0 + (w1 - w0) * u);
              if (v > 1) return;
              const i = y * W + x;
              let k = I * Math.pow(1 - u, 1.1) * (v < 0.3 ? 1 : v < 0.62 ? 0.62 : 0.3);
              // optional motion that keeps the beam itself still: light streaming OUT along it in soft pulses
              if (stream) { const ph = (u * len) / (16 * SZ) - t * 1.4; k *= ph - Math.floor(ph) < 0.4 ? 1.15 : 0.8; }
              if (behind && hullMask[i]) k *= 0.12;                // the crystal hides a beam on its far side
              k = Math.round(k * 10) / 10;
              if (k <= 0) return;
              const col = rcol === "green" ? G : rcol === "red" ? Rd : lerpC(G, Rd, clamp(u * 1.4));
              Lb[i] = addL(Lb[i], col, k);
            });
          }
          // the crack's mouth flares where the beam leaves it (only seen from the front)
          if (!behind) p.glow(sx, sy, (bm.main ? 9 : 5) * SZ, burst > 1.05 ? WHITE : G, 0.55 * I * gr0);
        }
      }
    }

    if (glowOn) {
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      for (const [x, y] of hull) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      const PAD = Math.round(M.r * 0.42), BANDS = [[0.14, 0.46], [0.32, 0.28], [0.58, 0.15], [1, 0.07]];
      const breathe = 0.88 + 0.12 * fl;
      for (let y = Math.max(0, Math.floor(by0 - PAD)); y <= Math.min(H - 1, Math.ceil(by1 + PAD)); y++)
        for (let x = Math.max(0, Math.floor(bx0 - PAD)); x <= Math.min(W - 1, Math.ceil(bx1 + PAD)); x++) {
          const i = y * W + x;
          if (hullMask[i]) continue;
          const od = -inside(x + 0.5, y + 0.5) / (PAD * breathe);
          if (od >= 1) continue;
          const a = (od < 0.14 ? 0.46 : od < 0.32 ? 0.28 : od < 0.58 ? 0.15 : 0.07) * rv * rv;
          if (a < 0.02) continue;
          const c = C[i], ca = c >>> 24;
          if (!ca) C[i] = (Math.round(a * 255) << 24) | (RED[4] & 0xffffff);
          else if (ca === 255) C[i] = lerpC(c, RED[4], a);
          if (od < 0.32) Lb[i] = addL(Lb[i], RED[6], 0.06 * fl * rv);
        }
    }

    // the death's pours of soul flame: the part of each stream in front of the crystal
    if (tl && jets) jets.forEach((j, i) => drawJet(p, D, i, j, view, cx, cy, mcz, M.r / 74, FH, "front"));

    // debris on a hit (ice.md §5: rigid pieces that tumble, bounce, skid and fade): shards of red glass flung off
    // the struck side, a spray of glitter, and a few sparks of the soul escaping through the wound
    if (hitA < 1.5 && st.debris !== false) {   // st.debris false: the shake and white frame without the shards
      const R = new Rng(Math.floor((st.hitT ?? 0) * 1000) + 7), side = st.hitSide ?? 1;
      const ix = cx - side * M.r * 0.7, iy = cy + (M.bot - M.top) / 2 + R.range(-18, 4);
      if (hitA < 0.12) sparkle(p, ix, iy, Math.round(10 * (1 - hitA / 0.12)) + 2, RED[7], RED[6], 0.9);
      const hashA = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;
      const DS = M.r / 46;
      for (let k = 0; k < 34; k++) {
        const big = k < 11;
        let x = ix + R.range(-4, 4) * DS, y = iy + R.range(-10, 10) * DS, vx = (-side * R.range(25, 120) + R.range(-25, 25)) * DS, vy = -R.range(30, 110) * DS;
        const spin = R.range(-16, 16), a0 = R.range(0, TAU), sz = (big ? R.range(2.8, 5) : R.range(1.2, 2.6)) * Math.sqrt(DS) * 1.15, life = R.range(0.9, 1.45);
        const nv = big && R.next() < 0.5 ? 4 : 3, jit = [R.range(0.6, 1), R.range(0.6, 1), R.range(0.6, 1), R.range(0.6, 1)];
        if (hitA > life) continue;
        let tt = 0, bounces = 0;
        while (tt < hitA) {
          const h = Math.min(1 / 60, hitA - tt);
          vy += 320 * DS * h; x += vx * h; y += vy * h; tt += h;
          if (y > fy - 1) { y = fy - 1; if (bounces < 2) { vy = -Math.abs(vy) * 0.32; vx *= 0.6; bounces++; } else { vy = 0; vx *= 0.88; } }
        }
        const ang = a0 + spin * Math.min(hitA, 0.8 + 0.1 * bounces), fade = clamp((life - hitA) / (life * 0.35));
        const pts = Array.from({ length: nv }, (_, q) => { const a = ang + (q / nv) * TAU; return [x + Math.cos(a) * sz * jit[q], y + Math.sin(a) * sz * jit[q] * 0.8]; });
        const step = hitA < 0.07 ? -1 : clamp(Math.round(3 + 3 * (0.5 + 0.5 * Math.cos(ang * 1.7))), 2, 6);
        const face = step < 0 ? WHITE : K(step);
        fillPoly(W, H, pts.map(([u, v]) => [u + 1, v + 1]), (X, Y) => { if (hashA(X, Y) < fade) C[Y * W + X] = K(0); });
        fillPoly(W, H, pts, (X, Y) => { if (hashA(X, Y) < fade) C[Y * W + X] = face; });
        if (big && step >= 4) { const [hx, hy] = pts.reduce((m, q) => (q[1] < m[1] ? q : m)); const X = Math.floor(hx), Y = Math.floor(hy); if (X >= 0 && Y >= 0 && X < W && Y < H) C[Y * W + X] = K(7); }
        if (hitA < 0.1) p.glow(x, y, 5, RED[6], 0.35);
      }
      for (let k = 0; k < 48; k++) {
        const vx = (-side * R.range(10, 140) + R.range(-40, 40)) * DS, vy = -R.range(10, 120) * DS, life = R.range(0.35, 0.8), tw = R.range(0, TAU);
        if (hitA > life) continue;
        const x = ix + vx * hitA, y = iy + vy * hitA + 140 * DS * hitA * hitA;
        if (y > fy) continue;
        const X = Math.floor(x), Y = Math.floor(y);
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const tw2 = Math.sin(hitA * 40 + tw);
        if (hitA > life * 0.6 && tw2 < 0) continue;
        C[Y * W + X] = tw2 > 0.6 ? WHITE : tw2 > -0.2 ? RED[7] : RED[6];
      }
      const EMB = [FH[1], FH[2], FH[4], FH[6]];
      for (let k = 0; k < 12; k++) {
        const vx = -side * R.range(10, 60) + R.range(-15, 15), vy = -R.range(20, 70), life = R.range(0.6, 1.2), ph = R.range(0, 6.3);
        if (hitA > life) continue;
        const x = ix + vx * hitA + 5 * Math.sin(hitA * 3 + ph), y = iy + vy * hitA - 20 * hitA * hitA;
        ember(p, x, y, 1 - hitA / life, k < 3 ? 2 : 1.3, EMB, hitA * 40 + ph);
      }
    }
    return frame;
  }
  return { frame, draw };
}
function addL(d, c, k) {
  const r = Math.min(255, (d & 255) + (c & 255) * k) | 0, g = Math.min(255, ((d >>> 8) & 255) + ((c >>> 8) & 255) * k) | 0, b = Math.min(255, ((d >>> 16) & 255) + ((c >>> 16) & 255) * k) | 0;
  return (255 << 24) | (b << 16) | (g << 8) | r;
}
