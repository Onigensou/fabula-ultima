// ============================================================================
// Nidhogg's return, phase 2 — the stage it is played on (pure: no DOM, no
// Foundry; the show, the Worker inputs and the Node test all use it).
//
// The approved mockup (tools/nidhogg-return-mockup/work/script.js v21) lays phase 2
// out in ITS canvas px: the Great Seal's battle framing (a 1682 x 946 crop of the
// stage), the smoke in effect px (2 canvas px) with a 48 px margin round the view
// and its camera fitted to the painting, the dragon sprite at his token size (1.5
// grid box, contain, texture scale 5) drawn mirrored at (FLOOR.x - DW / 2, DTOP).
//
// The game plays it in THAT frame, laid on the scene's battle framing (frameOn),
// so the bed of smoke covers the view as the mockup's does. Everything that is
// HIS (his feet, the stand of billows that hides him, his mouth where the blast
// and the rings start, the cull mask) is laid on his sprite where the game DRAWS
// it (returnStage(sprite, rect)), with the mockup's offsets scaled to his size:
// measured 2026-11-16 the arena puts him ~157 scene px left of and 20 px below
// the mockup's spot, 1.7 % smaller, so the mockup's fixed numbers would have
// missed him. With the mockup's rect the inputs are the page's exactly
// (return-stage.test.mjs, fixtures/return-smoke.json).
//
// Also here: his glowing parts (eyes, mouth, claws), the roar's rings (the
// mockup's drawRoar painting), the view (the on-screen part of the buffers) and a
// blur for the halos where a 2D canvas has no `filter`.
// ============================================================================

import { hex } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { ROAR, CAMF } from "./nidhogg-return.js";

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

/* ── The mockup's frame (its canvas px) ─────────────────────────────────── */

/** The Great Seal's stage rect and the battle framing's crop of it on a 1920 x 1080 screen (scene px of the painting). */
export const STAGE = Object.freeze({ x: 439, y: 241, w: 1682, h: 788 });
export const CROP = Object.freeze({ x: STAGE.x, y: STAGE.y + STAGE.h / 2 - (1080 * STAGE.w / 1920) / 2, w: STAGE.w, h: Math.round(1080 * STAGE.w / 1920) });
/** Canvas px per effect px. */
export const PX = 2;
/** Where the mockup stands him (the crystal's spot), canvas px. */
export const FLOOR = Object.freeze({ x: 470, y: STAGE.y + 560 - CROP.y });
/** The effect frame: the view (EW x EH effect px) and the margin round it for the camera's pull-back (WP5). */
export const EW = CROP.w / PX, EH = Math.ceil(CROP.h / PX), MG = 48, EWm = EW + 2 * MG, EHm = EH + 2 * MG;
/** The camera fitted to the painting, effect px: a floor point (X, 0, Z) m is at x = cx + F X / Z, y = yh + A / Z. */
export const CAM = (() => { const c = { cx: EW / 2, yh: (-590 + STAGE.y - CROP.y) / PX, F: 607 }; c.A = (EH - c.yh) * 10; return Object.freeze(c); })();
export const CAMm = Object.freeze({ cx: CAM.cx + MG, yh: CAM.yh + MG, F: CAM.F, A: CAM.A });
/** The halos' padding round each part, sprite px (the mockup's HPAD). */
export const HPAD = 24;
/** The halos' two blurs (sprite px) and their strengths (x the part's glow). */
export const HALO = Object.freeze([Object.freeze({ blur: 7.5, a: 0.5 }), Object.freeze({ blur: 2.6, a: 0.32 })]);
export const RING_C = Object.freeze([hex("#a6ff9c"), hex("#dcffd2"), hex("#5dff6e")]);
/** The rings' frame round his mouth (effect px): the widest ring reaches ~285 x 234 from it. */
export const RING_FRAME = Object.freeze({ W: 600, H: 500 });

