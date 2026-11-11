// Asura · Elemental Slash / Elemental Slash (Enchanted) / Elemental Slash: Overflow / Sword Enchant (inner script).
// Port of the approved mockup ("Asura Action Animations" artifact, v1 moves, approved 2026-11-11).
// LIVE board: the camera is never touched (the 3D stage keeps its parallax), only the bodies a beat moves are
// painted. cfg.move = "slash" | "overflow" | "enchant"; cfg.element = the enchant's element. Every number is in
// cfg (mockup px on a 1682 px stage, scaled by stage width / 1682). No backticks in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
if (!caster) { oni.fireDone(); return; }
const MOVE = cfg.move, EL = cfg.el;
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
if ((MOVE === 'slash' || MOVE === 'overflow') && !FOES.length) { oni.fireDone(); return; }
const CL = A.clips || {};
const tl = oni.timeline({ tokens, clips: CL, live: true, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet, glow = tl.draw.glowCircle;
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 991);
const rnd = (a, b) => a + (b - a) * R();
const T = [], sfx = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (!did) { did = true; fn(); } } }); };
const S_ = (at, url, v) => { if (url) sfx.push({ at, url, v: v * cfg.volume }); };
const K = TOK.k, kf = feet(K);
const center = (k) => { const Tk = TOK[k], f = feet(Tk); return { x: f.x, y: f.y - Tk.h * 0.5 }; };
const DIR = FOES.length ? (TOK[FOES[0]].x >= K.x ? 1 : -1) : 1;
// a point on his sprite (u, v = shares of the art) at his home spot, plus an offset of his feet
const bladeAt = (el, dx, dy, lift) => { const b = EL[el].blade; return { x: K.x + (b[0] - 0.5) * K.w * K.flip + (dx || 0), y: kf.y - (1 - b[1]) * K.h + (dy || 0) - (lift || 0) }; };
const clipW = (key, scale) => CL[key].w * scale * CL[key].k * KP;

// particles (additive, world space): motes drifting in to a point, sparks thrown out
const P = [];
m.hold(0, 60000, (t, S) => { if (!P.length) return; S.world.push({ z: 30, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter';
  for (const p of P) { const age = t - p.t0; if (age < 0 || age > p.life) continue; const u = age / p.life; let x, y;
    if (p.to) { const e = E.inQ(u), cx = (p.x + p.to.x) / 2 + p.arc, cy = Math.min(p.y, p.to.y) - 40 * KP; x = (1 - e) * (1 - e) * p.x + 2 * (1 - e) * e * cx + e * e * p.to.x; y = (1 - e) * (1 - e) * p.y + 2 * (1 - e) * e * cy + e * e * p.to.y; }
    else { x = p.x + p.vx * age * KP; y = p.y + (p.vy * age + 0.5 * (p.g || 0) * age * age) * KP; }
    glow(g, x, y, p.r * KP * 2.3, 'rgba(' + p.rgb + ',1)', (1 - u) * 0.95); }
  g.restore(); } }); });
const gather = (at, rgb, to, n, ms) => { for (let i = 0; i < n; i++) { const an = rnd(0, 6.283), r = rnd(90, 180) * KP; P.push({ t0: at, life: ms * rnd(0.7, 1.1), x: to.x + Math.cos(an) * r, y: to.y + Math.sin(an) * r * 0.7, to, arc: rnd(-60, 60) * KP, r: rnd(2, 4), rgb }); } };
const shards = (at, pt, rgb, n, spread) => { for (let i = 0; i < n; i++) { const an = rnd(0, 6.283), sp = rnd(0.15, spread); P.push({ t0: at, life: rnd(350, 700), x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, g: 0.0006, r: rnd(1.5, 3.2), rgb }); } };
const tint = (hue, sat, br) => 'sepia(1) saturate(' + sat + ') hue-rotate(' + (hue - 38) + 'deg) brightness(' + br + ')';
const body = (fn) => m.hold(0, 60000, (t, S) => fn(t, S.tok.k, S));
let total = 0, gate = 0;

