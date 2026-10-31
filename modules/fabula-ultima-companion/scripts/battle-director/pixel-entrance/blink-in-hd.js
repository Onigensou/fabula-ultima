// Blink in, at the party sprites' density. pixelfx's blink-in (adapted from Sprite Fusion's blink, MIT, Hugo
// Duprez / Patch) is drawn round a 24 x 38 stand-in; here every distance, speed, glow and spark size scales with
// the creature's real silhouette (K = its height / 38), and strokes stay 1 px, so it gains detail, not chunk.
// Ported from the approved mockup (claude.ai/artifact/WQXfrnXm8PPTdQSeaJ9WXk); the ring lies on the floor through
// floor.js (flat: the mockup exactly; under the 3D camera: the floor the camera draws).
import { Particles, Lights, P, Rng, PAL, fit, flare, sparkle, clamp, ease, rand, TAU, WHITE } from "./pixelfx/core/index.js";
import { makeFloor, band } from "./floor.js";
import { shades, squeezed } from "./pixelfx/fx/arcane/_lib.js";
import { Feathers } from "./pixelfx/fx/holy/_lib.js";

const LINE = 0.26, GROW = 0.1, OPEN = 0.12, ARRIVE = LINE + GROW + OPEN;

// feathers: a dark-to-bright ramp to burst the creature out of its silhouette in feathers (null: none). They
// dissolve into motes of light while they are still spreading, so they end with the blink.
export const meta = { name: "Blink in (HD)", duration: 1.5, loop: false, options: { palette: PAL.arcane, feathers: null, floorDy: 0, floor: null, seed: 12 } };

export function layout(o) {
  // the ring reaches 34 K round the feet: room for it however the floor is drawn
  const A = o.actor, K = Math.max(1, A.h / 38), F = makeFloor(o.floor, 0.2), rx = 34 * K * Math.hypot(F.ex[0], F.ez[0]), ry = 34 * K * Math.hypot(F.ex[1], F.ez[1]);
  const w = Math.ceil(Math.max(A.w + 120 * K, 2 * rx + 8)), h = Math.ceil(A.h + 45 * K + Math.max(25 * K, ry + 4));
  return { size: [w, h], origin: [Math.ceil(w / 2), Math.ceil(A.h + 45 * K)] };
}

