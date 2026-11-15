// ── Gryphon · Zero Power: Downburst (shot) ──────────────────────────────────────
// Port of the approved legacy-boss mockup (r2 "Rush past" version): the shipped full-body cut-in
// (his cut_in_zero_power art, pixel art drawn crisp), he rises in his feather outburst with four wing
// beats, wind gathers while he pulls back, then he rushes past the whole party formation at low height.
// His wake hits each PC as he passes; anyone Flying at cast time is spun in the wake and slammed to the
// ground (the skill strips Flying). He swoops home from the far side; the damage gate is on his landing.
// LIVE board: the camera is never touched. Every number is in cfg (mockup px on a 1682 px stage, x KP).
// No backticks in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
if (!caster) { oni.fireDone(); return; }

// Flying at cast time: the game's own predicate (sprite-shadow airborne = battle-director targetIsFlying),
// else the same rule by hand (an enabled "Flying" AE / status, unless a flying_grounded change is on).
const AIR = (() => { try { return globalThis.FUCompanion.api.spriteShadow.airborne || null; } catch (e) { return null; } })();
const isFlying = (t) => {
  try { if (AIR && typeof AIR.isAirborne === 'function') return !!AIR.isAirborne(t); } catch (e) {}
  try { const a = t.actor; if (!a) return false; const effs = a.appliedEffects || (a.effects && a.effects.contents) || [];
    for (const ae of effs) if (ae && !ae.disabled && (ae.changes || []).some((c) => c && c.key === 'flying_grounded')) return false;
    if (a.statuses && a.statuses.has && a.statuses.has('flying')) return true;
    return effs.some((e) => e && !e.disabled && String(e.name || '').trim().toLowerCase() === 'flying'); } catch (e) { return false; }
};

const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [], FLYERS = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; if (isFlying(t)) FLYERS.push(k); });
if (!FOES.length) { oni.fireDone(); return; }
let cutUrl = A.cutin;
try { const p = caster.actor && caster.actor.system && caster.actor.system.props; const u = p ? String(p.cut_in_zero_power || '').trim() : ''; if (u) cutUrl = u; } catch (e) {}

