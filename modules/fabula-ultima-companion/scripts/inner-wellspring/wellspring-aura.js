// scripts/inner-wellspring/wellspring-aura.js
//
// Ported AS IS from the approved lab module (~/.claude/skills/pixel-vfx-materials/lab/wellspring-aura.js,
// approved by the user 2026-11-01). Only the import paths changed: they point at the module's vendored
// pixelfx (scripts/battle-director/pixel-entrance/pixelfx/, MIT, see its LICENSE.txt / NOTICE.txt).
// Edit the lab copy first and re-port; do not tune the effects here.
//
// Lab: the Inner Wellspring picker's element auras — one effect round a round UI button (radius o.r), the button
// itself being the SOURCE (fire.md §1, shared rule 6). Origin = the button's centre. drawBack goes behind the button,
// draw in front of it, so the button really sits inside its effect (depth, fire.md §5b).
//   fire      ballFireAura: the button as a ball the fire ENGULFS — real tongues merged in one heat field (see its comment).
//   fire-rim  (first try) burn() (the campfire recipe, fire/_lib) with its tongues standing on the button's upper rim and rising
//             straight up in world space (forms rule 8); a cooler, taller back row behind the button; puffs, licks,
//             embers, a thin plume, light.
//   lightning the electrified recipe (lightning/_lib zigzag + crackle + flight/spark) on the button's rim instead of
//             a silhouette: arcs hop along the rim or reach out from it, re-struck every other frame; three jolts
//             a loop flare the rim and spray sparks. Yellow volt ramp.
//   water     water-orb's current (streaks on tilted planes, bright in front, dim behind) wrapped round the
//             button, beads flung off it under gravity (water/_lib bead), glints in front.
//   earth     faceted stones (nature/_lib stoneShape + drawRock, one light from the top left) orbiting on a
//             tilted ring, one ramp step darker behind, shedding grit that falls.
//   air       wind ribbons on tilted orbits (bright head, tapering dithered tail), two leaves riding them
//             (nature/_lib drawLeaf), wisps spiralling off.
// Every orbit turns a whole number of times per loop and every loop length divides 6 s, so it never seams.
// option button: true draws a stand-in button (lab only; the picker's real button is DOM). lift: px the button
// centre sits above the frame origin (the lab grid puts the origin on its floor line).
import { fit, mix, hex, rng, Rng, cycle, TAU, WHITE } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { noiseFor, hotFirst, burn, looped, drift, firePuff, lick, smokePuff, ember } from "../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";
import { zigzag, bowed, crackle, flight, spark } from "../battle-director/pixel-entrance/pixelfx/fx/lightning/_lib.js";
import { WATER, bead } from "../battle-director/pixel-entrance/pixelfx/fx/water/_lib.js";
import { stoneShape, drawRock, drawLeaf } from "../battle-director/pixel-entrance/pixelfx/fx/nature/_lib.js";

export const meta = {
  name: "Wellspring aura (lab)",
  desc: "An element's effect round a round button: fire on its rim, lightning crawling it, water circling it, stones orbiting it, wind wrapping it.",
  size: [140, 150], origin: [70, 146], duration: 6, loop: true, fps: 30,
  options: { el: "fire", r: 21, seed: 4, button: true, lift: 50 },
};

const FIRE = ["#4a1712", "#8a1f17", "#c9281f", "#f2561d", "#ff8a2a", "#ffc23d", "#ffe26b", "#fff3a6", "#ffffff"];
const VOLT_Y = ["#1a1206", "#3d2a08", "#6e4c0a", "#a8780e", "#e8c93c", "#ffe680", "#fff6c8", "#ffffff"];
const SPARK_Y = ["#ffffff", "#fff6c8", "#ffe680", "#e8c93c"];
const STONE = ["#120c08", "#24180f", "#3a2717", "#56391f", "#77512b", "#9c6e3c", "#c49560", "#e8c48e"];
const AIR = ["#0c2422", "#123f3b", "#1c6a62", "#2f9a8e", "#5fd3c6", "#a8efe4", "#e2fff9", "#ffffff"];
const LEAF = ["#0f2418", "#2d6436", "#4c9447", "#8ccf66"];
const DEG = Math.PI / 180;

// a point on a ring of radius rr seen tilted: z = sin(a) (+ near, - far), squashed by sq, the ring turned by tilt
function onRing(a, rr, sq, tilt) {
  const x = Math.cos(a) * rr, z = Math.sin(a), y = z * rr * sq;
  return [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt), z];
}

