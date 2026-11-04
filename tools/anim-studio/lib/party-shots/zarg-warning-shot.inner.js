// Warning Shot — approved mockup (v8). A reaction: plays after Zarg's ranged attack
// has hit, on that attack's targets. Zarg steps out 30, a second arrow (a pale comet
// streak) whistles just over each target's head and on past them (380 ms, linear),
// then a brightness pop + 054_powerdown_1 on the target. No number (gate null).
// Several targets: one arrow each, staggered cfg.stagger ms (cues marked each:true
// are repeated per target at the same stagger).
if (!caster || !targets.length) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t; const st = cfg.stagger || 0;
const dir = K.dirOf(TOK, 'c');
const C = TOK.c; const cf = K.feet(tl, 'c');
K.step(m, E, U, dir, 'c', 0, 0, t.back, 30);
const hand = { x: cf.x + dir * 30 * U + dir * 34 * U, y: cf.y - C.h * 0.45 };
let end = t.back + 460;
const arrow = (g, x, y, an) => {
  g.save(); g.translate(x, y); g.rotate(an); g.globalCompositeOperation = 'lighter';
  const L = 110 * U, F = 10 * U, h = 6 * U;
  const gr = g.createLinearGradient(-L, 0, F, 0);
  gr.addColorStop(0, 'rgba(255,240,170,0)'); gr.addColorStop(0.6, 'rgba(255,236,160,0.55)'); gr.addColorStop(0.92, '#fffbe6'); gr.addColorStop(1, '#fffbe6');
  g.shadowColor = '#ffe9a0'; g.shadowBlur = 26 * U; g.fillStyle = gr;
  g.beginPath(); if (g.roundRect) g.roundRect(-L, -h / 2, L + F, h, h / 2); else g.rect(-L, -h / 2, L + F, h); g.fill();
  g.restore();
};
TG.forEach((tk, i) => {
  const TT = TOK[tk]; const tf = K.feet(tl, tk);
  const at = t.shot + i * st;
  const to = { x: tf.x + dir * 260 * U, y: tf.y - TT.h * 0.95 - 40 * U };
  const an = Math.atan2(to.y - hand.y, to.x - hand.x);
  m.hold(at, at + t.fly, (e, S) => { const u = Math.min(1, e / t.fly); const x = hand.x + (to.x - hand.x) * u, y = hand.y + (to.y - hand.y) * u; S.world.push({ z: 60, draw: (g) => arrow(g, x, y, an) }); });
  const hit = at + t.fly;
  m.tint(hit, 220, tk, '#ffffff', (u) => 0.3 * (1 - E.outQ(u)));
  m.clip('powerdown', hit, { x: tf.x, y: tf.y - 8 * U, w: 508 * 0.85 * U, z: 40 });
  end = Math.max(end, hit + 867);
});
const sfx = [];
for (const c of cfg.sfx || []) { if (c.each) TG.forEach((k, i) => sfx.push({ at: c.at + i * st, url: c.url, v: c.v })); else sfx.push(c); }
await tl.run(T, { total: end + 60, sfx, onStart: K.ready });
oni.fireDone();
