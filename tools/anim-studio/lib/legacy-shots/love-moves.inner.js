// Love: Heartache / Shout my Soul / One more for you / Jamming Way / Rock your World (inner script).
// Port of the approved Legacy boss mockup (part-b3.js, these five are unchanged by the review rounds).
// LIVE board: the camera is never touched; only the bodies a beat moves are painted.
// cfg.move = "heartache" | "shout" | "onemore" | "jamming" | "rockworld"; cfg.t = the beat clock (ms).
// Every damage contact cues oni.hit(); the gate (oni.fireDone) sits where the mockup's markGate() is.
if (!caster) { K.ready(); oni.fireDone(); return; }
const MOVE = cfg.move; const t = cfg.t || {};
const SIDES = LV.sides();
// Rock your World buffs every ally on his side: they join as 'a0..' (targets already in the list keep their key)
const extra = {}; const AK = ['c'];
if (MOVE === 'rockworld') {
  const tk = new Map(); targets.forEach((x, i) => tk.set(x.id, 't' + i));
  SIDES.allies.forEach((x, i) => { if (tk.has(x.id)) AK.push(tk.get(x.id)); else { const k = 'a' + i; extra[k] = { token: x }; AK.push(k); } });
}
const { tl, T, m, TOK } = await boot(extra);
LV.init(tl, TOK, SIDES.foes);
const U = LV.U, DIR = LV.DIR, E = tl.E;
const TG = targets.map((x, i) => 't' + i);
const HI = LV.layer(m, 80);            // the mockup's "hit" canvas: above every battler
const GR = LV.layer(m, 3);             // the "ground" / "field" canvas: under the real tokens
let total = 1000;
const MV = (k) => (A.clips || {})[k] || { w: 1 };

if (MOVE === 'heartache') {
  // strum: a squash, a heart-shaped note flies to the target, hearts pop off its head, it wobbles, status beat
  const tk = TG[0];
  LV.keys(m, 'c', 'sx', [[0, 1], [100, 1.06, 'outQ'], [240, 1, 'outQ']]); LV.keys(m, 'c', 'sy', [[0, 1], [100, 0.94, 'outQ'], [240, 1, 'outQ']]);
  LV.S(100, 'magic4', 0.45);
  if (tk) {
    const from = LV.hand('c'), to = LV.body(tk), heart = LV.shape('heart', 13, LV.HEART);
    LV.fly(HI, 100, from, to, 620, 70 * U, E.sine, (g, x, y, ang) => LV.drawShape(g, heart, x, y, ang, 1));
    LV.toss(HI, t.land, LV.head(tk), 5, () => LV.shape('heart', 7, LV.HEART), { up: 0.25 });
    LV.S(t.land, 'heal', 0.35);
    LV.keys(m, tk, 'rot', [[t.land, 0], [t.land + 140, 8, 'outQ'], [t.land + 300, -8, 'outQ'], [t.land + 440, 0, 'outQ']]);
    const f = LV.F(tk); m.clip('powerup', t.gate, { x: f.x, y: f.y, w: MV('powerup').w * 0.55 * U, z: 50 });
  }
  LV.gate(m, t.gate); total = t.gate + 500;
}

if (MOVE === 'shout') {
  // he leans back, screams: four sound-wave rings roll out over the field, everyone is hit, then the status beat
  const list = TG.length ? TG : [];
  const n = list.length, HIT = t.scream + 4 * 130, OFFR = HIT + n * 50 + 250;
  LV.keys(m, 'c', 'rot', [[0, 0], [260, -10, 'outQ'], [380, 6, 'outQ'], [OFFR, 6], [OFFR + 200, 0, 'outQ']]);
  LV.S(t.scream, 'monster1', 0.5); LV.S(t.scream, 'wind1', 0.45);
  const KS = (tl.view().W || 1682) / 1682;
  m.hold(t.scream, OFFR, (e, S) => { S.shake = Math.max(S.shake, 4 * KS); });
  const h0 = LV.hand('c');
  for (let i = 0; i < 4; i++) GR.push({ t0: t.scream + i * 130, life: 900, draw: (g, e, u) => { const r = (10 + (1300 - 10) * E.outC(u)) * U; g.globalCompositeOperation = 'lighter'; g.strokeStyle = 'rgba(255,200,240,' + (1 - u).toFixed(3) + ')'; g.lineWidth = 6 * (1 - u * 0.6) * U; g.beginPath(); g.ellipse(h0.x, h0.y, r, r * 0.7, 0, 0, 6.2832); g.stroke(); } });
  list.forEach((k, i) => ZP.once(m, HIT + i * 50, () => oni.hit()));
  list.forEach((k) => { const f = LV.F(k); m.clip('powerdown', OFFR, { x: f.x, y: f.y, w: MV('powerdown').w * 0.55 * U, z: 50 }); });
  LV.gate(m, OFFR); total = OFFR + 500;
}

