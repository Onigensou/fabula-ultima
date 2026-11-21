// ============================================================================
// Nidhogg's return, phase 1: the dark closes in on the crystal, then the soul's
// last light (pure: no DOM, no Foundry; the Worker's crystal painter, the show
// and the Node test all use this). A port of the approved mockup
// (tools/nidhogg-return-mockup/work/script.js v21: edgeAt, dim, crystalAt's
// per-pixel pass, star, glintAt; the front frontAt / sAt and its constants are
// nidhogg-return.js's, shared with the clock).
//
// The user's rulings (HANDOFF.md "Ruled so far"): the dark closes in on the
// crystal — it never moves, never "sinks" — from far out to the heart: the
// beams' far ends first, then tips and edges, then the glass, then the core,
// which stays BRIGHT while it shrinks (its glass clears, the soul burns a little
// brighter). The front never stops: one exponential curve, slowest on the last
// of the core. Then ONE star of light where the core was (arms up / down, longer
// left / right), born inside the last of the core, at full strength the moment
// the core is gone, then it only weakens: it dims, cools to a dark green pixel
// and wavers as it goes out.
// ============================================================================

import { noise2, hex } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { CLOSE_IN, AFTER, frontAt, sAt } from "./nidhogg-return.js";

export { frontAt, sAt, CLOSE_IN, AFTER };

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };

/**
 * The frame the mockup painted its crystal into (560 x 620, the crystal's centre at x 280, its floor at 405). The
 * ragged noise and the dither are read in THESE coordinates, so the game's frame (crystal-painter FRAME, a different
 * size and origin) gets the same ragged edge on the same pixels of the crystal.
 */
export const MOCK_FRAME = Object.freeze({ W: 560, H: 620, CX: 280, FLOOR: 405 });
/** The crystal's heart (the soul) in its frame, y: the renderer's soul row (crystal-render.js soulY; seed 68 = FLOOR - 117.2). */
export const heartY = (mesh, FLOOR) => FLOOR - 18 - mesh.bot + (mesh.bot - mesh.top) / 2 + 0.1 * (mesh.top + mesh.bot);
/** The distance unit of the front (crystal heights x 0.55: 1 = the crystal's reach from its heart, about). */
export const rref = (mesh) => (mesh.top + mesh.bot) * 0.55;

/** The edge narrows as it nears the core, so what is left at the end is the core's light, not a halo of glass. */
export const edgeAt = (f) => CLOSE_IN.EDGE_CORE + (CLOSE_IN.EDGE - CLOSE_IN.EDGE_CORE) * clamp((f - CLOSE_IN.CORE_R) / 0.6);

/** As the glass goes, the soul burns a little brighter and the glass round it clears: the core's light stays bright. */
export const closeLook = (lastK) => ({ flameK: 1 + 0.35 * lastK, flameSee: 0.4 + 0.45 * lastK });

/**
 * The per-pixel tables, once per frame size: D = each pixel's distance from the heart (in rref), NZ = a fixed ragged
 * noise (noise2 at the mockup frame's coordinates), dmax = the farthest pixel. ox / oy: this frame's offset INTO the
 * mockup's frame (its x = this x + ox), also the dither's phase.
 */
export function closeTables({ W, H, CX, FLOOR, mesh }) {
  const hy = heartY(mesh, FLOOR), R = rref(mesh), n = W * H;
  const ox = MOCK_FRAME.CX - CX, oy = MOCK_FRAME.FLOOR - FLOOR;
  const D = new Float32Array(n), NZ = new Float32Array(n);
  let dmax = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    D[i] = Math.hypot(x - CX, y - hy) / R; NZ[i] = noise2((x + ox) * 0.06, (y + oy) * 0.06, 17);
    if (D[i] > dmax) dmax = D[i];
  }
  return { W, H, D, NZ, dmax, ox, oy, heartY: hy, rref: R };
}

/** The 4 x 4 ordered dither between the darkening's steps: it goes dark in pixel steps, not a smooth fade. */
export const BAY = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16));
/** Darken pixel i (packed ABGR, straight alpha) to m (1 kept .. 0 black), in 4 steps dithered at (x, y). */
export function dim(buf, i, x, y, m) {
  const c = buf[i];
  if (!(c & 0xffffff) || m >= 0.999) return;
  const q = clamp(m) * 4, b = Math.floor(q), k = (b + (q - b > BAY[((y & 3) << 2) | (x & 3)] ? 1 : 0)) / 4;
  if (k <= 0) { buf[i] = 0; return; }
  if (k >= 1) return;
  buf[i] = (c & 0xff000000) | ((((c >>> 16) & 255) * k) << 16) | ((((c >>> 8) & 255) * k) << 8) | ((c & 255) * k);
}

/**
 * The dark at front f (crystal heights from the heart, frontAt) over a painted crystal frame (straight alpha, in
 * place). The raggedness flattens as the front reaches the core; inside the core it closes as a near-clean circle, so
 * no scraps of glass are left round it.
 */
