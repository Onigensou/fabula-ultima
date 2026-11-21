// ============================================================================
// Nidhogg's battle opening, beat 2: his EYES (pure: no DOM, no Foundry; Worker-safe, Node-testable).
// Ported 1:1 from the approved mockup v3 (tools/nidhogg-opening-mockup/fx/eyes.js, 2026-11-19; the user took its
// defaults 2026-11-20: brow light OFF, eye size and spacing as they are, the dither edge as it is).
// The body below is the mockup's, unchanged; only the import points at the game's copy of the pixelfx core
// (crack-out.test.mjs checks the pixels against the mockup's own, colour and light).
// It is painted in a Worker with beat 1 (crack-out-painter.js, crystal-worker.js "crackout"); the host is
// nidhogg-crack-out.js.
// ============================================================================
//
// Beat 2 of Nidhogg's battle opening: in the black, a glimpse of BOTH his eyes flashes, their shapes briefly seen,
// then back to black (the user, 2026-11-19: "with its shapes (not sprite shape)").
//
// Drawn eye shapes, not pixels cut from his sprite. What is taken from the sprite (Nidhoggr_Standard.png, head on the
// left, one eye showing at sprite 147-165, 452-490) and from the return mockup's approved glow-through: the colours
// (his soul's greens, a pale core round the pupil, a dark teal rim), the slant (the eye rises toward the back of the
// head) and the thin streak of light running up and back from its outer corner. The sprite is in profile, so the
// second eye is new: the head faces the camera here, so the pair is mirrored about the screen's middle.
//
// Each eye: an almond (upper lid flatter and heavier: a glare), the inner corner hooked down, the outer corner tapering
// up into the streak; solid light inside, no pupil (his sprite's eye has none: a pale core in green); stepped tones
// (pixel art: no smooth alpha). It snaps open (white-hot for a moment, cooling to green), holds, then fades back
// into the dark as he draws away (v2, the user 2026-11-19; v1 had a slit pupil and shut its lids).
import { hex, clamp } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

export const SOUL = ["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2"].map(hex);
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };

// the beat, in s from its start (the user, 2026-11-19: open, hold a bit, then fade slowly into the dark "as if it
// slowly move backward"): they snap open, hold, then he draws back: the pair shrinks and closes in toward the middle
// (perspective), dims and cools to dark green, the glow tightens, until nothing is left
// open: the lids part over 0.4 s, ease-out (the user, 2026-11-19: the 0.09 s snap was too fast); hold: after fully open
export const EYE_T = { open: 0.4, hold: 1.35, recede: 1.8 };
export const EYES_DARK = EYE_T.open + EYE_T.hold + EYE_T.recede;          // the last of them is gone (the next beat counts from here)
export const EYES_END = EYES_DARK;

/**
 * drawEyes(pColor, s, { W, H, brow }) — pColor: a painter on the effect frame (colour + light buffers), s: seconds into
 * the beat. W x H: the effect frame. brow: the eyes' light catches the ridges of his brow (option, off by default).
 */
export function drawEyes(p, s, { W, H, brow = false, size = 1 } = {}) {
  if (s < 0 || s >= EYES_END) return;
  const o = 1 - Math.pow(1 - clamp(s / EYE_T.open), 2);   // ease-out (quadratic: a cubic looked done in 0.15 s)
  // white-hot as they part, cooling through the open, settling to green just after
  const heat = s < EYE_T.open ? 1 - 0.6 * (s / EYE_T.open) : 0.4 * Math.exp(-(s - EYE_T.open) / 0.15);
  // the drawing back: slow out of the hold, steady through the middle, easing into nothing
  const rl = clamp((s - EYE_T.open - EYE_T.hold) / EYE_T.recede), r = rl * rl * (3 - 2 * rl);
  const scale = 1 - 0.38 * r;                                // further away: smaller, and closer together
  const dim = Math.round(r * 4.2);                           // tones step down the ramp toward dark green
  const fade = 1 - smooth(0.62, 1, r);                       // the last of it dithers out
  const light = o * (0.8 + 0.55 * heat) * Math.pow(1 - r, 1.6);
  const cy = H * 0.44 - 6 * r, gap = W * 0.148 * size * scale;
  for (const side of [-1, 1]) {
    const cx = W / 2 + side * gap;
    drawEye(p, cx, cy, side, o, heat, light, size * scale, dim, fade, r);
    if (brow && light > 0.02) drawBrow(p, cx, cy, side, light, size * scale);
  }
  // the flash: a faint wash of his light over the black at the moment they open
  if (heat > 0.05) p.glow(W / 2, cy, W * 0.42, SOUL[3], 0.07 * heat * o);
}

