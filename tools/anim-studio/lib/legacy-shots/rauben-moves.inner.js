// Rauben · Great Axe (+ Great Axe - Counterattack) / Axe Throw / Bandit Raid / All you can take (inner script, every client).
// Port of the approved legacy-boss mockup (part-b3.js, Rauben defs). LIVE board: the camera is never touched,
// only the bodies a beat moves are painted. cfg.move = "greataxe" | "axethrow" | "raid" | "allyoucan".
// Every damage contact cues oni.hit(); the damage gate (oni.fireDone) sits where the mockup marks it.
// Numbers, flinch and HP bar are the game's. No floating text, no backticks in this file.
if (!caster) { readyHook(); oni.fireDone(); return; }
const MOVE = cfg.move;
const ALL = MOVE === 'allyoucan';
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
// All you can take: every creature on the board gains IP (the item's resolution grants it to every token)
const CREW = [];
if (ALL) {
  const seen = new Set([caster.id]); const disp = Number(caster.document && caster.document.disposition) || 0; const list = [];
  for (const t of (canvas.tokens && canvas.tokens.placeables) || []) { if (!t || !t.actor || seen.has(t.id) || !t.visible || (t.document && t.document.hidden)) continue; seen.add(t.id); list.push(t); }
  list.sort((a, b) => ((Number(a.document.disposition) === disp) ? 1 : 0) - ((Number(b.document.disposition) === disp) ? 1 : 0));
  list.forEach((t, i) => { const k = 'c' + i; CREW.push({ k, token: t }); if (!tokens[k]) tokens[k] = { token: t }; });
  CREW.push({ k: 'k', token: caster });
}
if (!ALL && !FOES.length) { readyHook(); oni.fireDone(); return; }
const A_IMG = A.images || {};
const tl = oni.timeline({ tokens, clips: A.clips || {}, images: A_IMG, live: true, depthRef: 'k' });
await tl.load();
const T = [];
const RK = RKit(tl, T);
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet;
const KP = RK.KP, m = RK.m, rnd = RK.rnd;
const CL = A.clips || {};
const K = TOK.k, kf = feet(K);
const center = (k) => { const Tk = TOK[k], f = feet(Tk); return { x: f.x, y: f.y - Tk.h * 0.5 }; };
const DIR = FOES.length ? (feet(TOK[FOES[0]]).x >= kf.x ? 1 : -1) : (() => { const o = CREW.find((c) => c.k !== 'k' && Number(c.token.document.disposition) !== Number(caster.document.disposition)); return o && feet(TOK[o.k]).x < kf.x ? -1 : 1; })();
const D2R = Math.PI / 180;
// a mockup lean (deg, positive = toward the party) as a canvas rotation
const lean = (deg) => deg * DIR * D2R;
const clipW = (key, scale) => CL[key].w * scale * 0.55 * KP;
// keyframed value: keys [{ t0, ms, to, ease }] run back to back from 0
const curve = (keys, t) => { let v = 0; for (const q of keys) { if (t < q.t0) break; v = lerp(v, q.to, (q.ease || E.outQ)(seg(t, q.t0, q.t0 + q.ms))); } return v; };
let total = 0, gate = 0, poseAt = null;

