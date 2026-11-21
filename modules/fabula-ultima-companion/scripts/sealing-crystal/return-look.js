// ============================================================================
// Nidhogg's return — the camera's view and the closing beat, "his look" (pure:
// no DOM, no Foundry; the show and the Node test use it). WP5 of the port of the
// approved mockup (tools/nidhogg-return-mockup/work/script.js v21: camAt /
// setCam, drawClosing, drawCloseDim, eyeBurst).
//
//   returnView  — the mockup's flat camera ({ s, k } from nidhogg-return.js camAt:
//                 world point A drawn at screen point P, scale s) as a Foundry view
//                 { x, y, scale } on the scene's battle framing: k 0 = the rest
//                 view as given (sidebar shift included), k 1 = his head at 0.42 of
//                 the visible width, mid-height.
//   lookGlow    — his eye and mouth burning up and throbbing (the mockup's halo /
//                 halo / pixels strengths for the part sprites the glow already has).
//   dimAlpha / dimPixels — the dark closing in round the screen's edges: a radial
//                 gradient from his head, on the screen (mockup px), as a texture.
//   eyeBurst    — his eye bursting into flame: a mass of fire puffs flung back and
//                 up out of the eye, embers, a short smoulder (the crystal death's
//                 approved soul-flame recipe), painted into a small frame round the
//                 eye. Facing -1 mirrors it (always flung away from the party).
//   fitFloor    — WP5b: the affine that lays the smoke's (2D canvas) frame on the floor
//                 as the 3D camera draws it (projectFoot of floor points), exact at
//                 his feet; rectMap / frameMatrix / mapPoint / unmapPoint around it.
// ============================================================================

import { hex, Rng } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { firePuff, ember } from "../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";
import { CAMF, CLOSE, BURST } from "./nidhogg-return.js";
import { CROP } from "./return-stage.js";

/* ── The camera ─────────────────────────────────────────────────────────── */

/**
 * The view for camera { s, k } (nidhogg-return.js camAt). rest: this client's rest view { x, y, scale } (the battle
 * framing: the mockup's whole screen); F: the frame on the scene (return-stage frameOn: canvas (cx, cy) = scene
 * (x + k cx, y + k cy)); face: his head, scene px, where it is drawn at rest. The mockup draws world point
 * A = CC + (face - CC) k at screen point P = CC + (at - CC) k with scale s (CC: the screen's middle); here the same,
 * with the screen's middle = the visible middle the rest view frames, and mockup px = F.k scene px at rest.
 */
export function returnView(cam, { rest, F, face }) {
  const s = Number(cam?.s) > 0 ? Number(cam.s) : 1, k = Number(cam?.k) || 0;
  const cx = F.x + F.k * CROP.w / 2, cy = F.y + F.k * CROP.h / 2;          // the stage's middle (the mockup's CC)
  const atX = (CAMF.at.fx - 0.5) * CROP.w * F.k, atY = (CAMF.at.fy - 0.5) * CROP.h * F.k;
  const fx = Number.isFinite(face?.x) ? face.x : cx, fy = Number.isFinite(face?.y) ? face.y : cy;
  return {
    x: cx + k * (fx - cx) - (k * atX + (cx - rest.x)) / s,
    y: cy + k * (fy - cy) - (k * atY + (cy - rest.y)) / s,
    scale: rest.scale * s,
  };
}

/** Where scene point q lands on the screen (px from the window's middle) for view v: Foundry's stage transform. */
export const screenOf = (q, v) => ({ x: (q.x - v.x) * v.scale, y: (q.y - v.y) * v.scale });

/* ── The smoke on the 3D floor (WP5b) ───────────────────────────────────── */

// Affines are PIXI's { a, b, c, d, tx, ty }: x' = a x + c y + tx, y' = b x + d y + ty.

/** Floor points to fit the smoke's frame on (scene px): his feet first (held exactly), then a grid over the stage's
 *  floor (rows from 0.6 of its height down to its bottom edge, the near floor weighing most as it moves most). */
export function floorPoints(stage, feet) {
  const pts = feet ? [{ x: feet.x, y: feet.y }] : [];
  for (const fy of [0.6, 0.7, 0.8, 0.9, 1]) for (const fx of [0, 0.25, 0.5, 0.75, 1]) pts.push({ x: stage.x + fx * stage.w, y: stage.y + fy * stage.h });
  return pts;
}

/**
 * The affine that best carries floor points src[i] (scene px, as the 2D canvas draws them) to dst[i] (where the 3D
 * camera draws them: projectFoot), exact at src[0] (his feet) and least-squares over the rest. Null when the points
 * are degenerate or any is missing.
 */
