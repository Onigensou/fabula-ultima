// ============================================================================
// Soul Tithe FX — the three approved round-end effects (pure: no Foundry, no
// PIXI; bare Node runs them for the tests).
//
// Ported from the user-approved mockup (tools/soul-tithe-fx-mock/mock/fx/
// soul-fx.js, v12), only the picked variants:
//   makeTithe   — Soul Tithe A "Torn out": departure D1 "Burns away", flight
//                 Flame A "Fireball", arrival A1 "Condenses from flame"
//                 (o.merge: it sinks into an existing fragment instead).
//   makeCalling — Calling A "Tether".
//   makeDestroy — Destroyed A "Flamelets home".
// The mock's HUD proposals (HP bar pieces, number pop-ups, the SOUL-TORN chip,
// the lasting grey on the owner) are NOT here: they wait on the user.
//
// Every effect is make(S, o) -> { D, update(dt), layers, state() }.
//   S.owner / S.frag  silhouettes (soul-fx-lib makeSil) in effect px, where the
//                     camera draws them, un-floated.
//   S.bob()           the fragment's float right now, effect px (+ = down).
//   S.ownerBob()      the owner's float right now (Flying hover + bob, idle Float),
//                     effect px (+ = down). Optional; see ownerFloat().
//   layers            [{ id, bounds(), draw(p) }]: each a tight texture of its
//                     own, drawn only while bounds() is not null (the approved
//                     "tight per-effect textures" cutback).
//   state()           what the sprites do now: { owner: { desat },
//                     frag: { show, revealY, hideMesh, flameK, flare, bright } }.
// Everything a silhouette needs (fill distances, crack fields, flamelet seeds,
// flight curves) is computed in make(), never on a beat frame.
// ============================================================================

import { Particles, P, Rng, clamp, ease, rand, smooth, seg, bump, TAU, WHITE, noise2, mix } from "../../battle-director/pixel-entrance/pixelfx/core/index.js";
import { drift } from "../../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";
import {
  SOUL, makeFlight, fireHead, puffField, silFire, insideDist, bfsFrom, rimOf, rowsOf,
  crackle, outlineAt, ghost, ghostCol, bodyLight, aura, noise2v, newBox, growBox, silBox, boxOk, puffBounds,
} from "./soul-fx-lib.js";
import { luma } from "../../battle-director/pixel-entrance/pixelfx/core/index.js";

const C = SOUL;
const lerp = (a, b, t) => a + (b - a) * t;
const qbez = (a, c, b, t) => [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]];
const cub = (a, b, c, d, u) => { const v = 1 - u; return [v * v * v * a[0] + 3 * v * v * u * b[0] + 3 * v * u * u * c[0] + u * u * u * d[0], v * v * v * a[1] + 3 * v * v * u * b[1] + 3 * v * u * u * c[1] + u * u * u * d[1]]; };
const pick = (R, a) => a[Math.floor(R.next() * a.length) % a.length];
const SPARKS = [WHITE, C[6], C[5], C[4]];

function stepParts(list, dt, rise = 160) {
  for (let i = list.length - 1; i >= 0; i--) {
    const q = list[i];
    q.age += dt;
    if (q.age >= q.life) { list.splice(i, 1); continue; }
    if (!q.lin) { q.vy -= rise * dt; q.vx -= q.vx * 4 * dt; q.vy -= q.vy * 2.5 * dt; }
    q.x += q.vx * dt; q.y += q.vy * dt;
  }
}
function psBounds(b, ps) {
  for (const q of ps.list) growBox(b, q.x, q.y, 4 + (q.size ?? 1) * 2);
  return b;
}

// ── Soul Tithe A: Torn out (D1 burns away, Flame A, A1 condenses) ──────────

/**
 * The owner rides its own float (a Flying actor hovers and bobs; an idle Float bobs).
 * H's body (y, chest) is moved IN PLACE to where its sprite is drawn now; its foot
 * stays on the ground (floor light, shadows). Synced once here, so everything make()
 * derives starts at the drawn spot, then on every update. dy() = the shift since make().
 */
function ownerFloat(S) {
  const H = S.owner, y0 = H.y, s0 = H.soul[1];
  const sync = () => { const d = Math.round(Number(S.ownerBob?.()) || 0); H.y = y0 + d; H.soul[1] = s0 + d; return d; };
  const d0 = sync();
  return { sync, dy: () => H.y - y0 - d0 };
}

/** The beats, in seconds from the start of one player's tithe. */
export const TITHE = Object.freeze({
  GRIP: 0.2, TEAR: 0.5, FLY: 0.9, ARRIVE: 1.6,
  /** Fully revealed (the cool front has passed the head). */
  REVEALED: 1.6 + 0.69,
  END: 2.65, END_MERGE: 2.35,
});

