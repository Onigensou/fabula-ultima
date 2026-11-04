// Brainwave Discharge — approved mockup (v8, round 3, purple psychic theme).
// Violet dim (#160626 at 0.5, under the tokens like the mockup's dim layer),
// Keren steps out 30 and trembles with violet sparks at her head, the RO
// howlingoflion cast swirl gathers under her (Magic4), then the RO howlingoflion
// burst detonates on each enemy 120 ms apart (Darkness4 each); damage on each
// burst's impact (350 ms). Gate = the first enemy's impact.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
if (!TG.length) { await tl.run(T, { total: 10, onStart: K.ready }); oni.fireDone(); return; }
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const cf = K.feet(tl, 'c');
const SC = tl.SCENE;
const rel = t.burst + (TG.length - 1) * 120 + 833; // all bursts done: step back + undim
// violet dim: in 500 (sine) from 0, out 500 once every burst is done
m.hold(0, rel + 520, (e, S) => {
  const a = e < 500 ? 0.5 * E.sine(e / 500) : e < rel ? 0.5 : 0.5 * (1 - E.sine(Math.min(1, (e - rel) / 500)));
  if (a <= 0) return;
  S.world.push({ z: 0, draw: (g) => { g.save(); g.fillStyle = 'rgba(22,6,38,' + a.toFixed(3) + ')'; g.fillRect(SC.x - SC.w, SC.y - SC.h, SC.w * 3, SC.h * 3); g.restore(); } });
});
// step out 30, tremble 600 ms with violet sparks around her head
K.step(m, E, U, dir, 'c', 0, 0, rel, 30);
const hd = K.head(tl, 'c');
K.twinkles(m, t.tremble, { x: hd.x + dir * 30 * U, y: hd.y }, K.tintF(280, 4, 1.3), 6, 30, U);
m.hold(t.tremble, t.tremble + 600, (e, S) => { S.tok.c.dx += Math.sin((e / 600) * 60) * 3 * U; });
// the swirl gathers under her
m.clip('howlCast', t.swirl, { x: cf.x + dir * 30 * U, y: cf.y, w: 162 * 0.85 * 1.9 * 1.3 * U, z: 2, add: true });
// a burst on each enemy, 120 ms apart
const sfx = (cfg.sfx || []).slice();
TG.forEach((tk, i) => {
  const at = t.burst + i * 120, tf = K.feet(tl, tk);
  m.clip('howl', at, { x: tf.x, y: tf.y, w: 862 * 0.85 * 1.9 * 0.6 * U, z: 50, add: true });
  m.shakeTok(at + t.impact, tk, 300, 9 * U);
  m.tint(at + t.impact, 220, tk, '#ffffff', (u) => 0.6 * (1 - u));
  if (cfg.burstSfx) sfx.push({ at, url: cfg.burstSfx.url, v: cfg.burstSfx.v });
});
await tl.run(T, { total: rel + 520, sfx, onStart: K.ready });
oni.fireDone();
