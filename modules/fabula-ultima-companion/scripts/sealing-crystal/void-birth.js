// ============================================================================
// Nidhogg's crystal comes back out of the void, after the dragon form falls
// (docs/nidhogg-boss-design.md §8b, mockup v15 FINAL). Ported from
// tools/nidhogg-fall-mockup/fx/void-birth.js; the rejected slow unveil
// (UNVEIL / revealAt, mockup 4) is left out. Pure: no DOM, no Foundry.
//
// On one clock (T = s into the fall), in the black:
//   heartbeats — a point of light where his heart is pulses in BOTH his colours:
//                a red halo PAINTED as stepped bands round a green core (red +
//                green added on the same pixels turns yellow), a red ring and a
//                green ring just behind it. The soul never shows alone.
//   gather     — (later fall) red motes drawn into the light, accelerating
//   dip        — (later fall) a short breath in
//   BLIP       — (later fall) the crystal is there at once (the crystal host
//                draws it, popped 1.14 -> 1, white frame, no shards): here a
//                white-red shock ring, a slower green ring, red glitter
// First fall (COMBO.first): three heartbeats, then the crystal fades in SOLID,
// holds, and ONE quick thick flash crosses it in 3D (crystal-render st.sweep),
// after which the glass is clear and the soul shows: comboAt() drives the
// crystal's reveal / opaque / sweep and the light here.
// ============================================================================

import { Rng, hex, clamp, TAU, WHITE } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

const RED = ["#12030b", "#2c0614", "#540a1c", "#861126", "#b91d31", "#e2414b", "#ff8c86", "#ffe2d4"].map(hex);
const GREEN = ["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2"].map(hex);
export const RED_SWELL = hex("#e2414b"), GREEN_SWELL = hex("#a6ff9c");

/** The later fall's blip (mockup 3, the user 2026-11-11: "later fall = mockup 3's crystal show-up, minus the debris"). */
export const BIRTH = Object.freeze({
  repeat: Object.freeze({ sparkAt: 3.35, beats: Object.freeze([3.35, 3.8]), motesFrom: 3.5, motesTo: 4.25, motes: 90, glitter: 55, dip: 4.18, blip: 4.3, flash: 0.4, ringR: 220, end: 5.8 }),
});

// The first fall: three blips, then the crystal fades in solid, holds, ONE quick thick flash passes through (the user,
// 2026-11-11). w = width x, k = strength, o = offset behind the lead.
const comboBirth = (beats) => Object.freeze({ sparkAt: beats[0], beats, motesFrom: 0, motesTo: 0, motes: 0, glitter: 0, dip: Infinity, blip: Infinity });
export const COMBO = Object.freeze({
  first: Object.freeze({ blackAt: 7.4, beats: Object.freeze([10.4, 11.9, 12.8]), fadeFrom: 13.2, fadeTo: 14.6, sweepAt: 17.2, sweepDur: 0.45,
    lines: Object.freeze([Object.freeze({ o: 0, w: 2.6, k: 1 })]), end: 20.6, birth: comboBirth(Object.freeze([10.4, 11.9, 12.8])), clearAt: 17.2 + 0.45 }),
});

/**
 * comboAt(T, C) -> { fade (the crystal's reveal, eased), opaque, sweep (crystal-render st.sweep), flare (the soul as
 * the line crosses it), swell (a soft light as the soul shows), done, on }
 */
export function comboAt(T, C) {
  const u = clamp((T - C.fadeFrom) / (C.fadeTo - C.fadeFrom)), fade = u * u * (3 - 2 * u);
  const v = (T - C.sweepAt) / C.sweepDur, last = C.lines[C.lines.length - 1].o;
  let sweep = null, flare = 0;
  if (v >= 0 && v < 1) {
    // the lead line enters at -0.1 and the last leaves at 1.1, at a steady pace
    sweep = { pos: -0.1 + (1.2 + last) * v, k: Math.min(1, v * 12, (1 - v) * 12), before: 1, after: 0, lines: C.lines.map((l) => ({ ...l })) };
    for (const l of C.lines) flare = Math.max(flare, l.k * Math.exp(-Math.pow((sweep.pos - l.o - 0.5) / 0.06, 2)));
  }
  const swell = Math.max(0, 1 - Math.abs(T - C.clearAt - 0.15) / 0.6);
  return { fade, opaque: v >= 1 ? 0 : 1, sweep, flare, swell, done: T >= C.clearAt, on: T >= C.fadeFrom };
}