export function makeTithe(S, o = {}) {
  const H = S.owner, F = S.frag, R = new Rng(o.seed ?? 21), merge = !!o.merge;
  const hf = ownerFloat(S);
  const { GRIP, TEAR, FLY, ARRIVE } = TITHE, SNAP = TEAR, FLY_T = ARRIVE - FLY;
  const SHOWN = merge ? ARRIVE + 0.24 : ARRIVE + 0.72;
  const D = merge ? TITHE.END_MERGE : TITHE.END;
  const BURN0 = 0.46, BURN1 = 0.78, GATHER = 0.78;
  const psOwner = new Particles({ rng: R, sparks: SPARKS }), psFrag = new Particles({ rng: new Rng((o.seed ?? 21) + 7), sparks: SPARKS });
  const hRim = rimOf(H), fRim = rimOf(F), rows = rowsOf(H);
  // the copy never stops: it strains, is wrenched out, glides on toward the enemy side
  const dirX = F.soul[0] < H.soul[0] ? -1 : 1;
  const GX = 0.941 * dirX, GY = -0.339, WR = 0.34, VG = 70, AG = 520;
  const sPull = (tt) => { if (tt < GRIP) return 0; if (tt < WR) return 6 * Math.pow(seg(tt, GRIP, WR), 2); const u = tt - WR; return 6 + 30 * (1 - Math.exp(-u / 0.06)) + VG * u + 0.5 * AG * u * u; };
  const vPull = (tt) => (sPull(tt + 0.005) - sPull(tt - 0.005)) / 0.01;
  const chest0 = [H.x + H.w / 2, H.soul[1]];
  const chestAt = (tt) => { const q = sPull(tt); return [chest0[0] + GX * q, chest0[1] + hf.dy() + GY * q]; };
  const originAt = (tt) => { const q = sPull(tt); return [Math.round(H.x + GX * q), Math.round(H.y + GY * q)]; };
  const start = chestAt(FLY), end = F.soul;
  const fcx = F.soul[0] - F.x, fcy = F.soul[1] - F.y;
  const midX = lerp(start[0], end[0], 0.5);
  const ctl = [midX, start[1] + ((midX - start[0]) * GY) / GX];
  const dIn = insideDist(F);
  // the fill's distance through the body from the impact point (the chest)
  let sx = Math.round(fcx), sy = Math.round(fcy), bd = 1e9;
  for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) if (F.in(x, y)) { const d = Math.hypot(x - fcx, y - fcy); if (d < bd) { bd = d; sx = x; sy = y; } }
  const geo = bfsFrom(F, [[sx, sy]]);
  let GMAX = 1;
  for (const v of geo) if (v < 1e8) GMAX = Math.max(GMAX, v);
  const fpOwner = [], fpFrag = [];
  let t = 0, snapped = false, arrived = false;
  const bob = () => Math.round(S.bob());
  let PL = 0;
  { let pr = start; for (let i = 1; i <= 40; i++) { const q = qbez(start, ctl, end, i / 40); PL += Math.hypot(q[0] - pr[0], q[1] - pr[1]); pr = q; } }
  const M0 = clamp((vPull(FLY) * FLY_T) / (PL || 1), 0, 2), M1 = 0.9;
  const herm = (q) => (q * q * q - 2 * q * q + q) * M0 + (-2 * q * q * q + 3 * q * q) + (q * q * q - q * q) * M1;
  const flightPath = (tt) => { const q = clamp((tt - FLY) / FLY_T), u = herm(q), [x, y] = qbez(start, ctl, end, u); return [x, y + bob() * u + hf.dy() * (1 - u)]; };
  const flight = makeFlight(flightPath, FLY, ARRIVE, { floorY: (u) => lerp(H.foot[1] + 2, F.foot[1] + 10, u), k0: 1, sinkTo: () => [end[0], end[1] + bob()] });
  const burnFront = (tt) => H.h + 6 - (H.h + 14) * seg(tt, BURN0, BURN1);
  const bodyAlpha = o.bodyAlpha ?? 0.9;
  // the reveal line (effect px, un-floated): nothing above it shows; it climbs from the feet as the fire cools
  const revealAt = (tt) => (tt < ARRIVE + 0.27 ? Infinity : F.y + (F.h + 4 - (F.h + 36) * ease.inOutSine(seg(tt, ARRIVE + 0.27, ARRIVE + 0.69))) - 7);

  const owner = {
    id: "owner",
    bounds() {
      const live = t < Math.max(FLY, TEAR + 0.9) || fpOwner.length || psOwner.count;
      if (!live) return null;
      const b = newBox();
      if (t < TEAR + 0.9) silBox(b, H, 0, 0, 12, 14, 4);
      if (t >= GRIP && t < FLY) {
        const [ox, oy] = originAt(t);
        silBox(b, H, ox - H.x, oy - H.y, 4, 30, 2);
        const [bx, by] = chestAt(t);
        growBox(b, bx, by, 44);
      }
      puffBounds(b, fpOwner); psBounds(b, psOwner);
      return boxOk(b);
    },
    draw(p) {
      crackle(p, H, hRim, smooth(0, GRIP, t) * (1 - seg(t, SNAP, SNAP + 0.3)), t);
      bodyLight(p, H, 0.35 * bump(t, 0.05, SNAP + 0.1));
      // the jagged white tear mark left on her chest
      if (t >= TEAR && t < TEAR + 0.9) {
        const k = 1 - seg(t, TEAR + 0.35, TEAR + 0.9), f = Math.floor(t * 30);
        if (k > 0.5 || f % 2 === 0) {
          const x0 = H.soul[0] + 1, y0 = H.soul[1] - 7;
          for (let i = 0; i < ZIG.length; i++) {
            p.dot(x0 + ZIG[i], y0 + i, i % 5 === 2 ? C[6] : WHITE, k);
            p.dot(x0 + ZIG[i] + 1, y0 + i, C[4], k * 0.8);
          }
          p.glow(x0, y0 + 7, 9, C[5], 0.35 * k);
        }
      }
      // the copy strains, is wrenched out and glides on; strands snap at 0.42 s; afterimages follow
      if (t >= GRIP && t < FLY) {
        const [ox, oy] = originAt(t), k = seg(t, GRIP, WR);
        if (t < 0.42) {
          const f = Math.floor(t * 30);
          for (let y = 4; y < H.h - 8; y += 5) {
            const r = rows[y];
            if (!r || rand(y, f >> 1) < 0.25) continue;
            const x0 = ox + r[0] + Math.round((r[1] - r[0]) * 0.6), y0 = oy + y, x1 = H.x + r[0] + 2, y1 = H.y + y;
            if (Math.abs(x1 - x0) < 3) continue;
            p.line(x0, y0, x1, y1, (u) => (rand(Math.round(u * 40), y, f) < 0.15 ? C[6] : C[4]), 0.95 - 0.5 * k);
          }
        }
        const fadeA = 1 - seg(t, BURN0, BURN0 + 0.2);
        for (let j = 3; j >= 1; j--) { const [ax, ay] = originAt(t - 0.035 * j); if (Math.abs(ax - ox) + Math.abs(ay - oy) > 1) outlineAt(p, H, ax - H.x, j === 1 ? C[5] : C[4], (0.9 - j * 0.2) * fadeA, ay - H.y); }
        if (t < BURN0) ghost(p, H, ox - H.x, 1, oy - H.y);
      }
      // D1: it catches fire from the feet up and burns away in flight
      if (t >= BURN0 && t < FLY && t < BURN1 + 0.02) {
        const front = burnFront(t), [CX, CY] = originAt(t);
        for (let y = 0; y < Math.min(H.h, front + 6); y++) for (let x = 0; x < H.w; x++) if (H.in(x, y) && y < front + noise2v(x, t) * 5) p.px(CX + x, CY + y, ghostCol(luma(H.pixels[y * H.w + x])));
        silFire(p, H, CX, CY, t, (x, y) => { const f = front + noise2v(x, t) * 5; return y >= f - 3 && y < f + 8 ? 0.9 : y >= f + 8 && y < f + 13 ? 0.45 : 0; }, { lift: 26, seed: 5 });
      }
      // the ball forming out of the drawn-in flames, gathering on the move, then launching
      if (t < FLY) {
        const k = ease.outCubic(seg(t, BURN0 + 0.06, GATHER));
        if (k > 0.02) {
          const gather = seg(t, GATHER, FLY), wob = 1 + 0.06 * Math.sin(t * 50), [bx, bY] = chestAt(t);
          fireHead(p, bx, bY, GX, GY, t, k * wob, 2.2, 4.6 * 2.2 * 0.8, 0.3 + 0.7 * seg(t, BURN0 + 0.1, FLY));
          p.glow(bx, bY, 40, C[5], (0.3 + 0.5 * gather) * k);
          p.glow(bx, bY, 12, WHITE, 0.25 * gather * k);
        }
      }
      puffField(p, fpOwner, t);
      psOwner.draw(p);
    },
  };

  const fl = { id: "flight", bounds: () => (flight.live() && t >= FLY - 0.05 ? flight.bounds() : null), draw: (p) => flight.draw(p) };

  const frag = {
    id: "frag",
    bounds() {
      const live = (t >= ARRIVE - 0.04 && t < ARRIVE + (merge ? 0.6 : 0.85)) || fpFrag.length || psFrag.count;
      if (!live) return null;
      const b = newBox();
      if (t >= ARRIVE - 0.04 && t < ARRIVE + 0.85) silBox(b, F, 0, bob(), 52, 52, 8);
      puffBounds(b, fpFrag); psBounds(b, psFrag);
      return boxOk(b);
    },
    draw(p) {
      const by = bob();
      // the body appears from the feet up behind the cooling front (a copy until it is whole; then the token itself)
      if (!merge && t >= ARRIVE + 0.27 && t < TITHE.REVEALED) {
        const ry = revealAt(t);
        for (let y = 0; y < F.h; y++) {
          if (F.y + y < ry) continue;
          for (let x = 0; x < F.w; x++) {
            const i = y * F.w + x;
            if (F.mask[i]) p.blendPx(F.x + x, F.y + y + by, F.pixels ? F.pixels[i] : C[5], bodyAlpha);
          }
        }
      }
      // A1: the ball hits and its fire floods out through the body from that point, then cools from the feet up
      if (!merge && t >= ARRIVE && t < ARRIVE + 0.85) {
        const fill = seg(t, ARRIVE, ARRIVE + 0.3), front = (GMAX + 10) * Math.pow(fill, 0.8), cool = seg(t, ARRIVE + 0.27, ARRIVE + 0.69);
        const coolY = F.h + 4 - (F.h + 36) * ease.inOutSine(cool), breath = 0.88 + 0.12 * Math.sin(t * 46) * Math.sin(t * 17);
        silFire(p, F, F.x, F.y + by, t, (x, y) => {
          const i = y * F.w + x, gj = geo[i] + noise2(x * 0.22, y * 0.22 + t * 24) * 7;
          if (gj > front) return 0;
          const cy2 = coolY + noise2v(x, t) * 6;
          if (y >= cy2) return 0;
          if (front - gj < 7 && fill < 1) return 0.95;
          if (!F.in(x, y - 1) || !F.in(x, y - 2)) return 0.92 * breath;
          const depth = 0.36 + 0.44 * Math.min(1, dIn[i] / 10), dr = 0.7 + 0.42 * noise2(x * 0.12, (y + t * 55) * 0.1, 4);
          return depth * dr * breath * (y > cy2 - 8 ? 0.9 : 1);
        }, { lift: 40 - 18 * cool, seed: 9, cool: seg(t, ARRIVE + 0.5, ARRIVE + 0.8) });
        const sink = seg(t, ARRIVE, ARRIVE + 0.28);
        if (sink < 1) {
          const kb = 1 - ease.inQuad(sink);
          fireHead(p, end[0], end[1] + by, GX, -GY * 0.2 + 0.4, t, kb, 2.2, 4.6 * 2.2 * 0.8, kb * 0.6);
          p.glow(end[0], end[1] + by, 50, C[5], 0.6 * kb);
        }
      } else if (merge && t >= ARRIVE) {
        // merge: its own fire flares; a gentle inner flash and one ring of aura
        const k = 1 - seg(t, ARRIVE, ARRIVE + 0.55);
        bodyLight(p, F, k * k * 0.35, C[6], by);
        aura(p, F, 1 + 2 * k, k, t, by);
        crackle(p, F, fRim, k * 0.8, t, by, 0.5);
      }
      puffField(p, fpFrag, t);
      psFrag.draw(p);
    },
  };

  return {
    D,
    layers: [owner, fl, frag],
    update(dt) {
      t += dt;
      hf.sync();
      flight.update(dt);
      if (t < TEAR && R.chance(dt * 60 * 0.5)) {
        const [x, y] = pick(R, hRim);
        psOwner.spawn(P.MOTE, H.x + x, H.y + y, dirX * R.range(20, 60), -R.range(0, 15), R.range(0.25, 0.45), R.chance(0.5) ? C[5] : C[6], 0.6);
      }
      // D1: the burning band throws flame puffs that are drawn in to its chest, where the ball forms
      if (t >= BURN0 && t < BURN1 + 0.04) {
        const front = burnFront(t), [CX, CY] = originAt(t);
        for (let n = 0; n < 4; n++) if (R.chance((340 * dt) / 4)) {
          const y = Math.round(front + R.range(-1, 9)), x = Math.floor(R.range(0, H.w));
          if (!H.in(x, y)) continue;
          const px = CX + x, py = CY + y, T = R.range(0.14, 0.24), [tx, ty] = chestAt(t + T);
          fpOwner.push({ kind: "puff", lin: true, x: px, y: py, vx: (tx - px) / T, vy: (ty - py) / T, age: 0, life: T, s: R.range(2.4, 4.6), f: R.next() });
        }
      }
      if (!arrived && t >= ARRIVE) {
        const x = end[0], y = end[1] + bob();
        for (let i = 0; i < 16; i++) { const a = R.range(Math.PI, TAU), sp = R.range(40, 120); fpFrag.push({ kind: "puff", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 - 20, age: 0, life: R.range(0.18, 0.34), s: R.range(2.6, 4.8), f: R.next() }); }
      }
      stepParts(fpOwner, dt); stepParts(fpFrag, dt);
      if (!snapped && t >= 0.42) {
        snapped = true;
        const [ox, oy] = originAt(t);
        for (let y = 10; y < H.h - 10; y += 14) { const r = rows[y]; if (!r) continue; const mx = (H.x + r[0] + ox + r[1]) / 2, my = (H.y + oy) / 2 + y; fpOwner.push({ kind: "puff", x: mx, y: my, vx: R.range(-20, 10) * -dirX, vy: -R.range(20, 50), age: 0, life: R.range(0.14, 0.24), s: R.range(1.4, 2.4), f: R.next() }); }
      }
      if (!arrived && t >= ARRIVE) {
        arrived = true;
        if (merge) {
          const [x, y] = end;
          for (let i = 0; i < 18; i++) {
            const a = R.range(0, TAU), d = R.range(18, 34), T = R.range(0.18, 0.3);
            psFrag.spawn(P.MOTE, x + Math.cos(a) * d, y + Math.sin(a) * d * 1.3 + bob(), (-Math.cos(a) * d) / T, (-Math.sin(a) * d * 1.3) / T, T, pick(R, [C[6], C[5]]), 0.8);
          }
        }
      }
      psOwner.update(dt); psFrag.update(dt);
    },
    state() {
      const tearing = t >= TEAR && t < TEAR + 0.25 && Math.floor(t * 30) % 2 === 0;
      const desat = tearing ? 1 : t < TEAR ? 0.35 * seg(t, GRIP, TEAR) : 0.7 * (1 - seg(t, TEAR + 0.15, TEAR + 1.1));
      const newK = ease.inOutSine(seg(t, ARRIVE + 0.5, ARRIVE + 0.9));
      return {
        owner: { desat },
        frag: {
          show: merge ? 1 : t >= ARRIVE ? 1 : 0,
          revealY: merge ? null : revealAt(t),
          // the token stays hidden until the copy above is whole, then takes over on the same frame
          hideMesh: !merge && t < TITHE.REVEALED,
          flameK: merge ? 1 : newK,
          flare: merge ? (t >= ARRIVE ? Math.pow(1 - seg(t, ARRIVE, ARRIVE + 0.7), 1.5) : 0) : newK > 0 ? 0.3 * Math.pow(1 - seg(t, SHOWN, SHOWN + 0.8), 1.5) : 0,
          bright: merge && t >= ARRIVE ? 0.5 * Math.pow(1 - seg(t, ARRIVE, ARRIVE + 0.6), 2) : 0,
        },
      };
    },
  };
}
const ZIG = [0, 1, 0, -1, 0, 1, 1, 0, -1, 0, 1, 0, 0, -1];