export function fitFloor(src, dst) {
  if (!src?.length || src.length !== dst?.length || src.length < 3) return null;
  const f = src[0], g = dst[0];
  if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
  let sxx = 0, sxy = 0, syy = 0, ux = 0, uy = 0, vx = 0, vy = 0;
  for (let i = 1; i < src.length; i++) {
    const q = dst[i];
    if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) return null;
    const dx = src[i].x - f.x, dy = src[i].y - f.y, ex = q.x - g.x, ey = q.y - g.y;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    ux += ex * dx; uy += ex * dy; vx += ey * dx; vy += ey * dy;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-9 * (sxx * syy || 1))) return null;
  const a = (ux * syy - uy * sxy) / det, c = (uy * sxx - ux * sxy) / det;
  const b = (vx * syy - vy * sxy) / det, d = (vy * sxx - vx * sxy) / det;
  return { a, b, c, d, tx: g.x - a * f.x - c * f.y, ty: g.y - b * f.x - d * f.y };
}

/** A translation as an affine. */
export const shiftOf = (dx, dy) => ({ a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy });
/** The similarity that carries a rect drawn at R0 onto the same thing drawn at R (his sprite: uniform scale). */
export function rectMap(R0, R) {
  const s = R0?.w > 0 && R?.w > 0 ? R.w / R0.w : 1;
  return { a: s, b: 0, c: 0, d: s, tx: R.x - R0.x * s, ty: R.y - R0.y * s };
}
/** Affine A after the frame F (local px u -> scene F + F.k u): the container's matrix. */
export const frameMatrix = (A, F) => ({ a: A.a * F.k, b: A.b * F.k, c: A.c * F.k, d: A.d * F.k, tx: A.a * F.x + A.c * F.y + A.tx, ty: A.b * F.x + A.d * F.y + A.ty });
/** Point p through affine m. */
export const mapPoint = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty });
/** Point p back through affine m (null if m is singular). */
export function unmapPoint(m, p) {
  const det = m.a * m.d - m.b * m.c;
  if (!det) return null;
  const x = p.x - m.tx, y = p.y - m.ty;
  return { x: (m.d * x - m.c * y) / det, y: (m.a * y - m.b * x) / det };
}

/* ── His look: eye and mouth ───────────────────────────────────────────── */

/**
 * The part sprites' strengths while the look plays (S = closeK, beat = throb): [halo wide, halo tight, pixels] per
 * part, as the mockup's drawClosing draws them (its drawDragon caps each at 1 and skips under 0.004).
 */
export function lookGlow(S, beat) {
  const a = (v) => (v <= 0.004 ? 0 : Math.min(1, v));
  return {
    eyes: [a(0.85 * S * beat), a(0.6 * S * beat), a(S)],
    mouth: [a(0.4 * S * beat), 0, a(0.65 * S)],
    claws: [0, 0, 0],
  };
}

/* ── His look: the dark round the edges ─────────────────────────────────── */

/** The gradient (mockup screen px): clear inside r0 of his head, 0.62 of the dark at 0.3 of the way, all of it at r1. */
export const DIM = Object.freeze({ r0: 90, r1: Math.hypot(CROP.w, CROP.h) * 0.6, mid: 0.3, midA: 0.62 });

/** The dark's alpha at r mockup px from his head, for strength S (closeK); CLOSE.dim at the rim. */
export function dimAlpha(r, S = 1) {
  const t = (r - DIM.r0) / (DIM.r1 - DIM.r0);
  const f = t <= 0 ? 0 : t < DIM.mid ? DIM.midA * (t / DIM.mid) : t < 1 ? DIM.midA + (1 - DIM.midA) * ((t - DIM.mid) / (1 - DIM.mid)) : 1;
  return CLOSE.dim * S * f;
}

/** The texture: N x N straight RGBA, black, alpha = the gradient / CLOSE.dim (the sprite's alpha brings CLOSE.dim * S);
 * its middle is his head and `reach` mockup px from it is the texture's edge (N / 2 px). */
export function dimPixels(N = 512, reach = 2 * DIM.r1) {
  const d = new Uint8ClampedArray(N * N * 4), c = N / 2, k = reach / c;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x + 0.5 - c, y + 0.5 - c) * k;
    d[(y * N + x) * 4 + 3] = Math.round((255 * dimAlpha(r, 1)) / CLOSE.dim);
  }
  return d;
}

/* ── His look: the eye bursts into flame ───────────────────────────────── */

