// Siren Trap — approved mockup (v8). Zarg steps out 46 and lobs a small device
// (700 ms, 140 px arc) to a spot among the enemies; it blares (Bell3 + 034_sonic_wave,
// additive) and every target sways 26 px toward it and back (900 ms). No number.
// Spot: the mockup put it 185 px party-side of the enemies' centre and 57 px lower;
// here that offset is taken from the targets' feet centroid. No targets: 500 px ahead.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const C = TOK.c; const cf = K.feet(tl, 'c');
K.step(m, E, U, dir, 'c', 0, 0, t.land, 46);
const hand = { x: cf.x + dir * 46 * U + dir * 34 * U, y: cf.y - C.h * 0.45 };
let spot;
if (TG.length) {
  let sx = 0, sy = 0; for (const k of TG) { const f = K.feet(tl, k); sx += f.x; sy += f.y; }
  spot = { x: sx / TG.length - dir * 185 * U, y: sy / TG.length + 57 * U };
} else spot = { x: cf.x + dir * 500 * U, y: cf.y };
const device = (g, x, y, a) => {
  g.save(); g.globalAlpha = a; g.translate(x, y);
  g.fillStyle = '#6d5a3d'; g.strokeStyle = '#2a1a0e'; g.lineWidth = 2 * U;
  g.beginPath(); if (g.roundRect) g.roundRect(-15 * U, -18 * U, 32 * U, 22 * U, 4 * U); else g.rect(-15 * U, -18 * U, 32 * U, 22 * U);
  g.fill(); g.stroke(); g.restore();
};
const flyEnd = t.land;
m.hold(t.toss, t.total, (e, S) => {
  const at = t.toss + e; let x = spot.x, y = spot.y, a = 1;
  if (at < flyEnd) { const k = E.ioQ(Math.min(1, e / (flyEnd - t.toss))); x = hand.x + (spot.x - hand.x) * k; y = hand.y + (spot.y - hand.y) * k - Math.sin(k * Math.PI) * 140 * U; }
  else if (at > t.total - 200) a = Math.max(0, (t.total - at) / 200);
  S.world.push({ z: 45, draw: (g) => device(g, x, y, a) });
});
m.clip('sonic', t.land, { x: spot.x, y: spot.y - 30 * U, w: 956 * 0.85 * 0.55 * U, z: 50, add: true });
for (const k of TG) {
  const f = K.feet(tl, k); const side = Math.sign(spot.x - f.x) || -dir;
  m.hold(t.land, t.land + 900, (e, S) => { const q = S.tok[k]; if (!q) return; q.dx += side * Math.sin(E.sine(Math.min(1, e / 900)) * Math.PI) * 26 * U; });
}
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
