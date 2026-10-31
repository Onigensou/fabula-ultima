// Void dash: the hound runs in from off-screen too fast to see (afterimages, speed lines, a burning streak on
// the floor) and skids to a stop in a white flash that cools into it.
// Drawn at the party sprites' density (1 px = 1 screen px at the battle view) with pixelfx's toolkit and its
// craft rules: fast in, slow out; a white hero frame; a freeze on contact; secondary motion (dust, grit, sparks,
// smoke); every particle varied; it ends empty.
// Ported from the approved mockup (claude.ai/artifact/WQXfrnXm8PPTdQSeaJ9WXk). The run, the streak, the rings and
// the dust lie on the floor through floor.js (flat: the mockup exactly; under the 3D camera: the floor the camera
// draws, the run coming from the floor direction drawn furthest behind the hound); the body stays on its card.
import { Particles, Lights, P, Rng, fit, sparkle, clamp, ease, rand, WHITE } from "./pixelfx/core/index.js";
import { VOID } from "./pixelfx/fx/shadow/_lib.js";
import { makeFloor, band } from "./floor.js";

// beats: a glint where it will come from, the run, the stop (held a moment), the cool-down, the settle
const GLINT = 0.1, RUN = 0.22, ARRIVE = GLINT + RUN, HOLD = 0.05, COOL = 0.4, END = 1.3, SY = 0.24, GHOSTS = 7;

export const meta = {
  name: "Void dash",
  desc: "A glint at the edge of the field, then the hound tears across it in afterimages and speed lines and skids to a stop in a white flash.",
  duration: END,
  loop: false,
  // from: where the run starts (off-screen); glint: where the field's edge is, so the warning is seen
  options: { palette: VOID, from: -460, glint: -300, dust: ["#a8794a", "#c99a64", "#e2bd8a"], floor: null, seed: 9 },
};

/** Frame size and origin (the hound's feet on its mark) for these options: it has to reach back to the start. */
export function layout(o) {
  const A = o.actor, F = makeFloor(o.floor, SY), d = F.front(), [sx, sy] = F.at(d[0] * o.from, d[1] * o.from);
  const back = Math.max(0, -sx) + A.w * 1.6 + 40, up = Math.max(0, -sy), down = Math.max(0, sy);
  return { size: [Math.ceil(back + Math.max(0, sx) + A.w / 2 + 240), Math.ceil(A.h + 130 + up + down)], origin: [Math.ceil(back), Math.ceil(A.h + 100 + up)] };
}

