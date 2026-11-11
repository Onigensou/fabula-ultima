// ============================================================================
// Sealing Crystal — one crystal's painter: crystal-render.js plus the frame
// hand-off. Pure (no DOM, no Foundry): the Worker (crystal-worker.js), the
// main-thread fallback (crystal-runtime.js) and the Node test all use this.
// ============================================================================

import { makeCrystal, crystalMesh } from "./crystal-render.js";

/**
 * The effect frame every crystal is painted into, in effect px. The crystal's
 * feet (its floor point) sit at (CX, FLOOR). Sized from the measured extent of
 * the idle crystal over a full turn at every crack stage, beams included
 * (seed 68: x CX +-290, y FLOOR -390 .. +108), with room to spare: the light
 * must not be cut by the frame's edge (mockup 7c), least of all below the feet.
 */
export const FRAME = Object.freeze({ W: 608, H: 548, CX: 304, FLOOR: 424 });
/** The death's frame: wide enough for the shatter's burst (~6 crystal radii; mockup 11p's 1120² frame). */
export const DEATH_FRAME = Object.freeze({ W: 1120, H: 1120, CX: 560, FLOOR: 720 });

/** The look the user chose (mockup defaults, 2026-11-10): seed 68, glass 95 %, soul shows 40 %, rage 180 %, rays Strong, soul green, 12 s turn. */
export const LOOK = Object.freeze({ seed: 68, glass: 0.95, flameSee: 0.4, rage: 1.8, rays: 2, rayColor: "green", rayMotion: "still", glow: true, turn: 12 });

export function makeCrystalPainter({ W = FRAME.W, H = FRAME.H, CX = FRAME.CX, FLOOR = FRAME.FLOOR, seed = LOOK.seed } = {}) {
  const cr = makeCrystal(W, H), mesh = crystalMesh(seed), n = W * H;
  return {
    W, H, mesh,
    /**
     * Paint the crystal at time t (s) with state st, into the handed-back
     * buffers when given (else new ones). Returns the two buffers + the cost.
     */
    draw({ t, st, color, light }) {
      const t0 = (globalThis.performance ?? Date).now();
      const f = cr.draw(t, { cx: CX, floorY: FLOOR, ...LOOK, ...st, mesh });
      const c = color && color.byteLength === n * 4 ? new Uint32Array(color) : new Uint32Array(n);
      const l = light && light.byteLength === n * 4 ? new Uint32Array(light) : new Uint32Array(n);
      const cRect = premultiply(f.color, c, W, H), lRect = premultiply(f.light, l, W, H);
      return { color: c.buffer, light: l.buffer, cRect, lRect, ms: (globalThis.performance ?? Date).now() - t0 };
    },
  };
}

/**
 * Copy src -> dst PREMULTIPLIED (rgb x alpha), and return the box of non-empty pixels [x0, y0, x1, y1] (null when
 * empty). Premultiplying here lets the host upload the bytes as they are: asking WebGL to premultiply on upload
 * (UNPACK_PREMULTIPLY_ALPHA) makes Chrome convert every pixel on the MAIN thread (measured 2026-11-10: ~2.6 ms a
 * frame on an RTX 3060 Ti, ~11 ms with the CPU slowed 4x). The box lets it upload only the part that changed.
 * Rounding: the same (v * a + 127) / 255 a GPU unpack does, near enough that no pixel art step changes.
 */
export function premultiply(src, dst, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < H; y++) {
    let rowAny = false;
    for (let x = 0; x < W; x++, i++) {
      const v = src[i];
      if (v === 0) { dst[i] = 0; continue; }
      const a = v >>> 24;
      if (a === 255) dst[i] = v;
      else if (a === 0) { dst[i] = 0; continue; }
      else {
        const r = ((v & 255) * a + 127) / 255 | 0, g = (((v >>> 8) & 255) * a + 127) / 255 | 0, b = (((v >>> 16) & 255) * a + 127) / 255 | 0;
        dst[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      rowAny = true;
    }
    if (rowAny) { if (y < y0) y0 = y; y1 = y; }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