function fireAura(o) {
  const H = hotFirst(fit(FIRE, 9)), D = 3, NL = noiseFor(D), R = o.r, Y0 = -R * 0.55;
  // [x, base (from Y0), height share, half-width, back row?]: the hottest, tallest tongues on top of the rim,
  // shorter down the sides; their bases sit 2-3 px inside the rim so no seam shows between button and flame
  const front = [-170, -150, -130, -110, -90, -70, -50, -30, -10].map((d) => {
    const a = d * DEG, up = -Math.sin(a);
    return [R * Math.cos(a) * 0.96, R * Math.sin(a) + 2.5 - Y0, 0.22 + 0.62 * up ** 1.6, 1.3 + 1.3 * up, 0];
  });
  const back = [-145, -118, -90, -62, -35].map((d) => {
    const a = d * DEG, up = -Math.sin(a);
    return [R * Math.cos(a) * 0.86, R * Math.sin(a) * 0.9 + 1 - Y0, 0.5 + 0.55 * up, 1.6 + up, 1];
  });
  const base = { H, D, NL, S: o.seed, height: R * 0.85, x: 0, y: Y0, spread: R * 0.75, lean: 0.12, wind: 3 };
  return {
    drawBack(p, t) { burn(p, t % D, back, { ...base, S: o.seed + 11, smoke: 0, puffs: 3, licks: 2, embers: 0, glow: 0.75, glowR: R * 1.6 }); },
    draw(p, t) { burn(p, t % D, front, { ...base, smoke: 5, smokeSize: 2.4, puffs: 6, licks: 4, embers: 10, glow: 0.3, glowR: R * 1.2 }); },
  };
}