if (MOVE === 'onemore') {
  // he points; a note flies to the ally, who sparkles and hops
  const ak = TG[0];
  LV.keys(m, 'c', 'rot', [[0, 0], [160, 8, 'outQ'], [t.gate, 8], [t.gate + 160, 0, 'outQ']]);
  LV.S(160, 'item', 0.45);
  if (ak) {
    const note = LV.shape('note', 10, LV.NOTE);
    LV.fly(HI, 160, LV.hand('c'), LV.body(ak), 520, 80 * U, E.sine, (g, x, y, ang) => LV.drawShape(g, note, x, y, ang, 1));
    LV.twinkles(HI, t.gate, LV.body(ak), 8, 40, '255,230,150'); LV.S(t.gate, 'magic4', 0.35);
    LV.keys(m, ak, 'air', LV.hopKeys(t.gate, 30, 1));
  }
  LV.gate(m, t.gate); total = t.gate + 400;
}

if (MOVE === 'jamming') {
  // a power chord: an electric shockwave runs along the floor to the target and bursts into a bolt
  const tk = TG[0];
  LV.keys(m, 'c', 'sx', [[0, 1], [120, 1.1, 'outQ'], [280, 1, 'outQ']]); LV.keys(m, 'c', 'sy', [[0, 1], [120, 0.88, 'outQ'], [280, 1, 'outQ']]);
  LV.S(120, 'thunder1', 0.45);
  if (tk) {
    const a0 = LV.F('c'), b0 = LV.F(tk), glow = tl.draw.glowCircle;
    GR.push({ t0: 120, life: 420, draw: (g, e, u) => { const x = a0.x + (b0.x - a0.x) * u, y = a0.y + (b0.y - a0.y) * u; const rr = tl.rng(Math.floor(e / 33) + 7);
      g.globalCompositeOperation = 'lighter'; g.strokeStyle = 'rgba(220,170,255,.95)'; g.lineWidth = 3 * U; g.beginPath(); g.moveTo(x - 40 * U * DIR, y);
      for (let i = 0; i < 6; i++) g.lineTo(x + (-40 + i * 14) * U * DIR, y + (rr() * 20 - 10) * U); g.stroke(); glow(g, x, y, 40 * U, 'rgba(200,140,255,0.7)', 1); } });
    const c = LV.body(tk); m.clip('hit_thunder', t.gate, { x: c.x, y: c.y, w: MV('hit_thunder').w * 0.55 * U, z: 50, add: true });
    LV.S(t.gate, 'thunder3', 0.5); ZP.once(m, t.gate, () => oni.hit());
  }
  LV.gate(m, t.gate); total = t.gate + 500;
}

if (MOVE === 'rockworld') {
  // he slides forward, an out-pulse bursts from him, the buff beat lands on every ally, he slides back
  const SL = 70 * U;
  LV.keys(m, 'c', 'dx', [[0, 0], [300, SL, 'sine'], [t.back, SL], [t.back + 360, 0, 'ioQ']], true);
  const b = LV.body('c'); m.clip('outpulse', 300, { x: b.x + SL * DIR, y: b.y, w: MV('outpulse').w * 0.55 * 1.4 * U, z: 40, add: true });
  LV.S(300, 'success2', 0.5);
  AK.forEach((k, i) => { const f = LV.F(k); m.clip('powerup', t.gate, { x: f.x + (k === 'c' ? SL * DIR : 0), y: f.y, w: MV('powerup').w * 0.55 * U, z: 50 }); LV.S(t.gate + i, 'powerup', 0.35 / 0.75); });
  LV.gate(m, t.gate); total = t.back + 360 + 50;
}

await tl.run(T, { total, sfx: LV.sfx, onStart: K.ready });
oni.fireDone();
