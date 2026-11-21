// ============================================================================
// Nidhogg's battle opening, beats 1-2 (the leak, his eyes) — the plan and the painter (pure: no DOM, no Foundry; the
// Worker, the main-thread fallback and the Node test all use this). The host on the page: nidhogg-crack-out.js.
//
// The mockup v3 (tools/nidhogg-opening-mockup/work/script.js) on the crack-out's own clock. The mockup's page time
// counts from before the impact (imp 0.6 s, leak imp + 0.75); the crack-out starts where the glass would have broken,
// which is BEAT.crack = 0.6 s after the impact at the earliest (shatter-transition.js), so here T = 0 is that break and
// the leak opens `lead` = 0.15 s into it (0.75 - 0.6). Then, as the mockup with the user's picks (2026-11-20):
//   leak      the first points open                     lead
//   black     the screen is black (veil + smoke)         leak + 3.6
//   allBlack  the mockup stops drawing the frozen frame   black + 0.02   -> beat 1 is over, beat 2 (the eyes) begins
//   eyes      both his eyes open in the black              black + 1.0    (crack-out-eyes.js = the mockup's fx/eyes.js)
//   eyesEnd   the mockup stops drawing them                eyes + EYES_END
//   dark      they are gone: the crack-out is over         eyes + EYES_DARK (3.55 s; beat 3, the claw, counts from here)
//
// The painter paints ONE frame per draw: the veil + the smoke (beat 1) or the eyes (beat 2; they never overlap). The mockup painted the veil and the smoke into two
// frames composited by the canvas; here the smoke is blended over the veil in the same frame (smoke-cloud.js
// blendPixel: source-over, the same result to within one level of 255). Frames come back STRAIGHT (not
// premultiplied) RGBA, as ImageData wants them: the host puts them into a DOM canvas, not a PIXI texture. cRect = the
// box of non-empty pixels [x0, y0, x1, y1] (inclusive) or null. The eyes also write LIGHT (their glow, additive; the
// mockup drew it with globalCompositeOperation "lighter"): `light` is straight RGBA too, alpha 255 where lit, lRect its
// box. The leak writes none: outside the eyes, light comes back as a 0-byte buffer (lRect null), or, if a light buffer
// was handed in, as that buffer cleared.
// ============================================================================

import { makeLeak } from "./crack-out-leak.js";
import { drawEyes, EYES_DARK, EYES_END } from "./crack-out-eyes.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

/** The user's picks from the mockup v3 (2026-11-20) and the port's numbers. */
export const CRACK_OUT_LOOK = Object.freeze({
  seeds: 5,          // points that leak first (mockup chips 3 / 5 / 8)
  dur: 3.6,          // s from the first leak to black (chips 2.8 / 3.6 / 4.6)
  lead: 0.15,        // s from the break to the first leak (the mockup's 0.75 s after the impact, less the 0.6 s hold)
  seed: 11,          // makeLeak's seed (the mockup's default)
  rows: 360,         // effect rows the window is cut into (the mockup: 1080 screen px at 3 a pixel)
  eyesAfter: 1.0,    // s from black to the eyes opening (the mockup's plan: eyes = black + 1.0)
  brow: false,       // the eyes' light on his brow ridges (a mockup chip; the user: OFF)
  eyeSize: 1,        // drawEyes size (the user: as it is)
});

/** The crack-out's moments (s from its start, at speed 1): beat 1 up to allBlack, beat 2 from there to dark. */
export function crackOutPlan(o = {}) {
  const L = { ...CRACK_OUT_LOOK, ...o };
  const leak = L.lead, black = leak + L.dur, eyes = black + L.eyesAfter;
  // allBlack: the mockup stops drawing the frozen frame (and the leak) 0.02 s after black; beat 1 ends there
  return Object.freeze({ leak, black, allBlack: black + 0.02, eyes, eyesEnd: eyes + EYES_END, dark: eyes + EYES_DARK, end: eyes + EYES_DARK });
}

/** Beat 1's nominal length (ms, speed 1): the break to all black. */
export const LEAK_MS = Math.round(crackOutPlan().allBlack * 1000);
/** Beat 2's nominal length (ms, speed 1): all black to dark (the mockup's 1.0 s after black, then EYES_DARK). */
export const EYES_MS = Math.round((crackOutPlan().dark - crackOutPlan().allBlack) * 1000);
/**
 * How long the crack-out lasts (ms, speed 1): beat 1 then beat 2, the break to dark. The style's crackOutMs: what a
 * client that cannot play it waits, and part of the GM's bound. A slow Worker start can add up to READY_WAIT_MS - lead
 * (nidhogg-crack-out.js); battle-opening.js races the crack-out against crackOutMs + 4 s, the shatter caps it at 15 s.
 */
export const CRACK_OUT_MS = Math.round(crackOutPlan().dark * 1000);
/** The longest beat 1 waits for its painter before it falls back to a plain fade to black (ms, speed 1). */
export const READY_WAIT_MS = 1500;
/** Beat 1's fallback (no painter in time): the cracked frame fades to black over this (ms, the old placeholder's). */
export const FALLBACK_FADE_MS = 1600;

