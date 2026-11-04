// Charm — approved mockup (v8). Keren steps out on a pink (330) hexagram circle
// (Magic1), steps back; three hearts arc from her hand to the target's head
// (140 ms apart), circle its head for 1.1 s (Saint1), then the target flashes.
// The mockup's "Charmed"/"Resisted" tag is dropped (no text in shots); the hearts
// are drawn as canvas hearts in the mockup's pink + glow. No number: gate null.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
if (!TG.length) { await tl.run(T, { total: 10, onStart: K.ready }); oni.fireDone(); return; }
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const tk = TG[0];
const cf = K.feet(tl, 'c');
K.step(m, E, U, dir, 'c', 0, 0, t.release, 46);
K.circle(tl, m, U, 'c', t.cast, t.castHold, 330, { dx: dir * 46 * U });
const heart = (g, x, y, a) => {
  if (a <= 0) return; const s = U * 1.15;
  g.save(); g.translate(x, y); g.scale(s, s); g.globalAlpha = a; g.shadowColor = '#ff4f9a'; g.shadowBlur = 10; g.fillStyle = '#ff7fb4';
  g.beginPath(); g.moveTo(0, 9); g.bezierCurveTo(-16, -2, -10, -17, 0, -8); g.bezierCurveTo(10, -17, 16, -2, 0, 9); g.closePath(); g.fill(); g.restore();
};
const hand = { x: cf.x + dir * (46 + 34) * U, y: cf.y - TOK.c.h * 0.45 };
const hd = K.head(tl, tk);
// three hearts arc hand -> head (850 ms, quad, heights 90/130/170)
for (let i = 0; i < 3; i++) {
  const at = t.release + i * 140, h = (90 + i * 40) * U;
  m.hold(at, at + 850, (e, S) => { const u = E.ioQ(Math.min(1, e / 850)); const x = hand.x + (hd.x - hand.x) * u, y = hand.y + (hd.y - hand.y) * u - Math.sin(u * Math.PI) * h; S.world.push({ z: 60, draw: (g) => heart(g, x, y, 1) }); });
}
// they circle the head for 1.1 s
const orbit = t.release + 280 + 850;
m.hold(orbit, orbit + 1100, (e, S) => {
  const u = e / 1100;
  S.world.push({ z: 60, draw: (g) => { for (let i = 0; i < 3; i++) { const a = u * Math.PI * 4 + i * 2.1; heart(g, hd.x + Math.cos(a) * 46 * U, hd.y + 10 * U + Math.sin(a) * 14 * U, 1); } } });
});
// the target flashes (brightness 1.6 -> 1)
m.tint(orbit + 1100, 220, tk, '#ffffff', (u) => 0.45 * (1 - E.outQ(u)));
const sfx = (cfg.sfx || []).slice();
if (cfg.orbitSfx) sfx.push({ at: orbit, url: cfg.orbitSfx.url, v: cfg.orbitSfx.v });
await tl.run(T, { total: orbit + 1100 + 300, sfx, onStart: K.ready });
oni.fireDone();