// side -1 = the eye on the left of the screen (his right eye). Outward = away from the screen's middle.
// No pupil: his sprite's eye is solid light (a pale core in green, a darker rim), so these are too.
function drawEye(p, cx, cy, side, o, heat, light, size, dim, fade, r) {
  const S = size;
  // corners: inner (toward the middle, lower), outer (higher)
  const Ix = cx - side * 31 * S, Iy = cy + 5 * S, Ox = cx + side * 33 * S, Oy = cy - 8 * S;
  const ax = Ox - Ix, ay = Oy - Iy, L = Math.hypot(ax, ay), ux = ax / L, uy = ay / L;
  // v axis: perpendicular, pointing DOWN the screen
  let vx = -uy, vy = ux; if (vy < 0) { vx = -vx; vy = -vy; }
  const Hu = 13 * S, Hl = 10.5 * S;
  // the upper lid comes down toward the inner corner (a scowl: the opening is lowest at the inner side), the lower
  // lid is round; the inner corner hooks down a little
  const hu = (t) => Hu * Math.pow(Math.sin(Math.PI * t), 0.85) * (0.45 + 0.55 * t);
  const hl = (t) => Hl * Math.pow(Math.sin(Math.PI * Math.pow(t, 1.1)), 0.85) + (t < 0.09 ? 3.2 * S * (1 - t / 0.09) * Math.min(1, t / 0.02) : 0);
  // the hot core: a little toward the inner side of the middle, between the lids (as the sprite's pale centre)
  const tc = 0.46, CX = Ix + ax * tc, CY = Iy + ay * tc + vy * (hl(tc) - hu(tc)) * 0.5 * o, CH = Math.max(1, (hu(tc) + hl(tc)) * 0.5 * o);
  const lift = Math.round(heat * 2.2) - dim;               // white-hot at the open, cooling to green; down as he recedes
  if (o > 0.02 && fade > 0.01) {
    const x0 = Math.floor(Math.min(Ix, Ox) - 4), x1 = Math.ceil(Math.max(Ix, Ox) + 4), y0 = Math.floor(Math.min(Iy, Oy) - Hu - 6), y1 = Math.ceil(Math.max(Iy, Oy) + Hl + 8);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - Ix, py = y + 0.5 - Iy, u = px * ux + py * uy, v = px * vx + py * vy, t = u / L;
      if (t <= 0 || t >= 1) continue;
      const top = hu(t) * o, bot = hl(t) * o;
      if (v < -top || v > bot) continue;
      const eTop = v + top, eBot = bot - v, eEnd = Math.min(t, 1 - t) * L * 0.55, e = Math.min(eTop, eBot, eEnd);
      // distance from the core, in eye heights, stretched along the eye (an oval core, not a ring)
      const dc = Math.hypot((x + 0.5 - CX) / 2.4, y + 0.5 - CY) / CH;
      let k = 4;                                              // the body of the eye
      if (dc < 0.42) k = 6; else if (dc < 0.85) k = 5;        // the pale core, and the bright green round it
      if (eTop < 2.6) k -= 1;                                // the upper lid's shade
      if (e < 2.2) k = Math.min(k, 3);
      if (e < 1.1) k = 2;                                    // the rim
      const kk = k + lift;
      if (kk < 0) continue;
      p.put(x, y, SOUL[Math.min(7, kk)], fade);
    }
  }
  // the streak: up and back from the outer corner (as on his sprite); it goes first as he recedes
  const sf = o * (1 - smooth(0.1, 0.55, r));
  if (sf > 0.3) {
    const n = Math.round(26 * S * sf);
    for (let i = 0; i <= n; i++) {
      const f = i / Math.max(1, n), x = Ox + side * (12 * f + 4 * f * f) * S, y = Oy - (5 * f + 9 * f * f) * S;
      const k = clamp(5 - Math.floor(f * 3.2) + Math.round(heat * 1.5) - dim, 0, 7);
      p.put(Math.floor(x), Math.floor(y), SOUL[k], 1);
      if (f < 0.4) p.put(Math.floor(x), Math.floor(y) + 1, SOUL[Math.max(0, k - 1)], 1);
    }
  }
  // its light (additive): a soft halo and a hot core, tightening as he draws back
  if (light > 0.01) {
    p.glow(cx, cy, 40 * S * (1 - 0.35 * r), SOUL[4], 0.4 * light);
    p.glow(CX, CY, 16 * S * (1 - 0.3 * r), SOUL[5], 0.5 * light);
  }
}

// the eye's light on the ridges round it: a brow ridge arching up and out, a ridge under the eye, the bridge
function drawBrow(p, cx, cy, side, light, size) {
  const S = size;
  const lines = [
    [[-36, -14], [-20, -20], [-2, -22], [18, -26], [38, -34], [52, -46]],    // the brow ridge (x outward, y down)
    [[-30, 13], [-12, 16], [8, 16], [26, 12]],                                // under the eye
    [[-44, -10], [-50, 4], [-48, 22]],                                        // the bridge of the snout
  ];
  for (const pts of lines) for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let k = 0; k <= n; k++) {
      const f = k / n, lx = ax + (bx - ax) * f, ly = ay + (by - ay) * f;
      const x = cx + side * lx * S, y = cy + ly * S, d = Math.hypot(lx, ly) / 50;
      const a = light * clamp(1.15 - d) ;
      if (a < 0.15) continue;
      const c = a > 0.55 ? SOUL[2] : a > 0.3 ? SOUL[1] : SOUL[0];
      p.put(Math.floor(x), Math.floor(y), c, 1);
      if (a > 0.3) p.put(Math.floor(x), Math.floor(y) + 1, a > 0.55 ? SOUL[1] : SOUL[0], 1);   // the ridge's lit face, 2 px
    }
  }
}
