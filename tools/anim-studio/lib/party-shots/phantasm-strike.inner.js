// Create Phantasm: Strike — approved mockup (Party Action Animations v8).
// cfg.skin: 'mirage' (Illusionist default) | 'foxfire' (Keren). The caster's real
// token is hidden by oni.timeline for the whole run (renderable guard), so there is
// never a duplicate; her step is painted from her own texture.
if (!caster || !targets.length) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const skinName = cfg.skin === 'foxfire' ? 'foxfire' : 'mirage';
const hue = skinName === 'foxfire' ? 330 : 275;
const dir = K.dirOf(TOK, 'c');
const tk = TG[0], TT = TOK[tk];
const cf = K.feet(tl, 'c');
const tf = K.feet(tl, tk), tmid = K.mid(tl, tk);
const skin = K.skin(tl, skinName, U);
const spot = K.summonSpot(tl, 'c');
const t = cfg.t;
// Keren: step out 40, hold, back
K.step(m, E, U, dir, 'c', 0, 0, t.back, 40);
K.circle(tl, m, U, 'c', t.cast, t.castHold, hue, { dx: dir * 40 * U });
const sx = cf.x + dir * 40 * U;
const dest = { x: tf.x - dir * 150 * U, y: tf.y };
let pos;
if (skinName === 'foxfire') {
  const born = { x: sx + dir * 90 * U, y: cf.y - 10 * U };
  m.clip('burst', t.appear, { x: born.x, y: born.y - 90 * U, w: 682 * 0.35 * 0.85 * U, z: 40, add: true, filter: K.tintF(330) });
  pos = (e) => {
    const a = t.appear;
    if (e < t.dash - a) { const u = Math.min(1, e / 300); return { x: born.x, y: born.y, a: u, s: 0.2 + 0.8 * u }; }
    if (e < t.slash1 - a) { const u = E.ioQ((e - (t.dash - a)) / (t.slash1 - t.dash)); return { x: born.x + (dest.x - born.x) * u, y: born.y + (dest.y - born.y) * u - Math.sin(u * Math.PI) * 40 * U, a: 1, s: 1 }; }
    if (e < t.leave - a) { const k = (e - (t.slash1 - a)) % 300; const lunge = k < 140 ? E.outQ(k / 140) : 1 - E.ioQ((k - 140) / 160); return { x: dest.x + dir * 40 * U * lunge, y: dest.y, a: 1, s: 1 }; }
    const u = E.ioQ(Math.min(1, (e - (t.leave - a)) / 800));
    const end = (e - (t.leave - a) > 1100) ? Math.max(0, 1 - (e - (t.leave - a) - 1100) / 300) : 1;
    return { x: dest.x + (spot.x - dest.x) * u, y: dest.y + (spot.y - dest.y) * u - Math.sin(u * Math.PI) * 120 * U, a: end, s: 1 };
  };
  K.phantasm(m, skin, t.appear, t.leave + 1400, pos, true);
} else {
  pos = (e) => {
    const a = t.appear;
    if (e < t.dash - a) { const u = E.outQ(Math.min(1, e / 450)); return { x: sx + dir * 70 * U * u, y: cf.y, a: 0.78 * u, s: 1 }; }
    const st = { x: sx + dir * 70 * U, y: cf.y };
    if (e < t.slash1 - a) { const u = E.ioQ((e - (t.dash - a)) / (t.slash1 - t.dash)); return { x: st.x + (dest.x - st.x) * u, y: st.y + (dest.y - st.y) * u - Math.sin(u * Math.PI) * 40 * U, a: 0.78, s: 1 }; }
    if (e < t.leave - a) { const k = (e - (t.slash1 - a)) % 300; const lunge = k < 140 ? E.outQ(k / 140) : 1 - E.ioQ((k - 140) / 160); return { x: dest.x + dir * 40 * U * lunge, y: dest.y, a: 0.78, s: 1 }; }
    return { x: dest.x, y: dest.y, a: 0.78 * Math.max(0, 1 - (e - (t.leave - a)) / 350), s: 1 };
  };
  K.phantasm(m, skin, t.appear, t.leave + 360, pos, true);
  m.clip('vanish', t.leave, { x: dest.x, y: dest.y, w: 332 * 1.9 * 0.85 * 0.9 * U, z: 40, add: true, filter: 'hue-rotate(65deg) brightness(1.2)' });
  const wEnd = K.wisp(m, t.leave + 350, { x: dest.x, y: dest.y - (TOK.c.h * 0.5) }, { x: spot.x, y: spot.y - 60 * U }, { U, rgb: '190,150,255', rad: 7, arcH: 110 });
  m.clip('burst', wEnd, { x: spot.x, y: spot.y - 60 * U, w: 682 * 0.35 * 0.85 * U, z: 40, add: true, filter: K.tintF(275) });
}
// two claw slashes on the target; damage gate on the second
for (let i = 0; i < 2; i++) m.clip('slash', t.slash1 + i * 300, { x: tmid.x, y: tmid.y, w: 512 * 0.42 * 0.85 * U, z: 50, add: true, filter: K.tintF(hue, 5, 1.2), rot: i ? -0.35 : 0.35, flip: i === 1 });
m.clip('pierce', t.slash1 + 300, { x: tmid.x, y: tmid.y, w: 660 * 0.85 * 0.8 * U, z: 51, add: true, filter: 'hue-rotate(' + (hue - 40) + 'deg)' });
m.shakeTok(t.slash1 + 300, tk, 300, 9 * U);
m.tint(t.slash1 + 300, 220, tk, '#ffffff', (u) => 0.5 * (1 - u));
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