// The button as a ball the fire ENGULFS (user, 2026-11-01: "the flame connect, or consider the button as a ball that
// fire engulf"). Built as fire.md §5a's merged body: real tongues, each the stock tongue's shape (tapered
// (1-u)^0.85, rounded foot, crackling edge), its own sway growing with height (u^2: the base holds, the tip swings
// and curls), the stock height jitter and leaps, the shared breath and the shared lean, an inward lean toward the
// top, all standing on the ball's upper arc and rising straight up (fire rises). Every tongue ADDS heat to one
// field (per-tongue heat across^0.7 * (0.25 + 0.75(1-u)^1.2), combined 1 - prod(1 - h)), joined by a shell of
// heat hugging the ball (thin underneath, thicker on top) so it wraps the whole ball. Cut into bands: one body,
// one hot core on top of the ball, an outer-only dark rim (no seam against the ball), and the rim breaking up near
// the tips. Licks and flame puffs leave from each tongue's ACTUAL tip at their birth (wind included), so blobs
// tear off and climb. A cooler, taller back body sits behind the ball; ~40% of the flow passes behind.
// REJECTED first try (user: "doesn't look that organic"): per-column heights over the shell. A breathing bar
// chart: nothing travelled up, no tongue shapes, colour stacked in stripes.
function ballFireAura(o) {
  const H = hotFirst(fit(FIRE, 9)), HB = [...H.slice(1), H[8]], D = 2, NL = noiseFor(D), S = o.seed;
  // the fire hugs the OUTSIDE of the button (its border and dark ring end ~2 px past o.r) and never draws inside it,
  // so the chosen button keeps the same face and edge as the others (user, 2026-11-01: "not eat into the button")
  const R = o.r + 2;
  // Balance (lab, 2026-11-01, from a frame strip against the stock campfire): the campfire's tongues are a short
  // crown about half the visible height; the upper half is its puff stream rising. A tall tongue body reads as a
  // shape swaying; the upward flow has to come from particles. So: short tongues, campfire-rate puffs off the tips
  // AND the fuel (options tongue / puffsTip / puffsFuel / puffK, to compare).
  const LIFT = R * (o.tongue ?? 0.55), SH_TOP = 3.2, SH_LOW = 1.3;
  // The campfire's flow comes off a ~20 px footprint into ONE column, plus a 16/s smoke plume, 12/s embers and light
  // over the whole column. This fire is ~2x as wide, so: more puffs, and an updraft drawing them in toward the axis
  // (inward velocity ∝ -x) so the sides feed one plume over the top instead of a wide sparse spray.
  const PUFFS_TIP = o.puffsTip ?? 10, PUFFS_FUEL = o.puffsFuel ?? 45, PUFF_K = o.puffK ?? 1.5, DRAW_IN = o.drawIn ?? 1.1;
  const SMOKE_RATE = o.smoke ?? 12, EMBER_RATE = o.embers ?? 12, LIGHT = o.glowK ?? 1;
  const GX0 = -R - 12, GX1 = R + 12, GY0 = Math.floor(-R - LIFT * 2.1), GY1 = R + 5, GW = GX1 - GX0, GH = GY1 - GY0;
  const heat = new Float32Array(GW * GH);
  const add = (x, y, v) => {
    const i = x - GX0, j = y - GY0;
    if (i < 0 || j < 0 || i >= GW || j >= GH || v <= 0) return;
    const k = j * GW + i;
    heat[k] = 1 - (1 - heat[k]) * (1 - Math.min(1, v));
  };
  // tongues on the upper arc, a pyramid: tallest over the top, short ones down the sides
  const ARC = (degs, hMul, wMul) => degs.map((d, i) => {
    const a = (d * Math.PI) / 180, up = -Math.sin(a);
    return { bx: R * Math.cos(a), by: R * Math.sin(a) + 1.5, env: 0.22 + 0.78 * up ** 1.6, w: (1.8 + 2.4 * up) * wMul, hMul, n: i * 13 + 5 };
  });
  const FRONT_T = ARC([-172, -152, -132, -113, -97, -83, -67, -48, -28, -8], 1, 1);
  const BACK_T = ARC([-140, -112, -90, -68, -40], 1.25, 1.1);
  const fla = (tt, s) => 0.74 + 0.16 * NL(tt, 7.3, s + 1) + 0.1 * NL(tt, 19, s + 2);
  const lean = (tt, s) => NL(tt, 0.67, s + 90) * 0.12;
  const height = (q, tt, s) => {
    const n = q.n + s, leap = Math.max(0, NL(tt, 2.6, n + 70) - 0.55) * 1.4, h = 2 + LIFT * q.env * q.hMul;
    return (h + 0.25 * h * NL(tt, 3.3, n) + h * leap) * (0.9 + 0.1 * fla(tt, s));
  };
  // the stock sweep: own sway growing with height + the shared lean + an inward lean toward the top
  const sweep = (q, tt, h, s) => NL(tt, 2.2, q.n + s + 40) * (1 + h * 0.08) + lean(tt, s) * h * 0.9 - Math.max(-2.5, Math.min(2.5, q.bx * 0.3));
  const tip = (q, tt, s) => { const h = height(q, tt, s); return [q.bx + sweep(q, tt, h, s) * 0.85, q.by - h * 0.88 + 3, h]; };
  const centreW = (x) => 1 - 0.4 * Math.pow(Math.min(1, Math.abs(x) / (R + 4)), 1.5);
  function tongues(list, tt, s) {
    for (const q of list) {
      const h = height(q, tt, s), sx = sweep(q, tt, h, s), n = q.n + s;
      for (let r = -2; r <= h; r++) {
        const u = Math.max(0, r) / Math.max(1, h);
        const half = q.w * Math.pow(1 - u, 0.85) * Math.min(1, (r + 3.5) / 3.5) + NL(tt, 9, n, r * 0.45) * 0.55;
        if (half < 0.3) continue;
        const cx = q.bx + sx * u * u + NL(tt, 4, n + 7, r * 0.2) * u * (1.1 + h * 0.04), y = Math.round(q.by - r);
        for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
          const across = 1 - Math.abs(x + 0.5 - cx) / half;
          if (across > 0) add(x, y, Math.pow(across, 0.7) * (0.25 + 0.75 * Math.pow(1 - u, 1.2)) * centreW(x));
        }
      }
    }
  }
  // the shell: heat hugging the ball, so the fire wraps it (the skin laps onto the face; none for the back body)
  function shell(tt, s, skin) {
    // whole pixels: the heat grid is indexed by integer x, y
    for (let y = Math.floor(-R - SH_TOP - 1); y <= Math.ceil(R + SH_LOW + 1); y++)
      for (let x = Math.floor(-R - SH_TOP - 1); x <= Math.ceil(R + SH_TOP + 1); x++) {
        const r = Math.hypot(x + 0.5, y + 0.5), d = r - R, up = -(y + 0.5) / (r || 1);
        const sh = SH_LOW + (SH_TOP - SH_LOW) * Math.max(0, up) + 0.5 * NL(tt, 9, s + 5, x * 0.7 + y * 1.3);
        if (d > sh || d < (skin ? -(1 + 2 * Math.max(0, up)) : 0)) continue;
        add(x, y, (0.3 + 0.45 * Math.max(0, up)) * (1 - Math.max(0, d) / (sh + 0.5)) * centreW(x));
      }
  }
  function body(p, t, list, s, ramp, skin) {
    const tt = t % D;
    heat.fill(0);
    shell(tt, s, skin);
    tongues(list, tt, s);
    const at = (i, j) => (i < 0 || j < 0 || i >= GW || j >= GH ? 0 : heat[j * GW + i]);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const v = heat[j * GW + i];
        if (v < 0.06) continue;
        const x = i + GX0, y = j + GY0;
        if (Math.hypot(x + 0.5, y + 0.5) < R) continue;   // nothing on or inside the button
        // the rim breaks up toward the tips, as the stock skin does
        if (v < 0.2 && y < -R - 6 && NL(tt, 8, s + 61, x * 0.9 + y * 0.7) > 0.3) continue;
        const r = Math.hypot(x + 0.5, y + 0.5);
        const edge = r > R - 0.5 && (at(i, j - 1) < 0.06 || at(i - 1, j) < 0.06 || at(i + 1, j) < 0.06 || at(i, j + 1) < 0.06);
        p.px(x, y, edge ? ramp[6] : v > 0.68 ? ramp[0] : v > 0.5 ? ramp[2] : v > 0.33 ? ramp[3] : v > 0.18 ? ramp[4] : ramp[5]);
      }
  }
  // the flow, from the real tips: flame puffs cooling into smoke, licks tearing off, embers; ~40% behind
  function flow(p, t, back) {
    const tt = t % D, list = back ? BACK_T : FRONT_T, s = back ? S + 50 : S, HH = back ? HB : H, EMB = [HH[1], HH[2], HH[4], HH[6]];
    // a flame puff from (x0, y0): hot, buoyant (the campfire's FIRE drift), cooling down the ramp, ~45% into smoke
    const puff = (z, age, x0, y0) => {
      const [x, y, vx, vy] = drift(x0 + z.ox, y0 + z.oy, z.vx - x0 * DRAW_IN, z.vy, Math.min(age, z.fire), 0, -95, 5, 3.2);
      if (age < z.fire) return firePuff(p, x, y, 1 - age / z.fire, z.sz, z.f, HH);
      if (age - z.fire > z.sl) return;
      const [sx, sy] = drift(x, y, vx * 0.6, vy * 0.6 - 6, age - z.fire, 3, -16, 1.6, 1.2);
      smokePuff(p, sx, sy, 1 - (age - z.fire) / z.sl, z.sz * 0.7, 0);
    };
    const mk = (r, env) => {
      const fire = r.range(0.14, 0.3), smokes = r.chance(0.45);
      return { back: r.chance(0.4), fire, smokes, sl: r.range(0.8, 1.3), ox: r.range(-1, 1), oy: r.range(0, 3), vx: r.range(-4, 4), vy: -r.range(15, 30), sz: r.range(0.8, 1.6) * (0.8 + 0.6 * env) * PUFF_K, f: r.next(), life: fire + (smokes ? 1.3 : 0) };
    };
    // tip puffs: the campfire's 8 per tongue per second, born at each tongue's tip as it was at their birth
    looped(tt, D, Math.round(list.length * PUFFS_TIP * D), s + 200, (r, j) => ({ ...mk(r, list[j % list.length].env), q: list[j % list.length] }), (z, age) => {
      if (z.back !== back) return;
      const [tx, ty] = tip(z.q, tt - age, s);
      puff(z, age, tx, ty);
    });
    // fuel puffs: the campfire's ~30 per second licking up off the fuel, here the burning shell over the ball's
    // upper arc (denser over the top), so the stream rises from the source itself
    looped(tt, D, Math.round(PUFFS_FUEL * D), s + 240, (r) => {
      const a = -Math.PI / 2 + (r.next() + r.next() - 1) * 1.25, up = -Math.sin(a);
      return { ...mk(r, up), x0: (R + 1) * Math.cos(a), y0: (R + 1) * Math.sin(a) - 1 };
    }, (z, age) => {
      if (z.back !== back) return;
      puff(z, age, z.x0, z.y0);
    });
    looped(tt, D, list.length * 8, s + 220, (r, j) => ({ q: list[j % list.length], back: r.chance(0.4), vx: r.range(-3, 3), vy: -r.range(12, 22), sz: r.range(0.9, 1.5) * (0.7 + 0.5 * list[j % list.length].env), life: 0.26 }), (z, age) => {
      if (z.back !== back) return;
      const [tx, ty] = tip(z.q, tt - age, s);
      lick(p, tx + z.vx * age, ty - 2 + z.vy * age, 1 - age / z.life, z.sz, HH);
    });
    // the plume: the campfire's smoke off the top, behind everything, each puff keeping the sway it left with
    if (back) looped(tt, D, Math.round(SMOKE_RATE * D), s + 300, (r) => ({ x: r.range(-5, 5), y: -R - LIFT * 0.8 - r.range(0, 8), vx: r.range(-2, 2), vy: -r.range(10, 17), life: r.range(2, 2.9), sz: r.range(2.4, 3.8) * (o.smokeK ?? 1) }), (z, age) => {
      const [x, y] = drift(z.x, z.y, z.vx, z.vy, age, 4, -20, 1.6, 1);
      smokePuff(p, x + NL(tt - age, 0.5, s + 60) * (2 + 3 * age), y, 1 - age / z.life, z.sz, SMOKE);
    });
    looped(tt, D, Math.round(EMBER_RATE * D), s + 500, (r) => ({ x: r.range(-R * 0.45, R * 0.45), back: r.chance(0.4), y: -R - r.range(4, 14), vx: r.range(-15, 15), vy: -r.range(25, 55), life: r.range(1, 1.9), sz: r.chance(0.15) ? 2 : r.range(1, 1.6), a: r.range(0, 6.3), b: r.range(0, 6.3) }), (z, age) => {
      if (z.back !== back) return;
      const [x, y] = drift(z.x, z.y, z.vx, z.vy, age, 0, -30, 1.6, 1.6);
      ember(p, x + 7 * (Math.sin(age * 2.3 + z.a) - Math.sin(z.a)), y + 2 * (Math.sin(age * 3 + z.b) - Math.sin(z.b)), 1 - age / z.life, z.sz, EMB, age * 40 + z.a);
    });
  }
  const GLOW = mix(mix(H[3], H[4], 0.5), WHITE, 0.25), SMOKE = mix(hex("#5b5566"), H[6], 0.25);
  return {
    drawBack(p, t) {
      const fl = fla(t % D, S), lx = lean(t % D, S) * 12;
      // the warm wash behind the ball, moving with the lean
      p.glow(lx, -R * 0.6, R * 2.4, GLOW, 0.22 * fl);
      p.glow(lx, -R * 1.2, R * 1.4, GLOW, 0.3 * fl);
      flow(p, t, true);
      body(p, t, BACK_T, S + 50, HB, false);
    },
    draw(p, t) {
      body(p, t, FRONT_T, S, H, false);
      flow(p, t, false);
      // the campfire's light over the column (its glows at -17..-21 over a 22 px fire, radius 46), placed over
      // this fire's top; the button face is cleared of light afterwards (clipFace)
      if (LIGHT > 0) {
        const tt = t % D, fl = fla(tt, S), lx = lean(tt, S) * 12, top = -R - LIFT * 0.5;
        for (const [x, k] of [[-6, 0.85], [0, 1], [6, 0.85]]) p.glow(x + lx, top - 4, 46, GLOW, 0.22 * k * fl * LIGHT);
        p.glow(lx, top + 4, 15, H[2], 0.14 * fl * LIGHT);
      }
    },
  };
}

