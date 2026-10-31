// Summoning circle, at the party sprites' density, built round the creature it summons. pixelfx's
// magic-circle-cast (column of light adapted from Sprite Fusion's holy light, MIT, Hugo Duprez / Patch), tightened
// from 3.9 s to 2.2 s and tied to the sprite: the circle is sized to its footprint, it RISES up out of the circle
// through a seam of light as the column fires, lit from below and cooling, and its eye catches a glint at the end.
// Lines stay 1 px; the runes are drawn at 2 px a pixel.
// Ported from the approved mockup (claude.ai/artifact/WQXfrnXm8PPTdQSeaJ9WXk). The circle, its runes' footing, the
// shock rings and the rings climbing the column lie on the floor through floor.js (flat: the mockup exactly; under
// the 3D camera: the floor the camera draws); the column, the creature and its light stay on its card.
import { Particles, Lights, P, Rng, PAL, fit, flare, sparkle, clamp, smooth, ease, noise2, fract, rand, luma, TAU, WHITE } from "./pixelfx/core/index.js";
import { bayer, GLYPHS } from "./pixelfx/fx/arcane/_lib.js";
import { makeFloor, band, ring as floorRing } from "./floor.js";

const SY = 0.3, NRUNE = 8, RUNE_PX = 2;
const PEN = [0.02, 0.26], PEN2 = [0.06, 0.3], INNER = [0.16, 0.36], STAR = [0.3, 0.52], RUNES = [0.5, 0.72];
const FLASH = 0.8, RISE = 0.38, BREAK = 1.2, GLINT = 1.36, GONE = 1.75, END = 2.2;

export const meta = { name: "Summoning circle (HD)", duration: END, loop: false, options: { palette: PAL.arcane, floorDy: 0, floor: null, seed: 6 } };

const scaleOf = (A) => Math.max(1, (A.w * 0.72) / 40);   // the outer ring reaches a little past its sides
export function layout(o) {
  // the widest floor shape is the first shock ring (1.8 x the circle): room for it however the floor is drawn
  const K = scaleOf(o.actor), up = Math.max(192 * K, o.actor.h + 60 * K), F = makeFloor(o.floor, SY), r = 72 * K;
  const half = Math.max(100 * K, r * Math.hypot(F.ex[0], F.ez[0]) + 8), below = Math.max(40 * K, r * Math.hypot(F.ex[1], F.ez[1]) + 8);
  return { size: [Math.ceil(2 * half), Math.ceil(up + below + Math.max(0, o.floorDy))], origin: [Math.ceil(half), Math.ceil(up)] };
}

/** How the creature itself shows: nothing until the flash, then it rises out of the circle (0 under the floor, 1 up). */
export function reveal(t) {
  const k = clamp((t - FLASH) / RISE);
  return { a: t >= FLASH ? 1 : 0, rise: ease.outCubic(k), shadow: k };
}

const wrap = (a) => ((a % TAU) + TAU) % TAU;
const fromFront = (g) => Math.abs(Math.atan2(Math.sin(g - Math.PI / 2), Math.cos(g - Math.PI / 2)));
const outerAt = (g, w) => w[0] + (fromFront(g) / Math.PI) * (w[1] - w[0]);
const innerAt = (g) => INNER[0] + (wrap(g + Math.PI / 2) / TAU) * (INNER[1] - INNER[0]);
const runeAngle = (k) => -Math.PI / 2 + ((k + 0.5) * TAU) / NRUNE;
const runeLit = (k) => RUNES[0] + (k * (RUNES[1] - RUNES[0])) / (NRUNE - 1);
const runeOut = (k) => BREAK + 0.1 + k * 0.04;
function level(t) {
  if (t < RUNES[0]) return 0.55;
  if (t < FLASH) return 0.55 + 0.4 * smooth(RUNES[0], FLASH, t);
  if (t < FLASH + 0.07) return 1.2;
  if (t < BREAK) return 0.92;
  return 0.92 * (1 - smooth(BREAK, GONE, t));
}
function rune(p, i, x, y, c, a, under) {
  const g = GLYPHS[i % GLYPHS.length], s = RUNE_PX, X = Math.round(x) - Math.round(1.5 * s), Y = Math.round(y) - g.length * s + 1;
  if (under) p.sprite(g, {}, X, Y + s, { tint: under, a, scale: s });
  p.sprite(g, {}, X, Y, { tint: c, a, scale: s });
}

