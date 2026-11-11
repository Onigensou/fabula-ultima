// Nidhogg's soul: a burning orb, its fire MERGED into one body (the user, 2026-11-10: "merge type").
//
// Ported from the approved fire-on-a-ball recipe, pixel-vfx-materials lab/wellspring-aura.js `ballFireAura`
// (fire.md short version 4 + 8, §5a, §5b):
//   - real tongues in a pyramid on the orb's upper arc, each rasterised into ONE shared heat field (overlaps combine
//     as 1 - Π(1 - h)), cut into tone bands: one silhouette, one outline round the whole shape, no seams;
//   - a cooler, taller back row drawn first and overlapped by the front row (depth: merge within a row, overlap
//     between rows);
//   - the upward read from the FLOW: flame puffs off the tips and off the burning shell, drawn inward into one
//     column, licks torn off the tips, embers; ~40 % of the particles behind the body;
//   - one shared breath for height and light, one shared lean.
// Changed for this fire:
//   - the ball is the SOURCE and is drawn: its inside is the hottest part of the field, so the orb is the white-mint
//     core low in the middle of the fire (the button in the original stayed clear);
//   - more AGGRESSIVE (the user, 2026-11-10): taller crown, faster noise, leaps more often and higher, a denser puff
//     stream, more licks and embers. Calm and violent are the same recipe at different rates (fire.md §6);
//   - sealed in a crystal: no smoke plume, and only a few puffs cool into a dark teal smoke before they vanish.
import { fit, mix, hex, WHITE } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { noiseFor, looped, drift, firePuff, lick, smokePuff, ember } from "../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";

const SOUL_FIRE = ["#0c2c28", "#11524a", "#178066", "#22a86c", "#3cd66c", "#5dff6e", "#a6ff9c", "#dcffd2", "#ffffff"];
export const FH = [...fit(SOUL_FIRE.map(hex), 9)].reverse(); // hot-first
const HB = [...FH.slice(1), FH[8]];
// flame puffs keep to the bright half of the ramp, so their rims never turn into dark teal bubbles over the body
const PH = [FH[0], FH[1], FH[2], FH[3], FH[4], FH[5], FH[5], FH[6], FH[6]], PHB = [FH[1], FH[2], FH[3], FH[4], FH[5], FH[5], FH[6], FH[6], FH[7]];