function boltAura(o) {
  const C = fit(VOLT_Y, 8), S = SPARK_Y.map(hex), R = o.r + 2.5, D = 2, FPS = 30, NF = 60, PER = 2;
  const JOLTS = [[3, 1], [22, 0.7], [41, 0.9]];
  const jolt = (f) => { for (const [f0, k] of JOLTS) if (f >= f0 && f < f0 + 3) return { a: f - f0, k }; return null; };
  const rim = (a, r = R) => [Math.cos(a) * r, Math.sin(a) * r];
  const frame = (t) => Math.floor((t % D) * FPS + 1e-6) % NF;
  return {
    drawBack(p, t) {
      const f = frame(t), j = jolt(f), r = rng(o.seed, 4, f);
      // a cold aura: a broken ring flickering just outside the rim
      for (let i = 0; i < 80; i++) {
        const q = r.next();
        if (q > (j ? 0.9 : 0.42)) continue;
        const [x, y] = rim((i / 80) * TAU, R + 1.2);
        p.px(x, y, j ? C[4] : q < 0.2 ? C[3] : C[2]);
      }
      p.glow(0, 0, R * 2, C[3], j ? 0.5 * j.k : 0.15 + 0.08 * r.next());
    },
    draw(p, t) {
      const tt = t % D, f = frame(t), j = jolt(f);
      if (j) {
        // the jolt: the whole rim flares, then cools back down the ramp
        for (let i = 0; i < 96; i++) { const [x, y] = rim((i / 96) * TAU); p.px(x, y, C[[7, 6, 5][j.a]]); }
        p.glowRing(0, 0, R, 6, C[5], 0.5 * j.k * (1 - j.a / 3));
      }
      // arcs: two or three at a time, re-struck every other frame; most hop along the rim bowing outward, some reach out
      const r = rng(o.seed, 7, f >> 1), n = 2 + (j ? 2 : r.int(0, 1));
      for (let i = 0; i < n; i++) {
        const a = r.range(0, TAU), out = r.chance(0.35), k = (f & 1 ? 0.75 : 0.95) * r.range(0.6, 1), R2 = rng(o.seed, 8, f, i);
        const [x0, y0] = rim(a);
        let b, x1, y1, bolt;
        if (out) {
          b = a + r.range(-0.5, 0.5);
          [x1, y1] = rim(b, R + r.range(7, 13));
          bolt = zigzag(R2, x0, y0, x1, y1, 0.42, 0.35);
        } else {
          b = a + r.sign() * r.range(0.35, 0.8);
          [x1, y1] = rim(b);
          const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L, ny = (x1 - x0) / L, m = (a + b) / 2;
          bolt = bowed(R2, x0, y0, x1, y1, Math.sign(nx * Math.cos(m) + ny * Math.sin(m)) * r.range(2, 4), 0.3, 0.3);
        }
        crackle(p, bolt, k, C, 0.4);
        // the rim catches the light where an arc touches it
        for (let q = -2; q <= 2; q++) for (const e of out ? [a] : [a, b]) { const [x, y] = rim(e + q * 0.05); p.px(x, y, C[5]); }
      }
      // sparks: a spray off the rim with every jolt, a few spat out between
      for (const [f0, k] of JOLTS) {
        const age = (((tt - f0 / FPS) % PER) + PER) % PER;
        for (let i = 0; i < 9; i++) {
          const q = rng(o.seed, 21, f0, i), life = q.range(0.18, 0.4);
          if (age >= life) continue;
          const a = q.range(0, TAU), [x0, y0] = rim(a), ang = a + q.range(-0.5, 0.5), sp = q.range(60, 150) * k;
          const [x, y, vx, vy] = flight(x0, y0, Math.cos(ang) * sp, Math.sin(ang) * sp - 30, age);
          spark(p, x, y, vx, vy, 1 - age / life, S);
        }
      }
      cycle(tt, PER, 6, o.seed + 3, (g) => g.range(0.15, 0.3), (age, life, q) => {
        const a = q.range(0, TAU), [x0, y0] = rim(a), ang = a + q.range(-0.6, 0.6), sp = q.range(50, 110);
        const [x, y, vx, vy] = flight(x0, y0, Math.cos(ang) * sp, Math.sin(ang) * sp - 20, age);
        spark(p, x, y, vx, vy, 1 - age / life, S);
      });
    },
  };
}