/** The burst's frame round his eye (effect px): the mockup's 200 x 150, the eye 140 px from its back edge, 105 down. */
export const LOOK_FRAME = Object.freeze({ W: 200, H: 150, back: 140, up: 105 });
/** The frame's origin (effect px) for his eye (effect px) and facing (+1: he faces x+, the burst flies to x-). */
export const lookFrameAt = (eye, facing = 1) => ({
  ox: Math.round(eye.x) - (facing >= 0 ? LOOK_FRAME.back : LOOK_FRAME.W - LOOK_FRAME.back),
  oy: Math.round(eye.y) - LOOK_FRAME.up,
});

// (kept to the bright half of the soul ramp: cooled to dark teal, their rims read as bubbles over his dark head)
export const IG = Object.freeze(["#ffffff", "#e9ffe4", "#b8ffad", "#7dff7e", "#5dff6e", "#5dff6e", "#3cd66c", "#3cd66c", "#22a86c"].map(hex));
export const EMB = Object.freeze([hex("#ffffff"), hex("#a6ff9c"), hex("#3cd66c"), hex("#178066")]);

/**
 * Paint the burst at u (s since the look began) with painter p (effect px), from his eye { x, y }: n puffs
 * front-loaded over BURST.emit, a fan back and up (-2.65 +- 0.8 rad, mirrored for facing -1), dragged to a stop,
 * rising as they cool; 14 embers; a smoulder of 30 small rising puffs; the socket white-hot, then glowing.
 * Returns false when nothing of it is up. With facing +1 it paints what the mockup's eyeBurst paints, pixel for pixel.
 */
export function eyeBurst(p, u, eye, n = 220, facing = 1) {
  const f = u - BURST.t;
  if (f < 0 || f > 2) return false;
  const fs = facing >= 0 ? 1 : -1, R = new Rng(7331), EX = eye.x, EY = eye.y;
  for (let k = 0; k < n; k++) {
    const tb = BURST.emit * Math.pow(R.next(), 1.6);
    const an = -2.65 + (R.next() + R.next() - 1) * 0.8;                  // back and up, a fan
    const sp = 150 + 330 * Math.pow(R.next(), 1.2), life = R.range(0.25, 0.6), size = R.range(1.6, 4.4), frac = R.next();
    const tau = f - tb;
    if (tau < 0 || tau > life) continue;
    const e = ((1 - Math.exp(-3.4 * tau)) / 3.4) * sp;
    const x = EX + fs * (Math.cos(an) * e), y = EY + Math.sin(an) * e - 0.5 * 130 * tau * tau;
    firePuff(p, x, y, 1 - tau / life, size * (1 + 0.6 * Math.max(0, 1 - tau / 0.15)), frac, IG, 0.16);
  }
  // embers flung out with it, wandering up and cooling
  for (let k = 0; k < 14; k++) {
    const tb = BURST.emit * R.next(), an = -2.65 + (R.next() - 0.5) * 2.2, sp = R.range(90, 260), life = R.range(0.5, 1.1), sz = R.next() < 0.2 ? 2 : 1, ph = R.range(0, 6.3);
    const tau = f - tb;
    if (tau < 0 || tau > life) continue;
    const e = ((1 - Math.exp(-2.6 * tau)) / 2.6) * sp;
    ember(p, EX + fs * (Math.cos(an) * e) + fs * (3 * Math.sin(tau * 9 + ph)), EY + Math.sin(an) * e - 0.5 * 40 * tau * tau, 1 - tau / life, sz, EMB, tau * 40 + ph);
  }
  // the smoulder: small puffs rising off the eye, fewer and fewer
  for (let k = 0; k < 30; k++) {
    const tb = BURST.emit + BURST.smoulder * Math.pow(k / 30, 1.4), life = R.range(0.3, 0.55), size = R.range(1, 2.2) * (1 - 0.5 * k / 30), frac = R.next(), dx = R.range(-8, -2);
    const tau = f - tb;
    if (tau < 0 || tau > life) continue;
    firePuff(p, EX + fs * (dx * tau * 3), EY - 1 - 30 * tau - 20 * tau * tau, 1 - tau / life, size, frac, IG, 0.12);
  }
  // the socket: white-hot as it tears open, then a hot glow while it smoulders
  const hot = Math.max(0, 1 - f / 0.22), sm = Math.max(0, 1 - f / (BURST.emit + BURST.smoulder));
  p.glow(EX, EY, 6 + 12 * hot, IG[3], 0.25 * sm + 0.5 * hot);
  if (hot > 0) p.glow(EX, EY, 3 + 3 * hot, IG[1], 0.8 * hot);
  return true;
}
