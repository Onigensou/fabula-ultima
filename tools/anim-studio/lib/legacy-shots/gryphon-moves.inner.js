// ── Gryphon · filler moves (shot) ───────────────────────────────────────────────
// Port of the approved legacy-boss mockup: Talon, Razor Plume, Airdrop, Air Blast, Aerial Shockwave,
// Turbulence Wind, Wind Wall. cfg.move picks one. LIVE board: the camera is never touched, only the
// bodies a beat moves are painted. Each move fires the damage gate where the mockup marks it.
// Every number is in cfg (mockup px on a 1682 px stage, x KP). No backticks in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
if (!caster) { oni.fireDone(); return; }
const MOVE = cfg.move;
const NEEDS = { talon: 1, razorplume: 1, airdrop: 1, airblast: 1, aerialshock: 1, turbulence: 1, windwall: 0 };
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
targets.slice(0, cfg.maxTargets || 8).forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
if (NEEDS[MOVE] && !FOES.length) { oni.fireDone(); return; }
const CL = A.clips || {};
const tl = oni.timeline({ tokens, clips: CL, live: true, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet;
const KP = (tl.STAGE.w || 1682) / 1682;
const T = [], sfx = [];
const m = tl.mk(T);
const G = GK.make(tl, m, KP, cfg.seed || 1170);
const rnd = G.rnd;
const S_ = (at, url, v) => { if (url) sfx.push({ at, url, v: v * cfg.volume }); };
const clipW = (key, scale) => CL[key].w * CL[key].k * scale * KP;
const K = TOK.k, kf = feet(K);
const DIR = FOES.length ? (TOK[FOES[0]].x >= K.x ? 1 : -1) : (K.x <= tl.STAGE.x + tl.STAGE.w / 2 ? 1 : -1);
// his "hand" (where wind and darts leave him): ahead of his middle, 62 % up his body
const hand = (air) => ({ x: kf.x + DIR * K.w * 0.3, y: kf.y - (air || 0) - K.h * 0.62 });
// a point in front of a target, on his side
const front = (k, gap) => { const f = feet(TOK[k]); return { x: f.x - DIR * gap * G.s(k), y: f.y }; };
// his body track: fn(t) -> { dx, dy, air, sx, sy } or null (untouched)
const body = (t0, t1, fn) => m.hold(t0, t1, (e, S) => { const o = fn(e + t0); if (!o) return; const q = S.tok.k; q.dx += o.dx || 0; q.dy += o.dy || 0; q.air += o.air || 0; q.sx *= o.sx || 1; q.sy *= o.sy || 1; });
const squash = (t, a, ms, from, to) => { const u = E.outQ(seg(t, a, a + ms)); return [lerp(from[0], to[0], u), lerp(from[1], to[1], u)]; };
// a move along the floor from p0 to p1 with an optional hop (mockup moveActor)
const walk = (t, a, ms, p0, p1, ease, hop) => { const u = seg(t, a, a + ms), e = ease(u); return { dx: lerp(p0.x, p1.x, e) - kf.x, dy: lerp(p0.y, p1.y, e) - kf.y, air: Math.sin(e * Math.PI) * (hop || 0) * KP }; };
const HOME = { x: kf.x, y: kf.y };
let total = 0, gate = 0;

if (MOVE === 'talon') {
  // ── Talon: a short hopping lunge, a three-claw rake, back ──
  const tk = FOES[0], c = G.center(tk), s = G.s(tk), Tk = TOK[tk], tf = feet(Tk);
  const DEST = front(tk, cfg.talonGap);
  const L = cfg.lunge, RAKE = L, HIT = RAKE + 3 * 70, BACK = HIT + 300;
  total = BACK + cfg.back; gate = HIT;
  body(0, total, (t) => { if (t < L) return walk(t, 0, L, HOME, DEST, E.ioQ, 30); if (t < BACK) return { dx: DEST.x - kf.x, dy: DEST.y - kf.y }; return walk(t, BACK, cfg.back, DEST, HOME, E.ioQ, 30); });
  for (let i = 0; i < 3; i++) { const at = RAKE + i * 70;
    G.crescent(at, { x: tf.x - DIR * 10 * s + DIR * i * 12 * s, y: tf.y - Tk.h * (0.7 - i * 0.15) }, { ang: 0.9, len: 120, w: 14, dir: DIR }); S_(at, A.sfx.slash1, 0.4); }
  m.clip('claw', HIT, { x: c.x, y: c.y, w: clipW('claw', 1), z: 40 }); S_(HIT, A.sfx.blowL, 0.5);
  G.hit(HIT, tk, 'normal');
}

if (MOVE === 'razorplume') {
  // ── Razor Plume: a wing flap, then a fan of five feather darts at each target in turn ──
  const FL = 140 + 160; S_(0, A.sfx.wind7, 0.5);
  body(0, FL, (t) => { const q = t < 140 ? squash(t, 0, 140, [1, 1], [1.08, 0.9]) : squash(t, 140, 160, [1.08, 0.9], [1, 1]); return { sx: q[0], sy: q[1] }; });
  let at = FL;
  for (const k of FOES.slice(0, 2)) { const f = feet(TOK[k]), Tk = TOK[k], s = G.s(k);
    for (let i = 0; i < 5; i++) G.fly(at, hand(), { x: f.x + rnd(-20, 20) * s, y: f.y - Tk.h * rnd(0.3, 0.7) }, { ms: 300 + i * 25, draw: G.SHAPE.dart, arc: rnd(-30, 30) });
    S_(at, A.sfx.evade, 0.4);
    const hitAt = at + 320; m.clip('hit_phys', hitAt, { x: G.center(k).x, y: G.center(k).y, w: clipW('hit_phys', 1), z: 40 }); S_(hitAt, A.sfx.slash1, 0.35); G.hit(hitAt, k, 'normal');
    at = hitAt + 160; }
  gate = at; total = at + 400;
}

if (MOVE === 'airdrop') {
  // ── Airdrop: grab beside the grappled creature, climb with it, let go at the top, it slams into the floor ──
  const tk = FOES[0], Tk = TOK[tk], f = feet(Tk), s = G.s(tk);
  const DEST = (() => { const p = front(tk, cfg.grabGap); return { x: p.x, y: p.y + 2 * KP }; })();
  const GRAB = cfg.grab, CLIMB = GRAB, TOP = CLIMB + cfg.climb, DROP = TOP + 150, LAND = DROP + cfg.drop, RET = LAND + 250;
  total = RET + cfg.ret + 200; gate = LAND;
  const UP = cfg.climbLift * KP, UPT = cfg.carryLift * KP;
  body(0, RET + cfg.ret, (t) => {
    if (t < GRAB) return walk(t, 0, GRAB, HOME, DEST, E.ioQ, 40);
    const at = { dx: DEST.x - kf.x, dy: DEST.y - kf.y };
    if (t < RET) { at.air = UP * E.sine(seg(t, CLIMB, TOP)); return at; }
    const w = walk(t, RET, cfg.ret, DEST, HOME, E.ioQ, 0); w.air = UP * (1 - E.sine(seg(t, RET, RET + cfg.ret))); return w; });
  S_(GRAB, A.sfx.blowL, 0.4); G.hit(GRAB, tk, 'normal', false);
  S_(CLIMB, A.sfx.wind4, 0.5);
  m.hold(CLIMB, LAND, (e, S) => { const t = e + CLIMB; const q = S.tok[tk]; let air;
    if (t < TOP) air = UPT * E.sine(seg(t, CLIMB, TOP)); else if (t < DROP) air = UPT; else air = UPT * (1 - E.inC(seg(t, DROP, LAND))); q.air += air; });
  G.shadow(DROP, 350, LAND, f, 40, s);
  S_(LAND, A.sfx.land, 0.6); S_(LAND, A.sfx.blowL, 0.6); m.shake(LAND, 360, 14);
  G.dust(LAND, f, { n: 18, s: s * 1.3 }); G.ring(LAND, f, { r1: 160, w: 8, s }); G.crack(LAND, f, s);
  G.hit(LAND, tk, 'strong');
}

if (MOVE === 'airblast') {
  // ── Air Blast: wind gathers at his hand, a green-white wind ball flies to the target and bursts ──
  const tk = FOES[0], c = G.center(tk), s = G.s(tk);
  G.wisps(0, hand(), { n: 10, r: 90, ms: 400 }); S_(0, A.sfx.wind4, 0.4);
  const BALL = 450; S_(BALL, A.sfx.wind7, 0.5);
  const HIT = G.fly(BALL, hand(), c, { ms: 480, arc: 40, ease: E.sine, draw: G.SHAPE.wind(24) });
  m.clip('wind1', HIT, { x: c.x, y: c.y, w: clipW('wind1', 1), z: 40 }); S_(HIT, A.sfx.wind1, 0.5);
  G.ring(HIT, feet(TOK[tk]), { rgb: '200,255,220', s });
  G.hit(HIT, tk, 'normal');
  gate = HIT; total = HIT + 400 + 400;
}

if (MOVE === 'aerialshock') {
  // ── Aerial Shockwave: a wing sweep, then three wind crescents in quick succession, one per target ──
  body(0, 320, (t) => { const q = t < 160 ? squash(t, 0, 160, [1, 1], [1.1, 0.88]) : squash(t, 160, 160, [1.1, 0.88], [1, 1]); return { sx: q[0], sy: q[1] }; });
  const C0 = 320; let last = C0;
  FOES.slice(0, 3).forEach((k, i) => { const at = C0 + i * 170; S_(at, A.sfx.wind7, 0.45);
    const hit = G.fly(at, hand(), G.center(k), { ms: 380, draw: G.SHAPE.crs });
    m.clip('wind2', hit, { x: G.center(k).x, y: G.center(k).y, w: clipW('wind2', 1), z: 40 }); S_(hit, A.sfx.slash2, 0.3); G.hit(hit, k, 'normal'); last = at + 170; });
  gate = last + 450; total = gate + 300;
}

if (MOVE === 'turbulence') {
  // ── Turbulence Wind: a wind spiral under each target and a light shake, then the debuff beat. No damage. ──
  S_(0, A.sfx.wind1, 0.5); G.rumble(0, 700, 2);
  for (const k of FOES) { const s = G.s(k), f = feet(TOK[k]);
    for (let j = 0; j < 3; j++) G.ring(0, f, { rgb: '190,255,215', r0: 60, r1: 10, ms: 700, s });
    G.wisps(0, G.center(k), { n: 8, r: 70, ms: 600 });
    m.clip('powerdown', 700, { x: f.x, y: f.y, w: clipW('powerdown', 1), z: 30 }); }
  gate = 700; total = 700 + 600 + 300;
}

if (MOVE === 'windwall') {
  // ── Wind Wall: a pale wind curtain rises in front of his own side, then the buff beat ──
  S_(0, A.sfx.wind4, 0.5);
  const xw = kf.x + DIR * cfg.wallAhead * KP, ST = tl.STAGE;
  for (let at = 0; at < 1300; at += 40) for (let i = 0; i < 4; i++) {
    const x = xw + rnd(-30, 30) * KP, y0 = ST.y + ST.h * rnd(250 / 788, 650 / 788), vy = rnd(0.25, 0.5) * KP, life = rnd(500, 900), r = rnd(30, 70) * KP;
    G.add(at, life, 34, (g, e, t) => { const y = y0 - vy * e; g.strokeStyle = 'rgba(210,255,230,' + (0.5 * Math.sin(t * Math.PI)) + ')'; g.lineWidth = 2 * KP; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 14 * KP, y - r / 2, x, y - r); g.stroke(); }); }
  m.clip('powerup', 1300, { x: kf.x, y: kf.y, w: clipW('powerup', 1), z: 3 }); S_(1300, A.sfx.powerup, 0.35 / 0.75);
  gate = 1300; total = 1300 + 800 + 300;
}

ZP.once(m, gate, () => oni.fireDone());
await tl.run(T, { total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