function waterAura(o) {
  const C = fit(WATER, 8), D = 3, R = o.r;
  // three currents: radius, ring tilt, squash, whole turns per loop, dash phase
  const CUR = [
    { rr: R + 5, tilt: -0.38, sq: 0.34, turns: 1, ph: 0, thick: true },
    { rr: R + 8.5, tilt: 0.32, sq: 0.28, turns: -1, ph: 0.3, thick: true },
    { rr: R + 3, tilt: 0.06, sq: 0.44, turns: 2, ph: 0.6, thick: false },
  ];
  const current = (p, t, near) => {
    for (const c of CUR) {
      const spin = (c.turns * TAU * (t % D)) / D;
      for (let s = 0; s < 1; s += 0.005) {
        const dash = (s * 3 + c.ph) % 1;
        if (dash > 0.55) continue;
        const [x, y, z] = onRing(spin + s * TAU * Math.sign(c.turns || 1), c.rr, c.sq, c.tilt);
        if (z >= 0 !== near) continue;
        if (near) {
          p.px(x, y, dash < 0.07 ? WHITE : dash < 0.3 ? C[6] : C[5]);
          if (c.thick) p.px(x, y + 1, dash < 0.3 ? C[5] : C[4]);
        } else p.px(x, y, dash < 0.2 ? C[4] : C[3]);
      }
    }
  };
  // beads flung off the currents: born where a current is, carried along it, falling away under gravity
  const beads = (p, t, near) => cycle(t % D, D, 9, o.seed + 40, (g) => g.range(0.45, 0.8), (age, life, q) => {
    const c = CUR[q.int(0, 2)], born = (t % D) - age, a = (c.turns * TAU * born) / D + q.range(0, TAU);
    const [x0, y0, z] = onRing(a, c.rr, c.sq, c.tilt);
    if (z >= 0 !== near) return;
    const [x1, y1] = onRing(a + 0.05 * Math.sign(c.turns), c.rr, c.sq, c.tilt), sp = q.range(40, 80), L = Math.hypot(x1 - x0, y1 - y0) || 1;
    const [x, y, vx, vy] = flight(x0, y0, ((x1 - x0) / L) * sp, ((y1 - y0) / L) * sp - 15, age, { g: 0.5, drag: 1.2 });
    bead(p, x, y, vx, vy, q.chance(0.3) ? 2 : 1, C, 1 - age / life);
  });
  return {
    drawBack(p, t) {
      p.glow(0, 0, R * 1.9, C[4], 0.24);
      current(p, t, false);
      beads(p, t, false);
    },
    draw(p, t) {
      current(p, t, true);
      beads(p, t, true);
      // glints riding the near side
      for (let i = 0; i < 3; i++) {
        const c = CUR[i], [x, y, z] = onRing((c.turns * TAU * (t % D)) / D + i * 2.1, c.rr, c.sq, c.tilt);
        if (z < 0.2) continue;
        p.px(x, y, WHITE);
        p.glow(x, y, 5, C[5], 0.4 * z);
      }
    },
  };
}