const CL = A.clips || {};
const tl = oni.timeline({ tokens, clips: CL, images: { cut: cutUrl }, live: true, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet;
const KP = (tl.STAGE.w || 1682) / 1682;
const T = [], sfx = [];
const m = tl.mk(T);
const G = GK.make(tl, m, KP, cfg.seed || 4410);
const S_ = (at, url, v) => { if (url) sfx.push({ at, url, v: v * cfg.volume }); };
const clipW = (key, scale) => CL[key].w * CL[key].k * scale * KP;
const K = TOK.k, kf = feet(K);
const avg = (f) => FOES.reduce((s, k) => s + f(k), 0) / FOES.length;
const DIR = avg((k) => TOK[k].x) >= K.x ? 1 : -1;

// ── the beat clock (mockup beats run back to back) ──
const C = cfg;
const CUT = 0;
const RISE = CUT + C.cutIn + C.cutHold + C.cutOut;   // 650 + 850 + 650
const FLAPS = 4 * (C.flapDown + C.flapUp);
const GATH = RISE + Math.max(C.rise, FLAPS);
const RUSH = GATH + C.gather;
const TURB = RUSH + C.rush;
const HASFLY = FLYERS.length > 0;
const SPUN = TURB + C.spin, SLAM = SPUN + C.drop;
const TEND = HASFLY ? SLAM + C.bounceUp + C.bounceDown : TURB + 400;
const SWOOP = TEND, GATE = SWOOP + C.swoop, total = GATE + 300;

// ── where he goes: pull back, rush past to beyond the far side of the formation, swoop in from his own side ──
const view = tl.camView({});
const LIFT = C.lift * KP, LOW = C.rushLift * KP;
const x0 = kf.x - DIR * C.pullBack * KP;
const farX = DIR > 0 ? Math.max.apply(null, FOES.map((k) => feet(TOK[k]).x)) : Math.min.apply(null, FOES.map((k) => feet(TOK[k]).x));
const x1 = DIR > 0 ? Math.max(farX + K.w, view.right + K.w * 0.6) : Math.min(farX - K.w, view.left - K.w * 0.6);
const y1 = avg((k) => feet(TOK[k]).y);
const xs = DIR > 0 ? Math.min(view.left - K.w * 0.6, kf.x - K.w * 1.5) : Math.max(view.right + K.w * 0.6, kf.x + K.w * 1.5);
const ys = kf.y - C.swoopUp * KP;

// his pose at time t (null = untouched: the real token)
const pose = (t) => {
  if (t < RISE || t >= GATE) return null;
  const o = { dx: 0, dy: 0, air: 0, sx: 1, sy: 1, alpha: 1 };
  if (t < GATH) {
    o.air = LIFT * E.outC(seg(t, RISE, RISE + C.rise));
    const e = t - RISE, cyc = C.flapDown + C.flapUp;
    if (e < FLAPS) { const i = Math.floor(e / cyc), p = e - i * cyc; const from = i === 0 ? [1, 1] : [1, 1.05];
      if (p < C.flapDown) { const u = E.outQ(p / C.flapDown); o.sx = lerp(from[0], 1.06, u); o.sy = lerp(from[1], 0.9, u); }
      else { const u = E.outQ((p - C.flapDown) / C.flapUp); o.sx = lerp(1.06, 1, u); o.sy = lerp(0.9, 1.05, u); } }
    else o.sy = 1.05;
  } else if (t < RUSH) {
    o.air = LIFT; o.dx = -DIR * C.pullBack * KP * E.sine(seg(t, GATH, RUSH)); o.sy = lerp(1.05, 1, E.sine(seg(t, GATH, RUSH)));
  } else if (t < TURB) {
    const e = E.inQ(seg(t, RUSH, TURB)); o.dx = lerp(x0, x1, e) - kf.x; o.dy = lerp(kf.y, y1, e) - kf.y;
    o.air = lerp(LIFT, LOW, E.outQ(seg(t, RUSH, RUSH + C.rush * 0.4)));
  } else if (t < SWOOP) { o.alpha = 0; }
  else { const u = seg(t, SWOOP, GATE), e = E.outC(u); o.dx = lerp(xs, kf.x, e) - kf.x; o.dy = lerp(ys, kf.y, e) - kf.y; o.air = C.swoopLift * KP * (1 - E.sine(u)); }
  return o;
};
m.hold(RISE, GATE, (e, S) => { const o = pose(e + RISE); if (!o) return; const q = S.tok.k; q.dx += o.dx; q.dy += o.dy; q.air += o.air; q.sx *= o.sx; q.sy *= o.sy; q.alpha *= o.alpha; if (o.alpha <= 0) q.hidden = true; });
const bodyAt = (t) => { const o = pose(t) || { dx: 0, dy: 0, air: 0 }; return { x: kf.x + o.dx, y: kf.y + o.dy - o.air - K.h * 0.5 }; };

// ── 1. Cut-in: the shipped Zero Power cut-in with his portrait (pixel art: no smoothing while it draws) ──
S_(CUT, A.sfx.overdrive, 0.9);
m.hold(CUT, RISE, (e, S) => { S.screen.push({ draw: (g) => { g.imageSmoothingEnabled = false; } }); });
ZP.cutin(tl, m, CUT, 'cut', { slideIn: C.cutIn, hold: C.cutHold, slideOut: C.cutOut });
m.hold(CUT, RISE, (e, S) => { S.screen.push({ draw: (g) => { g.imageSmoothingEnabled = true; } }); });

// ── 2. Rise: scene dim, wing beats, feather outburst ──
m.dim(RISE, 500, C.dim);
S_(RISE, A.sfx.flash2, 0.5);
{ const b = bodyAt(RISE); m.clip('jb_feathers', RISE, { x: b.x, y: b.y, w: clipW('jb_feathers', 2.2), z: 30 }); }

// ── 3. Wind gathers: wisps pull in, he pulls back to launch ──
S_(GATH, A.sfx.wind4, 0.5);
G.rumble(GATH, RUSH, 2);
G.wisps(GATH, bodyAt(GATH), { n: 24, ms: C.gather * 0.8 });

// ── 4. Rush past: low dash through the formation; the wake hits each PC as he passes ──
S_(RUSH, A.sfx.wind1, 0.7); S_(RUSH, A.sfx.shukuchi, 0.5);
G.speedLines(RUSH, TURB, { angle: DIR > 0 ? 0 : Math.PI, alpha: 0.45, color: '230,255,240' });
// ghosts every 6 % of the (eased) dash; a gust trail every other one
for (let i = 1; i * 0.06 < 1; i++) {
  const at = RUSH + C.rush * Math.sqrt(i * 0.06); const o = pose(at);
  G.ghost(at, 'k', o, { ms: 260, opacity: 0.45 });
  if (i % C.gustEvery === 0) { const p = { x: kf.x + o.dx - DIR * 40 * KP, y: kf.y + o.dy - o.air - K.h * 0.4 }; m.clip('jb_gust', at, { x: p.x, y: p.y, w: clipW('jb_gust', 0.9), z: 20, rot: DIR > 0 ? Math.PI : 0, alpha: () => 0.7 }); }
}
for (const k of FOES) {
  const xt = feet(TOK[k]).x - DIR * 30 * KP; const ex = (xt - x0) / (x1 - x0); const at = RUSH + C.rush * Math.sqrt(Math.max(0, Math.min(1, ex)));
  const s = G.s(k);
  G.ring(at, G.feet(k), { rgb: '220,255,235', r1: 130, s });
  G.dust(at, G.feet(k), { n: 10, s });
  G.wisps(at, G.center(k), { n: 8, r: 80, ms: 300 });
  m.shake(at, 200, 8);
  if (FLYERS.indexOf(k) < 0) { G.hit(at, k, 'normal', true, true); S_(at, A.sfx.damage5, 0.35);
    // painted (with its hover) while he crosses the floor and through its flinch, so the bodies sort together
    const h = G.hover(k); m.hold(RUSH, Math.max(TURB, at + 900), (e, S) => { const q = S.tok[k]; q.alpha *= 0.999; q.air += h; }); }
  else G.hit(at, k, 'normal', false, true);       // the flyer only flinches here; its hit is the slam (its own track lifts it)
}

// ── 5. Turbulence: the wake lingers; a flyer is spun and slammed to the ground ──
S_(TURB, A.sfx.wind4, 0.45);
G.rumble(TURB, TEND, 3);
for (const k of FOES) G.wisps(TURB, G.center(k), { n: 6, r: 90, ms: 500 });
const SPIN_LIFT = C.spinLift * KP;
for (const k of FLYERS) {
  const Tk = TOK[k], d = Tk.h * 0.45, base = G.hover(k);
  // painted from the first wake hit: its hover until the spin, the spin + lift, the drop, the bounce, then grounded to the end
  m.hold(RUSH, total, (e, S) => { const t = e + RUSH; const q = S.tok[k]; let air = base, rot = 0;
    if (t >= TURB && t < SPUN) { const u = seg(t, TURB, SPUN); air = lerp(base, SPIN_LIFT, E.outC(u)); rot = E.outQ(u) * C.spinDeg * Math.PI / 180 * DIR; }
    else if (t >= SPUN && t < SLAM) air = SPIN_LIFT * (1 - E.inC(seg(t, SPUN, SLAM)));
    else if (t >= SLAM && t < SLAM + C.bounceUp) air = C.bounce * KP * E.outQ(seg(t, SLAM, SLAM + C.bounceUp));
    else if (t >= SLAM + C.bounceUp && t < TEND) air = C.bounce * KP * (1 - E.inQ(seg(t, SLAM + C.bounceUp, TEND)));
    else if (t >= SLAM) air = 0;
    // the spin turns round the body's middle (the painter rotates round the feet)
    if (rot) { q.dx += -d * Math.sin(rot); air += d * (1 - Math.cos(rot)); q.rot += rot; }
    q.air += air; q.alpha *= 0.999; });
  const f = G.feet(k), s = G.s(k);
  S_(SLAM, A.sfx.blowL, 0.6); S_(SLAM, A.sfx.land, 0.5); m.shake(SLAM, 380, 16);
  G.dust(SLAM, f, { n: 18, s: s * 1.3 }); G.ring(SLAM, f, { r1: 170, w: 9, s }); G.crack(SLAM, f, s);
  G.hit(SLAM, k, 'strong', true, true);
}

// ── 6. Swoop home: back in from his own side, high, gliding down to his spot; the damage gate on landing ──
S_(SWOOP, A.sfx.wind7, 0.5);
m.undim(SWOOP, 700, C.dim);

ZP.once(m, GATE, () => oni.fireDone());
await tl.run(T, { total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