/**
 * His sprite where the MOCKUP draws it: DK canvas px per sprite px (contain in a 165 px box, texture scale 5),
 * mirrored (head on the left in the image, facing the party on the right), top-left at (x, y).
 */
export function spriteFrame(width, height) {
  const DK = Math.min(165 / width, 165 / height) * 5, DW = width * DK, DH = height * DK, DTOP = 175 - CROP.y;
  return { DK, DW, DH, DTOP, x: FLOOR.x - DW / 2, y: DTOP, w: DW, h: DH };
}

/* ── His glowing parts (sprite px, unmirrored: head on the left) ─────────── */

export const PARTS = Object.freeze({
  eyes: (x, y) => x >= 135 && x <= 182 && y >= 455 && y <= 500,
  mouth: (x, y) => x >= 85 && x <= 235 && y > 500 && y <= 600,
  claws: (x, y) => y >= 700 || (y >= 640 && (x < 215 || x > 540)),
});
export const PART_KEYS = Object.freeze(Object.keys(PARTS));
/** A glowing pixel (index i into straight RGBA d): the sprite's own green glow. */
export const isGlow = (d, i) => { const r = d[i], g = d[i + 1], b = d[i + 2]; return d[i + 3] > 40 && g > r + 25 && g > b + 5 && g > 90; };

/**
 * A part's glowing pixels, cropped to their box: { x0, y0, w, h, data (RGBA, the sprite's pixels, alpha 0 elsewhere) }
 * in sprite px, or null when the sprite has none there. sprite: { width, height, data } (straight RGBA).
 */
export function glowPart(sprite, key) {
  const f = PARTS[key], { width: W, height: H, data: d } = sprite;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isGlow(d, (y * W + x) * 4) && f(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    if (!isGlow(d, i) || !f(x, y)) continue;
    const o = ((y - y0) * w + (x - x0)) * 4;
    out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = d[i + 3];
  }
  return { x0, y0, w, h, data: out };
}

/* ── The smoke painter's inputs (the mockup's, from the sprite's alpha) ──── */

/**
 * returnStage(sprite, rect = the mockup's, facing = +1) -> the frame's numbers for his sprite drawn at `rect` (canvas
 * px of the frame) and the return painter's inputs. The smoke's camera and its bed of billows stay on the battle
 * framing (the painting); everything that is HIS is laid on his sprite where it is drawn, as the mockup lays it on
 * the sprite where IT drew him (same offsets, scaled with his size). facing +1: he faces x+ (the mockup: the image
 * mirrored); -1: the image as it is, facing x-.
 * -> { rect, DK (canvas px per sprite px), facing, feet { x, y } canvas px, mouth { cx, cy } canvas px, ring { x, y }
 *   (the mouth in buffer px: the rings start there), eye { x, y } effect px (WP5's closing beat), eyeUV / faceUV (his eye
 *   and the middle of his head in sprite px, unmirrored), face { x, y } canvas px (where the camera pushes in),
 *   smoke = { W, H, cam, at, src, seed, body: { lobes, core }, under (Uint8Array(W * H)), genW } (return-painter.js) }.
 */
