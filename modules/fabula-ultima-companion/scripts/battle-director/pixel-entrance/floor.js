// The floor under a creature, in its entrance frame.
//
// A floor point (x along the creature's facing, z toward the camera, both in
// effect px at its feet) is drawn at frame px F.at(x, z). With no 3D camera
// that is the approved mockup's own flat view: x as is, z squashed by the
// effect's own `sy`. Under the 3D camera the runtime passes the camera's map of
// the floor at the creature's feet ({ ex, ez }: where one floor px along x / z
// lands in the frame), so rings, the summoning circle and the dash's run path
// lie on the floor the camera draws, while everything on the creature's card
// (afterimages, blink, feathers, the column) stays upright.
//
// band() and ring() are pixelfx's `band` and arcane `floorRing` with the
// squashed ellipse replaced by that map; on a flat floor they draw exactly
// what the originals draw.

import { hex, TAU, WHITE } from "./pixelfx/core/index.js";

/** The floor for an effect: `map` from the runtime (null = flat), `sy` the effect's own squash, `y0` its line. */
export function makeFloor(map, sy, y0 = 0) {
  const ex = map?.ex ?? [1, 0], ez = map?.ez ?? [0, sy];
  const det = ex[0] * ez[1] - ez[0] * ex[1] || 1e-6;
  const F = {
    flat: !map,
    ex, ez, y0,
    /** Frame px of floor point (x, z). */
    at: (x, z = 0) => [x * ex[0] + z * ez[0], y0 + x * ex[1] + z * ez[1]],
    /** Floor point under frame px (X, Y). */
    inv: (X, Y) => {
      const dy = Y - y0;
      return [(X * ez[1] - dy * ez[0]) / det, (dy * ex[0] - X * ex[1]) / det];
    },
    /** The unit floor direction drawn furthest toward the frame's +x (the creature's front). */
    front: () => {
      const n = Math.hypot(ex[0], ez[0]) || 1;
      return [ex[0] / n, ez[0] / n];
    },
    /** How many frame px one floor px can span at most (sampling density). */
    stretch: Math.max(1, Math.hypot(ex[0], ex[1]), Math.hypot(ez[0], ez[1])),
  };
  return F;
}

/**
 * pixelfx `band` on the floor: a ring round floor point (cx, cz), radius r,
 * thickness th inward, alpha k, coloured by depth through the band with ramp
 * (dark to bright). keep(angle) picks which part to draw; (g) => Math.sin(g) < 0
 * is the far half (away from the camera).
 */
export function band(p, F, cx, cz, r, th, k, ramp, keep = () => true, hot = false) {
  if (r <= 0 || k <= 0) return;
  const R = ramp.map(hex), n = R.length;
  for (let j = 0, m = Math.ceil(r * TAU * 1.2 * F.stretch); j < m; j++) {
    const ang = (j / m) * TAU, ca = Math.cos(ang), sa = Math.sin(ang);
    if (!keep(ang)) continue;
    for (let o = th; o >= 0; o -= 0.5) {
      const u = o / th, c = u < 0.15 ? (hot ? WHITE : R[n - 1]) : u < 0.4 ? R[n - 2] : u < 0.7 ? R[n - 3] : R[n - 4];
      const [x, y] = F.at(cx + ca * (r - o), cz + sa * (r - o));
      p.dot(x, y, c, k * (u < 0.4 ? 1.2 : 1.15 - u));
    }
  }
}

/**
 * pixelfx arcane `floorRing` on the floor: a 1 px line round floor point
 * (cx, cz) at radius r, colour c and alpha a (each a value or a function of
 * the angle), keep(angle) as in band().
 */
export function ring(p, F, cx, cz, r, c, a = 1, keep = null) {
  if (r < 0.5) return;
  const fc = typeof c === "function", fa = typeof a === "function";
  const [X, Y] = F.at(cx, cz);
  const hx = r * Math.hypot(F.ex[0], F.ez[0]), hy = Math.max(0.3, r * Math.hypot(F.ex[1], F.ez[1]));
  const det = F.ex[0] * F.ez[1] - F.ez[0] * F.ex[1] || 1e-6;
  p.shade(X - hx - 1, Y - hy - 1, X + hx + 1, Y + hy + 1, (x, y, o) => {
    const [u, v] = F.inv(x - X, y - Y + F.y0), d = Math.hypot(u, v) / r;
    if (d < 1e-6) return;
    // the distance to the ring in px: |d - 1| over the length of d's gradient
    const nu = u / (d * r), nv = v / (d * r);
    const g = Math.hypot(F.ez[1] * nu - F.ex[1] * nv, -F.ez[0] * nu + F.ex[0] * nv) / Math.abs(det) / r;
    if (Math.abs(d - 1) / g > 0.5) return;
    const ang = Math.atan2(v, u);
    if (keep && !keep(ang)) return;
    o.c = fc ? c(ang) : c;
    o.a = fa ? a(ang) : a;
  });
}
