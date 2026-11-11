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
// ============================================================================

import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { premultiply } from "./crystal-painter.js";
import { makeFallSmoke, FALL } from "./fall-smoke.js";
import { makeVoidBirth, BIRTH, COMBO, comboAt, RED_SWELL, GREEN_SWELL } from "./void-birth.js";

/** The void layer's frame: the heart in the middle, room for the blip's widest ring (r 240 x 0.8) and its glitter. */
export const VOID_FRAME = Object.freeze({ W: 620, H: 520 });

/**
 * makeFallPainter(o):
 *   o.layer "smoke": { W, H, kind, img: { width, height, data }, x0, y0, k, mirror, seed }
 *   o.layer "void":  { W, H, kind, heart: { x, y } (default the frame's middle), seed }
 * -> { W, H, draw({ T, t, color, light }) -> { color, light, cRect, lRect, ms } }
 */
export function makeFallPainter(o = {}) {
  const W = Math.max(1, Math.round(o.W)), H = Math.max(1, Math.round(o.H)), n = W * H, kind = o.kind === "first" ? "first" : "repeat";
  const frame = createFrame(W, H);
  let paint;
  if (o.layer === "smoke") {
    const smoke = makeFallSmoke(W, H, { img: o.img, x0: o.x0, y0: o.y0, k: o.k, mirror: o.mirror !== false, seed: o.seed ?? 7 });
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
  return {
    W, H,
    draw({ T, t = T, color, light }) {
      const t0 = (globalThis.performance ?? Date).now();
      clearFrame(frame);
      paint(painterFor(frame), Number(T) || 0, Number(t) || 0);
      const c = color && color.byteLength === n * 4 ? new Uint32Array(color) : new Uint32Array(n);
      const l = light && light.byteLength === n * 4 ? new Uint32Array(light) : new Uint32Array(n);
      const cRect = premultiply(frame.color, c, W, H), lRect = premultiply(frame.light, l, W, H);
      return { color: c.buffer, light: l.buffer, cRect, lRect, ms: (globalThis.performance ?? Date).now() - t0 };
    },
  };
}