export function returnStage(sprite, rect = null, facing = 1) {
  const S0 = spriteFrame(sprite.width, sprite.height), R = rect ?? { x: S0.x, y: S0.y, w: S0.w, h: S0.h };
  const d = sprite.data, SW = sprite.width, SH = sprite.height, mir = facing >= 0;
  // (the mockup's own frame keeps its exact DK: R.w / SW is DK only up to rounding)
  const DK = rect ? R.w / SW : S0.DK, KY = rect ? R.h / SH : S0.DK;
  const XR = rect ? R.x + R.w : FLOOR.x + S0.DW / 2, YB = rect ? R.y + R.h : S0.DTOP + S0.DH;   // right and bottom edges
  const toCanvas = (u, v) => ({ x: mir ? XR - u * DK : R.x + u * DK, y: R.y + v * KY });
  const alphaAt = (u, v) => { u = Math.round(u); v = Math.round(v); return u >= 0 && v >= 0 && u < SW && v < SH ? d[(v * SW + u) * 4 + 3] : 0; };
  const alphaAtCanvas = (cx, cy) => alphaAt(mir ? (XR - cx) / DK : (cx - R.x) / DK, (cy - R.y) / KY);
  // his feet: the mockup stands him on FLOOR, (FLOOR.y - DTOP) below his sprite's top, at its middle
  const feet = rect ? { x: R.x + R.w / 2, y: R.y + (FLOOR.y - S0.DTOP) * (R.h / S0.DH) } : { x: FLOOR.x, y: FLOOR.y };
  const FZ = CAM.A / (feet.y / PX - CAM.yh), at = { Z: FZ, X: ((feet.x / PX - CAM.cx) * FZ) / CAM.F };
  // the stand of billows that hides him: a grid over his figure, just in front of him, keeping the billows that cover
  // any of him
  const lobes = [], Zb = at.Z - 0.4;
  {
    const s = CAM.F / Zb, toWorld = (cx, cy) => ({ X: (cx / PX - CAM.cx) / s, Y: (CAM.yh + CAM.A / Zb - cy / PX) / s });
    const a = toWorld(R.x, YB), b = toWorld(XR, R.y);
    for (let Y = 0.3; Y < b.Y + 0.6; Y += 0.8) for (let X = a.X - 0.4; X < b.X + 0.6; X += 0.8) {
      const r = 0.85, cx = (CAM.cx + X * s) * PX, cy = (CAM.yh + CAM.A / Zb - Y * s) * PX, rc = r * s * PX * 0.9;
      let hit = false;
      for (let k = 0; k < 13 && !hit; k++) {
        const an = (k / 12) * Math.PI * 2, rr = k === 12 ? 0 : rc, px = cx + Math.cos(an) * rr, py = cy + Math.sin(an) * rr;
        if (alphaAtCanvas(px, py) > 40) hit = true;
      }
      if (hit) lobes.push({ X, Y, Z: Zb, r });
    }
  }
  // his mouth, in the world (the middle of the mouth's glow, at the depth of the stand of smoke over him)
  const mc = toCanvas(160, 548), sc = CAM.F / Zb;
  const MOUTH = { cx: mc.x, cy: mc.y, X: (mc.x / PX - CAM.cx) / sc, Y: (CAM.yh + CAM.A / Zb - mc.y / PX) / sc, Z: Zb };
  // where his sprite lies, per effect pixel: smoke over it is never skipped (the smoke's speed-only cull)
  const under = new Uint8Array(EWm * EHm);
  for (let cy = Math.max(0, Math.floor(R.y)); cy < Math.min(EH * PX, Math.ceil(YB)); cy++)
    for (let cx = Math.max(0, Math.floor(R.x)); cx < Math.min(EW * PX, Math.ceil(XR)); cx++)
      if (alphaAtCanvas(cx, cy) > 0) under[(((cy / PX) | 0) + MG) * EWm + ((cx / PX) | 0) + MG] = 1;
  const ec = toCanvas(154, 477);
  // his head, where the camera pushes in (WP5): the mockup's CAMF.face, in his sprite's px, laid on this rect
  const faceUV = { u: (FLOOR.x + S0.DW / 2 - CAMF.face.x) / S0.DK, v: (CAMF.face.y - S0.DTOP) / S0.DK }, fc = toCanvas(faceUV.u, faceUV.v);
  return {
    rect: { ...R }, DK, facing: mir ? 1 : -1, feet, mouth: { cx: MOUTH.cx, cy: MOUTH.cy }, ring: { x: MOUTH.cx / PX + MG, y: MOUTH.cy / PX + MG }, eye: { x: ec.x / PX, y: ec.y / PX },
    eyeUV: { u: 154, v: 477 }, faceUV, face: { x: fc.x, y: fc.y },
    smoke: { W: EWm, H: EHm, cam: { ...CAMm }, at, src: MOUTH, seed: 5, body: { lobes, core: MOUTH }, under, genW: EW },
  };
}

