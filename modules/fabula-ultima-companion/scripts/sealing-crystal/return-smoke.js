// ============================================================================
// Nidhogg's return, phase 2: the dark blown off him as 3D smoke. A port of the
// approved mockup's fx/break-smoke.js (tools/nidhogg-return-mockup, v21; the user
// picked v16 as THE version, v17 = the speed-only cull, pixel-identical). Only the
// imports and the export name changed; every rule and number is the mockup's, and
// the comments carry the user's rulings. Pure: no DOM, no Foundry (Worker-safe).
// Pixel identity with the mockup: return-smoke.test.mjs (fixtures/return-smoke.json).
// ============================================================================
// Phase 2 of Nidhogg's return: his dragon form breaks through the dark, and the dark is blown away as smoke.
//
// The black void becomes a bed of black smoke lying on the Great Seal's floor, in 3D: every billow is a lobe with a
// world position (X across, Y up, Z away from the camera, metres) seen through a camera fitted to the painting (its
// horizon solved from the seal's concentric rings, ~stage row -590). From his feet a shock front runs out over the
// floor, slowing as it goes; as it reaches each billow, the billow is thrown outward along the floor and up, swells
// and thins out. Billows in front of him fly toward the camera and grow; far ones shrink into the back. Behind the
// front the black itself clears, so the arena is uncovered from under him outward.
// Everything is a function of the time since he broke through (tau), so the page can scrub it.
import { Rng, mix, hex, clamp, noise2 } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { cloudFast as cloud } from "./smoke-cloud.js";

const SMOKE = ["#000000", "#040605", "#090d0b", "#101714", "#18221d", "#223029", "#2f4038"].map(hex);
const SOUL = ["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2"].map(hex);
// lit from below by the seal's green glow as the floor is uncovered
const LIT = SMOKE.map((c, i) => mix(c, SOUL[Math.min(6, i + 1)], 0.45));
const FACE_R = 95, FACE_SQ = 0.85;   // the face's clear circle round the mouth (effect px), a little flattened
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };
const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
// the blast (shock front) and the black's clearing behind it; the veil's numbers are shared with returnVeil()
const BLAST = Object.freeze({ RMAX: 17, TAU: 0.9, clearBehind: 1.0, band: 0.9, life: Object.freeze([1.0, 1.7]), SQ: 0.82, edge: 0.6 });

/**
 * The black over the arena, as a field (WP6): the one rule the Worker's CPU veil (makeReturnSmoke drawVeil), the show's
 * GPU veil (a shader with these uniforms) and the show's edge test all use. Per effect pixel (x, y) the on-screen
 * distance from his mouth in metres at his depth, d = hypot(x + .5 - mx, (y + .5 - my) / sq) / k (float32, as the
 * CPU's table holds it); m = clamp((d - rc(tau)) / band); alpha = 0 at m <= 0, else the 4-step Bayer dither of m.
 * returnVeil(W, H, { cam, at, src }) -> { mx, my, k, sq, band, rc(tau), dist(x, y), alpha8(d, rc, x, y), edge(tau, view) }
 */
