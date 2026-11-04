// Detonate Phantasm — approved mockup (v8). The phantasm that goes in is the REAL
// one on the field: a phantasm among the targets if the player picked one, else the
// caster's nearest own phantasm (token flags summonedBy = caster actor uuid +
// isPhantasm). It overloads where it stands, rushes the target and bursts in the
// ORIGINAL explosion (boss-loot Explosion_2_Radial_PURPLE under a 0.6 dim). With no
// phantasm on the board (Preview Bench) the skin is drawn at the summon spot instead.
if (!caster) { K.ready(); oni.fireDone(); return; }
const NS = 'fabula-ultima-companion';
const ownerUuid = caster.actor ? caster.actor.uuid : null;
const isMine = (tk) => { const f = (tk && tk.document && tk.document.flags && tk.document.flags[NS]) || {}; return !!f.isPhantasm && String(f.summonedBy || '') === String(ownerUuid); };
const all = (canvas.tokens && canvas.tokens.placeables) || [];
let ph = (ctx.targetTokens || []).find(isMine) || null;
if (!ph) { const mine = all.filter(isMine); mine.sort((a, b) => Math.hypot(a.center.x - caster.center.x, a.center.y - caster.center.y) - Math.hypot(b.center.x - caster.center.x, b.center.y - caster.center.y)); ph = mine[0] || null; }
const enemies = (ctx.targetTokens || []).filter((tk) => tk && tk.center && !isMine(tk) && tk.id !== caster.id);
// the phantasm is drawn as 'ph', never also as a target
for (let i = targets.length - 1; i >= 0; i--) if (isMine(targets[i])) targets.splice(i, 1);
const B = await boot(ph ? { ph: { token: ph } } : null);
const { tl, T, m, TOK, U, E } = B;
const tk = Object.keys(TOK).find((k) => /^t\d+$/.test(k) && enemies.some((x) => TOK[k].token && TOK[k].token.id === x.id));
if (!tk) { await tl.run(T, { total: 10, onStart: K.ready }); oni.fireDone(); return; }
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const hue = cfg.dark === false ? 48 : 280;
const tf = K.feet(tl, tk), tmid = K.mid(tl, tk);
K.step(m, E, U, dir, 'c', t.cast, t.cast, t.back, 40);
K.circle(tl, m, U, 'c', t.cast + 380, t.castHold, hue, { dx: dir * 40 * U });
const dest = { x: tf.x - dir * 60 * U, y: tf.y };
const glow = 'hsl(' + hue + ',90%,65%)';
if (ph) {
  const P0 = K.feet(tl, 'ph');
  // selection mark: a turning dashed ring under it
  K.groundRing(m, 0, t.overload, P0, 75, 75, glow, U, true);
  // overload: swell + pulse, glowing in the type colour
  m.hold(t.overload, t.rush, (e, S) => { const u = e / (t.rush - t.overload); const s = 1 + 0.45 * u + 0.08 * Math.sin(e / 25); const q = S.tok.ph; q.sx *= s; q.sy *= s; });
  m.tint(t.overload, t.rush - t.overload, 'ph', glow, (u) => 0.25 + 0.45 * u);
  // rush
  m.hold(t.rush, t.boom, (e, S) => { const u = E.inQ(e / (t.boom - t.rush)); const q = S.tok.ph; q.dx += (dest.x - P0.x) * u; q.dy += (dest.y - P0.y) * u - Math.sin(u * Math.PI) * 50 * U; q.sx *= 1.45; q.sy *= 1.45; });
  m.hold(t.boom, t.total, (e, S) => { S.tok.ph.hidden = true; });
} else {
  const skin = K.skin(tl, cfg.skin === 'foxfire' ? 'foxfire' : 'mirage', U);
  const P0 = K.summonSpot(tl, 'c');
  K.phantasm(m, skin, 0, t.boom, (e) => {
    if (e < t.rush) { const s = e > t.overload ? 1 + 0.45 * (e - t.overload) / (t.rush - t.overload) : 1; return { x: P0.x, y: P0.y, a: Math.min(1, e / 300), s }; }
    const u = E.inQ((e - t.rush) / (t.boom - t.rush)); return { x: P0.x + (dest.x - P0.x) * u, y: P0.y + (dest.y - P0.y) * u - Math.sin(u * Math.PI) * 50 * U, a: 1, s: 1.45 };
  }, true);
}
// the original explosion, under the original 0.6 dim
m.dim(t.boom, 250, 0.6); m.undim(t.boom + 1350, 250, 0.6);
m.clip('explosion', t.boom, { x: tmid.x, y: tmid.y, w: 1200 * 0.85 * 0.8 * U, z: 55, add: true });
m.shake(t.boom + 220, 520, 14 * U); m.shakeTok(t.boom + 220, tk, 400, 10 * U);
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
