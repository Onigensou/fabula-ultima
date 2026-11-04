// Multi Shatter — approved mockup (v8, round 2). Up to 3 of the caster's OWN
// phantasms already on the field (token flags isPhantasm + summonedBy = caster
// actor uuid; nearest first) flare while she channels, then each charges its own
// target from where it stands and shatters on impact: glass shards (mirage) or
// pink embers + burst (foxfire), 001_hit_physical, damage.
// Pairing: phantasm i -> target i. With NO phantasm on the board (Preview Bench)
// the skin is drawn at the mockup's three spots around K.summonSpot instead. With
// fewer phantasms than targets, the extra targets still take the shatter + hit at
// their impact time, without a charging body (nothing to send).
// cfg.skin: 'mirage' (Illusionist class default) | 'foxfire' (Keren).
if (!caster) { K.ready(); oni.fireDone(); return; }
const NS = 'fabula-ultima-companion';
const ownerUuid = caster.actor ? caster.actor.uuid : null;
const isMine = (tk) => { const f = (tk && tk.document && tk.document.flags && tk.document.flags[NS]) || {}; return !!f.isPhantasm && String(f.summonedBy || '') === String(ownerUuid); };
for (let i = targets.length - 1; i >= 0; i--) if (isMine(targets[i])) targets.splice(i, 1);
if (targets.length > 3) targets.length = 3;
const all = (canvas.tokens && canvas.tokens.placeables) || [];
const dist = (tk) => Math.hypot(tk.center.x - caster.center.x, tk.center.y - caster.center.y);
const mine = all.filter(isMine).sort((a, b) => dist(a) - dist(b)).slice(0, Math.max(1, targets.length));
const extra = {}; mine.forEach((tk, i) => { extra['p' + i] = { token: tk }; });
const B = await boot(extra);
const { tl, T, m, TOK, TG, U, E } = B;
if (!TG.length) { await tl.run(T, { total: 10, onStart: K.ready }); oni.fireDone(); return; }
const t = cfg.t;
const skinName = cfg.skin === 'foxfire' ? 'foxfire' : 'mirage';
const hue = skinName === 'foxfire' ? 330 : 275;
const dir = K.dirOf(TOK, 'c');
const drawArt = (g, k, x, y, a, s, filter) => { const art = tl.art(k), T0 = TOK[k]; if (!art || !T0 || a <= 0) return; g.save(); g.translate(x, y); g.scale(T0.flip * s, s); g.globalAlpha = a; if (filter) g.filter = filter; g.drawImage(art, -T0.w / 2, -T0.h * T0.foot, T0.w, T0.h); g.restore(); };
// Keren: cast() = step out 46, Magic4, circle (hold 600), back after the last hit clip
const lastImpact = t.charge + (TG.length - 1) * t.stagger + t.travel;
K.step(m, E, U, dir, 'c', 0, 0, lastImpact + t.hitMs, 46);
K.circle(tl, m, U, 'c', t.cast, t.castHold, hue, { dx: dir * 46 * U });
// fallback spots (mockup SPOTS relative to the summon spot)
const base = K.summonSpot(tl, 'c');
const SP = [[0, 0], [110, -120], [15, 130]].map((o) => ({ x: base.x + dir * o[0] * U, y: base.y + o[1] * U }));
const skin = mine.length ? null : K.skin(tl, skinName, U);
const sfx = (cfg.sfx || []).slice();
TG.forEach((tk, i) => {
  const at = t.charge + i * t.stagger, hit = at + t.travel;
  const tf = K.feet(tl, tk), tmid = K.mid(tl, tk);
  const dest = { x: tf.x - dir * 70 * U, y: tf.y };
  const pk = mine[i] ? 'p' + i : null;
  if (pk) {
    const P0 = K.feet(tl, pk);
    const posAt = (e) => { const u = E.inQ(Math.min(1, Math.max(0, e / t.travel))); return { x: P0.x + (dest.x - P0.x) * u, y: P0.y + (dest.y - P0.y) * u }; };
    // flare (x1.15) from the cast release, then the charge; hidden once it shatters
    m.hold(t.flare, at, (e, S) => { const q = S.tok[pk]; q.sx *= 1.15; q.sy *= 1.15; });
    m.hold(at, hit, (e, S) => {
      const q = S.tok[pk]; const p = posAt(e); q.dx += p.x - P0.x; q.dy += p.y - P0.y; q.sx *= 1.15; q.sy *= 1.15;
      S.world.push({ z: 29, draw: (g) => { for (let j = 4; j >= 1; j--) { const pp = posAt(e - j * 60); drawArt(g, pk, pp.x, pp.y, 0.3 * (1 - j / 5), 1.15, 'blur(2px)'); } } });
    });
    m.hold(hit, 1e9, (e, S) => { S.tok[pk].hidden = true; });
  } else if (skin) {
    const P0 = SP[i % 3];
    K.phantasm(m, skin, 0, hit, (e) => {
      if (e < at) return { x: P0.x, y: P0.y, a: (skinName === 'foxfire' ? 1 : 0.78) * Math.min(1, e / 350), s: e >= t.flare ? 1.15 : 1 };
      const u = E.inQ(Math.min(1, (e - at) / t.travel)); return { x: P0.x + (dest.x - P0.x) * u, y: P0.y + (dest.y - P0.y) * u, a: skinName === 'foxfire' ? 1 : 0.78, s: 1.15 };
    }, true);
  }
  // shatter + hit on impact
  if (skinName === 'foxfire') {
    m.clip('burst', hit, { x: tmid.x, y: tmid.y, w: 682 * 0.85 * 0.4 * U, z: 52, add: true, filter: K.tintF(330) });
    K.shards(tl, m, hit, tmid, '#ff8fc4', 12, 140, U, 11 + i);
  } else K.shards(tl, m, hit, tmid, '#c9a8ff', 14, 150, U, 11 + i);
  m.clip('hit', hit, { x: tmid.x, y: tmid.y, w: 488 * 0.85 * 1.2 * U, z: 53 });
  m.shakeTok(hit, tk, 300, 9 * U);
  m.tint(hit, 220, tk, '#ffffff', (u) => 0.6 * (1 - u));
  if (cfg.hitSfx) sfx.push({ at: hit, url: cfg.hitSfx.url, v: cfg.hitSfx.v });
});
await tl.run(T, { total: Math.max(t.total, lastImpact + 1100), sfx, onStart: K.ready });
oni.fireDone();