/** o: { r (orb radius), seed, rage (1 = this mockup's default aggression; 0.6 calmer, 1.4 wilder) } */
export function makeSoulBallFire(o = {}) {
  const D = 2, NL = noiseFor(D), S = o.seed ?? 4, R = o.r ?? 9, KS = R / 13;
  const rage = () => o.rage ?? 1;
  const LIFT = R * 2.3, SH_TOP = 4.2 * KS, SH_LOW = 1.6 * KS;
  const GX0 = -R - 16, GX1 = R + 16, GY0 = Math.floor(-R - LIFT * 2.8), GY1 = R + 5, GW = GX1 - GX0, GH = GY1 - GY0;
  const heat = new Float32Array(GW * GH);
  const add = (x, y, v) => {
    const i = x - GX0, j = y - GY0;
    if (i < 0 || j < 0 || i >= GW || j >= GH || v <= 0) return;
    const k = j * GW + i;
    heat[k] = 1 - (1 - heat[k]) * (1 - Math.min(1, v));
  };
  const ARC = (degs, hMul, wMul) => degs.map((d, i) => {
    const a = (d * Math.PI) / 180, up = -Math.sin(a);
    return { bx: R * Math.cos(a), by: R * Math.sin(a) + 1.5, env: 0.22 + 0.78 * up ** 1.6, w: (1.9 + 2.6 * up) * wMul * KS, hMul, n: i * 13 + 5 };
  });
  const FRONT_T = ARC([-172, -152, -132, -113, -97, -83, -67, -48, -28, -8], 1, 1);
  const BACK_T = ARC([-140, -112, -90, -68, -40], 1.3, 1.1);
  const fla = (tt, s) => 0.74 + 0.16 * NL(tt, 7.3, s + 1) + 0.1 * NL(tt, 19, s + 2);
  const lean = (tt, s) => NL(tt, 0.67, s + 90) * 0.14;
  const height = (q, tt, s) => {
    const g = rage(), n = q.n + s;
    const leap = Math.max(0, NL(tt, 2.6, n + 70) - (0.55 - 0.12 * g)) * (1.4 + 0.5 * g), h = 2 + LIFT * q.env * q.hMul * (0.75 + 0.25 * g);
    return (h + (0.25 + 0.08 * g) * h * NL(tt, 3.3, n) + h * leap) * (0.9 + 0.1 * fla(tt, s));
  };
  const sweep = (q, tt, h, s) => NL(tt, 2.2, q.n + s + 40) * (1 + h * 0.08) + lean(tt, s) * h * 0.9 - Math.max(-2.5, Math.min(2.5, q.bx * 0.3));
  const tip = (q, tt, s) => { const h = height(q, tt, s); return [q.bx + sweep(q, tt, h, s) * 0.85, q.by - h * 0.88 + 3, h]; };
  const centreW = (x) => 1 - 0.4 * Math.pow(Math.min(1, Math.abs(x) / (R + 4)), 1.5);
  function tongues(list, tt, s) {
    for (const q of list) {
      const h = height(q, tt, s), sx = sweep(q, tt, h, s), n = q.n + s;
      for (let r = -2; r <= h; r++) {
        const u = Math.max(0, r) / Math.max(1, h);
        const half = q.w * Math.pow(1 - u, 0.85) * Math.min(1, (r + 3.5) / 3.5) + NL(tt, 9, n, r * 0.45) * 0.6;
        if (half < 0.3) continue;
        const cx = q.bx + sx * u * u + NL(tt, 4, n + 7, r * 0.2) * u * (1.2 + h * 0.05), y = Math.round(q.by - r);
        for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
          const across = 1 - Math.abs(x + 0.5 - cx) / half;
          if (across > 0) add(x, y, Math.pow(across, 0.7) * (0.25 + 0.75 * Math.pow(1 - u, 1.2)) * centreW(x));
        }
      }
    }
  }
  // the burning orb: hottest in the middle (the core), a burning skin round it, thicker on top
  function shell(tt, s, core) {
    for (let y = Math.floor(-R - SH_TOP - 1); y <= Math.ceil(R + SH_LOW + 1); y++)
      for (let x = Math.floor(-R - SH_TOP - 1); x <= Math.ceil(R + SH_TOP + 1); x++) {
        const r = Math.hypot(x + 0.5, y + 0.5), d = r - R, up = -(y + 0.5) / (r || 1);
        if (d < 0) {
          if (!core) continue;
          const c = 1 - r / R, churn = 0.08 * NL(tt, 6, s + 9, x * 0.6 - y * 0.8);
          add(x, y, 0.26 + 0.5 * Math.pow(c, 1.6) + churn);
          continue;
        }
        const sh = SH_LOW + (SH_TOP - SH_LOW) * Math.max(0, up) + 0.5 * NL(tt, 9, s + 5, x * 0.7 + y * 1.3);
        if (d > sh) continue;
        add(x, y, (0.3 + 0.45 * Math.max(0, up)) * (1 - d / (sh + 0.5)) * centreW(x));
      }
  }
  function body(p, tt, list, s, ramp, core) {
    heat.fill(0);
    shell(tt, s, core);
    tongues(list, tt, s);
    const at = (i, j) => (i < 0 || j < 0 || i >= GW || j >= GH ? 0 : heat[j * GW + i]);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const v = heat[j * GW + i];
        if (v < 0.06) continue;
        const x = i + GX0, y = j + GY0;
        if (v < 0.2 && y < -R - 6 && NL(tt, 8, s + 61, x * 0.9 + y * 0.7) > 0.3) continue;
        const edge = at(i, j - 1) < 0.06 || at(i - 1, j) < 0.06 || at(i + 1, j) < 0.06 || at(i, j + 1) < 0.06;
        p.px(x, y, edge ? ramp[6] : v > 0.7 ? ramp[0] : v > 0.52 ? ramp[1] : v > 0.38 ? ramp[2] : v > 0.24 ? ramp[3] : v > 0.13 ? ramp[4] : ramp[5]);
      }
  }
  const SMOKE = mix(hex("#1d2b2a"), FH[6], 0.3);
  function flow(p, tt, back) {
    const g = rage(), list = back ? BACK_T : FRONT_T, s = back ? S + 50 : S, HH = back ? HB : FH, EMB = [HH[1], HH[2], HH[4], HH[6]];
    const DRAW_IN = 1.2, PUFF_K = 1.25;
    const puff = (z, age, x0, y0) => {
      const [x, y, vx, vy] = drift(x0 + z.ox, y0 + z.oy, z.vx - x0 * DRAW_IN, z.vy, Math.min(age, z.fire), 0, -110 * g * KS, 5, 3.2);
      if (age < z.fire) return firePuff(p, x, y, 1 - age / z.fire, z.sz, z.f, back ? PHB : PH);
      if (age - z.fire > z.sl) return;
      const [sx, sy] = drift(x, y, vx * 0.6, vy * 0.6 - 6, age - z.fire, 3, -16, 1.6, 1.2);
      smokePuff(p, sx, sy, 1 - (age - z.fire) / z.sl, z.sz * 0.6, SMOKE, false, 0.6);
    };
    const mk = (r, env) => {
      const fire = r.range(0.18, 0.4), smokes = r.chance(0.15);
      return { back: r.chance(0.6), fire, smokes, sl: r.range(0.4, 0.7), ox: r.range(-1, 1), oy: r.range(0, 3), vx: r.range(-5, 5) * KS, vy: -r.range(18, 36) * g * KS, sz: r.range(0.8, 1.7) * (0.8 + 0.6 * env) * PUFF_K * KS, f: r.next(), life: fire + (smokes ? 0.7 : 0) };
    };
    looped(tt, D, Math.round(list.length * 9 * g * D), s + 200, (r, j) => ({ ...mk(r, list[j % list.length].env), q: list[j % list.length] }), (z, age) => {
      if (z.back !== back) return;
      const [tx, ty] = tip(z.q, tt - age, s);
      puff(z, age, tx, ty);
    });
    looped(tt, D, Math.round(35 * g * D), s + 240, (r) => {
      const a = -Math.PI / 2 + (r.next() + r.next() - 1) * 1.3, up = -Math.sin(a);
      return { ...mk(r, up), x0: (R + 1) * Math.cos(a), y0: (R + 1) * Math.sin(a) - 1 };
    }, (z, age) => {
      if (z.back !== back) return;
      puff(z, age, z.x0, z.y0);
    });
    looped(tt, D, Math.round(list.length * 11 * g), s + 220, (r, j) => ({ q: list[j % list.length], back: r.chance(0.4), vx: r.range(-4, 4) * KS, vy: -r.range(14, 26) * g * KS, sz: r.range(0.9, 1.6) * (0.7 + 0.5 * list[j % list.length].env) * KS, life: 0.24 }), (z, age) => {
      if (z.back !== back) return;
      const [tx, ty] = tip(z.q, tt - age, s);
      lick(p, tx + z.vx * age, ty - 2 + z.vy * age, 1 - age / z.life, z.sz, HH);
    });
    looped(tt, D, Math.round(22 * g * D), s + 500, (r) => ({ x: r.range(-R * 0.5, R * 0.5), back: r.chance(0.4), y: -R - r.range(4, 14), vx: r.range(-18, 18) * KS, vy: -r.range(30, 65) * g * KS, life: r.range(0.8, 1.6), sz: r.chance(0.18) ? 2 : r.range(1, 1.6), a: r.range(0, 6.3), b: r.range(0, 6.3) }), (z, age) => {
      if (z.back !== back) return;
      const [x, y] = drift(z.x, z.y, z.vx, z.vy, age, 0, -30, 1.6, 1.6);
      ember(p, x + 7 * (Math.sin(age * 2.3 + z.a) - Math.sin(z.a)), y + 2 * (Math.sin(age * 3 + z.b) - Math.sin(z.b)), 1 - age / z.life, z.sz, EMB, age * 40 + z.a);
    });
  }
  const GLOW = mix(mix(FH[3], FH[4], 0.5), WHITE, 0.25);
  return {
    /** Draw it all, origin = the orb's centre (p.place it there first). speed scales time (a flare runs it faster). */
    draw(p, t, glowK = 1) {
      const tt = ((t * (1 + 0.3 * (rage() - 1))) % D + D) % D, fl = fla(tt, S), lx = lean(tt, S) * 12;
      p.glow(lx, -R * 0.6, R * 2.6, GLOW, 0.2 * fl * glowK);
      flow(p, tt, true);
      body(p, tt, BACK_T, S + 50, HB, false);
      body(p, tt, FRONT_T, S, FH, true);
      flow(p, tt, false);
      const top = -R - LIFT * 0.5;
      for (const [x, k] of [[-6, 0.85], [0, 1], [6, 0.85]]) p.glow((x + lx) * KS, top - 4, 40 * KS, GLOW, 0.18 * k * fl * glowK);
      p.glow(lx, top + 4, 15 * KS, FH[2], 0.14 * fl * glowK);
    },
  };
}