export function returnVeil(W, H, { cam, at, src = null }) {
  const S0 = src || { X: at.X, Y: 0, Z: at.Z };
  const { cx, yh, A, F } = cam;
  const mx = cx + (F * S0.X) / S0.Z, my = yh + (A - F * S0.Y) / S0.Z, k = F / S0.Z, sq = BLAST.SQ, band = BLAST.band;
  const frontR = (tau) => (tau <= 0 ? 0 : BLAST.RMAX * (1 - Math.exp(-tau / BLAST.TAU)));
  const rc = (tau) => frontR(tau) - BLAST.clearBehind;
  const dist = (x, y) => Math.fround(Math.hypot(x + 0.5 - mx, (y + 0.5 - my) / sq) / k);
  /** The veil's alpha byte (0, 64, 128, 191, 255) at pixel (x, y) for distance d (float32) and rc. */
  const alpha8 = (d, r, x, y) => {
    const m = clamp((d - r) / band);
    if (m <= 0) return 0;
    const q = m * 4, b = Math.floor(q), kk = (b + (q - b > BAY[((y & 3) << 2) | (x & 3)] ? 1 : 0)) / 4;
    return kk <= 0 ? 0 : Math.round(255 * kk) & 255;
  };
  /** The veil's clip (drawVeil's integer bounds) for a view, or the whole buffer. */
  const clip = (view) => (view ? [Math.max(0, view.x0 | 0), Math.max(0, view.y0 | 0), Math.min(W, Math.ceil(view.x1)), Math.min(H, Math.ceil(view.y1))] : [0, 0, W, H]);
  /** Does the veil (as drawVeil paints it) have a pixel on the buffers' edge? (the window outside them stays black then) */
  const edge = (tau, view = null) => {
    if (tau <= 0) return true;
    const r = rc(tau), [x0, y0, x1, y1] = clip(view);
    if (x1 <= x0 || y1 <= y0) return false;
    const hit = (x, y) => alpha8(dist(x, y), r, x, y) > 0;
    if (y0 === 0) for (let x = x0; x < x1; x++) if (hit(x, 0)) return true;
    if (y1 === H) for (let x = x0; x < x1; x++) if (hit(x, H - 1)) return true;
    if (x0 === 0) for (let y = y0; y < y1; y++) if (hit(0, y)) return true;
    if (x1 === W) for (let y = y0; y < y1; y++) if (hit(W - 1, y)) return true;
    return false;
  };
  return { mx, my, k, sq, band, rc, frontR, dist, alpha8, clip, edge };
}

/**
 * The camera, in effect px: a floor point (X, 0, Z) is at x = cx + F X / Z, y = yh + A / Z (A = F x camera height).
 * makeReturnSmoke(W, H, { cam: { cx, yh, A, F }, at: { X, Z } (his feet), src: { X, Y, Z } (his mouth), seed,
 *   body: { lobes: [{ X, Y, Z, r }], core: { X, Y, Z } }, under: Uint8Array(W * H), genW })
 *   -> { draw(pBack, pFront, tau, view), drawVeil(C, tau, view), frontR(tau), P, veil (returnVeil), count, doneAt }
 * (The camera is the one fitted to the Great Seal painting at the battle's REST framing, in effect px of the buffers;
 * view = { x0, y0, x1, y1 } in those px, or null for all of them.)
 */