/** `under` as run lengths (alternating 0-runs and 1-runs, starting with 0): return-painter underFromRuns' input. */
export function underRuns(u) {
  const runs = [];
  let v = 0, n = 0;
  for (let i = 0; i < u.length; i++) { const b = u[i] ? 1 : 0; if (b === v) n++; else { runs.push(n); v = b; n = 1; } }
  runs.push(n);
  return runs;
}

/* ── Where the frame is drawn, and what of it is on screen ─────────────── */

/**
 * The frame on the scene: the battle framing's crop of the scene's stage rect (the mockup's STAGE by default; a stage
 * of another width scales the frame with it). -> { x, y, k }: canvas (cx, cy) is scene (x + k cx, y + k cy).
 */
export function frameOn(stage = STAGE) {
  const w = Number(stage?.w) > 0 ? Number(stage.w) : STAGE.w, h = Number(stage?.h) > 0 ? Number(stage.h) : STAGE.h;
  const sx = Number.isFinite(Number(stage?.x)) ? Number(stage.x) : STAGE.x, sy = Number.isFinite(Number(stage?.y)) ? Number(stage.y) : STAGE.y;
  const k = w / STAGE.w;
  return { x: sx, y: sy + h / 2 - (k * 1080 * STAGE.w / 1920) / 2, k };
}

/**
 * The on-screen part of the effect buffers (buffer px, the mockup's viewOf): a canvas-px rect of the visible window,
 * padded 8 px for the shake, clamped to the buffers.
 */
export function viewOf(c0x, c0y, c1x, c1y) {
  const w = (v) => v / PX + MG, lo = (v, n) => clamp(Math.floor(v) - 8, 0, n), hi = (v, n) => clamp(Math.ceil(v) + 8, 0, n);
  return { x0: lo(w(Math.min(c0x, c1x)), EWm), x1: hi(w(Math.max(c0x, c1x)), EWm), y0: lo(w(Math.min(c0y, c1y)), EHm), y1: hi(w(Math.max(c0y, c1y)), EHm) };
}
/** The rest framing's view (the whole crop): the mockup's VIEW with the camera at rest. */
export const REST_VIEW = Object.freeze(viewOf(0, 0, CROP.w, CROP.h));

/* ── The roar's rings (the mockup's drawRoar, painted into a frame round his mouth) ──── */

/**
 * Paint the rings at tau (s since the pierce) with painter p, round his mouth at (mx, my) in the painter's px (the
 * mockup: buffer px). Waves of sound out of his mouth: rings of pale soul light growing and fading, born at the edge
 * of his face (never over it), stronger on the side he faces (facing +1: x+, the party's side in the mockup).
 * Returns false when no ring is up.
 */
export function paintRings(p, tau, mx, my, facing = 1) {
  if (tau <= 0 || tau > ROAR.rings * ROAR.every + ROAR.life) return false;
  const fs = facing >= 0 ? 1 : -1;
  let any = false;
  for (let j = 0; j < ROAR.rings; j++) {
    const u = tau - j * ROAR.every;
    if (u <= 0 || u >= ROAR.life || tau > ROAR.len + ROAR.life) continue;
    const k = u / ROAR.life, r = ROAR.facePx + ROAR.speed * u * (1 - 0.35 * k), a = (1 - k) * (1 - k) * (1 - 0.1 * j);
    // a band a few pixels thick (thinner as it fades), solid where strong, its light added round it
    const w = Math.max(1, Math.round(4 * (1 - k))), n = Math.ceil(Math.PI * 2 * r);
    for (let i = 0; i < n; i++) {
      const an = (i / n) * Math.PI * 2, front = 0.3 + 0.7 * Math.max(0, fs * Math.cos(an));
      const v = a * front, c = v > 0.6 ? RING_C[1] : v > 0.3 ? RING_C[0] : RING_C[2];
      for (let t = 0; t < w; t++) {
        const rr = r - t * 1.1, x = Math.round(mx + Math.cos(an) * rr), y = Math.round(my + Math.sin(an) * rr * 0.82);
        p.put(x, y, c, v > 0.35 ? 1 : v * 2.4);
        p.add(x, y, RING_C[2], 0.5 * v);
      }
    }
    any = true;
  }
  return any;
}