export function makeVoidBirth({ seed = 9 } = {}) {
  const cache = new Map();
  const motesFor = (B) => {
    if (cache.has(B)) return cache.get(B);
    const R = new Rng(seed), list = [];
    for (let i = 0; i < B.motes; i++) {
      const dur = R.range(0.55, 1.15), start = R.range(B.motesFrom, Math.max(B.motesFrom, B.motesTo - dur));
      list.push({ an: R.range(0, TAU), r0: R.range(130, 430), start, dur, spin: R.range(0.3, 0.9) * (R.chance(0.5) ? 1 : -1), c: R.pick([5, 6, 6, 7]) });
    }
    const R2 = new Rng(seed + 1), glitter = [];
    for (let i = 0; i < (B.glitter ?? 0); i++) {
      const an = R2.range(0, TAU), sp = R2.range(120, 400);
      glitter.push({ ox: Math.cos(an) * R2.range(4, 40), oy: Math.sin(an) * R2.range(6, 70), vx: Math.cos(an) * sp, vy: Math.sin(an) * sp * 0.8 - R2.range(0, 60), life: R2.range(0.45, 1.1), c: R2.pick([5, 6, 7, 7]) });
    }
    const v = { list, glitter };
    cache.set(B, v);
    return v;
  };

  /**
   * draw(p, T, B, heart, t, mode, k): p = painter on the effect frame, heart = { x, y } in its effect px, t = wall
   * clock (glitter twinkle), mode = "together" (the user's pick) | "alternating", k = the point's light (the first
   * fall hands it over to the crystal as it fades in)
   */
  function draw(p, T, B, heart, t, mode = "together", k = 1) {
    if (k <= 0.004) return;
    const { list, glitter } = motesFor(B);
    const hx = heart.x, hy = heart.y;
    if (T < B.sparkAt) return;
    const born = T >= B.blip;
    if (!born) {
      const n = B.beats.length;
      let pulse = 0, beatI = 0;
      B.beats.forEach((b, i) => { if (T >= b) beatI = i; const f = T - b; if (f >= 0 && f < 0.9) pulse = Math.max(pulse, f < 0.08 ? f / 0.08 : Math.pow(1 - (f - 0.08) / 0.82, 2)); });
      const grow = n > 1 ? beatI / (n - 1) : 1, appear = clamp((T - B.sparkAt) / 0.25), alt = mode === "alternating";
      const isRed = alt && beatI % 2 === 1, A = (0.35 + 0.65 * pulse) * appear * (0.7 + 0.5 * grow) * k;
      const rIn = 7 + 7 * pulse + 4 * grow;
      if (!alt) {
        const rOut = rIn + 14 + 30 * pulse + 18 * grow, bands = [[RED[4], 0.6], [RED[3], 0.4], [RED[2], 0.22]];
        for (let y = Math.floor(hy - rOut); y <= hy + rOut; y++) for (let x = Math.floor(hx - rOut); x <= hx + rOut; x++) {
          const d = Math.hypot(x + 0.5 - hx, (y + 0.5 - hy) / 0.92); if (d < rIn || d > rOut) continue;
          const kb = Math.min(2, Math.floor(((d - rIn) / (rOut - rIn)) * 3)); p.put(x, y, bands[kb][0], bands[kb][1] * A);
        }
        p.glow(hx, hy, rIn + 6, GREEN[5], 0.85 * A);
        p.glow(hx, hy, rIn * 0.6 + 3, GREEN[7], 0.5 * A);
      } else if (isRed) { p.glow(hx, hy, 34 + 60 * pulse + 30 * grow, RED[5], 0.6 * A); p.glow(hx, hy, rIn, RED[6], 0.4 * A); }
      else { p.glow(hx, hy, 10 + 24 * pulse + 10 * grow, GREEN[5], 0.75 * A); }
      // the point itself: white, its arms in the beat's colour (together: green arms, red tips)
      const core = pulse > 0.5 ? 2 : 1, arm = alt ? (isRed ? RED[6] : GREEN[7]) : GREEN[7], tip = alt ? arm : RED[6];
      for (let y = -core; y <= core; y++) for (let x = -core; x <= core; x++) { const m = Math.abs(x) + Math.abs(y); if (m <= core) p.put(Math.floor(hx + x), Math.floor(hy + y), m === 0 ? WHITE : m === core && core > 1 ? tip : arm, appear * k); }
      // each beat's rings: red outside, green just behind and smaller
      B.beats.forEach((b, i) => {
        const f = T - b; if (f < 0 || f > 0.95) return;
        const big = 0.8 + 0.5 * (n > 1 ? i / (n - 1) : 1);
        const ringAt = (delay, scaleR, c0, c1) => { const ff = f - delay; if (ff < 0 || ff > 0.85) return; const u = ff / 0.85, r = (6 + 120 * big * (1 - Math.pow(1 - u, 2.2))) * scaleR; ring(p, hx, hy, r, r * 0.92, u < 0.4 ? c0 : c1, (1 - u) * 0.9 * k, 1); };
        if (alt) { if (i % 2) ringAt(0, 1, RED[6], RED[5]); else ringAt(0, 1, GREEN[6], GREEN[5]); }
        else { ringAt(0, 1, RED[6], RED[5]); ringAt(0.09, 0.8, GREEN[6], GREEN[5]); }
      });
      // the gather: red motes drawn in from the dark, accelerating, curling a little as they come
      for (const m of list) {
        const u = (T - m.start) / m.dur; if (u < 0 || u >= 1) continue;
        const e = Math.pow(u, 2.2), r = m.r0 * (1 - e), an = m.an + m.spin * e;
        const x = hx + Math.cos(an) * r, y = hy + Math.sin(an) * r * 0.8;
        const a = clamp(u * 5);
        for (const [ex, ey] of [[0, 0], [1, 0], [0, 1], [1, 1]]) p.put(Math.floor(x) + ex, Math.floor(y) + ey, ex + ey === 0 ? RED[7] : RED[m.c], a);
        const r2 = m.r0 * (1 - Math.pow(Math.max(0, u - 0.05), 2.2)), an2 = m.an + m.spin * Math.pow(Math.max(0, u - 0.05), 2.2);
        const tx = hx + Math.cos(an2) * r2, ty = hy + Math.sin(an2) * r2 * 0.8, nn = Math.min(10, Math.ceil(Math.hypot(tx - x, ty - y)));
        for (let i = 1; i <= nn; i++) p.put(Math.floor(x + ((tx - x) * i) / nn), Math.floor(y + ((ty - y) * i) / nn), RED[Math.max(3, m.c - 1 - Math.floor((i / nn) * 2))], a * (1 - i / (nn + 1)));
        p.glow(x, y, 5, RED[5], 0.45 * a);
      }
      // the dip: the light pulls into the heart
      const d = (T - B.dip) / (B.blip - B.dip);
      if (d >= 0 && d < 1) p.glow(hx, hy, 60 * (1 - d) + 8, WHITE, 0.5 * d);
      return;
    }
    // BLIP: the shock ring (white, then red), a slower green ring, glitter thrown off the crystal
    const f = T - B.blip;
    if (f < 0.45) { const u = f / 0.45, r = 20 + (B.ringR ?? 220) * (1 - Math.pow(1 - u, 3)); ring(p, hx, hy, r, r * 0.8, u < 0.25 ? WHITE : RED[u < 0.6 ? 6 : 5], 1 - u, 2); }
    if (f < 0.9) { const u = f / 0.9, r = 14 + 170 * (1 - Math.pow(1 - u, 2)); ring(p, hx, hy, r, r * 0.8, GREEN[6], (1 - u) * 0.8, 1); }
    if (f < 0.3) p.glow(hx, hy, 120, WHITE, 0.7 * (1 - f / 0.3));
    for (const g of glitter) {
      if (f >= g.life) continue;
      const tt = f, dr = 3.2, s = (1 - Math.exp(-dr * tt)) / dr;
      const x = hx + g.ox + g.vx * s, y = hy + g.oy + g.vy * s + 40 * tt * tt;
      const a = 1 - f / g.life, tw = ((Math.floor(t * 30) + g.c * 7) % 5) === 0;
      p.put(Math.floor(x), Math.floor(y), tw ? WHITE : RED[g.c], a);
      if (g.c === 7) p.light(x, y, RED[6], 0.6 * a);
    }
  }
  return { draw };
}

// a thin elliptical ring, dithered at alpha a
function ring(p, cx, cy, rx, ry, c, a, w = 1) {
  const n = Math.max(24, Math.ceil(TAU * Math.max(rx, ry)));
  for (let i = 0; i < n; i++) {
    const an = (i / n) * TAU, x = cx + Math.cos(an) * rx, y = cy + Math.sin(an) * ry;
    for (let k = 0; k < w; k++) p.put(Math.floor(x + Math.cos(an) * k), Math.floor(y + Math.sin(an) * k), c, a);
    if (a > 0.3) p.light(x, y, c, 0.25 * a);
  }
}