export function create(o) {
  const C = fit(o.palette, 8), R = new Rng(o.seed), A = o.actor, FROM = o.from;
  // the run path: s along the floor's front direction (s < 0 behind the mark); where it is drawn, and its slope
  const F = makeFloor(o.floor, SY), dir = F.front(), on = (s) => F.at(s * dir[0], s * dir[1]);
  const [ux, uy] = on(1), un = Math.hypot(ux, uy) || 1, UX = ux / un, UY = uy / un;
  // dust and grit land on the path's line (flat: y = 0)
  const floor = (x) => (Math.abs(UX) > 1e-3 ? (x / UX) * UY : 0);
  const shade = new Uint8Array(A.w * A.h);
  for (let i = 0; i < shade.length; i++) if (A.mask.data[i]) shade[i] = lumaOf(A.pixels[i]) < 0.2 ? 1 : 2;
  const ps = new Particles({ rng: R, ground: floor, sparks: [WHITE, C[6], C[5], C[4]] }), lights = new Lights();
  // a particle kicked off the path at run distance s + ds, height h: thrown along the path at v, and up by vy
  const kick = (kind, s, ds, h, v, vy, ...rest) => {
    const [x, y] = on(s + ds);
    ps.spawn(kind, x, y + h, v * UX, vy + v * UY, ...rest);
  };
  // dust the colour of the floor it is kicked off (the caller passes the arena's sand), never the void palette
  const DUST = fit(o.dust, 3), GX = Math.max(FROM, o.glint);
  const lines = [], ghosts = [], trail = [];
  let t = 0, arrived = false, ghostAcc = 0;
  // where the body is: off-screen at FROM, tearing in (most of the way in the first quarter), a short skid past
  // the mark and back
  const run = (tt) => {
    if (tt < GLINT) return { x: FROM, bob: 0, speed: 0 };
    const u = clamp((tt - GLINT) / RUN);
    if (u < 1) {
      const e = 1 - Math.pow(1 - u, 4), speed = 4 * Math.pow(1 - u, 3);
      return { x: FROM * (1 - e) + 7 * Math.sin(u * Math.PI) * u * u, bob: -Math.abs(Math.sin(u * 22)) * 4 * (1 - u), speed };
    }
    const s = clamp((tt - ARRIVE) / 0.14);
    return { x: 6 * (1 - ease.outCubic(s)), bob: 0, speed: 0 };
  };
  const stretch = (speed) => 1 + 0.55 * clamp(speed / 4);

  return {
    update(dt) {
      t += dt;
      const r = run(t), sp = r.speed;
      if (t >= GLINT && t < ARRIVE) {
        // afterimages: where it was a moment ago
        for (ghostAcc += dt; ghostAcc > 0.016; ghostAcc -= 0.016) {
          ghosts.unshift({ x: r.x, bob: r.bob, sx: stretch(sp), born: t });
          if (ghosts.length > GHOSTS) ghosts.pop();
          trail.push(r.x);
        }
        // speed lines peel off its back, stay where they are born and shrink
        for (let i = 0; i < 3; i++) {
          const [bx, by] = on(r.x);
          lines.push({ x: bx + A.x - R.range(0, 12), y: by + A.y + R.range(0.12, 0.92) * A.h + r.bob, len: R.range(30, 110) * clamp(sp / 2), t0: t, life: R.range(0.12, 0.26), c: R.pick([WHITE, C[6], C[6], C[5], C[4]]) });
        }
        // the paws kick dust and grit back, and strike sparks off the floor
        if (R.chance(0.9)) kick(P.DUST, r.x, R.range(-A.w * 0.3, A.w * 0.2), -2, -R.range(40, 160), -R.range(10, 50), R.range(0.35, 0.7), R.pick(DUST), R.range(3, 7));
        if (R.chance(0.5)) kick(P.GRIT, r.x, R.range(-A.w * 0.2, A.w * 0.2), -2, -R.range(60, 220), -R.range(60, 220), R.range(0.4, 0.8), R.pick(DUST), R.chance(0.3) ? 2 : 1);
        if (R.chance(0.35)) kick(P.SPARK, r.x, A.w * 0.2, -1, -R.range(80, 260), -R.range(40, 160), R.range(0.15, 0.35));
      }
      if (!arrived && t >= ARRIVE) {
        arrived = true;
        const cy = A.y + A.h * 0.5;
        lights.add(0, cy, A.h * 1.4, C[5], 1, 0.4);
        lights.add(0, cy, A.h * 0.6, WHITE, 0.9, 0.12);
        // the skid throws dust and grit forward, low, and sparks off the claws
        for (let i = 0; i < 16; i++) kick(P.DUST, 0, A.w * R.range(0.1, 0.5), -2, R.range(40, 190), -R.range(8, 60), R.range(0.5, 1), R.pick(DUST), R.range(4, 10));
        for (let i = 0; i < 22; i++) kick(P.GRIT, 0, A.w * R.range(0.1, 0.45), -2, R.range(60, 260), -R.range(80, 260), R.range(0.5, 1), R.pick(DUST), R.chance(0.3) ? 2 : 1);
        for (let i = 0; i < 14; i++) kick(P.SPARK, 0, A.w * R.range(0, 0.4), -1, R.range(120, 360), -R.range(60, 240), R.range(0.2, 0.45));
        for (let i = 0; i < 18; i++) ps.spawn(P.STAR, R.range(-0.4, 0.4) * A.w, A.y + R.range(0.1, 0.9) * A.h, R.range(-60, 60), -R.range(20, 90), R.range(0.3, 0.7), R.pick([WHITE, C[6], C[5]]), R.range(1.5, 4));
        // the streak it left smoulders into void smoke
        for (let i = 0; i < trail.length; i += 3) {
          const [vx, vy] = on(trail[i] + R.range(-6, 6));
          ps.spawn(P.VAPOUR, vx, vy + A.y * R.range(0.05, 0.4), R.range(-10, 10), -R.range(8, 26), R.range(0.5, 0.9), R.chance(0.5) ? C[4] : C[5], R.range(3, 6), R.range(0, 0.12));
        }
      }
      for (let i = lines.length - 1; i >= 0; i--) if (t - lines[i].t0 > lines[i].life) lines.splice(i, 1);
      if (t > ARRIVE + 0.12) ghosts.length = 0;
      ps.update(dt);
      lights.update(dt);
    },

    drawBack(p) {
      const r = run(t), k = t < ARRIVE ? 1 : 1 - clamp((t - ARRIVE) / 0.55);
      // the glint where it will come from: a point of light on the floor and a ring that pings out
      if (t < GLINT + 0.08) {
        const q = clamp(t / GLINT), [gx, gy] = on(GX);
        sparkle(p, gx, gy + A.y * 0.45, 3 + 9 * ease.outCubic(q), C[6], C[5], 0.7);
        band(p, F, GX * dir[0], GX * dir[1], 6 + 34 * ease.outCubic(q), 2, 1 - q * 0.7, [C[3], C[5], C[6], WHITE]);
      }
      // the burning streak along the floor, white-hot right behind it, cooling back toward where it started
      if (t >= GLINT && k > 0) {
        const [x0, y0] = on(FROM), [x1, y1] = on(r.x), [xm, ym] = on((FROM + r.x) / 2);
        p.line(x0, y0 - 1, x1, y1 - 1, (u) => (u > 0.9 ? WHITE : u > 0.6 ? C[6] : u > 0.3 ? C[5] : C[4]), (u) => k * clamp(0.2 + u));
        p.line(x0, y0, x1, y1, C[2], k * 0.8);
        p.glowLine(xm, ym - 2, x1, y1 - 2, 7, C[5], 0.35 * k);
      }
      ps.draw(p, "back");
    },

    draw(p) {
      const r = run(t);
      // speed lines
      for (const l of lines) {
        const q = (t - l.t0) / l.life, len = l.len * (1 - q);
        if (len < 1) continue;
        p.line(l.x - len * UX, l.y - len * UY, l.x, l.y, (u) => (u > 0.85 ? WHITE : l.c), (u) => (1 - q) * (0.3 + 0.7 * u));
      }
      // afterimages, oldest first: void-coloured, thinner and fainter the older they are
      for (let i = ghosts.length - 1; i >= 1; i--) {
        const g = ghosts[i], age = i / GHOSTS;
        body(p, A, shade, on(g.x), g.bob, g.sx, (v) => (v === 1 ? C[2] : age < 0.4 ? C[5] : age < 0.7 ? C[4] : C[3]), 0.85 * (1 - age));
      }
      // the body itself while it runs: too fast to see, a white-hot shape with a violet rim
      if (t >= GLINT && t < ARRIVE) {
        const at = on(r.x);
        body(p, A, shade, at, r.bob, stretch(r.speed), (v, u) => (v === 1 ? C[4] : u > 0.55 ? WHITE : C[6]), 1);
        p.glow(at[0], at[1] + A.y + A.h * 0.5, A.h * 0.9, C[5], 0.5);
      }
      // the stop: a white hero frame, held, then the colour cools back in under a crackling rim
      if (t >= ARRIVE) {
        const h = t - ARRIVE, x = r.x, [bx, by] = on(x);
        if (h < HOLD) body(p, A, shade, [bx, by], 0, 1, (v) => (v === 1 ? C[6] : WHITE), 1);
        else if (h < HOLD + COOL) {
          const k = 1 - (h - HOLD) / COOL, f = Math.floor(t * 30);
          for (let y = 0; y < A.h; y++)
            for (let xx = 0; xx < A.w; xx++) {
              const i = y * A.w + xx;
              if (shade[i]) p.light(bx + A.x + xx, by + A.y + y, C[6], k * k * (shade[i] === 1 ? 0.25 : 0.75));
              else if (edge(A, xx, y) && rand(xx, y, f) < 0.8 * k) p.px(bx + A.x + xx, by + A.y + y, k > 0.5 && rand(xx, y, 3) < 0.5 ? WHITE : C[6]);
            }
        }
        const q = h / 0.45;
        if (q < 1) band(p, F, x * dir[0], x * dir[1], A.w * (0.2 + 0.9 * ease.outCubic(q)), Math.max(1, 5 * (1 - q)), 1.15 - q, [C[3], C[5], C[6], WHITE], undefined, q < 0.2);
      }
      ps.draw(p, "front");
      lights.draw(p);
    },
  };
}

// the silhouette with its feet at frame px [ox, oy] (+ bob), stretched sx wide backwards from its front edge (it
// faces right)
function body(p, A, shade, [ox, oy], bob, sx, col, a) {
  const cx = A.x + A.w / 2, shift = -(A.w / 2) * (sx - 1), half = (A.w / 2 + 1) * sx;
  for (let y = 0; y < A.h; y++)
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
      const i = Math.round(cx + (x + 0.5 - cx) / sx - 0.5) - A.x;
      if (i < 0 || i >= A.w) continue;
      const v = shade[y * A.w + i];
      if (v) p.dot(ox + x + shift, oy + A.y + y + bob, col(v, i / A.w), a);
    }
}
const edge = (A, x, y) => {
  const on = (i, j) => i >= 0 && j >= 0 && i < A.w && j < A.h && A.mask.data[j * A.w + i];
  return !on(x, y) && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1));
};
const lumaOf = (c) => (0.299 * (c & 255) + 0.587 * ((c >>> 8) & 255) + 0.114 * ((c >>> 16) & 255)) / 255;