if (MOVE === 'slash') {
  // ── Elemental Slash: two heavy strides, a four-arm wind-up, one brutal cut in the current Aspect's element ──
  const aspect = (() => { try { for (const e of caster.actor.effects) { if (e.disabled) continue; const mm = /^(fire|bolt|ice|air)\s+aspect$/i.exec(String(e.name || '').trim()); if (mm) return mm[1].toLowerCase(); } } catch (e) {} return null; })();
  const tk = FOES[0], tf = feet(TOK[tk]), c = center(tk);
  const DEST = { x: tf.x - DIR * (TOK[tk].w * 0.45 + K.w * 0.5), y: tf.y + 4 * KP };
  const W0 = cfg.walk, WU = W0 + cfg.windup, CUT = WU + 80, HIT = CUT + cfg.stop, BACK = HIT + 450;
  total = BACK + cfg.walk * 1.1 + 300; gate = HIT;
  body((t, d) => {
    let p = { x: kf.x, y: kf.y }, air = 0, rot = 0, sx = 1, sy = 1;
    if (t < W0) { const u = E.ioQ(seg(t, 0, W0)); p = { x: lerp(kf.x, DEST.x, u), y: lerp(kf.y, DEST.y, u) }; air = Math.sin(seg(t, 0, W0) * Math.PI) * 10 * KP; }
    else if (t < BACK) { p = DEST;
      if (t < WU) { const u = E.outC(seg(t, W0, WU)); rot = -11 * u; sx = lerp(1, 1.06, u); sy = lerp(1, 0.93, u); }
      else if (t < CUT) { const u = E.inQ(seg(t, WU, CUT)); rot = lerp(-11, 10, u); sx = lerp(1.06, 0.96, u); sy = lerp(0.93, 1.05, u); }
      else { const u = E.sine(seg(t, HIT + 100, BACK)); rot = lerp(10, 0, u); sx = lerp(0.96, 1, u); sy = lerp(1.05, 1, u); } }
    else { const u = E.sine(seg(t, BACK, BACK + cfg.walk * 1.1)); p = { x: lerp(DEST.x, kf.x, u), y: lerp(DEST.y, kf.y, u) }; air = Math.sin(u * Math.PI) * 8 * KP; }
    if (t < total) { d.dx = p.x - kf.x; d.dy = p.y - kf.y; d.air = air; d.rot = rot * Math.PI / 180 * DIR; d.sx = sx; d.sy = sy; }
  });
  m.hold(HIT, HIT + 600, (tt, S) => { S.tok[tk].hurt = true; });
  S_(0, A.sfx.earth5, 0.3); S_(W0, A.sfx.earth5, 0.3); m.shake(W0, 120, 3 * KP); S_(W0, A.sfx.swingC, 0.4);
  if (aspect) m.clip('enc_' + aspect, W0, { x: bladeAt(aspect, DEST.x - kf.x, DEST.y - kf.y).x, y: bladeAt(aspect, DEST.x - kf.x, DEST.y - kf.y).y, w: clipW('enc_' + aspect, 0.6), z: 22, add: true });
  S_(CUT, A.sfx.slashL, 0.65); S_(CUT, A.sfx.swingA, 0.4);
  if (!aspect) { m.clip('slash_phys', CUT, { x: c.x, y: c.y, w: clipW('slash_phys', 2), z: 40 }); m.clip('ggslash3', CUT, { x: c.x, y: c.y, w: clipW('ggslash3', 1.1), z: 41, add: true, rot: -30 * Math.PI / 180 }); }
  else { const e = EL[aspect];
    m.clip('px_' + aspect, CUT, { x: c.x - 40 * KP, y: c.y + 50 * KP, w: clipW('px_' + aspect, 2.6), z: 40 });
    m.clip('mv_' + aspect, CUT, { x: c.x, y: c.y, w: clipW('mv_' + aspect, 1.9), z: 41 });
    m.clip('ggslash3', CUT, { x: c.x, y: c.y, w: clipW('ggslash3', 1.1), z: 42, add: true, rot: -30 * Math.PI / 180, filter: tint(e.hue, 6, 1.3) });
    S_(CUT, A.sfx[e.s2], 0.4); }
  m.shake(HIT, 260, 9 * KP);
}

