// ============================================================================
// Nidhogg's return, phase 2 — its three smoke layers as one painter (pure: no
// DOM, no Foundry; the Worker, the main-thread fallback and the Node test all
// use this). Mirrors fall-painter.js.
//
//   back  — the billows behind him (drawn before his sprite)
//   front — the billows in front of him, and the stand of smoke over him
//   veil  — the black over the arena, cleared from under his mouth outward
//
// All three come from return-smoke.js (the mockup's break-smoke.js) and share
// one buffer size W x H (the view plus the camera's margin). Frames come back
// PREMULTIPLIED with their non-empty box, like the crystal's and the fall's
// (crystal-painter.js premultiply), so the host uploads them as they are.
// Cost (Node, this PC, rest view): ~14 ms a frame on average, ~47 ms at the
// worst (tau 0.2-0.5) for back + front + veil together. WP6: split per layer
// (o.layers), so the show runs back and front in two Workers at once.
// ============================================================================

import { premultiply } from "./crystal-painter.js";
import { makeBoxFrame, DstTrack } from "./box-frame.js";
import { makeReturnSmoke } from "./return-smoke.js";

export const RETURN_LAYERS = Object.freeze(["back", "front", "veil"]);

/** `under` as run lengths (alternating 0-runs and 1-runs, starting with 0) -> Uint8Array(n). */
export function underFromRuns(runs, n) {
  const u = new Uint8Array(n);
  let i = 0, v = 0;
  for (const k of runs) { if (v) u.fill(1, i, Math.min(n, i + k)); i += k; v ^= 1; }
  return u;
}

/**
 * makeReturnPainter(o): o = { W, H, cam, at, src, seed, body, under, genW } (makeReturnSmoke's inputs; `under` a
 * Uint8Array(W * H), or { runs } as underFromRuns takes, or null), and optionally `layers`: which of RETURN_LAYERS this
 * painter paints (default all three). WP6: the show paints back and front in two Workers at once (each its own
 * painter, ["back"] / ["front"]) and the veil on the GPU; a layer left out costs nothing (the billows are still all
 * placed, so a painted layer is the same pixels whichever others are painted with it).
 * -> { W, H, count, doneAt, layers, draw({ T, st, back, front, veil }) -> { layers, rects, ms, msBy } }
 *   T: tau, s since he broke through (the smoke's clock). st.view: the on-screen part of the buffers
 *   { x0, y0, x1, y1 } (effect px), or null / absent for all of it.
 *   back / front / veil: ArrayBuffers of W*H*4 handed back for reuse (else new ones are made).
 *   layers / rects: only this painter's layers; rects: each one's box of non-empty pixels [x0, y0, x1, y1], or null.
 *   ms: the whole frame; msBy: { place (billows placed + sorted, shared), back, front, veil } (each incl. its premultiply).
 * Each frame is a function of (T, view) only: back and front are cleared, and so is the veil (outside the view it
 * is left EMPTY; the mockup's own buffer kept whatever an earlier, wider view had put there, which is off screen).
 * Smoke perf pass (2026-11-16, pixel-identical): back / front are cleared and premultiplied only where drawn
 * (box-frame.js). draw({ warm: true, ... }) paints the frame into the painter's own scratch buffers and returns
 * { warm: true, ms } (the show's JIT warm-up in the quiet seconds before the roar: nothing is handed back or shown).
 */
export function makeReturnPainter(o = {}) {
  const W = Math.max(1, Math.round(o.W)), H = Math.max(1, Math.round(o.H)), n = W * H;
  const want = Array.isArray(o.layers) ? RETURN_LAYERS.filter((k) => o.layers.includes(k)) : RETURN_LAYERS.slice();
  const has = { back: want.includes("back"), front: want.includes("front"), veil: want.includes("veil") };
  const under = o.under instanceof Uint8Array ? o.under : Array.isArray(o.under?.runs) ? underFromRuns(o.under.runs, n) : null;
  const smoke = makeReturnSmoke(W, H, { cam: o.cam, at: o.at, src: o.src ?? null, seed: o.seed ?? 5, body: o.body ?? null, under, genW: o.genW ?? W });
  // a band (back / front only): rows [y0, y1) of the buffers, in band-sized buffers (W x (y1 - y0)); rects in the whole
  // buffers' rows. The veil is never banded (it is drawn on the GPU; a CPU veil goes with a whole-frame painter).
  const band = Array.isArray(o.band) && !has.veil ? [Math.max(0, o.band[0] | 0), Math.min(H, o.band[1] | 0)] : null;
  const y0 = band ? band[0] : 0, BH = band ? Math.max(1, band[1] - band[0]) : H;
  const fb = has.back ? makeBoxFrame(W, BH, y0) : null, ff = has.front ? makeBoxFrame(W, BH, y0) : null, veil = has.veil ? new Uint32Array(n) : null;
  const outs = { back: new DstTrack(W, BH), front: new DstTrack(W, BH) };
  const full = (r) => (r && y0 ? [r[0], r[1] + y0, r[2], r[3] + y0] : r);
  let scratch = null;   // warm draws: tracks + buffers that never leave the painter
  const take = (b) => (b && b.byteLength === n * 4 ? new Uint32Array(b) : new Uint32Array(n));
  const now = () => (globalThis.performance ?? Date).now();
  return {
    W, H, band, count: smoke.count, doneAt: smoke.doneAt, layers: want,
    draw({ T, st, back, front, veil: veilBuf, warm = false }) {
      const t0 = now(), tau = Number(T) || 0, v = st?.view;
      const view = v && [v.x0, v.y0, v.x1, v.y1].every(Number.isFinite) ? v : null;
      const layers = {}, rects = {}, msBy = {};
      const pb = fb ? fb.begin() : null, pf = ff ? ff.begin() : null;
      // the billows (both layers placed and culled together; cloud() only for this painter's layers), timed apart
      // through the painters' own clock: smoke.draw paints back then front
      if (fb || ff) {
        const t1 = now();
        smoke.draw(pb, pf, tau, view, band ? H : null);
        msBy.smoke = now() - t1;
      }
      const bb = fb ? fb.end() : null, bfr = ff ? ff.end() : null;
      if (warm) {
        scratch ??= { back: new DstTrack(W, BH), front: new DstTrack(W, BH), buf: {} };
        if (fb) scratch.buf.back = scratch.back.out(scratch.buf.back, fb.frame.color, bb.c).u32.buffer;
        if (ff) scratch.buf.front = scratch.front.out(scratch.buf.front, ff.frame.color, bfr.c).u32.buffer;
        return { warm: true, ms: now() - t0 };
      }
      if (fb) { const t1 = now(), o = outs.back.out(back, fb.frame.color, bb.c); rects.back = full(o.rect); layers.back = o.u32.buffer; msBy.pmBack = now() - t1; }
      if (ff) { const t1 = now(), o = outs.front.out(front, ff.frame.color, bfr.c); rects.front = full(o.rect); layers.front = o.u32.buffer; msBy.pmFront = now() - t1; }
      if (veil) {
        const t1 = now();
        if (tau > 0) veil.fill(0);
        smoke.drawVeil(veil, tau, view);
        const c = take(veilBuf);
        rects.veil = premultiply(veil, c, W, H); layers.veil = c.buffer;
        msBy.veil = now() - t1;
      }
      return { layers, rects, ms: now() - t0, msBy };
    },
  };
}