export function create(o) {
  const C = fit(o.palette, 8), R = new Rng(o.seed), A = o.actor, sh = shades(A), K = Math.max(1, A.h / 38), F = makeFloor(o.floor, 0.2);
  const ps = new Particles({ rng: R, ground: () => 0, sparks: [WHITE, C[6], C[5], C[4]] }), lights = new Lights();
  const mx = A.x + A.w / 2, my = A.y + A.h * 0.55, COLS = [WHITE, C[6], C[6], C[5], C[4]];
  const inside = (x, y) => x >= 0 && y >= 0 && x < A.w && y < A.h && A.mask.data[y * A.w + x];
  const FR = o.feathers ? fit(o.feathers, 6) : null, plumes = new Feathers(R, o.floorDy ?? 0);
  // the silhouette's rim, upper part (wings, crest): where feathers tear loose
  const rim = [];
  for (let y = 0; y < A.h * 0.75; y++) for (let x = 0; x < A.w; x++) if (inside(x, y) && (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1))) rim.push([A.x + x, A.y + y]);
  const pluck = (n, burst) => {
    for (let i = 0; i < n && rim.length; i++) {
      const [x, y] = R.pick(rim), dx = x - mx, dy = y - my, d = Math.hypot(dx, dy) || 1, sp = (burst ? R.range(110, 220) : R.range(20, 60)) * K * 0.6;
      const len = R.range(0.16, 0.26) * A.h * (burst ? 1 : 0.8);
      plumes.add({ x, y, vx: (dx / d) * sp, vy: (dy / d) * sp * 0.8 - (burst ? 30 : 0) * K, a: Math.atan2(dy, dx) + R.range(-0.6, 0.6), len, wid: len * R.range(0.22, 0.28),
        life: R.range(0.45, 0.7), delay: burst ? R.range(0, 0.04) : 0, back: R.chance(0.35), sink: R.range(26, 40) * K * 0.6, amp: R.range(8, 13) * K * 0.6 });
    }
  };

  // more bits for the bigger body, from proportionally further out
  const bits = Array.from({ length: Math.round(230 * K) }, () => {
    const a = R.range(0, TAU), d = R.range(16, 46) * K, ty = A.y + R.range(3, A.h - 2);
    let oy = Math.sin(a) * d * 0.8 - 6 * K;
    if (ty + oy > -2) oy = -Math.abs(oy) - 2;
    return { tx: mx + R.range(-1, 1) * K, ty, ox: Math.cos(a) * d, oy, t0: R.range(0, 0.1), t1: LINE + R.range(-0.02, GROW), spin: R.range(0.8, 1.8) * R.sign(), c: R.pick(COLS) };
  });
  let t = 0, arrived = false;
  const at = (b, tt) => {
    const k = clamp((tt - b.t0) / (b.t1 - b.t0)), e = ease.outCubic(k), r = 1 - e, sp = b.spin * r * 1.2;
    const ox = b.ox * Math.cos(sp) - b.oy * Math.sin(sp), oy = b.ox * Math.sin(sp) + b.oy * Math.cos(sp);
    return [b.tx + ox * r, Math.min(-1, b.ty + oy * r), k];
  };
  const ring = (p, far) => {
    const k = (t - ARRIVE + 0.03) / 0.5;
    if (k >= 0 && k < 1) band(p, F, 0, 0, (4 + 30 * ease.outCubic(k)) * K, Math.max(1, 3 * K * (1 - k)), 1.15 - k, [C[3], C[5], C[6], WHITE], (g) => (Math.sin(g) < 0) === far, k < 0.25);
  };

  return {
    update(dt) {
      t += dt;
      if (t < LINE && R.chance(Math.min(1, 0.6 * K))) {
        const a = R.range(0, TAU), D = R.range(22, 44) * K, T = R.range(0.12, 0.18), v = (D * 3) / (Math.exp(3 * T) - 1);
        const x = mx + Math.cos(a) * D, y = Math.min(-2, my + Math.sin(a) * D), l = Math.hypot(x - mx, y - my) || 1;
        ps.spawn(P.STREAK, x, y, ((mx - x) / l) * v, ((my - y) / l) * v, T, R.chance(0.5) ? C[6] : C[5]);
      }
      if (!arrived && t >= ARRIVE) {
        arrived = true;
        if (FR) pluck(Math.round(9 * K), true);
        lights.add(mx, my - 6 * K, 56 * K, C[5], 0.9, 0.35);
        lights.add(mx, my, 24 * K, WHITE, 0.8, 0.1);
        for (let i = 0; i < Math.round(30 * K); i++) {
          const a = R.range(0, TAU), sp = R.range(35, 110) * K;
          ps.spawn(R.chance(0.6) ? P.STAR : P.MOTE, mx, my, Math.cos(a) * sp, Math.sin(a) * sp * 0.7 - 30 * K, R.range(0.4, 0.85), R.pick(COLS), R.range(0.6, 1.6) * K);
        }
        for (let i = 0; i < Math.round(12 * K); i++) {
          const s = R.sign();
          ps.spawn(P.SPARK, mx + s * R.range(2, 8) * K, -1, s * R.range(60, 180) * K, -R.range(20, 110) * Math.sqrt(K), R.range(0.2, 0.45));
        }
      }
      // each feather goes out in a puff of motes as it fades, mid-flight
      for (const f of plumes.list)
        if (f.delay <= 0 && f.life - dt <= 0)
          for (let i = 0; i < 3; i++) ps.spawn(P.MOTE, f.x, f.y, f.vx * 0.3 + R.range(-20, 20) * K, f.vy * 0.3 - R.range(10, 30) * K, R.range(0.2, 0.35), R.pick([C[6], C[5], FR[5]]), 0.6 * K);
      plumes.update(dt);
      ps.update(dt);
      lights.update(dt);
    },
    drawBack(p) {
      if (FR) plumes.draw(p, FR, "back");
      ring(p, true);
      p.glow(0, -1, 26 * K, C[5], 0.3 * (t < ARRIVE ? t / ARRIVE : 1 - clamp((t - ARRIVE) / 0.5)));
    },
    draw(p) {
      for (const b of bits) {
        if (t < b.t0 || t > b.t1 + 0.02) continue;
        const [x, y, k] = at(b, t);
        p.dot(x, y, k > 0.75 ? WHITE : b.c, Math.min(1, 0.35 + k * 2));
        if (k > 0.55) {
          // a tail that grows with the scale: a few px behind it along its path
          for (let j = 1; j <= Math.round(K); j++) {
            const [px, py] = at(b, t - 0.008 * j);
            p.dot(px, py, j === 1 ? C[6] : C[5], 0.8 - j * 0.15);
          }
        }
        if (k > 0.8) p.glow(x, y, 3 * K, C[6], 0.3);
      }
      if (t >= LINE - 0.04 && t < LINE) {
        const q = (t - LINE + 0.04) / 0.04;
        sparkle(p, mx, my, (2 + 3 * q) * K, C[6], C[5], 0.6);
      } else if (t >= LINE && t < LINE + GROW) {
        // a line of light opening top to bottom: a white core K px wide, violet either side
        const q = ease.outCubic((t - LINE) / GROW), hh = (A.h / 2 + 3 * K) * q, half = Math.max(1, Math.round(K / 2));
        for (let y = -hh - 2 * K; y <= hh + 2 * K; y++)
          for (let dx = -half; dx <= half; dx++) p.dot(mx + dx, my + y, Math.abs(y) < hh ? WHITE : C[6], Math.abs(y) < hh ? 1 : 0.7);
        for (let y = -hh * 0.7; y <= hh * 0.7; y++) (p.dot(mx - half - 1, my + y, C[5], 0.6), p.dot(mx + half + 1, my + y, C[5], 0.6));
        p.glow(mx, my, 30 * K, C[5], 0.9);
        p.glow(mx, my, 8 * K, WHITE, 0.5);
      } else if (t >= LINE + GROW && t < ARRIVE) {
        const q = ease.outCubic((t - LINE - GROW) / OPEN);
        squeezed(p, A, sh, q, WHITE, C[6]);
        p.glow(mx, my, 36 * K, C[5], 0.8);
      } else if (t >= ARRIVE && t < ARRIVE + 0.42) {
        const k = 1 - (t - ARRIVE) / 0.42, f = Math.floor(t * 30);
        if (k > 0.86) squeezed(p, A, sh, 1, WHITE, C[6]);
        for (let y = 0; y < A.h; y++)
          for (let x = 0; x < A.w; x++)
            if (inside(x, y)) p.light(A.x + x, A.y + y, C[6], k * k * (sh[y * A.w + x] === 1 ? 0.3 : 0.8));
            else if ((inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1)) && rand(x, y, f) < 0.85 * k) p.px(A.x + x, A.y + y, k > 0.5 && rand(x, y, 7) < 0.5 ? WHITE : C[6]);
        p.glow(mx, my, 34 * K, C[5], 0.6 * k);
      }
      if (t >= ARRIVE && t < ARRIVE + 0.2) {
        const q = (t - ARRIVE) / 0.2;
        flare(p, mx, my - 4 * K, (18 * Math.pow(1 - q, 1.5) + 2) * K, 1 - q, C);
      }
      ring(p, false);
      if (FR) plumes.draw(p, FR, "front");
      ps.draw(p);
      lights.draw(p);
    },
  };
}
