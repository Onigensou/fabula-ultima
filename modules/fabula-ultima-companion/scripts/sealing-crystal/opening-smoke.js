// ============================================================================
// The battle opening's close-up smoke (pure; no DOM, no Foundry, Node-testable: opening-smoke.test.mjs).
//
// The user (2026-11-19, on the opening film): "Add smoke to the claw and wings." So the claw and wing close-ups read
// as HIM INSIDE THE DARK: dark, soft, see-through wisps that drift slowly across the frame in front of him, in the
// campfire-wisp register (memory: smoke BLENDS, soft see-through puffs, not crisp billows standing apart), drawn with
// the same renderer and ramp as his return smoke (smoke-cloud.js cloudFast, return-smoke.js's SMOKE tones; dark lobes,
// no lit crown). The subject stays readable: a clear oval round the shot's subject point thins every wisp near it.
//
// Screen-space: one small pixel frame over the window (W x H effect px, PX screen px each), so it never needs the 3D
// camera. Everything is a function of (seed, t): the show paints the frame at t, a rig can scrub it.
// ============================================================================

import { Rng, hex, clamp } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

/** The smoke's tones (darkest first): return-smoke.js SMOKE, the same family; a faint warm-green light ramp. */
export const OPENING_SMOKE = Object.freeze(["#000000", "#040605", "#090d0b", "#101714", "#18221d", "#223029", "#2f4038"].map(hex));
export const OPENING_SMOKE_LIT = Object.freeze(["#020403", "#08100c", "#0f1c16", "#17291f", "#203628", "#2b4533", "#3a5a43"].map(hex));
/** Screen px per effect px, and the wisps' numbers. */
export const CLOSE_SMOKE = Object.freeze({
  PX: 4, count: 30,
  life: Object.freeze([3.2, 5.2]),      // s a wisp lives (fades in, drifts and swells, fades out)
  r: Object.freeze([0.07, 0.15]),       // radius at birth, x frame height; swells to x1.7 by death
  a: Object.freeze([0.55, 0.95]),       // peak density weight
  drift: Object.freeze([0.025, 0.06]),  // frame heights / s across, in the shot's drift direction
  rise: Object.freeze([0.01, 0.035]),   // frame heights / s upward
  clear: Object.freeze([0.16, 0.34]),   // the subject's clear oval: none inside rx = clear[0] H, full past clear[1] H
  dens: 0.9, max: 0.7,                   // cloudFast: soft, never fully opaque
  steps: false,                          // smooth alpha: soft see-through puffs (stepped alpha drew rings round every lobe)
  lit: 0.9,                              // each lobe's light: the smoke shows its own grey-green tones (b 0 = pure black discs)
});

const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };

/**
 * The close-up smoke for a frame of W x H effect px. o.seed, o.dir (+1 the wisps drift right, -1 left). Returns
 * lobesAt(t, subject) -> [{ x, y, r, a, b: 0, w: 0 }] (effect px; cloudFast's lobes): subject = { x, y } (fractions of
 * the frame) is kept clear. Wisps are born spread over the whole frame (a few deliberately in front of the subject
 * line, thinned by the clear oval), each on its own staggered cycle, so the frame is never empty and never pulses.
 */
export function makeCloseupSmoke(W, H, { seed = 11, dir = 1, n = CLOSE_SMOKE.count } = {}) {
  const S = CLOSE_SMOKE, rng = new Rng(seed);
  const span = (a, b) => a + rng.next() * (b - a);
  const wisps = Array.from({ length: n }, (_, i) => ({
    life: span(S.life[0], S.life[1]), phase: rng.next(),
    x0: span(-0.15, 1.15) * W, y0: span(0.05, 1.05) * H,
    r0: span(S.r[0], S.r[1]) * H, a: span(S.a[0], S.a[1]),
    vx: span(S.drift[0], S.drift[1]) * H * dir, vy: -span(S.rise[0], S.rise[1]) * H,
    wob: span(0, Math.PI * 2), i,
  }));
  return {
    W, H, dir, wisps,
    lobesAt(t, subject = { x: 0.5, y: 0.5 }) {
      const sx = subject.x * W, sy = subject.y * H, out = [];
      for (const w of wisps) {
        const cyc = t / w.life + w.phase, k = cyc - Math.floor(cyc), born = Math.floor(cyc);
        // a new cycle re-seeds where the wisp starts (deterministic from its index and cycle), across the frame
        const jx = ((Math.sin((w.i + 1) * 12.9898 + born * 78.233) * 43758.5453) % 1 + 1) % 1;
        const jy = ((Math.sin((w.i + 1) * 39.3468 + born * 11.135) * 24634.6345) % 1 + 1) % 1;
        const age = k * w.life;
        const x = ((w.x0 + jx * W * 0.6) % (W * 1.3)) - W * 0.15 + w.vx * age + Math.sin(w.wob + age * 0.9) * H * 0.012;
        const y = ((w.y0 + jy * H * 0.5) % (H * 1.1)) + w.vy * age;
        const r = w.r0 * (1 + 0.7 * k);
        const fade = smooth(0, 0.22, k) * (1 - smooth(0.7, 1, k));
        // the clear oval (wider than tall), measured to the wisp's near EDGE: a big wisp beside him must not cover him
        const d = Math.max(0, Math.hypot((x - sx) / 1.35, y - sy) - 0.75 * r) / H;
        const clearK = smooth(S.clear[0], S.clear[1], d);
        const a = w.a * fade * (0.08 + 0.92 * clearK);                // near the subject: a faint veil, never a wall
        if (a <= 0.02 || x + r * 1.6 < 0 || x - r * 1.6 > W || y + r * 1.6 < 0 || y - r * 1.6 > H) continue;
        // a wisp is a small cluster of soft lobes (never one round disc), lit a little so it reads as smoke, not a hole
        for (let j = 0; j < 3; j++) {
          const ang = w.wob + j * 2.1 + age * 0.35, off = r * (j === 0 ? 0 : 0.55);
          out.push({ x: x + Math.cos(ang) * off * 1.3, y: y + Math.sin(ang) * off * 0.7, r: r * (j === 0 ? 0.8 : 0.6), a: a * (j === 0 ? 0.6 : 0.45), b: S.lit, w: 0 });
        }
      }
      return out;
    },
  };
}