export function makeReturnSmoke(W, H, { cam, at, src = null, seed = 5, body = null, under = null, genW = W }) {
  // genW: the width the bed of billows is laid out for (the view's width). The buffers (W x H) may be wider, with a
  // margin round the view for the camera's pull-back; the billows stay the same ones.
  // under: optional Uint8Array(W * H), 1 where something other than the black veil lies under the FRONT layer (his
  // sprite). Used only to skip smoke that cannot change a pixel (see `cull` in draw()).
  // src: where the blast comes from (his MOUTH, in the air: the user, 2026-11-15 "the dispersion starts from the source
  // of the roar"). Every distance is measured in 3D from it. `at` (his feet) only splits the billows into the layer
  // behind him and the one in front of him.
  const S0 = src || { X: at.X, Y: 0, Z: at.Z };
  const { cx, yh, A, F } = cam;
  const proj = (X, Y, Z) => ({ x: cx + (F * X) / Z, y: yh + (A - F * Y) / Z, s: F / Z });
  // the shock front over the floor: fast, slowing (R = RMAX (1 - e^(-t / TAU)))
  // the blast front spreads ON SCREEN from his mouth, as the sound rings do (an ellipse, flattened like them), measured
  // in metres at his depth (the user, 2026-11-15: the smoke just under his face cleared before the rest — a floor-3D
  // measure reaches the floor under his head first, which read as a weak patch under his face). The billows are still
  // thrown along the floor, in 3D.
  const P = { ...BLAST, life: [...BLAST.life] };   // edge: how far a billow may lie inside the front, x its radius
  const MS = { x: cx + (F * S0.X) / S0.Z, y: yh + (A - F * S0.Y) / S0.Z, k: F / S0.Z };
  const screenD = (x, y) => Math.hypot(x - MS.x, (y - MS.y) / P.SQ) / MS.k;
  const frontR = (tau) => (tau <= 0 ? 0 : P.RMAX * (1 - Math.exp(-tau / P.TAU)));
  const reachT = (d) => (d >= P.RMAX * 0.999 ? 99 : -P.TAU * Math.log(1 - d / P.RMAX));

  // ---- the bed of smoke: rows spaced so each row's billows overlap the next on screen
  const R = new Rng(seed), lobes = [];
  for (let Z = 8.6; Z < 31; Z *= 1.045) {
    const half = ((genW / 2 + 60) * Z) / F, step = 1.05;
    for (let X = -half + R.range(0, step); X < half; X += step * R.range(0.8, 1.15)) {
      const r = R.range(0.6, 1.0), Zj = Z * R.range(0.985, 1.015), Y0 = r * R.range(0.45, 0.8);
      const sx = cx + (F * X) / Zj, sy = yh + (A - F * Y0) / Zj, d = screenD(sx, sy);
      // thrown OUTWARD ON SCREEN from his mouth, like the rings and the front (the user, 2026-11-15: at 11.6 the smoke
      // edge followed the roar ring everywhere but the bottom: billows in front of him were thrown along the floor
      // toward the camera, dropped off the bottom of the screen at once and left no edge there). The screen push is
      // turned into world motion at the billow's depth: across = X, down/up = toward/away from the camera, so the
      // ones below his face still come toward you and grow, at the ring's pace.
      const ux0 = sx - MS.x, uy0 = sy - MS.y, ul = Math.hypot(ux0, uy0) || 1, ux = ux0 / ul, uy = uy0 / ul;
      const dirX = (ux * Zj) / F, dirZ = (-uy * Zj * Zj) / (A - F * Y0);   // world metres per screen px
      lobes.push({ X, Y: Y0, Z: Zj, r, d, t0: reachT(d), dirX, dirZ,
        v0: 260 + 420 * Math.pow(clamp(1 - d / 12), 1.3) + R.range(-30, 30), vy: R.range(0.6, 1.6), drag: R.range(1.4, 2.0),
        grow: R.range(0.35, 0.8), life: R.range(P.life[0], P.life[1]), b: R.range(0.18, 0.4), ph: R.range(0, 100) });
    }
  }
  // the smoke that hides HIM (the user, 2026-11-15: he stays hidden until the smoke is blown): a stand of billows over
  // his whole figure, just in front of him. They are blown off out from his MOUTH, sideways across the screen (a throw
  // toward the camera made the billows over his face grow and sit on it: his face stayed hidden till late). The ones
  // nearest his mouth go first, fastest, and are gone soonest, so his face is the first of him to show.
  if (body) {
    const c = body.core;
    for (const b of body.lobes) {
      const dx = b.X - c.X, dy = b.Y - c.Y, d3 = Math.hypot(dx, dy);
      // (downward throws are flattened into sideways ones: thrown into the floor, they stopped there in front of his chest)
      let an = d3 > 0.3 ? Math.atan2(dy, dx) : R.range(0, Math.PI * 2);
      if (Math.sin(an) < 0) an = Math.atan2(Math.sin(an) * 0.25, Math.cos(an) || (R.next() < 0.5 ? -1 : 1));
      const near = clamp(1 - d3 / 4);
      lobes.push({ X: b.X, Y: b.Y, Z: b.Z, r: b.r, d: d3, t0: 0.02 + 0.075 * d3 + R.range(0, 0.04), dirX: Math.cos(an), dirY: Math.sin(an), dirZ: -0.15,
        v0: R.range(7, 10) + 6 * near, vy: R.range(0.2, 0.8), drag: R.range(1.6, 2.2), grow: R.range(0.2, 0.5) * (1 - 0.6 * near),
        life: R.range(0.75, 1.15) * (1 - 0.45 * near), b: R.range(0.18, 0.4), ph: R.range(0, 100), body: true });
    }
  }
  // for the black clearing behind the front: per effect pixel, the 3D distance from the source (his mouth, in the air)
  // to the floor point that pixel sees, the SAME measure the floor billows are thrown by. (It was the distance from
  // the mouth to the pixel's whole line of sight: under his face the sight lines pass close by his mouth, so the black
  // there cleared before the smoke on that floor had been thrown, and the smoke there showed thin over the lit floor.)
  // (now: the same on-screen measure as the billows, so the black and the smoke on it always clear together)
  // (WP6: built on the first CPU veil only: with the veil drawn on the GPU this painter never needs it)
  const VEIL = returnVeil(W, H, { cam, at, src });
  let DIST = null;
  const distTable = () => {
    if (DIST) return DIST;
    DIST = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) DIST[y * W + x] = screenD(x + 0.5, y + 0.5);
    return DIST;
  };

  // ---- the cull (speed only; the picture is pixel-identical). A billow not yet thrown is pure black (tone 0, no warm
  // light, full opacity). Where it lies wholly over veil that is still fully black, with no thrown billow anywhere
  // near it (in either layer) and, for the front layer, nothing of him under it, it is black drawn over black: it
  // cannot change a pixel, and its density only shades other unthrown (black) billows. Those are skipped. At the
  // start of the roar that is most of the ~770 billows, and they were most of the cost.
  // Coarse grids of 8 px cells; PAD covers the cloud's blur (2 px), its slope (1 px) and the disc's rounding (1 px).
  const CELL = 8, PAD = 4, GC = Math.ceil(W / CELL), GR = Math.ceil(H / CELL), MOVED = new Uint8Array(GC * GR);
  let UNDER = null;
  if (under) {
    UNDER = new Uint8Array(GC * GR);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (under[y * W + x]) UNDER[((y / CELL) | 0) * GC + ((x / CELL) | 0)] = 1;
  }
  const cellBox = (x, y, r) => [Math.max(0, Math.floor((x - r - PAD) / CELL)), Math.min(GC - 1, Math.floor((x + r + PAD) / CELL)), Math.max(0, Math.floor((y - r - PAD) / CELL)), Math.min(GR - 1, Math.floor((y + r + PAD) / CELL))];
  const markBox = (G, x, y, r) => { const [c0, c1, r0, r1] = cellBox(x, y, r); for (let j = r0; j <= r1; j++) G.fill(1, j * GC + c0, j * GC + c1 + 1); };
  const anyBox = (G, x, y, r) => { const [c0, c1, r0, r1] = cellBox(x, y, r); for (let j = r0; j <= r1; j++) for (let i = c0; i <= c1; i++) if (G[j * GC + i]) return true; return false; };

  // one billow at tau: world position after its throw, its size and opacity
  function lobeAt(q, tau) {
    const u = tau - q.t0;
    if (u <= 0) return { X: q.X, Y: q.Y, Z: q.Z, r: q.r, a: 1, b: 0, lit: 0, still: true };
    const e = (1 - Math.exp(-q.drag * u)) / q.drag;
    const X = q.X + q.dirX * q.v0 * e + 0.25 * noise2(q.ph + u * 0.7, 0.3, seed);
    const Z = q.Z + q.dirZ * q.v0 * e;
    const Y = Math.max(0.25, q.Y + (q.dirY || 0) * q.v0 * e + q.vy * e + 0.35 * u * u);
    const end = smooth(q.life * 0.45, q.life, u);
    return { X, Y, Z, r: q.r * (1 + q.grow * (1 - Math.exp(-1.4 * u))) * (1 - 0.55 * end), a: 1 - Math.pow(end, 1.5), b: q.b * smooth(0, 0.35, u), lit: smooth(0, 0.3, u) * clamp(1.2 - Y / 3) };
  }

  // the billows split at his feet's depth: behind him (drawn before him) and in front (after him)
  // view: the part of the buffers on screen this frame { x0, y0, x1, y1 } (default: all of them); billows wholly
  // outside it are left out. pBack / pFront may be null: that layer is not painted (WP6: the two layers are painted
  // in two Workers at once; each still places EVERY billow, so the cull sees the same thrown billows and each
  // painted layer is the same pixels as when both are painted together)
  // frameH: the painters hold only a band of the buffers' rows (their oy / h; return-painter.js band): the cloud paints
  // those rows of the whole frame (smoke-cloud.js frameH), the same pixels as there
  function draw(pBack, pFront, tau, view = null, frameH = null) {
    const vx0 = view ? view.x0 : 0, vy0 = view ? view.y0 : 0, vx1 = view ? view.x1 : W, vy1 = view ? view.y1 : H;
    const back = [], front = [];
    // the roar's breath keeps his face clear (the user, 2026-11-15: smoke still blocked his face): on screen, a circle
    // round his mouth that opens in the first moments of the roar; any billow in FRONT of him that reaches into it is
    // pushed out to its rim (so the smoke parts round his face), at full density
    const M = proj(S0.X, S0.Y, S0.Z), clr = FACE_R * smooth(0, 0.3, tau);
    // the roar's front itself sweeps the smoke (the user, 2026-11-15: "the gap still persists": at 11.6 the smoke edge
    // followed the ring everywhere but the bottom). Measured: the billows below his face are the nearest to the
    // camera, 40-60 px across against ~25 px at the sides, so although their CENTRES rode the ring, their inner halves
    // reached ~50 px back inside it and merged into one flat black wall well short of the ring. Now no billow may reach
    // inside the front: one whose inner edge does is pushed out along the line from his mouth until its inner edge sits
    // on the front (the same on-screen ellipse the black clears by), so the edge is the ring's shape all the way round.
    const Rf = Math.max(0, frontR(tau) - P.clearBehind) * MS.k;
    // (for the cull: the veil is fully black where the distance is past this, metres)
    const opaqueAt = frontR(tau) - P.clearBehind + P.band, still = [];
    MOVED.fill(0);
    for (const q of lobes) {
      const L = lobeAt(q, tau);
      if (L.a < 0.03 || L.Z < 3.2) continue;
      const s = proj(L.X, L.Y, L.Z), rp = L.r * s.s, isFront = L.Z < at.Z;
      let x = s.x, y = s.y, a = L.a;
      if (Rf > 0) {
        const dx = x - MS.x, dy = y - MS.y, d = Math.hypot(dx, dy);
        if (d > 0.5) {
          const ux = dx / d, uy = dy / d, need = Rf / Math.hypot(ux, uy / P.SQ) + rp * P.edge * (0.35 + 1.3 * ((q.ph * 7.31) % 1));   // varied per billow: a ragged edge, not a clean oval
          if (d < need) { x = MS.x + ux * need; y = MS.y + uy * need; }
        }
      }
      if (isFront && clr > 0) {
        const dx = x - M.x, dy = (y - M.y) / FACE_SQ, d = Math.hypot(dx, dy), need = clr + rp * 0.85;
        if (d < need) { const k = d > 0.5 ? need / d : 0; const an = d > 0.5 ? 0 : q.ph; x = d > 0.5 ? M.x + dx * k : M.x + Math.cos(an) * need; y = d > 0.5 ? M.y + dy * k * FACE_SQ : M.y + Math.sin(an) * need * FACE_SQ; }
      }
      if (x + rp < vx0 - 4 || x - rp > vx1 + 4 || y + rp < vy0 - 4 || y - rp > vy1 + 4) continue;
      const e = { x, y, r: rp, a, b: L.b, w: 0.35 * L.lit * a, k: 0, ph: q.ph, age: 0, z: L.Z };
      if (L.still) still.push([e, isFront]); else { (isFront ? front : back).push(e); markBox(MOVED, x, y, rp); }
    }
    for (const [e, isFront] of still) {
      const far = (Math.hypot(e.x - MS.x, (e.y - MS.y) / P.SQ) - (e.r + PAD) / P.SQ) / MS.k >= opaqueAt;
      if (far && !anyBox(MOVED, e.x, e.y, e.r) && !(isFront && UNDER && anyBox(UNDER, e.x, e.y, e.r))) continue;   // cannot change a pixel
      (isFront ? front : back).push(e);
    }
    // far to near, so nearer billows sit on top inside each layer
    back.sort((a, b) => b.z - a.z); front.sort((a, b) => b.z - a.z);
    const co = { dens: 3.4, max: 1, lit: 1.2, steps: true, ...(frameH != null ? { frameH } : {}) };
    if (pBack) cloud(pBack, back, SMOKE, LIT, co);
    if (pFront) cloud(pFront, front, SMOKE, LIT, co);
  }

  // the black over the arena: whole until he breaks through, then cleared from under him outward, a little behind the
  // front (so the thrown smoke is what is seen at the edge), in dithered steps. Writes straight into an RGBA buffer.
  function drawVeil(C, tau, view = null) {
    if (tau <= 0) { C.fill(0xff000000); return; }
    const D = distTable(), rc = VEIL.rc(tau), [x0, y0, x1, y1] = VEIL.clip(view), a8 = VEIL.alpha8;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x, a = a8(D[i], rc, x, y);
      C[i] = a === 0 ? 0 : (a << 24) >>> 0;
    }
  }
  const lastT = Math.max(...lobes.map((q) => (q.t0 < 50 ? q.t0 + q.life : 0)));
  return { draw, drawVeil, frontR, P, veil: VEIL, count: lobes.length, doneAt: lastT };
}