/**
 * What the crack-out shows at T: hold (the cracked frame, before the first leak) | leak | black (beat 1 over, no eyes
 * yet) | eyes | dark (over).
 */
export function crackOutPhase(T, P = crackOutPlan()) {
  if (T >= P.dark) return "dark";
  if (T >= P.eyes && T < P.eyesEnd) return "eyes";
  if (T >= P.allBlack) return "black";
  if (T >= P.leak - 0.01) return "leak";
  return "hold";
}
/** Does beat 1's painter have anything to paint at T (the mockup's leak window)? */
export const paintsAt = (T, P = crackOutPlan()) => T >= P.leak - 0.01 && T < P.allBlack;
/** Does beat 2 (the mockup's eyes window: T in [eyes, eyes + EYES_END]; drawEyes is empty at its very end)? */
export const eyesAt = (T, P = crackOutPlan()) => T >= P.eyes && T < P.eyesEnd;

/**
 * The effect frame for a window of W x H CSS px: PX screen px per effect px, a whole number, so the frame keeps the
 * mockup's ~360 rows (1920 x 1080 -> 3, 640 x 360, as the mockup); EW x EH effect px (the last column / row may run
 * a little off the window).
 */
export function effectGrid(W, H, rows = CRACK_OUT_LOOK.rows) {
  const PX = Math.max(2, Math.round((Number(H) || 1080) / rows));
  return Object.freeze({ PX, EW: Math.max(1, Math.ceil((Number(W) || 1920) / PX)), EH: Math.max(1, Math.ceil((Number(H) || 1080) / PX)) });
}

/**
 * A FALLBACK for a shatter without ctx.strokes: the crack strokes ({ kind, pts: [{x, y}], width: [] }, CSS px)
 * rebuilt from its segments (ctx.cracks). toSegs() emits each stroke's segments in order, each turned to run away from
 * the impact; consecutive segments of one stroke share a point, so a new stroke starts where the kind changes or no
 * point is shared. APPROXIMATE: strokes that meet end to end merge, and a stroke's direction can come out reversed, so
 * the leak's emitters land a little differently from the mockup's. The real path is ctx.strokes (exact).
 */
export function strokesFromCracks(cracks = []) {
  const out = [];
  const same = (p, q) => !!p && !!q && p.x === q.x && p.y === q.y;
  let cur = null;
  for (const c of cracks) {
    if (!c?.a || !c?.b) { cur = null; continue; }
    const A = { x: c.a.x, y: c.a.y }, B = { x: c.b.x, y: c.b.y };
    if (cur && cur.kind === c.kind) {
      // a stroke of one segment so far may have been turned: flip it if its START is the shared point
      if (cur.pts.length === 2 && !same(cur.pts[1], A) && !same(cur.pts[1], B) && (same(cur.pts[0], A) || same(cur.pts[0], B))) { cur.pts.reverse(); cur.width.reverse(); }
      const tail = cur.pts[cur.pts.length - 1];
      if (same(tail, A)) { cur.pts.push(B); cur.width.push(c.w1); continue; }
      if (same(tail, B)) { cur.pts.push(A); cur.width.push(c.w0); continue; }
    }
    cur = { kind: c.kind, pts: [A, B], width: [c.w0, c.w1] };
    out.push(cur);
  }
  return out;
}

/** The box [x0, y0, x1, y1] of non-zero pixels of a w x h Uint32 buffer, or null. */
export function boxOf(buf, w, h) {
  let y0 = -1, y1 = -1, x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    let a = -1, b = -1;
    for (let x = 0; x < w; x++) if (buf[r + x]) { a = x; break; }
    if (a < 0) continue;
    for (let x = w - 1; x >= a; x--) if (buf[r + x]) { b = x; break; }
    if (y0 < 0) y0 = y;
    y1 = y;
    if (a < x0) x0 = a;
    if (b > x1) x1 = b;
  }
  return y0 < 0 ? null : [x0, y0, x1, y1];
}

/**
 * Where the leak's frame is cut into bands (fractions of its height), one painter per band, each on a Worker lane of
 * its own (nidhogg-crack-out.js). A band paints only its rows (the veil's and, by smoke-cloud.js cloudFast's band
 * mode, the smoke's), each runs the whole puff list (~0.5 ms), so a frame costs about half (Node, 2026-11-20: whole
 * frame p95 9.1 / max 9.8 ms; see crack-out.test.mjs for the bands).
 */
export const LEAK_CUTS = Object.freeze([0.5]);
/**
 * The leak's JIT warm-up: frames each band's Worker draws and throws away before "ready" (crystal-worker.js
 * crackOut.warm). A fresh Worker met one path of the leak's code for the first time at the smoke's peak and paid for
 * it in a real frame (real GPU, 2026-11-20: the top band's frame at T 2.19 s, 33-35 ms in the crack-out, 13.8 ms
 * against ~8 in a Worker alone; three draws round 2.2 s first: max 9.7). draw() is a pure function of T, so the frames
 * after it are the same pixels (crack-out.test.mjs).
 */