export function closeIn(color, light, tab, f, box = "full") {
  const { W, H, D, NZ, ox, oy } = tab, { CORE_R, RAG } = CLOSE_IN;
  const edge = edgeAt(f), ragK = 0.15 + 0.85 * clamp((f - CORE_R) / 0.5), inCore = f < CORE_R + 0.03;
  // box (optional): every non-zero pixel lies in it (crystal-render.js box(); null: none), and empty pixels are
  // skipped anyway, so the same pixels
  if (!box) return;
  const [bx0, by0, bx1, by1] = Array.isArray(box) ? box : [0, 0, W - 1, H - 1];
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const i = y * W + x;
    if (!color[i] && !light[i]) continue;
    const d = D[i], rag = inCore ? 0.04 : (d > CORE_R + 0.12 ? RAG : RAG * clamp((d - CORE_R) / 0.12)) * ragK;
    const m = 1 - clamp((d + rag * NZ[i] - f) / edge);
    dim(color, i, x + ox, y + oy, m); dim(light, i, x + ox, y + oy, m);
  }
}

/* ── The soul's last light: one star ───────────────────────────────────── */

export const SOUL = Object.freeze(["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2"].map(hex));
const WHITE = hex("#ffffff");
/** The star's frame (effect px), the light in its middle; arm reach (effect px at full strength). */
export const STAR = Object.freeze({ W: 220, H: 130, ARM_H: 72, ARM_V: 30 });
const TONES = [SOUL[2], SOUL[3], SOUL[4], SOUL[5], SOUL[6], SOUL[7], WHITE];
const toneOf = (a) => TONES[Math.max(0, Math.min(TONES.length - 1, Math.floor(a * TONES.length * 0.999)))];

/**
 * Draw the light at strength S (0..1) with painter p at `at` (effect px), `size` x. Everything from S, the way a real
 * light dims: arm length ~ S (long side arms, shorter up / down), the arms' brightness ~ S, the glow fades faster
 * (S^1.6) so a weak light has no halo left, the centre cools from white-hot through the soul's greens to a dark green
 * ember, shrinking to one pixel. (The closing beat of the mockup put the same star in his eye, size 0.42.)
 */
export function star(p, S, at, size = 1) {
  const hx = Math.round(at.x), hy = Math.round(at.y);
  if (S <= 0.015) return;
  const g = Math.pow(S, 1.6);
  if (g > 0.01) { p.glow(hx, hy, (12 + 30 * g) * size, SOUL[4], 0.5 * g); p.glow(hx, hy, (5 + 9 * g) * size, SOUL[6], 0.65 * g); }
  const LH = STAR.ARM_H * S * size, LV = STAR.ARM_V * S * size;
  if (LH > 3) { p.glowLine(hx - LH, hy, hx + LH, hy, 3.2, SOUL[5], 0.5 * g); p.glowLine(hx - LH * 0.55, hy, hx + LH * 0.55, hy, 1.6, SOUL[7], 0.45 * g); }
  if (LV > 3) p.glowLine(hx, hy - LV, hx, hy + LV, 2.6, SOUL[5], 0.4 * g);
  // the arms: solid pixels, each a tone of the light's strength there (brightest at the centre, dimmer to the tips)
  for (const [dx, dy, L0] of [[1, 0, LH], [-1, 0, LH], [0, 1, LV], [0, -1, LV]]) {
    const L = Math.round(L0);
    for (let i = 1; i <= L; i++) {
      const a = S * Math.pow(1 - i / (L + 1), 1.3);
      if (a < 0.08) continue;
      const x = hx + dx * i, y = hy + dy * i;
      p.put(x, y, toneOf(a), 1);
      if (i < L * 0.22 && a > 0.35) { const b = toneOf(a * 0.55); p.put(x + dy, y + dx, b, 1); p.put(x - dy, y - dx, b, 1); }
    }
  }
  // the centre: a small diamond at full strength, one pixel at the end, cooling as it weakens
  const r = Math.round(2.4 * S * size);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const q = Math.abs(dx) + Math.abs(dy); if (q <= r) p.put(hx + dx, hy + dy, toneOf(S * (1 - 0.4 * q / (r + 1))), 1); }
}

/**
 * The light's strength at u = T - gone (s; nidhogg-return returnState().glintU), or null outside its life.
 * Born INSIDE the last of the core: as the core shrinks its light gathers into the star, at full strength exactly as
 * the core is gone; from there it only weakens: a short moment at full, then it fades, slowest at the very end; it
 * wavers on a smooth random wave (noise2, no beat), a little more as it weakens.
 */
export function glintAt(u) {
  if (u == null || !Number.isFinite(u)) return null;
  const D2 = AFTER.glint, LEAD = AFTER.lead;
  if (u < -LEAD || u >= D2) return null;
  if (u < 0) return { S: Math.pow(smooth(-LEAD, 0, u), 1.3) };
  const v = u / D2, fade = (1 - v) * (1 - v) * (1 + 2 * v), depth = (0.1 + 0.16 * (1 - fade)) * smooth(0.1, 0.35, u);
  const sway = 1 + depth * noise2(u * 2.8, 0.37, 41);
  return { S: clamp(fade * sway) * (1 - smooth(0.92, 1, v)) };
}