function earthAura(o) {
  const S = fit(STONE, 8), SB = [S[0], S[0], S[1], S[2], S[3], S[4], S[5], S[6]], D = 6, R = o.r, SQ = 0.3, TILT = -0.18;
  const SIZES = [5.2, 3.4, 4.4, 2.8, 4.8, 3.8];
  const RK = SIZES.map((s, i) => {
    const g = new Rng(o.seed * 31 + i * 7 + 1);
    return { a0: (i / 6) * TAU + g.range(-0.25, 0.25), s, pts: stoneShape(g), spin: (g.chance(0.5) ? 1 : -1) * (1 + g.int(0, 1)), bob: g.range(0, TAU), rr: R + 8 + g.range(-1.5, 1.5) };
  });
  const pos = (k, tt) => {
    const ph = (TAU * tt) / D, [x, y, z] = onRing(k.a0 + ph, k.rr, SQ, TILT);
    return [x, y + Math.sin(ph * 2 + k.bob) * 1.2, z];
  };
  const rocks = (p, t, near) => {
    const tt = t % D, list = RK.map((k) => [k, ...pos(k, tt)]).filter(([, , , z]) => z >= 0 === near).sort((a, b) => a[3] - b[3]);
    for (const [k, x, y, z] of list) drawRock(p, x, y, k.s * (0.86 + 0.18 * z), (k.spin * TAU * tt) / D, k.pts, near ? S : SB);
  };
  // grit shaken off the stones, falling and fading
  const grit = (p, t, near) => cycle(t % D, D, 26, o.seed + 5, (g) => g.range(0.4, 0.8), (age, life, q) => {
    const k = RK[q.int(0, RK.length - 1)], [x0, y0, z] = pos(k, (t % D) - age);
    if (z >= 0 !== near) return;
    const u = age / life;
    p.dot(x0 + q.range(-1.5, 1.5) + q.range(-4, 4) * u, y0 + 1 + 70 * age * age, u < 0.4 ? S[5] : S[4], 1 - u);
  });
  return {
    drawBack(p, t) { rocks(p, t, false); grit(p, t, false); },
    draw(p, t) { grit(p, t, true); rocks(p, t, true); },
  };
}