if (MOVE === 'overflow') {
  // ── Overflow: the fire blade boils over, a leap in a ring of flame, the slam, a fire wave across the party ──
  const BOIL = 400, RISE = BOIL + cfg.rise, SLAM = RISE + 160, IMP = SLAM + 150;
  total = IMP + FOES.length * cfg.wave + 900; gate = IMP;
  body((t, d) => {
    let air = 0, rot = 0;
    if (t < BOIL) rot = -6 * E.outC(seg(t, 0, BOIL));
    else if (t < RISE) { air = 150 * KP * E.outC(seg(t, BOIL, RISE)); rot = -6; }
    else if (t < SLAM) { air = 150 * KP; rot = -6; }
    else if (t < IMP) { air = 150 * KP * (1 - E.inC(seg(t, SLAM, IMP))); rot = lerp(-6, 4, seg(t, SLAM, IMP)); }
    else rot = lerp(4, 0, E.sine(seg(t, IMP + 600, IMP + 900)));
    if (t < total) { d.air = air; d.rot = rot * Math.PI / 180 * DIR; }
  });
  const fb = bladeAt('fire');
  S_(0, A.sfx.fire1, 0.5); m.clip('enc_fire', 0, { x: fb.x, y: fb.y, w: clipW('enc_fire', 1), z: 22, add: true }); gather(0, EL.fire.rgb, fb, 18, 600);
  S_(BOIL, A.sfx.swingF, 0.45); m.clip('smoke11', BOIL, { x: kf.x, y: kf.y, w: clipW('smoke11', 1.1), z: 6, add: true, alpha: () => 0.5 });
  const fb2 = bladeAt('fire', 0, 0, 150 * KP); m.clip('enc_fire', RISE, { x: fb2.x, y: fb2.y, w: clipW('enc_fire', 1.2), z: 22, add: true });
  S_(IMP, A.sfx.explode2, 0.6); S_(IMP, A.sfx.fire3, 0.5); m.shake(IMP, 500, 16 * KP);
  m.clip('fire_expn', IMP, { x: kf.x + DIR * 70 * KP, y: kf.y, w: clipW('fire_expn', 0.8), z: 20, add: true });
  const PCx = FOES.reduce((s, k) => s + center(k).x, 0) / FOES.length, PCy = FOES.reduce((s, k) => s + center(k).y, 0) / FOES.length;
  m.clip('fire_all', IMP, { x: PCx, y: PCy, w: clipW('fire_all', 1.6), z: 38, depth: false });
  FOES.forEach((k, i) => { const at = IMP + i * cfg.wave, f = feet(TOK[k]), c = center(k);
    m.clip('firewall', at, { x: f.x, y: f.y, w: clipW('firewall', 0.9), z: 39, add: true });
    m.clip('hit_fire', at, { x: c.x, y: c.y, w: clipW('hit_fire', 1), z: 40, add: true });
    S_(at, A.sfx.hitfire, 0.3); m.hold(at, at + 600, (tt, S) => { S.tok[k].hurt = true; }); });
}

if (MOVE === 'enchant') {
  // ── Sword Enchant: the blade drawn across his own forearm, then it drinks the element ──
  const el = cfg.element, e = EL[el], bp = bladeAt(el);
  const CUTA = cfg.drag, DRINK = CUTA + 200, PU = DRINK + 500;
  total = PU + 700 + 400; gate = CUTA;
  body((t, d) => { let rot = 0; if (t < CUTA) rot = -5 * E.outC(seg(t, 0, CUTA)); else rot = lerp(-5, 0, E.sine(seg(t, PU + 700, PU + 1000))); if (t < total) d.rot = rot * Math.PI / 180 * DIR; });
  S_(0, A.sfx.sword2, 0.45);
  shards(CUTA, bp, '200,30,40', 10, 0.3); m.hold(CUTA, CUTA + 400, (tt, S) => { S.tok.k.hurt = true; });
  gather(DRINK, e.rgb, bp, 22, 650); S_(DRINK, A.sfx[e.s1], 0.5);
  m.clip('enc_' + el, DRINK, { x: bp.x, y: bp.y, w: clipW('enc_' + el, 1), z: 22, add: true });
  m.clip('powerup', PU, { x: kf.x, y: kf.y, w: clipW('powerup', 1), z: 3, filter: tint(e.hue, 6, 1.1) });
  S_(PU, A.sfx.powerup, 0.45); m.tint(PU, 400, 'k', 'rgb(' + e.rgb + ')', (u) => 0.7 * (1 - u));
}

once(gate, () => oni.fireDone());
await tl.run(T, { total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