// ── Calling A: Tether ───────────────────────────────────────────────────────

export const CALLING = Object.freeze({
  REACH: [0.12, 0.34], PULL: [0.4, 1.7], BEADS: 6, TRAVEL: 0.42, REEL: [1.85, 2.05], END: 2.5,
  /** The first bead lands: when the steal is written. */
  WRITE: 0.4 + 0.42,
});

export function makeCalling(S, o = {}) {
  const H = S.owner, F = S.frag, R = new Rng(o.seed ?? 3);
  const hf = ownerFloat(S);
  const { REACH, PULL, BEADS: NB, TRAVEL, REEL } = CALLING, D = CALLING.END;
  const ps = new Particles({ rng: R, sparks: SPARKS });
  const fRim = rimOf(F), hRim = rimOf(H);
  const beads = Array.from({ length: NB }, (_, i) => ({ t0: PULL[0] + (i * (PULL[1] - PULL[0] - TRAVEL)) / (NB - 1) }));
  const side = H.soul[0] >= F.soul[0] ? 1 : -1;
  let t = 0, swallowed = false;
  const bob = () => Math.round(S.bob());
  const A = () => [H.soul[0] - 2 * side, H.soul[1]], B = () => [F.soul[0] + 6 * side, F.soul[1] + bob()];
  const at = (s, strand) => {
    const [ax, ay] = A(), [bx, by] = B(), L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L, ny = (bx - ax) / L;
    const tension = bump(t, PULL[0] - 0.1, PULL[1] + 0.2);
    const amp = (2 + 3 * tension) * Math.sin(Math.PI * s);
    const w = amp * Math.sin(TAU * (s * 6 - t * 2.2) + strand * Math.PI);
    const sag = Math.sin(Math.PI * s) * (14 - 8 * tension);
    return [lerp(ax, bx, s) + nx * w, lerp(ay, by, s) + ny * w + sag];
  };
  const arrivedBeads = () => beads.filter((b) => t >= b.t0 + TRAVEL).length;
  const tether = {
    id: "tether",
    bounds() {
      if (t >= D && !ps.count) return null;
      const b = newBox(), [ax, ay] = A(), [bx, by] = B();
      growBox(b, ax, ay, 18); growBox(b, bx, by, 36);
      growBox(b, (ax + bx) / 2, (ay + by) / 2 + 14, 22);
      silBox(b, H, 0, 0, 3, 3, 3); silBox(b, F, 0, bob(), 6, 6, 6);
      return psBounds(b, ps);
    },
    draw(p) {
      const by = bob();
      let s0 = 0;
      if (t < REACH[0]) s0 = 1;
      else if (t < REACH[1]) s0 = 1 - ease.outQuart(seg(t, REACH[0], REACH[1]));
      if (t >= REEL[0]) s0 = ease.inCubic(seg(t, REEL[0], REEL[1]));
      if (s0 < 1) {
        const [ax, ay] = A(), [bx, byy] = B(), L = Math.hypot(bx - ax, byy - ay), n = Math.ceil(L);
        for (let i = Math.floor(s0 * n); i <= n; i++) {
          const s = i / n, [x1, y1] = at(s, 0), [x2, y2] = at(s, 1);
          const front = Math.sin(TAU * (s * 6 - t * 2.2)) > 0;
          p.dot(x2, y2, front ? C[4] : C[6], 1);
          p.dot(x1, y1, front ? C[6] : C[4], 1);
          if (i % 3 === 0) p.light(x1, y1, C[5], 0.35);
        }
        for (let i = Math.floor(s0 * 12); i < 12; i++) {
          const [xa, ya] = at(i / 12, 0), [xb, yb] = at((i + 1) / 12, 0);
          p.glowLine(xa, ya, xb, yb, 7, C[5], 0.18);
        }
        if (s0 < 0.02) {
          const [hx, hy] = at(0, 0);
          p.circle(hx, hy, 2.2, C[5]); p.dot(hx, hy, WHITE); p.glow(hx, hy, 12, C[5], 0.5);
        }
        const [tx, ty] = at(s0, 0);
        p.circle(tx, ty, 1.8, C[6]); p.glow(tx, ty, 8, C[5], 0.5);
      }
      const latched = t >= REACH[1] && t < REEL[0];
      let pulseH = 0, pulseF = 0;
      for (const b of beads) {
        pulseH = Math.max(pulseH, 1 - clamp(Math.abs(t - b.t0) / 0.12));
        pulseF = Math.max(pulseF, 1 - clamp(Math.abs(t - b.t0 - TRAVEL) / 0.12));
      }
      crackle(p, H, hRim, latched ? 0.35 + 0.5 * pulseH : 0, t, 0, 0.2);
      bodyLight(p, H, 0.3 * pulseH);
      for (const b of beads) {
        const u = (t - b.t0) / TRAVEL;
        if (u < 0 || u > 1) continue;
        const s = ease.inOutSine(u);
        const [x, y] = at(s, 0), [x2, y2] = at(Math.max(0, s - 0.03), 0), [x3, y3] = at(Math.max(0, s - 0.06), 0);
        p.circle(x3, y3, 1.8, C[4]); p.circle(x2, y2, 2.6, C[5]); p.circle(x, y, 3.4, C[5]); p.circle(x, y, 2.4, C[6]);
        p.dot(x, y, WHITE); p.dot(x - side, y, WHITE);
        p.glow(x, y, 16, C[5], 0.6);
      }
      const got = arrivedBeads() / NB, settle = 1 - seg(t, REEL[1], REEL[1] + 0.45);
      aura(p, F, (0.5 + 2.5 * got) * settle, (0.4 + 0.6 * got) * settle, t, by);
      crackle(p, F, fRim, 0.8 * pulseF, t, by, 0.6);
      bodyLight(p, F, 0.25 * pulseF + 0.15 * got * settle, C[6], by);
      if (t >= REEL[1] && t < REEL[1] + 0.25) {
        const k = 1 - seg(t, REEL[1], REEL[1] + 0.25), [x, y] = B();
        p.glowRing(x - 6 * side, y, 14 + 18 * (1 - k), 4, C[5], 0.5 * k);
        bodyLight(p, F, 0.6 * k, C[6], by);
      }
      ps.draw(p);
    },
  };
  return {
    D,
    layers: [tether],
    update(dt) {
      t += dt;
      hf.sync();
      for (const b of beads)
        if (!b.left && t >= b.t0) {
          b.left = true;
          for (let i = 0; i < 6; i++) {
            const [x, y] = pick(R, hRim), [ax, ay] = A();
            ps.spawn(P.MOTE, H.x + x, H.y + y, (ax - H.x - x) * 2.5, (ay - H.y - y) * 2.5, R.range(0.15, 0.25), C[5], 0.6);
          }
        }
      if (!swallowed && t >= REEL[1]) {
        swallowed = true;
        const [x, y] = B();
        for (let i = 0; i < 16; i++) {
          const a = R.range(0, TAU), d = R.range(20, 36), T = R.range(0.16, 0.28);
          ps.spawn(P.MOTE, x + Math.cos(a) * d, y + Math.sin(a) * d * 1.4, (-Math.cos(a) * d) / T, (-Math.sin(a) * d * 1.4) / T, T, pick(R, [C[6], C[5]]), 0.8);
        }
      }
      ps.update(dt);
    },
    state() {
      const got = arrivedBeads() / NB;
      return {
        owner: { desat: 0.45 * bump(t, PULL[0] - 0.1, REEL[1]) },
        frag: {
          show: 1, flameK: 1,
          bright: 0.35 * got * (1 - seg(t, REEL[1] + 0.1, REEL[1] + 0.5)) + 0.08 * got * (1 - seg(t, D - 0.3, D)),
          flare: Math.max(0.2 * got * (1 - seg(t, REEL[1], REEL[1] + 0.6)), ...beads.map((b) => 0.75 * (1 - clamp(Math.abs(t - b.t0 - TRAVEL) / 0.16))), t >= REEL[1] ? Math.pow(1 - seg(t, REEL[1], REEL[1] + 0.6), 1.3) : 0),
        },
      };
    },
  };
}