export function create(o) {
  const A = o.actor, K = scaleOf(A), FY = o.floorDy, C = fit(o.palette, 8), S = o.seed, Rg = new Rng(S), F = makeFloor(o.floor, SY, FY);
  const Rr = 40 * K, R2 = 35 * K, RI = 24 * K, RR = 30 * K, TOP = Math.max(192 * K, A.h * 2.6), W = Math.max(8 * K, A.w * 0.2);
  const ps = new Particles({ rng: Rg, ground: () => FY, sparks: [WHITE, C[6], C[5], C[4]] }), lights = new Lights();
  const COL = [WHITE, C[6], C[5], C[4], C[3]];
  const strands = Array.from({ length: 9 }, () => ({ o: Rg.range(-0.85, 0.85), w: Rg.range(0.04, 0.1), f: Rg.range(1, 3) }));
  const tri = (a0) => [0, 1, 2].map((k) => a0 + (k * TAU) / 3).map((a) => [Math.cos(a) * RI, Math.sin(a) * RI]);
  const Ta = tri(-Math.PI / 2), Tb = tri(Math.PI / 2), edges = [];
  for (let k = 0; k < 3; k++)
    for (const T of [Ta, Tb]) edges.push({ p0: T[k], p1: T[(k + 1) % 3], t0: STAR[0] + (k * (STAR[1] - STAR[0])) / 3, dur: (STAR[1] - STAR[0]) / 3 });
  // the creature's brightest spot (the Looker's eye): where the closing glint lands
  let ex = 0, ey = 0, en = 0;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) { const c = A.pixels[y * A.w + x]; if (A.mask.data[y * A.w + x] && luma(c) > 0.8) (ex += x, ey += y, en++); }
  const eye = en > 4 ? [A.x + ex / en, A.y + ey / en] : null;
  let t = 0, flashed = false, broke = false, glinted = false;
  const out = new Array(NRUNE).fill(false);
  const lineCol = (lvl, age) => (age < 0.05 ? WHITE : age < 0.16 ? C[6] : lvl > 1 ? WHITE : lvl > 0.8 ? C[6] : lvl > 0.45 ? C[5] : lvl > 0.28 ? C[4] : C[3]);
  const lineA = (lvl) => clamp(lvl / 0.3);
  const lift = () => (1 - reveal(t).rise) * A.h;

  function planeLine(p, p0, p1, t0, dur, lvl, far) {
    const s = clamp((t - t0) / dur);
    if (s <= 0) return;
    let u0 = 0, u1 = s;
    const v0 = p0[1], v1 = p1[1];
    if ((v0 < 0) !== (v1 < 0)) {
      const uc = v0 / (v0 - v1);
      if ((v0 < 0) === far) u1 = Math.min(u1, uc);
      else u0 = uc;
    } else if ((v0 < 0) !== far) return;
    if (u1 <= u0) return;
    const Pt = (u) => F.at(p0[0] + (p1[0] - p0[0]) * u, v0 + (v1 - v0) * u);
    const [xa, ya] = Pt(u0), [xb, yb] = Pt(u1);
    p.line(xa, ya, xb, yb, (q) => lineCol(lvl, t - (t0 + (u0 + (u1 - u0) * q) * dur)), lineA(lvl));
  }
  function circle(p, far) {
    if (t >= GONE) return;
    const lvl = level(t), keep = far ? (g) => Math.sin(g) < 0 : (g) => Math.sin(g) >= 0, a = lineA(lvl);
    const ring = (r, when, chase) => floorRing(p, F, 0, 0, r, (g) => (chase && chase(g) ? WHITE : lineCol(lvl, t - when(g))), (g) => (t < when(g) ? 0 : a), keep);
    const run = t > RUNES[0] && t < BREAK ? (t - RUNES[0]) * 9 + (t - RUNES[0]) ** 2 * 14 : null;
    const chase = run === null ? null : (g) => [0, Math.PI].some((o) => Math.abs(Math.atan2(Math.sin(g - run - o), Math.cos(g - run - o))) < 0.22);
    ring(Rr, (g) => outerAt(g, PEN), chase);
    ring(Rr - 1, (g) => outerAt(g, PEN), chase);
    ring(R2, (g) => outerAt(g, PEN2));
    ring(RI, innerAt);
    for (let j = 0; j < 64; j++) {
      const g = ((j + 0.5) * TAU) / 64;
      if (Math.sin(g) < 0 !== far) continue;
      const when = outerAt(g, PEN2) + 0.02;
      if (t < when) continue;
      const r0 = j % 2 ? R2 + (Rr - R2) * 0.45 : R2;
      const [xa, ya] = F.at(Math.cos(g) * r0, Math.sin(g) * r0), [xb, yb] = F.at(Math.cos(g) * Rr, Math.sin(g) * Rr);
      p.line(xa, ya, xb, yb, lineCol(lvl, t - when), a * (j % 2 ? 0.6 : 1));
    }
    for (const e of edges) planeLine(p, e.p0, e.p1, e.t0, e.dur, lvl, far);
  }
  function runes(p, far) {
    for (let k = 0; k < NRUNE; k++) {
      const g = runeAngle(k);
      if (Math.sin(g) < 0 !== far) continue;
      const [x, y0] = F.at(Math.cos(g) * RR, Math.sin(g) * RR), lit = t - runeLit(k), gone = clamp((t - runeOut(k)) / 0.2);
      if (t < innerAt(g) || gone >= 1) continue;
      if (lit < 0) {
        rune(p, k, x, y0 - 1, C[3], 1, 0);
        continue;
      }
      const rise = 3 * K * ease.outBack(clamp(lit / 0.15), 2.4), bob = lit > 0.15 ? Math.sin(t * 6 + k) * 0.5 * K : 0, y = y0 - 1 - rise + bob;
      const hot = lit < 0.06 || (t > FLASH && t < FLASH + 0.07), lvl = level(t);
      rune(p, k, x, y, hot ? WHITE : lvl > 0.8 ? WHITE : C[6], 1 - gone, hot ? C[6] : C[4]);
      if (lit < 0.08) sparkle(p, x, y - 5 * RUNE_PX, (4 * (1 - lit / 0.08) + 1) * K, C[6], C[5], 0.5);
      p.glow(x, y - 2 * K, 8 * K, C[5], (0.3 + 0.3 * lvl) * (1 - gone));
    }
  }
  // the column: narrower than the creature, so it rises through a shaft of light rather than vanishing in one
  function column(p) {
    if (t < FLASH - 0.16 || t > BREAK + 0.4) return;
    if (t < FLASH) {
      const a = smooth(FLASH - 0.16, FLASH - 0.03, t), top = FY - (TOP - 10 * K) * ease.outCubic(a);
      for (let y = FY - 1; y >= top; y--) p.dot(0, y, y > top + 6 * K ? C[6] : WHITE, a * (0.35 + 0.65 * (1 + (y - FY) / TOP)));
      p.glow(0, top, 9 * K, C[6], 0.5 * a);
      p.glow(0, FY - 6 * K, 24 * K, C[5], 0.4 * a);
      return;
    }
    const u = t - FLASH, brk = clamp((t - BREAK) / 0.3), top = FY - TOP * ease.outExpo(clamp(u / 0.08));
    const w = t < BREAK ? W * (1 + 0.38 * Math.exp(-u * 9)) : W * (1 - ease.outCubic(brk) * 0.85);
    const fade = 1 - smooth(BREAK + 0.12, BREAK + 0.38, t), white = u < 0.067;
    if (fade <= 0) return;
    for (let y = FY + 3; y >= Math.ceil(top); y--) {
      const h = FY - y, ww = w * (1 + 0.5 * Math.exp(-Math.max(0, h) / (6 * K))), pulse = fract(h * 0.022 / K - u * 3.4) < 0.07 ? 1 : 0;
      for (let x = Math.floor(-ww * 1.3); x <= Math.ceil(ww * 1.3); x++) {
        const q = Math.abs(x + 0.5) / ww;
        if (brk > 0 && noise2((x * 0.32) / K, (h * 0.11) / K - (t - BREAK) * 9, S) * 0.5 + 0.5 < brk * 1.25 - 0.1) continue;
        let lv = q < 0.2 ? 0 : q < 0.42 ? 1 : q < 0.66 ? 2 : q < 0.88 ? 3 : 4;
        for (const s of strands) if (Math.abs((x + 0.5) / ww - s.o - 0.05 * Math.sin(t * s.f + s.o * 9)) < s.w) lv = Math.max(0, lv - 1);
        lv = white ? 0 : Math.max(0, lv - pulse);
        // behind the creature's body the shaft thins, so the body reads against it
        const a = (q < 0.88 ? 1 : (1.3 - q) / 0.42) * fade * (behind(x, y) ? 0.45 : 1);
        if (a <= bayer(x, y) * (q < 0.66 ? 0.2 : 1)) continue;
        p.px(x, y, COL[lv]);
      }
      if ((h & 15) === 0 && h < TOP - ww * 2.4 - 8 * K) p.glow(0, y, ww * 2.4 + 6 * K, C[5], 0.3 * fade);
    }
    for (let i = 0; i < 5; i++) {
      const k = (t - (FLASH + 0.06 + i * 0.1)) / 0.5;
      if (k < 0 || k > 1) continue;
      const rx = Math.max(w * 1.4, A.w * 0.55) * (1 + k * 0.35), yc = -3 * K - ease.outQuad(k) * A.h * 1.4, n = Math.ceil(rx * 7 * F.stretch);
      for (let j = 0; j < n; j++) {
        const g = (j / n) * TAU, [x, y] = F.at(Math.cos(g) * rx, Math.sin(g) * rx);
        if (Math.sin(g) < 0 && behind(x, y + yc)) continue;
        p.dot(x, y + yc, k < 0.3 ? WHITE : C[6], (1 - k) * fade * (Math.sin(g) < 0 ? 0.6 : 1));
      }
    }
    p.glow(0, FY - 4 * K, 34 * K, C[6], 0.45 * fade);
  }
  // is a local point behind the (risen part of the) creature's body?
  function behind(x, y) {
    if (reveal(t).a <= 0 || y > 0) return false;
    const i = Math.floor(x - A.x), j = Math.floor(y - A.y - lift());
    return i >= 0 && j >= 0 && i < A.w && j < A.h && A.mask.data[j * A.w + i] > 0;
  }
  // the creature, lit from below by the circle: brightest at its feet, cooling over 0.8 s, a crackling rim at first
  function bodyLight(p) {
    const since = t - FLASH;
    if (since < 0 || since > 0.85) return;
    const k = 1 - since / 0.85, dy = lift(), f = Math.floor(t * 30);
    const on = (i, j) => i >= 0 && j >= 0 && i < A.w && j < A.h && A.mask.data[j * A.w + i];
    for (let j = 0; j < A.h; j++) {
      const y = A.y + j + dy;
      if (y > 0) continue;
      const up = 0.3 + 0.7 * (j / A.h);
      for (let i = 0; i < A.w; i++) {
        if (on(i, j)) p.light(A.x + i, y, C[6], k * k * up * (since < 0.06 ? 1.2 : 0.75));
        else if (since < 0.4 && (on(i - 1, j) || on(i + 1, j) || on(i, j - 1) || on(i, j + 1)) && rand(i, j, f) < 0.75 * (1 - since / 0.4))
          p.px(A.x + i, y, rand(i, j, 5) < 0.5 ? WHITE : C[6]);
      }
    }
    // the seam it rises through: a white-hot cut across the circle's heart while it comes up
    const r = reveal(t).rise;
    if (r < 1) {
      const half = A.w * 0.55 * (0.6 + 0.4 * (1 - r));
      p.line(-half, -1, half, -1, (q) => (Math.abs(q - 0.5) < 0.3 ? WHITE : C[6]));
      p.line(-half * 0.8, 0, half * 0.8, 0, C[5]);
      p.glowLine(-half, -2, half, -2, 8 * K, C[5], 0.7 * (1 - r));
    }
  }
  function shock(p, far) {
    for (const [d, r0, r1, th, dur] of [[0, Rr * 0.6, Rr * 1.8, 6 * K, 0.4], [0.06, Rr * 0.4, Rr * 1.3, 3 * K, 0.32]]) {
      const k = (t - FLASH - d) / dur;
      if (k < 0 || k >= 1) continue;
      band(p, F, 0, 0, r0 + (r1 - r0) * ease.outCubic(k), Math.max(1, th * (1 - k)), 1.15 - k, [C[3], C[5], C[6], WHITE], (g) => Math.sin(g) < 0 === far, k < 0.2);
    }
  }

  return {
    update(dt) {
      t += dt;
      if (t > PEN[0] && t < STAR[1] && Rg.chance(Math.min(1, 0.6 * K))) {
        let x, y;
        if (t < PEN[1]) {
          const g = Math.PI / 2 + Rg.sign() * ((t - PEN[0]) / (PEN[1] - PEN[0])) * Math.PI;
          (x = Math.cos(g) * Rr), (y = Math.sin(g) * Rr);
        } else if (t < INNER[1]) {
          const g = -Math.PI / 2 + ((t - INNER[0]) / (INNER[1] - INNER[0])) * TAU;
          (x = Math.cos(g) * RI), (y = Math.sin(g) * RI);
        } else {
          const e = Rg.pick(edges.filter((e) => t >= e.t0 && t < e.t0 + e.dur)) ?? edges[0], s = clamp((t - e.t0) / e.dur);
          (x = e.p0[0] + (e.p1[0] - e.p0[0]) * s), (y = e.p0[1] + (e.p1[1] - e.p0[1]) * s);
        }
        const [X, Y] = F.at(x, y);
        ps.spawn(P.EMBER, X, Y - 1, Rg.range(-12, 12) * K, Rg.range(-30, -8) * K, Rg.range(0.2, 0.45), C[6], 1);
      }
      if (t > RUNES[1] - 0.1 && t < FLASH - 0.04 && Rg.chance(Math.min(1, 0.8 * K))) {
        const g = Rg.range(0, TAU), D = Rg.range(Rr * 0.7, Rr * 1.1), T = Rg.range(0.12, 0.18), v = (D * 3) / (Math.exp(3 * T) - 1);
        const [x, y1] = F.at(Math.cos(g) * D, Math.sin(g) * D), y = y1 - 1, l = Math.hypot(x, y - FY + 2) || 1;
        ps.spawn(P.STREAK, x, y, (-x / l) * v, ((FY - 2 - y) / l) * v, T, Rg.chance(0.5) ? C[6] : C[5]);
      }
      if (!flashed && t >= FLASH) {
        flashed = true;
        lights.add(0, FY - A.h * 0.6, A.h * 1.1, C[5], 0.9, 0.5);
        lights.add(0, FY - 5 * K, 36 * K, WHITE, 0.8, 0.12);
        for (let i = 0; i < Math.round(30 * K); i++) {
          const s = Rg.sign(), sp = Rg.range(80, 175) * K;
          ps.spawn(P.SPARK, s * Rg.range(0, Rr * 0.5), FY - 1, s * sp, -Rg.range(30, 180) * Math.sqrt(K), Rg.range(0.25, 0.6));
        }
        for (let i = 0; i < Math.round(28 * K); i++) {
          const s = Rg.sign();
          ps.spawn(P.STAR, s * Rg.range(0, 14) * K, FY - Rg.range(1, 4) * K, s * Rg.range(50, 140) * K, -Rg.range(10, 90) * K, Rg.range(0.35, 0.8), Rg.pick([WHITE, C[6], C[6], C[5]]), Rg.range(0.7, 2.2) * K);
        }
      }
      // light and motes stream up the creature as it comes up out of the floor
      if (t > FLASH && t < FLASH + RISE + 0.1 && Rg.chance(Math.min(1, 0.9 * K)))
        ps.spawn(P.MOTE, Rg.range(-0.45, 0.45) * A.w, FY - Rg.range(0, 6), 0, -Rg.range(140, 260) * Math.sqrt(K), Rg.range(0.2, 0.35), Rg.chance(0.5) ? WHITE : C[6], 0.8 * K);
      if (t > RUNES[0] && t < BREAK + 0.1 && Rg.chance(Math.min(1, 0.14 * K))) {
        const g = Rg.range(0, TAU), r = Rg.pick([Rr, R2, RI]), [x, y] = F.at(Math.cos(g) * r, Math.sin(g) * r);
        ps.spawn(P.STAR, x, y - 0.5, 0, -Rg.range(2, 8) * K, Rg.range(0.2, 0.4), Rg.pick([WHITE, C[6]]), Rg.range(0.8, 2) * K);
      }
      if (!broke && t >= BREAK) {
        broke = true;
        for (let i = 0; i < Math.round(36 * K); i++)
          ps.spawn(P.STAR, Rg.range(-1, 1) * W * 0.9, FY - Rg.range(2, TOP * 0.8), Rg.range(-12, 12) * K, -Rg.range(8, 40) * K, Rg.range(0.4, 0.9), Rg.pick([WHITE, WHITE, C[6], C[5]]), Rg.range(0.6, 2.4) * K);
      }
      for (let k = 0; k < NRUNE; k++)
        if (!out[k] && t >= runeOut(k)) {
          out[k] = true;
          const g = runeAngle(k), [x, y0] = F.at(Math.cos(g) * RR, Math.sin(g) * RR), y = y0 - 5 * K;
          for (let i = 0; i < 3; i++) ps.spawn(P.STAR, x + Rg.range(-2, 2) * K, y + Rg.range(-2, 2) * K, Rg.range(-14, 14) * K, -Rg.range(10, 40) * K, Rg.range(0.25, 0.45), Rg.pick([WHITE, C[6]]), Rg.range(0.6, 1.6) * K);
        }
      // the closing beat: its eye catches the light
      if (!glinted && t >= GLINT && eye) {
        glinted = true;
        lights.add(eye[0], eye[1], 22 * K, WHITE, 0.6, 0.18);
      }
      ps.update(dt);
      lights.update(dt);
    },
    drawBack(p) {
      const lvl = level(t);
      if (t < GONE) {
        const k = lvl * smooth(PEN[0], PEN[1] + 0.15, t);
        p.glow(0, FY, Rr * 1.3, C[4], 0.28 * k);
        for (const s of [-1, 1]) {
          const [x, y] = F.at(s * Rr * 0.6, 0);
          p.glow(x, y + 1, Rr * 0.7, C[5], 0.12 * k);
        }
      }
      shock(p, true);
      circle(p, true);
      runes(p, true);
      column(p);
      ps.draw(p, "back");
    },
    draw(p) {
      shock(p, false);
      circle(p, false);
      runes(p, false);
      bodyLight(p);
      const pen = (x, y) => {
        sparkle(p, x, y, 2 * K, C[6], C[5], 0.5);
        p.glow(x, y, 7 * K, C[6], 0.45);
      };
      if (t > PEN[0] && t < PEN[1]) for (const s of [-1, 1]) {
        const g = Math.PI / 2 + s * ((t - PEN[0]) / (PEN[1] - PEN[0])) * Math.PI;
        pen(...F.at(Math.cos(g) * Rr, Math.sin(g) * Rr));
      }
      if (t > INNER[0] && t < INNER[1]) {
        const g = -Math.PI / 2 + ((t - INNER[0]) / (INNER[1] - INNER[0])) * TAU;
        pen(...F.at(Math.cos(g) * RI, Math.sin(g) * RI));
      }
      for (const e of edges)
        if (t > e.t0 && t < e.t0 + e.dur) {
          const s = (t - e.t0) / e.dur;
          pen(...F.at(e.p0[0] + (e.p1[0] - e.p0[0]) * s, e.p0[1] + (e.p1[1] - e.p0[1]) * s));
        }
      if (t >= FLASH && t < FLASH + 0.2) {
        const a = (t - FLASH) / 0.2;
        flare(p, 0, FY - 8 * K, 34 * K * Math.pow(1 - a, 1.5), 1 - a, C);
      }
      if (eye && t >= GLINT && t < GLINT + 0.3) {
        const q = (t - GLINT) / 0.3;
        sparkle(p, eye[0], eye[1], Math.round(9 * K * Math.sin(Math.PI * Math.min(1, q * 1.6))), WHITE, C[6], 0.7 * (1 - q));
      }
      ps.draw(p, "front");
      lights.draw(p);
    },
  };
}