function airAura(o) {
  const C = fit(AIR, 8), Lf = LEAF.map(hex), D = 1.5, R = o.r;
  const RIB = [
    { rr: R + 6, tilt: -0.42, sq: 0.32, turns: 2, len: 2.4, ph: 0 },
    { rr: R + 10, tilt: 0.36, sq: 0.27, turns: 2, len: 1.9, ph: 2.1 },
    { rr: R + 3.5, tilt: 0.08, sq: 0.46, turns: 3, len: 1.4, ph: 4.2 },
    { rr: R + 13, tilt: -0.1, sq: 0.22, turns: 1, len: 1.2, ph: 1.0 },
  ];
  const head = (c, t) => c.ph + (c.turns * TAU * (t % D)) / D;
  const ribbons = (p, t, near) => {
    for (const c of RIB) {
      const h = head(c, t), breathe = Math.sin((TAU * 2 * (t % D)) / D + c.ph) * 1.2;
      for (let s = 0; s < c.len; s += 0.015) {
        const [x, y, z] = onRing(h - s, c.rr + breathe, c.sq, c.tilt);
        if (z >= 0 !== near) continue;
        const u = s / c.len, a = 1 - u * u;
        const col = near ? (s < 0.08 ? WHITE : u < 0.4 ? C[6] : C[5]) : u < 0.3 ? C[4] : C[3];
        p.dot(x, y, col, a);
        if (u < 0.6) p.dot(x, y - 1, near ? C[5] : C[3], a * 0.9);
        if (near && u < 0.2) p.dot(x, y + 1, C[5], a);
      }
    }
  };
  const leaves = (p, t, near) => {
    for (let i = 0; i < 2; i++) {
      const c = RIB[i], a = head(c, t) - 0.25, [x, y, z] = onRing(a, c.rr, c.sq, c.tilt);
      if (z >= 0 !== near) continue;
      const [x2, y2] = onRing(a + 0.05, c.rr, c.sq, c.tilt);
      drawLeaf(p, x, y, near ? 8 : 6, 2.2, Math.atan2(y2 - y, x2 - x), (TAU * 3 * (t % D)) / D + i, near ? Lf : [Lf[0], Lf[0], Lf[1], Lf[2]]);
    }
  };
  // wisps spiralling off the wind
  const wisps = (p, t, near) => cycle(t % D, D, 10, o.seed + 9, (g) => g.range(0.35, 0.6), (age, life, q) => {
    const a = q.range(0, TAU) + age * 5, rr = R + 4 + age * 28, [x, y, z] = onRing(a, rr, 0.38, q.range(-0.4, 0.4));
    if (z >= 0 !== near) return;
    p.dot(x, y, near ? C[5] : C[4], 1 - age / life);
  });
  return {
    drawBack(p, t) { p.glow(0, 0, R * 1.7, C[4], 0.12); wisps(p, t, false); ribbons(p, t, false); leaves(p, t, false); },
    draw(p, t) { wisps(p, t, true); ribbons(p, t, true); leaves(p, t, true); },
  };
}