// ── Destroyed A: Flamelets home ─────────────────────────────────────────────

const DESTROY_SEED = 51, NLETS = 7;

/** The flamelets' own dice, in the order the mock drew them (silhouette-independent). */
function planFlamelets(R) {
  const out = [];
  for (let i = 0; i < NLETS; i++) {
    const sp = R.range(90, 150);
    out.push({ sp, jx: R.range(-20, 20), jy: R.range(50, 90), T: R.range(0.56, 0.68), apex: R.range(50, 150), side: R.range(-30, 40), tx: R.range(-7, 7), ty: R.range(-22, 18), n: i, ord: R.next() });
  }
  return out.sort((a, b) => a.ord - b.ord).map((l, i) => ({ ...l, home: 0.6 + i * 0.065 }));
}

/** When the flamelets land on the owner: FIRST (the refund is written then) and LAST; END the whole effect. */
export const DESTROY = (() => {
  const L = planFlamelets(new Rng(DESTROY_SEED)), arr = L.map((l) => l.home + l.T);
  const FIRST = Math.min(...arr), LAST = Math.max(...arr);
  return Object.freeze({ HIT: 0.06, BURST: 0.42, FIRST, LAST, END: LAST + 0.8 });
})();

export function makeDestroy(S, o = {}) {
  const H = S.owner, F = S.frag, R = new Rng(DESTROY_SEED);
  const hf = ownerFloat(S);
  const HIT = 0.06, CRACK = [0.06, 0.3], BURN = [0.28, 0.46], BURST = 0.42;
  const fcx = F.soul[0] - F.x, fcy = F.soul[1] - F.y;
  const hRim = rimOf(H), side = H.soul[0] >= F.soul[0] ? 1 : -1;
  const cracks = [], Rc = new Rng(9);
  for (let k = 0; k < 7; k++) {
    let a = (k / 7) * TAU + Rc.range(-0.3, 0.3), x = fcx, y = fcy;
    const pts = [];
    for (let i = 0; i < 46; i++) {
      a += Rc.range(-0.5, 0.5); x += Math.cos(a) * 1.2; y += Math.sin(a) * 1.6;
      if (!F.in(Math.round(x), Math.round(y))) break;
      pts.push([Math.round(x), Math.round(y), i / 46]);
    }
    cracks.push(pts);
  }
  const dCrack = bfsFrom(F, [[Math.round(fcx), Math.round(fcy)], ...cracks.flat().map(([x, y]) => [x, y])]);
  let DCMAX = 1;
  for (const v of dCrack) if (v < 1e8) DCMAX = Math.max(DCMAX, v);
  const pix = [];
  for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) if (F.in(x, y)) pix.push([x, y]);
  if (!pix.length) pix.push([Math.round(fcx), Math.round(fcy)]);
  const seeds = [[fcx, fcy]];
  while (seeds.length < NLETS) {
    let best = pix[0], bd = -1;
    for (let i = 0; i < pix.length; i += 3) { const [x, y] = pix[i]; let d = 1e9; for (const s of seeds) d = Math.min(d, Math.hypot(x - s[0], (y - s[1]) * 0.8)); if (d > bd) { bd = d; best = pix[i]; } }
    seeds.push(best);
  }
  const dSeed = bfsFrom(F, seeds.map(([x, y]) => [Math.round(x), Math.round(y)])), dInF = insideDist(F);
  const hc = [H.soul[0], H.soul[1] + 4];
  const plan = planFlamelets(new Rng(DESTROY_SEED));
  const lets = plan.map((q) => {
    const [sx, sy] = seeds[q.n], x0 = F.x + sx, y0 = F.y + sy, dx = sx - fcx, dy = sy - fcy, d = Math.hypot(dx, dy) || 1;
    return { x0, y0, vx: (dx / d) * q.sp * 0.8 + q.jx, vy: (dy / d) * q.sp * 0.6 - q.jy, T: q.T, apex: q.apex, side: q.side, tgt: [hc[0] + q.tx, hc[1] + q.ty], n: q.n, home: q.home };
  });
  const exAt = (l, tt) => drift(l.x0, l.y0, l.vx, l.vy, Math.max(0, tt - BURST), 0, -40, 3.2, 3.2);
  for (const l of lets) {
    const [x, y, vx, vy] = exAt(l, l.home);
    l.p0 = [x, y]; l.p1 = [x + (vx * l.T) / 3, y + (vy * l.T) / 3];
    l.p2 = [l.tgt[0] - 60 * side + l.side * side, Math.min(y, l.tgt[1]) - l.apex]; l.p3 = l.tgt; l.arrive = l.home + l.T;
  }
  const posAt = (l, tt) => {
    if (tt < l.home) return exAt(l, tt);
    const u = clamp((tt - l.home) / l.T), [x, y] = cub(l.p0, l.p1, l.p2, l.p3, u), [x2, y2] = cub(l.p0, l.p1, l.p2, l.p3, Math.min(1, u + 0.02));
    // the target is the owner's chest where it is drawn now
    const dy = hf.dy() * u;
    return [x, y + dy, (x2 - x) / (0.02 * l.T), (y2 - y) / (0.02 * l.T)];
  };
  const FIRST = Math.min(...lets.map((l) => l.arrive)), LAST = Math.max(...lets.map((l) => l.arrive)), D = LAST + 0.8;
  const fpFrag = [], fpLets = [];
  let t = 0;
  const bob = () => Math.round(S.bob());
  const frontAt = (tt) => (DCMAX + 8) * seg(tt, BURN[0], BURN[1]);
  const mixc = (c, d, k) => { const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255; return ((255 << 24) | ((b + (((d >>> 16) & 255) - b) * k) << 16) | ((g + (((d >>> 8) & 255) - g) * k) << 8) | (r + ((d & 255) - r) * k)) >>> 0; };
  const bodyAlpha = o.bodyAlpha ?? 0.9;

  const fragL = {
    id: "frag",
    bounds() {
      if (t >= BURST + 0.3 && !fpFrag.length) return null;
      const b = newBox();
      if (t < BURST + 0.3) silBox(b, F, 0, bob(), 34, 44, 4);
      return boxOk(puffBounds(b, fpFrag));
    },
    draw(p) {
      const by = bob();
      // the body itself: the real token is hidden from the hit on; this copy flashes, jolts and is eaten
      if (t < BURST + 0.3) {
        const bright = 0.6 * bump(t, 0, 0.2) + 0.35 * seg(t, CRACK[0], BURN[0]), front = frontAt(t);
        const jx = t >= HIT && t < BURN[0] ? Math.round(Math.sin(t * 90)) : 0;
        for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
          const i = y * F.w + x;
          if (!F.mask[i]) continue;
          if (t >= BURN[0] && (dCrack[i] <= front || front > DCMAX)) continue;
          const c = F.pixels ? F.pixels[i] : C[5];
          p.blendPx(F.x + x + jx, F.y + y + by, bright > 0.004 ? mixc(c, C[6], Math.min(1, bright)) : c, bodyAlpha);
        }
      }
      if (t >= CRACK[0] && t < BURN[1]) {
        const g = ease.outCubic(seg(t, CRACK[0], CRACK[1])), fade = 1 - seg(t, BURN[0] + 0.06, BURN[1]), front = frontAt(t);
        for (const pts of cracks) for (const [x, y, u] of pts) { if (u > g) break; if (dCrack[y * F.w + x] <= front && t > BURN[0]) continue; p.px(F.x + x, F.y + y + by, u > g - 0.12 ? WHITE : C[6]); p.light(F.x + x, F.y + y + by, C[5], 0.25 * fade); }
        p.glow(F.soul[0], F.soul[1] + by, 30 + 30 * g, C[5], 0.4 * g * fade);
      }
      if (t >= BURN[0] && t < BURST + 0.24) {
        const front = frontAt(t), out = seg(t, BURST, BURST + 0.22), keep = 70 * (1 - ease.inQuad(out));
        silFire(p, F, F.x, F.y + by, t, (x, y) => {
          const i = y * F.w + x, d = dCrack[i];
          if (d > front || dSeed[i] > keep) return 0;
          if (front - d < 7 && t < BURN[1]) return 0.95;
          const depth = 0.4 + 0.42 * Math.min(1, dInF[i] / 10), dr = 0.72 + 0.4 * noise2(x * 0.12, (y + t * 55) * 0.1, 6);
          return depth * dr * (1 - 0.5 * out) * (0.6 + 0.4 * (1 - dSeed[i] / Math.max(1, keep)));
        }, { lift: 28, seed: 21 });
      }
      puffField(p, fpFrag, t);
    },
  };
  const letsL = {
    id: "lets",
    bounds() {
      const b = newBox();
      if (t >= BURST - 0.04) for (const l of lets) {
        if (t >= l.arrive + 0.08) continue;
        const [x, y] = posAt(l, Math.min(t, l.arrive));
        growBox(b, x, y + (t < l.home ? bob() : 0), 28);
      }
      return boxOk(puffBounds(b, fpLets));
    },
    draw(p) {
      const by = bob();
      for (const l of lets) {
        if (t < BURST - 0.04) continue;
        const sink = seg(t, l.arrive, l.arrive + 0.08);
        if (sink >= 1) continue;
        const [x, y, vx, vy] = posAt(l, Math.min(t, l.arrive));
        const k = ease.outCubic(seg(t, BURST - 0.04, BURST + 0.1)) * (1 - ease.inQuad(sink));
        fireHead(p, x, y + (t < l.home ? by * (1 - seg(t, BURST, l.home)) : 0), vx || 0.01, vy || -1, t + l.n, k, 1.5, 4.6 * 1.5 * 0.85, 0.9);
        p.glow(x, y, 22, C[5], 0.4 * k);
      }
      puffField(p, fpLets, t);
    },
  };
  const ownerL = {
    id: "owner",
    bounds() {
      if (t < FIRST - 0.05 || t > D) return null;
      return silBox(newBox(), H, 0, 0, 42, 42, 20);
    },
    draw(p) {
      let pulse = 0;
      for (const l of lets) pulse = Math.max(pulse, bump(t, l.arrive - 0.02, l.arrive + 0.22));
      crackle(p, H, hRim, 0.7 * pulse, t, 0, 0.3);
      bodyLight(p, H, 0.14 * pulse + 0.16 * bump(t, LAST, LAST + 0.7));
      if (t >= FIRST) p.glow(hc[0], hc[1] + hf.dy(), 40, C[5], 0.25 * pulse);
    },
  };
  return {
    D, FIRST, LAST,
    layers: [fragL, ownerL, letsL],
    update(dt) {
      t += dt;
      hf.sync();
      for (const l of lets) {
        if (t < BURST + 0.03 || t >= l.arrive) continue;
        for (let n = 0; n < 2; n++) if (R.chance(80 * dt)) { const [x, y, vx, vy] = posAt(l, t - n * dt * 0.5); fpLets.push({ kind: "puff", x: x + R.range(-1.5, 1.5), y: y + R.range(-1.5, 1.5), vx: vx * 0.15 + R.range(-6, 6), vy: vy * 0.15 - R.range(0, 10), age: 0, life: R.range(0.16, 0.3), s: R.range(2.2, 3.6), f: R.next() }); }
        if (!l.sunk && t >= l.arrive - dt * 1.5) {
          l.sunk = true;
          for (let i = 0; i < 6; i++) { const a = R.range(0, TAU), d = R.range(8, 16), T = R.range(0.1, 0.16); fpLets.push({ kind: "puff", lin: true, x: l.tgt[0] + Math.cos(a) * d, y: l.tgt[1] + Math.sin(a) * d * 1.3, vx: (-Math.cos(a) * d) / T, vy: (-Math.sin(a) * d * 1.3) / T, age: 0, life: T, s: R.range(1.2, 2), f: R.next() }); }
        }
      }
      if (t >= BURN[0] && t < BURN[1]) {
        const front = frontAt(t);
        for (let n = 0; n < 3; n++) if (R.chance((220 * dt) / 3)) { const [x, y] = pix[Math.floor(R.next() * pix.length)]; if (Math.abs(dCrack[y * F.w + x] - front) < 6) fpFrag.push({ kind: "puff", x: F.x + x, y: F.y + y + bob(), vx: R.range(-15, 15), vy: -R.range(20, 50), age: 0, life: R.range(0.14, 0.26), s: R.range(1.8, 3.2), f: R.next() }); }
      }
      stepParts(fpFrag, dt, 140); stepParts(fpLets, dt, 140);
    },
    state() {
      return {
        owner: { desat: 0 },
        frag: {
          show: 1, hideMesh: true,
          flameK: 1 - ease.inQuad(seg(t, BURN[0], BURST + 0.12)),
          flare: t < BURST + 0.12 ? 0.9 * bump(t, 0, BURST + 0.12) : 0,
          bright: 0,
        },
      };
    },
  };
}