export const LEAK_WARM_TS = Object.freeze([1.4, 2.2, 3.0]);
/** The leak's bands: [[0, c1), ..., [ck, H)] (rows of the whole frame), each at least one row. */
export function leakBands(H, cuts = LEAK_CUTS) {
  const e = [0];
  for (const c of cuts) e.push(Math.min(H, Math.max(e.at(-1) + 1, Math.min(H - 1, Math.round(H * c)))));
  e.push(H);
  return e.slice(0, -1).map((y0, i) => [y0, e[i + 1]]).filter(([a, b]) => b > a);
}

/**
 * makeCrackOutPainter(o): o = { W, H (the effect frame), PX, strokes ([{ kind, pts, width }], CSS px), impact {x, y}
 * (CSS px), U (min(window W, H), CSS px), look? (CRACK_OUT_LOOK overrides), band? [y0, y1), eyes? (default true) }.
 * Building the leak costs ~140 ms (Node, this PC): done here, in the Worker, before "ready".
 * -> { W, H, P, leak, band, draw({ T, color?, light? }) -> { color, light, cRect, lRect, ms, puffs, phase, band } }
 *    T: s into the crack-out (speed 1). color / light: the ArrayBuffers handed back for reuse, or none.
 *    Beat 1 (paintsAt) paints the leak; beat 2 (eyesAt) the eyes, colour + light; any other T an empty frame.
 * With a BAND, beat 1 (and any T that is not the eyes) paints only rows [y0, y1): its buffers are W x (y1 - y0), its
 * cRect in the WHOLE frame's rows, and `band` says so; the eyes (unless eyes: false, then nothing) stay whole frames
 * (W x H, band null). Joined, the bands are the whole-frame painter's frame pixel for pixel (crack-out.test.mjs).
 */
export function makeCrackOutPainter(o = {}) {
  const W = Math.max(1, Math.round(o.W)), H = Math.max(1, Math.round(o.H)), PX = Number(o.PX) || 3;
  const look = { ...CRACK_OUT_LOOK, ...(o.look ?? {}) };
  const P = crackOutPlan(look);
  const geo = { strokes: o.strokes ?? [], I: { x: Number(o.impact?.x) || 0, y: Number(o.impact?.y) || 0 }, U: Number(o.U) || Math.min(W, H) * PX };
  const leak = makeLeak({ geo, W, H, PX, seeds: look.seeds, start: P.leak, black: P.black, seed: look.seed });
  const band = Array.isArray(o.band) ? [Math.max(0, Math.min(H - 1, o.band[0] | 0)), Math.max(1, Math.min(H, o.band[1] | 0))] : null;
  if (band && band[1] <= band[0]) band[1] = band[0] + 1;
  const withEyes = o.eyes !== false;
  const N = W * H;
  // the whole frame (the eyes; and the leak without a band), and the band's rows (the leak with one)
  const frame = !band || withEyes ? createFrame(W, H) : null;
  const bframe = band ? createFrame(W, band[1] - band[0], 0, band[0]) : frame;
  return {
    W, H, P, leak, band,
    draw({ T, color, light } = {}) {
      const t0 = (globalThis.performance ?? Date).now();
      T = Number(T) || 0;
      let puffs = 0;
      const eyes = withEyes && eyesAt(T, P);
      const f = eyes ? frame : bframe, n = f.w * f.h;
      clearFrame(f);
      // the veil and the smoke through one painter: the smoke blends over the veil (see the header)
      if (paintsAt(T, P)) { const p = painterFor(f); puffs = leak.draw(p, p, T) || 0; }
      // his eyes: the mockup's drawEyes(painterFor(eF), T - P.eyes, { W: EW, H: EH, brow }) into a cleared frame
      else if (eyes) drawEyes(painterFor(f), T - P.eyes, { W, H, brow: look.brow, size: look.eyeSize });
      let cRect = boxOf(f.color, f.w, f.h);
      if (cRect && f.oy) { cRect[1] += f.oy; cRect[3] += f.oy; }
      const c = color && color.byteLength === n * 4 ? new Uint32Array(color) : new Uint32Array(n);
      c.set(f.color);
      // the light: only the eyes write it; a light buffer handed in always comes back (cleared outside the eyes)
      const handed = !!light && light.byteLength === N * 4;
      let l = null, lRect = null;
      if (eyes || handed) {
        l = handed ? new Uint32Array(light) : new Uint32Array(N);
        if (eyes) { l.set(frame.light); lRect = boxOf(frame.light, W, H); } else l.fill(0);
      }
      return { color: c.buffer, light: l ? l.buffer : new ArrayBuffer(0), cRect, lRect, ms: (globalThis.performance ?? Date).now() - t0, puffs, phase: crackOutPhase(T, P), band: f === bframe ? band : null };
    },
  };
}
