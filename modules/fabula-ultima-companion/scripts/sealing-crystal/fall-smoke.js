// ============================================================================
// Nidhogg's fall: the dragon's body TURNS INTO black smoke, then the smoke
// swallows the arena (docs/nidhogg-boss-design.md §8b, mockup v15 FINAL).
// Ported from tools/nidhogg-fall-mockup/fx/fall-smoke.js; the rejected veil
// (the slow drawn-in swirl, mockup 4) is left out. Pure: no DOM, no Foundry
// (the Worker paints it, fall-painter.js).
//
// Five beats on one body (pixel-vfx-materials materials/conversion.md):
//   1. CHARGE  his soul's green light crackles along his outline, streaks of it
//              are pulled into his core, his glowing parts flare, he shudders
//   2. FLASH   the whole silhouette white for a moment, a ring on the floor
//   3. FRONT   a ragged edge travels through the body from his core outward
//   4. SEAM    ahead of the edge his soul's light shows through; at the edge he
//              is charred black
//   5. RELEASE each charred pixel lets go AS SMOKE (puff seeds born where they
//              stood, thrown out fast and braked hard, swelling as they slow),
//              lit green from below while young; soul sparks fly up, grit falls
// Then the mass becomes the engulfing front (solid black inside, billows at its
// edge) and settles into the void. The engulf's texture is ONE frame-sized field
// in two octaves, the second rotated, so it never repeats (the user, 2026-11-11).
// The body is drawn here at effect resolution from the first frame on.
// Scrubbable: at(T) re-simulates from 0 for an earlier time.
// ============================================================================

import { Rng, mix, hex, clamp, noise2, tileNoise, TAU, WHITE } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { cloudFast as cloud } from "./smoke-cloud.js";

const SMOKE = ["#000000", "#050807", "#0c1411", "#16231d", "#22352c", "#33493d", "#4a6353"].map(hex);
const SOUL = ["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2"].map(hex);
const LIT = SMOKE.map((c, i) => mix(c, SOUL[Math.min(6, i + 1)], 0.5));
const BLACK = hex("#000000"), CHAR = [hex("#020403"), hex("#07100c"), hex("#0f1d17")];

/** The two falls' smoke beats (s from the start of the fall). */
export const FALL = Object.freeze({
  first: Object.freeze({ charge: 0.1, flash: 1.0, front: 1.07, frontEnd: 3.7, engulfFrom: 3.0, engulfTo: 7.0, settleFrom: 6.7, settleTo: 7.4 }),
  repeat: Object.freeze({ charge: 0.08, flash: 0.38, front: 0.43, frontEnd: 1.5, engulfFrom: 1.15, engulfTo: 2.9, settleFrom: 2.8, settleTo: 3.25 }),
});
export const FRONTS = Object.freeze(["core", "wounds", "crown"]);

const hash = (x, y, s) => { const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); };
const easeIO = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u));

/**
 * makeFallSmoke(W, H, { img: { width, height, data } (the sprite's RGBA), x0, y0 (effect px of the sprite's
 * top-left), k (effect px per sprite px), mirror, seed }) -> { draw(p, T, P, frontMode), drawRest(p), at, core,
 * centre, count }
 */
