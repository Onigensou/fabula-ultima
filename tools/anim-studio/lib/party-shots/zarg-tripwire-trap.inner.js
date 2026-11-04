// Tripwire Trap — approved mockup (v8). A wire draws itself taut across each target's
// feet (280 px, 18 px above the feet line, from the far side toward Zarg, 400 ms),
// glints, snaps (SE_BTL_HitBlowS): the target tips forward 14 deg toward Zarg (220 ms),
// 001_hit_physical + damage gate, holds 250 ms, then rights itself (350 ms).
if (!caster || !targets.length) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t;
const cf = K.feet(tl, 'c');
const TIP = 14 * Math.PI / 180;
for (const tk of TG) {
  const tf = K.feet(tl, tk), tmid = K.mid(tl, tk);
  const side = Math.sign(cf.x - tf.x) || 1;
  const y = tf.y - 18 * U, x0 = tf.x - side * 140 * U, x1 = tf.x + side * 140 * U;
  m.hold(0, t.snap, (e, S) => {
    const k = E.outQ(Math.min(1, e / t.draw)); const xe = x0 + (x1 - x0) * k;
    S.world.push({ z: 45, draw: (g) => { g.save(); g.strokeStyle = '#e9f2ff'; g.lineWidth = 3 * U; g.beginPath(); g.moveTo(x0, y); g.lineTo(xe, y); g.stroke(); g.restore(); } });
  });
  K.twinkles(m, t.draw, { x: tf.x + side * 100 * U, y }, K.tintF(210, 4, 1.3), 2, 5, U);
  m.hold(t.blow, t.right + 350, (e, S) => {
    const q = S.tok[tk]; if (!q) return; const at = t.blow + e; let r;
    if (at < t.snap) r = E.inQ(Math.min(1, e / (t.snap - t.blow)));
    else if (at < t.right) r = 1;
    else r = 1 - E.ioQ(Math.min(1, (at - t.right) / 350));
    q.rot += side * TIP * r;
  });
  m.clip('hit', t.snap, { x: tmid.x, y: tmid.y, w: 488 * 0.85 * U, z: 50 });
}
await tl.run(T, { total: t.right + 350 + 60, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