if (MOVE === 'greataxe') {
  // ── Great Axe: dash, overhead swing, hit, two coins to him, back ──
  const tk = FOES[0], tf = feet(TOK[tk]), c = center(tk);
  const DEST = { x: tf.x - DIR * cfg.gap * KP * tl.depthRatio(kf, tf), y: tf.y };
  const D = cfg.dash, WIND = D + cfg.wind, CUT = WIND + cfg.swing, STEAL = CUT + cfg.hitstop, GATE = STEAL + cfg.coinMs, SETTLE = GATE + cfg.settle, HOME = SETTLE + cfg.home;
  total = HOME + 300; gate = GATE;
  const rotKeys = [{ t0: D, ms: cfg.wind, to: -16 }, { t0: WIND, ms: cfg.swing, to: 16 }, { t0: GATE, ms: cfg.settle, to: 0 }];
  poseAt = (t) => { let x = kf.x, y = kf.y, air = 0;
    if (t < D) { const u = E.ioQ(seg(t, 0, D)); x = lerp(kf.x, DEST.x, u); y = lerp(kf.y, DEST.y, u); }
    else if (t < SETTLE) { x = DEST.x; y = DEST.y; }
    else { const u = E.ioQ(seg(t, SETTLE, HOME)); x = lerp(DEST.x, kf.x, u); y = lerp(DEST.y, kf.y, u); air = Math.sin(u * Math.PI) * cfg.hop * KP; }
    return { dx: x - kf.x, dy: y - kf.y, air, rot: lean(curve(rotKeys, t)), sx: 1, sy: 1 }; };
  // the dash leaves three afterimages (trail .3 of the eased move)
  for (const e of [0.3, 0.6, 0.9]) { const u = e < 0.5 ? Math.sqrt(e / 2) : 1 - Math.sqrt((1 - e) / 2); const at = Math.round(u * D) + 1; RK.ghost(at, 'k', poseAt(at)); }
  RK.snd(WIND, 'swingF', 0.55);
  m.clip('slash3', CUT, { x: c.x, y: c.y, w: clipW('slash3', 1.2), z: 40 });
  RK.once(CUT, () => oni.hit());
  RK.snd(CUT, 'blowL', 0.6); RK.shake(CUT, 260, 10);
  RK.snd(STEAL, 'steal', 0.45); RK.snd(STEAL, 'coin', 0.45);
  // coinsTo: two coins hop from the target to him (resolves when the first lands = the gate)
  const to = () => ({ x: DEST.x, y: DEST.y - K.h * tl.depthRatio(kf, DEST) * 0.5 });
  for (let i = 0; i < 2; i++) { const ox = rnd(-12, 12) * KP, arc = rnd(70, 130); RK.fly(STEAL + i * 70, () => ({ x: c.x + ox, y: c.y }), to, { ms: cfg.coinMs, arc, ease: E.sine, z: 41, draw: (g, age) => RK.coin(g, age, 7 * KP) }); }
}

if (MOVE === 'axethrow') {
  // ── Axe Throw: a spinning axe flies out, hits, and arcs back into his hand ──
  const tk = FOES[0], c = center(tk);
  const hand = () => ({ x: kf.x + DIR * K.w * 0.3, y: kf.y - K.h * 0.62 });
  const W1 = cfg.wind, HIT = W1 + cfg.out, BACK = HIT + cfg.back, SQ = BACK + 90, SQ2 = SQ + 120, END = SQ2 + 140;
  total = END + 300; gate = HIT;
  const rotKeys = [{ t0: 0, ms: cfg.wind, to: -12 }, { t0: W1, ms: 100, to: 10 }, { t0: SQ2, ms: 140, to: 0 }];
  const sqKeys = (t) => t < BACK ? 1 : t < SQ ? lerp(1, 1.05, E.outQ(seg(t, BACK, SQ))) : lerp(1.05, 1, E.outQ(seg(t, SQ, SQ2)));
  poseAt = (t) => { const sx = sqKeys(t), sy = 2 - sx; return { dx: 0, dy: 0, air: 0, rot: lean(curve(rotKeys, t)), sx, sy }; };
  RK.snd(W1, 'swingC', 0.5);
  RK.fly(W1, hand, () => c, { ms: cfg.out, arc: 60, spin: 0.35, z: 40, draw: (g) => RK.axe(g, 1.1 * KP) });
  m.clip('slash', HIT, { x: c.x, y: c.y, w: clipW('slash', 1), z: 41 });
  RK.once(HIT, () => oni.hit());
  RK.snd(HIT, 'blowL', 0.5); RK.snd(HIT, 'swingA', 0.4);
  RK.fly(HIT, () => c, hand, { ms: cfg.back, arc: -70, spin: 0.35, z: 40, draw: (g) => RK.axe(g, 1.1 * KP) });
}

if (MOVE === 'raid') {
  // ── Bandit Raid: he whistles; three bandits dash through the target from off-screen, one hit at the end ──
  const tk = FOES[0], tf = feet(TOK[tk]), c = center(tk);
  const W0 = 160, WEND = W0 + 300 + 160, RUN = WEND;
  const LAST = RUN + 2 * cfg.stagger + cfg.runMs;
  total = LAST + 400; gate = LAST;
  const rotKeys = [{ t0: 0, ms: 160, to: 6 }, { t0: W0 + 300, ms: 160, to: 0 }];
  poseAt = (t) => ({ dx: 0, dy: 0, air: 0, rot: lean(curve(rotKeys, t)), sx: 1, sy: 1 });
  RK.snd(W0, 'item', 0.4);
  const ed = RK.edges();
  const x0 = (DIR > 0 ? ed.left : ed.right) - DIR * 120 * KP, x1 = (DIR > 0 ? ed.right : ed.left) + DIR * 218 * KP;
  for (let i = 0; i < 3; i++) {
    const art = RK.pick(cfg.bandits), img = tl.IMG[art]; if (!img) continue;
    const y = tf.y + (i - 1) * 18 * KP, h = RK.banditH(img, cfg.bsc[art] || 1.34, tl.depthS(tf.x, y)), z = y < tf.y ? 3 : 30;
    RK.runner(RUN + i * cfg.stagger, { img, dir: DIR, x0, x1, y, h, ms: cfg.runMs, ease: E.lin, z,
      bob: (u) => Math.abs(Math.sin(u * Math.PI * 9)) * 8 * KP, rot: (u) => Math.sin(u * Math.PI * 9) * 4,
      trail: 64, trailSpec: (p) => ({ x: p.x - DIR * 20 * KP, y: p.y, vx: -0.05 * DIR * KP, vy: -0.02 * KP, life: 500, rr: rnd(5, 10) * KP, rgb: '190,170,140', a0: 0.4, grow: 1 }) });
  }
  m.clip('hit', LAST, { x: c.x, y: c.y, w: clipW('hit', 1), z: 41 });
  RK.once(LAST, () => oni.hit());
  RK.snd(LAST, 'blowL', 0.5);
}

