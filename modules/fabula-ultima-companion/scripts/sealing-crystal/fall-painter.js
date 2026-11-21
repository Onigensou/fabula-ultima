// ============================================================================
// Nidhogg's fall — its two effect layers as painters (pure: no DOM, no Foundry;
// the Worker, the main-thread fallback and the Node test all use this).
//
//   smoke — one frame over the whole visible arena: his body (his sprite's
//           pixels at effect resolution) turning into smoke, the engulf, the
//           settle to black (fall-smoke.js). 24 ms a frame on average, ~70 ms at
//           the engulf's peak (Node, this PC): Worker only in practice.
//   void  — a frame round his heart: the blips (first fall), the pulses, the
//           gather and the blip's rings + glitter (later fall) (void-birth.js).
//
// The two never draw at the same time (the smoke has settled to black before
// the first pulse), so the show runs one at a time.
// Frames come back PREMULTIPLIED with their non-empty box, like the crystal's
// (crystal-painter.js premultiply), so the host uploads them as they are.
// Smoke perf pass (2026-11-16, pixel-identical): frames cleared and premultiplied only where drawn (box-frame.js);
// the smoke may be painted in horizontal BANDS by two or three painters (o.band = [y0, y1): rows of the whole frame),
// each running the whole simulation and painting only its rows, joined by the host (nidhogg-fall-show.js) into the
// frame one painter paints.
// ============================================================================

import { makeFallSmoke, FALL } from "./fall-smoke.js";
import { makeVoidBirth, BIRTH, COMBO, comboAt, RED_SWELL, GREEN_SWELL } from "./void-birth.js";
import { makeBoxFrame, DstTrack } from "./box-frame.js";

/** The void layer's frame: the heart in the middle, room for the blip's widest ring (r 240 x 0.8) and its glitter. */
export const VOID_FRAME = Object.freeze({ W: 620, H: 520 });

/** Where the smoke's frame is cut into n bands (fractions of its height), n painters on n lanes. A band works out
 * only its own rows (smoke-cloud.js), so the cuts follow where the smoke is: the engulf's heaviest rows are round the
 * middle, so with three the middle band is the narrowest (Node replays of the real-GPU fall, 2026-11-16: slowest band
 * 15.4 ms with two at 0.5, 11.4 ms with three at 0.36 / 0.6; 18.1 ms before, two at 0.6 with the lower band redoing
 * the upper's rows). */
export const BAND_CUTS = Object.freeze({ 1: Object.freeze([]), 2: Object.freeze([0.5]), 3: Object.freeze([0.36, 0.6]) });
/** The smoke's n bands (1..3): [[0, c1), [c1, c2), ..., [ck, H)], rows of the whole frame, each at least one row. */
export const smokeBands = (H, n = 2) => {
  const cuts = BAND_CUTS[Math.max(1, Math.min(3, n | 0))] ?? BAND_CUTS[2], e = [0];
  for (const c of cuts) e.push(Math.min(H, Math.max(e.at(-1) + 1, Math.min(H - 1, Math.round(H * c)))));
  e.push(H);
  return e.slice(0, -1).map((y0, i) => [y0, e[i + 1]]).filter(([a, b]) => b > a);
};

/**
 * makeFallPainter(o):
 *   o.layer "smoke": { W, H, kind, img: { width, height, data }, x0, y0, k, mirror, seed, seedStep?, band? [y0, y1) }
 *   o.layer "void":  { W, H, kind, heart: { x, y } (default the frame's middle), seed }
 * -> { W, H, band, draw({ T, t, color, light }) -> { color, light, cRect, lRect, band, ms } }
 * With a band, the buffers are W x (y1 - y0) (the band's rows) and cRect / lRect are in the WHOLE frame's rows.
 */
export function makeFallPainter(o = {}) {
  const W = Math.max(1, Math.round(o.W)), H = Math.max(1, Math.round(o.H)), kind = o.kind === "first" ? "first" : "repeat";
  const band = o.layer === "smoke" && Array.isArray(o.band) ? [Math.max(0, o.band[0] | 0), Math.min(H, o.band[1] | 0)] : null;
  const y0 = band ? band[0] : 0, BH = band ? Math.max(1, band[1] - band[0]) : H;
  const bf = makeBoxFrame(W, BH, y0), frame = bf.frame;
  let paint;
  if (o.layer === "smoke") {
    const smoke = makeFallSmoke(W, H, { img: o.img, x0: o.x0, y0: o.y0, k: o.k, mirror: o.mirror !== false, seed: o.seed ?? 7, seedStep: o.seedStep });
    paint = (p, T) => { if (T < FALL[kind].settleTo) smoke.draw(p, Math.max(0, T), FALL[kind], "core"); };
  } else {
    const birth = makeVoidBirth({ seed: o.seed ?? 9 }), heart = o.heart ?? { x: W / 2, y: H / 2 };
    paint = (p, T, t) => {
      if (kind === "first") {
        const C = COMBO.first, K = comboAt(T, C);
        birth.draw(p, T, C.birth, heart, t, "together", 1 - K.fade);
        // the soft swell as the soul shows
        if (K.swell > 0) { p.glow(heart.x, heart.y, 150, RED_SWELL, 0.22 * K.swell); p.glow(heart.x, heart.y, 60, GREEN_SWELL, 0.28 * K.swell); }
      } else birth.draw(p, T, BIRTH.repeat, heart, t, "together", 1);
    };
  }
  const out = { c: new DstTrack(W, BH), l: new DstTrack(W, BH) };
  const full = (r) => (r && y0 ? [r[0], r[1] + y0, r[2], r[3] + y0] : r);
  return {
    W, H, band,
    draw({ T, t = T, color, light }) {
      const t0 = (globalThis.performance ?? Date).now();
      // (a draw that throws loses the handed buffers: the host's next ones are new, so out's tracks stay right)
      const p = bf.begin();
      paint(p, Number(T) || 0, Number(t) || 0);
      const box = bf.end();
      const c = out.c.out(color, frame.color, box.c), l = out.l.out(light, frame.light, box.l);
      return { color: c.u32.buffer, light: l.u32.buffer, cRect: full(c.rect), lRect: full(l.rect), band, ms: (globalThis.performance ?? Date).now() - t0 };
    },
  };
}