/**
 * The box (inclusive, in a frame's px: [x0, y0, x1, y1], clipped to W x H) that holds every pixel paintRings(p, tau,
 * mx, my) writes into a frame whose origin is (ox, oy), or null when it writes none. WP6: the show paints and uploads
 * only this box (the ring pixels are opaque, so the premultiply is the identity on them; return-stage.test.mjs checks
 * both against the full-frame paint).
 */
export function ringsBox(tau, mx, my, W, H, ox = 0, oy = 0) {
  if (tau <= 0 || tau > ROAR.rings * ROAR.every + ROAR.life || tau > ROAR.len + ROAR.life) return null;
  let r = -1;
  for (let j = 0; j < ROAR.rings; j++) {
    const u = tau - j * ROAR.every;
    if (u <= 0 || u >= ROAR.life) continue;
    const k = u / ROAR.life;
    r = Math.max(r, ROAR.facePx + ROAR.speed * u * (1 - 0.35 * k));
  }
  if (r < 0) return null;
  // x = round(mx + cos * rr), y = round(my + sin * rr * 0.82) with rr <= r: within r (+ the rounding) of the mouth
  const x0 = Math.max(0, Math.floor(mx - r - 1) - ox), x1 = Math.min(W - 1, Math.ceil(mx + r + 1) - ox);
  const y0 = Math.max(0, Math.floor(my - 0.82 * r - 1) - oy), y1 = Math.min(H - 1, Math.ceil(my + 0.82 * r + 1) - oy);
  return x1 < x0 || y1 < y0 ? null : [x0, y0, x1, y1];
}

/* ── A blur for the halos where the canvas has no `filter` (three box passes ~ a Gaussian of that sigma) ──── */

/** Blur straight RGBA (w x h) in place, premultiplied while it blurs; sigma in px. */
export function boxBlurRGBA(data, w, h, sigma) {
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const radii = [0, 1, 2].map((i) => ((i < m ? wl : wl + 2) - 1) / 2);
  const P = new Float32Array(w * h * 4), T = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { const a = data[i * 4 + 3] / 255; P[i * 4] = data[i * 4] * a; P[i * 4 + 1] = data[i * 4 + 1] * a; P[i * 4 + 2] = data[i * 4 + 2] * a; P[i * 4 + 3] = data[i * 4 + 3]; }
  const pass = (src, dst, r, horiz) => {
    const L = horiz ? w : h, M = horiz ? h : w, iv = 1 / (2 * r + 1);
    for (let q = 0; q < M; q++) for (let c = 0; c < 4; c++) {
      const at = (p) => (horiz ? (q * w + p) : (p * w + q)) * 4 + c;
      let acc = 0;
      for (let p = -r; p <= r; p++) if (p >= 0 && p < L) acc += src[at(p)];
      for (let p = 0; p < L; p++) {
        dst[at(p)] = acc * iv;
        const add = p + r + 1, sub = p - r;
        if (add < L) acc += src[at(add)];
        if (sub >= 0) acc -= src[at(sub)];
      }
    }
  };
  for (const r of radii) { if (r <= 0) continue; pass(P, T, r, true); pass(T, P, r, false); }
  for (let i = 0; i < w * h; i++) {
    const a = P[i * 4 + 3], k = a > 0 ? 255 / a : 0;
    data[i * 4] = P[i * 4] * k; data[i * 4 + 1] = P[i * 4 + 1] * k; data[i * 4 + 2] = P[i * 4 + 2] * k; data[i * 4 + 3] = a;
  }
  return data;
}