export function makeFallSmoke(W, H, { img, x0, y0, k, mirror = true, seed = 7 }) {
  // ---- the body, one cell per effect pixel (nearest sample of the sprite)
  const BW = Math.ceil(img.width * k), BH = Math.ceil(img.height * k), grid = new Int32Array(BW * BH).fill(-1), cells = [];
  for (let ey = 0; ey < BH; ey++) for (let ex = 0; ex < BW; ex++) {
    let sx = Math.min(img.width - 1, Math.floor((ex + 0.5) / k)); const sy = Math.min(img.height - 1, Math.floor((ey + 0.5) / k));
    if (mirror) sx = img.width - 1 - sx;
    const i = (sy * img.width + sx) * 4, a = img.data[i + 3];
    if (a < 40) continue;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    grid[ey * BW + ex] = cells.length;
    cells.push({ ex, ey, x: x0 + ex, y: y0 + ey, c: (255 << 24) | (b << 16) | (g << 8) | r, a: a / 255, glow: g > r + 25 && g > b + 5 && g > 90, edge: false, key: 0, gone: false });
  }
  const on = (ex, ey) => ex >= 0 && ey >= 0 && ex < BW && ey < BH && grid[ey * BW + ex] >= 0;
  for (const c of cells) c.edge = !on(c.ex - 1, c.ey) || !on(c.ex + 1, c.ey) || !on(c.ex, c.ey - 1) || !on(c.ex, c.ey + 1);
  const rim = [];
  for (let ey = -1; ey <= BH; ey++) for (let ex = -1; ex <= BW; ex++) if (!on(ex, ey) && (on(ex - 1, ey) || on(ex + 1, ey) || on(ex, ey - 1) || on(ex, ey + 1))) rim.push({ x: x0 + ex, y: y0 + ey, ex, ey });
  // the source: his soul glows through his ribs; its middle is the core. Wounds: the glowing patches, spread apart.
  // (a sprite with no green glow: the body's middle stands in for the core)
  const glows = cells.filter((c) => c.glow);
  const centre = cells.reduce((s, c) => ({ x: s.x + c.x / cells.length, y: s.y + c.y / cells.length }), { x: 0, y: 0 });
  const core = glows.length ? glows.reduce((s, c) => ({ x: s.x + c.x / glows.length, y: s.y + c.y / glows.length }), { x: 0, y: 0 }) : { ...centre };
  const wounds = [];
  { const R = new Rng(seed + 31); let guard = 0; while (glows.length && wounds.length < 7 && guard++ < 4000) { const c = glows[Math.floor(R.next() * glows.length)]; if (wounds.every((w) => Math.hypot(w.x - c.x, w.y - c.y) > 45)) wounds.push({ x: c.x, y: c.y }); } }
  if (!wounds.length) wounds.push({ ...core });
  let top = Infinity, bottom = -Infinity;
  for (const c of cells) { if (c.y < top) top = c.y; if (c.y > bottom) bottom = c.y; }
  if (!cells.length) { top = y0; bottom = y0; }
  const keyed = new Map();
  function keysFor(mode) {
    if (keyed.has(mode)) return keyed.get(mode);
    const raw = new Float32Array(cells.length);
    cells.forEach((c, i) => { raw[i] = mode === "crown" ? c.y - top : mode === "wounds" ? Math.min(...wounds.map((w) => Math.hypot(c.x - w.x, c.y - w.y))) : Math.hypot(c.x - core.x, c.y - core.y); });
    let mx = 0; for (const v of raw) mx = Math.max(mx, v);
    mx = mx || 1;
    const keys = new Float32Array(cells.length);
    cells.forEach((c, i) => {
      keys[i] = raw[i] / mx + 0.1 * (hash(c.ex, c.ey, 3) - 0.5) + 0.08 * noise2(c.x * 0.05, c.y * 0.05, seed + 5) - (c.edge ? 0.03 : 0) - (c.a < 0.8 ? 0.05 : 0);
    });
    keyed.set(mode, keys);
    return keys;
  }
  // each released pixel's direction: away from where the front came from
  const fromOf = (mode, c) => {
    if (mode === "crown") return { x: c.x - centre.x, y: -20 };
    if (mode === "wounds") { let best = wounds[0], bd = 1e9; for (const w of wounds) { const d = Math.hypot(c.x - w.x, c.y - w.y); if (d < bd) { bd = d; best = w; } } return { x: c.x - best.x, y: c.y - best.y }; }
    return { x: c.x - core.x, y: c.y - core.y };
  };

  // ---- the engulfing front
  const far = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - centre.x, (y - centre.y) / 0.72)));
  const RMAX = far / 0.8 / 0.93, R0 = 120, NA = 96, ANG = new Uint8Array(W * H), DIST = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - centre.x, dy = (y + 0.5 - centre.y) / 0.72, i = y * W + x;
    ANG[i] = Math.min(NA - 1, Math.floor(((Math.atan2(dy, dx) + Math.PI) / TAU) * NA)); DIST[i] = Math.hypot(dx, dy);
  }
  // the engulfed smoke's texture: ONE field the size of the frame plus its drift (a repeated tile lined up in a grid
  // was seen, the user, 2026-11-11). Two octaves of value noise, the second rotated, so neither the tiling nor the
  // noise's own square lattice shows.
  const MX = 40, MY = 100, FW = W + MX, FH = H + MY, FIELD = new Float32Array(FW * FH);
  { const ca = Math.cos(0.65), sa = Math.sin(0.65);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const rx = ca * x - sa * y, ry = sa * x + ca * y;
      FIELD[y * FW + x] = 0.5 + 0.5 * (0.7 * tileNoise(x / 32, y / 32, 0, 0, seed + 21) + 0.3 * tileNoise(rx / 14.2, ry / 14.2, 0, 0, seed + 22));
    } }
  const frontR = (T, P) => R0 + (RMAX - R0) * Math.pow(clamp((T - P.engulfFrom) / (P.engulfTo - P.engulfFrom)), 1.35);
  const wob = (an, T) => 1 + 0.13 * noise2(1.6 * Math.cos(an) + T * 0.35, 1.6 * Math.sin(an) - T * 0.2, seed + 3) + 0.05 * noise2(5 * Math.cos(an), 5 * Math.sin(an) + T, seed + 4);

  // ---- simulation
  let sim = null, simMode = null;
  const reset = (mode) => { for (const c of cells) c.gone = false; sim = { T: 0, R: new Rng(seed), puffs: [], sparks: [], grit: [], frontAcc: 0, mode }; simMode = mode; };
  const fOf = (T, P) => -0.08 + 1.18 * easeIO((T - P.front) / (P.frontEnd - P.front));

  function step(dt, P) {
    const s = sim, R = s.R, T = (s.T += dt), keys = keysFor(s.mode);
    if (T >= P.front) {
      const f = fOf(T, P);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (c.gone || keys[i] >= f) continue;
        c.gone = true;
        const dir = fromOf(s.mode, c), dl = Math.hypot(dir.x, dir.y) || 1;
        // one smoke seed per 5 x 5 cells; it starts three cells big, so the body's cover goes over into the smoke
        if (c.ex % 5 === 0 && c.ey % 5 === 0) {
          const sp = R.range(60, 170), big = R.chance(0.2);
          s.puffs.push({ x: c.x, y: c.y, vx: (dir.x / dl) * sp + R.range(-14, 14), vy: (dir.y / dl) * sp * 0.75 + R.range(-14, 8), age: 0, life: R.range(2.0, 3.2),
            r0: 3.2, r1: big ? R.range(22, 30) : R.range(14, 22), a: 1, b: R.range(0.3, 0.7), warm: c.glow ? 1 : 0.5, ph: R.range(0, 100), drag: R.range(2.0, 2.8), front: false });
        } else if (R.chance(c.glow ? 0.08 : 0.012)) {
          s.sparks.push({ x: c.x, y: c.y, vx: (dir.x / dl) * R.range(30, 90) + R.range(-10, 10), vy: (dir.y / dl) * R.range(20, 60) - R.range(20, 50), age: 0, life: R.range(0.5, 1.2) });
        } else if (c.y > bottom - 60 && R.chance(0.02)) {
          s.grit.push({ x: c.x, y: c.y, vx: R.range(-14, 14), vy: R.range(-20, 0), age: 0, life: R.range(0.6, 1.2), floor: bottom + R.range(-4, 4) });
        }
      }
    }
    // the engulfing front's billows
    const r = frontR(T, P), speed = (r - frontR(T - dt, P)) / dt;
    if (T >= P.engulfFrom && T <= P.engulfTo + 0.4) {
      s.frontAcc += (2 * Math.PI * r * 0.85) / 5 / 1.3 * dt;
      let guard = 0;
      while (s.frontAcc >= 1 && guard++ < 400) {
        s.frontAcc -= 1;
        const an = R.range(0, TAU), rr = r * wob(an, T) * R.range(0.97, 1.06);
        const x = centre.x + Math.cos(an) * rr, y = centre.y + Math.sin(an) * rr * 0.72;
        if (x < -60 || y < -60 || x > W + 60 || y > H + 60) continue;
        const sp = speed * R.range(0.95, 1.15) + R.range(2, 10), big = R.chance(0.35), r1 = big ? R.range(24, 34) : R.range(14, 22);
        s.puffs.push({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp * 0.72 - R.range(0, 8), age: 0, life: R.range(1.0, 1.6), r0: r1 * 0.55, r1, a: 1, b: R.range(0.45, 0.85), warm: 0, ph: R.range(0, 100), front: true, drag: 0.6 });
      }
    }
    for (let i = s.puffs.length - 1; i >= 0; i--) {
      const q = s.puffs[i];
      if ((q.age += dt) >= q.life) { s.puffs.splice(i, 1); continue; }
      if (T >= P.engulfFrom) { const dx = q.x - centre.x, dy = (q.y - centre.y) / 0.72; if (Math.hypot(dx, dy) < r * 0.93 * wob(Math.atan2(dy, dx), T) * 0.7 - 20) { s.puffs.splice(i, 1); continue; } }
      // thrown out, braked hard, then lifting once it has swelled (a body's smoke is warm)
      q.vx -= q.vx * q.drag * dt; q.vy -= q.vy * q.drag * dt;
      if (!q.front) q.vy -= 10 * (1 - Math.exp(-q.age / 0.9)) * dt;
      q.x += q.vx * dt; q.y += q.vy * dt;
    }
    for (const list of [s.sparks, s.grit]) for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i]; if ((q.age += dt) >= q.life) { list.splice(i, 1); continue; }
      if (list === s.grit) { q.vy += 260 * dt; q.x += q.vx * dt; q.y = Math.min(q.floor, q.y + q.vy * dt); }
      else { q.vx -= q.vx * 1.6 * dt; q.vy -= q.vy * 1.6 * dt + 30 * dt; q.x += q.vx * dt; q.y += q.vy * dt; }
    }
  }
  function at(T, P, mode) {
    if (!sim || mode !== simMode || T < sim.T - 1e-6) reset(mode);
    while (sim.T + 1 / 30 <= T + 1e-6) step(1 / 30, P);
  }

  // ---- drawing
  function drawBody(p, T, P, mode) {
    const keys = keysFor(mode), fr = Math.floor((T ?? 0) * 30);
    const charge = T == null || T < P.charge ? 0 : clamp((T - P.charge) / (P.flash - P.charge));
    const white = T != null && (T < 0.07 || (T >= P.flash && T < P.front));
    const f = T != null && T >= P.front ? fOf(T, P) : -1;
    // the shudder: grows through the charge, one or two pixels, stops at the flash
    const sh = T != null && T < P.flash ? Math.round((0.6 + 2.2 * charge) * (fr % 2 ? 1 : -1) * (T < 0.5 ? Math.max(charge, 1 - T / 0.5) : 1)) : 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.gone) continue;
      let col = c.c;
      if (white) col = c.edge ? SOUL[6] : WHITE;
      else if (f > -1) {
        const d = keys[i] - f;
        // right at the edge he is charred black, live green sparks in the char; ahead of it a white-mint hot line,
        // then his soul's green shining through, then a faint green cast
        if (d < 0.03) col = hash(c.ex, c.ey, fr) < 0.06 ? SOUL[5] : CHAR[d < 0.015 ? 0 : 1];
        else if (d < 0.055) col = hash(c.ex, c.ey, fr + 7) < 0.4 ? WHITE : SOUL[7];
        else if (d < 0.09) col = hash(c.ex, c.ey, fr + 3) < 0.5 ? SOUL[6] : SOUL[5];
        else if (d < 0.17) col = mix(c.c, c.glow ? SOUL[6] : SOUL[3], c.glow ? 0.6 : 0.35);
        else if (d < 0.3) col = c.glow ? mix(c.c, SOUL[6], 0.35) : mix(c.c, SOUL[2], 0.12);
        if (d >= 0.03 && d < 0.09) p.add(c.x, c.y, SOUL[5], 0.35);
      } else if (charge > 0) {
        // the charge: his glowing parts flare toward white-mint, the rest takes a green cast
        col = c.glow ? mix(c.c, charge > 0.75 && hash(c.ex, c.ey, fr) < 0.3 ? WHITE : SOUL[7], 0.25 + 0.65 * charge) : mix(c.c, SOUL[3], 0.18 * charge);
        if (c.glow && charge > 0.3) p.add(c.x, c.y, SOUL[5], 0.25 * charge);
      }
      p.put(c.x + sh, c.y, col, c.a >= 0.95 ? 1 : c.a);
    }
    // the charge, outside the body: the outline crackles, streaks of light are pulled into the core
    if (charge > 0 && T < P.flash) {
      const pr = 0.1 + 0.6 * charge * charge;
      for (const rc of rim) { const h = hash(rc.ex * 61 + rc.ey, fr, 7); if (h < pr) p.put(rc.x + sh, rc.y, charge > 0.7 && hash(rc.ex, rc.ey, fr) < 0.5 ? WHITE : h < pr * 0.4 ? SOUL[7] : SOUL[5], 1); }
      const R = new Rng(seed + fr), n = Math.floor(3 + 10 * charge);
      for (let s = 0; s < n; s++) {
        const an = R.range(0, TAU), D = R.range(60, 190) * (1 - ((fr % 6) / 6) * 0.5), len = R.range(10, 26);
        for (let j = 0; j < len; j++) { const dd = D - j; p.put(Math.floor(core.x + Math.cos(an) * dd), Math.floor(core.y + Math.sin(an) * dd * 0.8), j < 3 ? WHITE : SOUL[j < 10 ? 6 : 5], 1 - j / len); }
      }
      p.glow(core.x, core.y, 50 + 70 * charge, SOUL[4], 0.5 * charge);
      p.glow(core.x, core.y, 20 + 20 * charge, SOUL[6], 0.4 * charge * charge);
    }
  }

  function draw(p, T, P, mode = "core") {
    at(T, P, mode);
    const settle = clamp((T - P.settleFrom) / (P.settleTo - P.settleFrom));
    // the engulfed area
    if (T >= P.engulfFrom) {
      const r = frontR(T, P) * 0.93, C = p.C, WB = new Float32Array(NA + 1);
      for (let j = 0; j <= NA; j++) WB[j] = r * wob((j / NA) * TAU - Math.PI, T);
      const tex = 1 - settle, ox = Math.floor(T * 3), oy = Math.floor(T * 9), T1 = SMOKE[1] | 0xff000000, T2 = SMOKE[2] | 0xff000000, T3 = SMOKE[3] | 0xff000000;
      for (let y = 0; y < H; y++) {
        const row = Math.min(FH - 1, y + oy) * FW + MX;
        for (let x = 0; x < W; x++) {
          const i = y * W + x, e = WB[ANG[i]];
          if (DIST[i] >= e) continue;
          let c = 0xff000000;
          if (tex > 0) { const n = FIELD[row + Math.max(-MX, x - ox)] * tex * (0.55 + 0.45 * DIST[i] / e); c = n > 0.62 ? T3 : n > 0.5 ? T2 : n > 0.4 ? T1 : c; }
          C[i] = c;
        }
      }
    }
    // the body still standing (behind its own smoke: the smoke comes off it toward us)
    if (T < P.frontEnd + 0.2) drawBody(p, T, P, mode);
    // the flash's ring on the floor and its light
    const fk = (T - P.flash) / 0.5;
    if (fk > 0 && fk < 1) {
      const rx = 30 + 260 * (1 - Math.pow(1 - fk, 3)), ry = rx * 0.22, n = Math.ceil(TAU * rx);
      for (let i = 0; i < n; i++) { const an = (i / n) * TAU; p.put(Math.floor(core.x + Math.cos(an) * rx), Math.floor(bottom - 4 + Math.sin(an) * ry), fk < 0.2 ? WHITE : SOUL[6], 1 - fk); }
      p.glow(core.x, core.y, 160, SOUL[5], 0.6 * (1 - fk));
      p.glow(core.x, core.y, 70, WHITE, 0.5 * Math.max(0, 1 - fk * 3));
    }
    // the smoke
    const k = 1 - settle;
    if (k > 0.001) {
      const RS = settle ? SMOKE.map((c) => mix(BLACK, c, k)) : SMOKE, RL = settle ? LIT.map((c) => mix(BLACK, c, k)) : LIT;
      const rf = T >= P.engulfFrom ? frontR(T, P) * 0.93 : 0, list = [];
      for (const q of sim.puffs) {
        const kk = q.age / q.life, grow = 1 - Math.exp(-2.2 * q.age), r = q.r0 + (q.r1 - q.r0) * grow;
        const a = q.a * (kk < 0.6 ? 1 : 1 - (kk - 0.6) / 0.4);
        if (a < 0.02 || q.x + r < 0 || q.y + r < 0 || q.x - r > W || q.y - r > H) continue;
        let deep = 1;
        if (rf) { const dx = q.x - centre.x, dy = (q.y - centre.y) / 0.72, d = Math.hypot(dx, dy) / (rf * wob(Math.atan2(dy, dx), T)); deep = 0.35 + 0.65 * clamp((d - 0.72) / 0.28); }
        // born black like the char it came from, brightening to its own tone as it swells
        const born = clamp(q.age / 0.35);
        list.push({ x: q.x, y: q.y, r, a, b: q.b * (0.25 + 0.75 * born) * (1 - 0.5 * kk) * deep, k: kk, ph: q.ph, age: q.age, w: q.warm * Math.exp(-q.age * 2.2) });
      }
      cloud(p, list, RS, RL, { dens: 4, max: 1, lit: 1.4, steps: true });
    }
    // soul sparks and grit, over the smoke
    for (const q of sim.sparks) { const a = 1 - q.age / q.life, c = q.age < 0.05 ? WHITE : q.age < 0.2 ? SOUL[7] : SOUL[a > 0.5 ? 6 : 5]; p.put(Math.floor(q.x), Math.floor(q.y), c, a); p.add(Math.floor(q.x), Math.floor(q.y), SOUL[5], 0.5 * a); }
    for (const q of sim.grit) p.put(Math.floor(q.x), Math.floor(q.y), CHAR[2], 1 - q.age / q.life);
  }
  return { draw, drawRest: (p) => drawBody(p, null, FALL.first, "core"), at, core, centre, top, bottom, get count() { return sim ? sim.puffs.length : 0; } };
}