if (MOVE === 'allyoucan') {
  // ── All you can take: dim, he steps up, coins shower onto every creature, the game's IP number reads the gain ──
  const STEP = cfg.step, SHOWER = STEP;
  const N = CREW.length, ARRIVE = 560;
  const GATE = SHOWER + (N - 1) * 70 + ARRIVE;
  const BACK = GATE + 500, HOME = BACK + cfg.home;
  total = HOME + 200; gate = GATE;
  const DEST = { x: kf.x + DIR * 60 * KP, y: kf.y };
  poseAt = (t) => { let x = kf.x; if (t < BACK) x = lerp(kf.x, DEST.x, E.sine(seg(t, 0, STEP))); else x = lerp(DEST.x, kf.x, E.ioQ(seg(t, BACK, HOME))); return { dx: x - kf.x, dy: 0, air: 0, rot: 0, sx: 1, sy: 1 }; };
  m.hold(0, total, (t, S) => { const a = t < BACK ? 0.45 * E.sine(seg(t, 0, 400)) : 0.45 * (1 - E.sine(seg(t, BACK, BACK + 400))); S.dim = Math.max(S.dim, a); });
  RK.snd(SHOWER, 'coin', 0.5);
  const ipGain = (actor) => { const p = (actor && actor.system && actor.system.props) || {}; let cur = Number(p.current_ip), max = Number(p.max_ip);
    if (!('current_ip' in p) || !('max_ip' in p)) { const s = (actor && actor.system) || {}; cur = Number(s.current_ip); max = Number(s.max_ip); }
    if (!Number.isFinite(cur) || !Number.isFinite(max)) return 0; return Math.max(0, Math.min(max, cur + cfg.gain) - cur); };
  const bdNumbers = () => { try { return globalThis.FUCompanion.api.experimental.battleDirector.damageNumbers; } catch (e) { return null; } };
  CREW.forEach((cr, i) => {
    const at = SHOWER + i * 70, Tk = TOK[cr.k]; if (!Tk) return;
    const home = () => { const f = feet(Tk); const dx = cr.k === 'k' ? DEST.x - kf.x : 0; return { x: f.x + dx, y: f.y - Tk.h * 0.5 }; };
    for (let n = 0; n < 5; n++) { const ox = rnd(-30, 30) * KP, tx = rnd(-20, 20) * KP;
      RK.fly(at, () => ({ x: home().x + ox, y: RK.edges().top - 40 * KP }), () => ({ x: home().x + tx, y: home().y }), { ms: 520 + n * 40, arc: 0, ease: E.inQ, z: 41, draw: (g, age) => RK.coin(g, age, 7 * KP) }); }
    RK.snd(at + ARRIVE, 'coin', 0.25);
    RK.twinkles(at + ARRIVE, home(), 3, 24, '255,220,120');
    const amount = ipGain(cr.token.actor), uuid = cr.token.document && cr.token.document.uuid;
    if (amount > 0 && uuid) RK.once(at + ARRIVE, () => { const dn = bdNumbers(); if (dn && dn.renderLocal) dn.renderLocal({ kind: 'gain', tokenUuid: uuid, resource: 'ip', amount }); });
  });
}

// his body, every frame of the shot
m.hold(0, total, (t, S) => { if (!poseAt) return; const p = poseAt(t), d = S.tok.k; d.dx = p.dx; d.dy = p.dy; d.air = p.air; d.rot = p.rot; d.sx = p.sx; d.sy = p.sy; });
RK.once(gate, () => oni.fireDone());
await tl.run(T, { total, onStart: readyHook });
oni.fireDone();