const MAKERS = { fire: ballFireAura, "fire-rim": fireAura, bolt: boltAura, ice: waterAura, water: waterAura, earth: earthAura, air: airAura };

// the lab's stand-in for the picker's DOM button: a parchment disc, gold rim, dark ring
function standIn(p, R) {
  const PARCH = hex("#d9c49a"), RIM = hex("#c9a44a"), INK = hex("#140d07");
  p.shade(-R - 3, -R - 3, R + 3, R + 3, (x, y, out) => {
    const d = Math.hypot(x, y);
    if (d > R + 2.5) return;
    out.c = d > R + 1 ? INK : d > R - 1 ? RIM : mix(PARCH, hex("#f4e9cf"), Math.max(0, -(x + y) / (2 * R)));
  });
}

// Keep the front layer off the button face (user, 2026-11-01: "not eat into the button so it is uniform with other
// buttons"). Inside the button (its border and dark ring end ~2 px past o.r) the LIGHT is cleared for every element,
// so glows never tint the face, and the colour too for the elements that live round the rim (fire, lightning). The
// orbiters (water, earth, air) keep their colour: they pass in front of the button on purpose (depth).
const RIM_ONLY = new Set(["fire", "fire-rim", "bolt"]);
function clipFace(p, rad, colour) {
  const r2 = rad * rad, cx = p.tx - p.ox, cy = p.ty - p.oy;
  for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(p.h - 1, Math.ceil(cy + rad)); y++)
    for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(p.w - 1, Math.ceil(cx + rad)); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy >= r2) continue;
      p.L[y * p.w + x] = 0;
      if (colour) p.C[y * p.w + x] = 0;
    }
}

export function create(o) {
  const aura = (MAKERS[o.el] ?? fireAura)(o);
  return {
    drawBack(p, t) { if (o.lift) p.place(o.x ?? 0, (o.y ?? 0) - o.lift); aura.drawBack(p, t); if (o.button) standIn(p, o.r); },
    draw(p, t) {
      if (o.lift) p.place(o.x ?? 0, (o.y ?? 0) - o.lift);
      aura.draw(p, t);
      // the lab draws a stand-in button into the same frame, so clip only when the button is a real (DOM) one
      if (!o.button) clipFace(p, o.r + 2, RIM_ONLY.has(o.el));
    },
  };
}
