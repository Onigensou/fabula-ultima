// Hina: the cast-then-clip spells (approved mockup). cfg.mode picks one:
//   glacies | iceberg | heal | cleanse | dispel | shroud | weapon | bind
// Shape: step out 46, cast sound, RO hexagram circle in the school colour (700 ms
// hold), release + step back, then the MV clip on each target. Heal is shared by
// every caster (Hina, Blanche, class parents): the caster is whoever casts.
// A self-target (caster in the target list) gets the clip on the caster too.
if (!caster) { K.ready(); oni.fireDone(); return; }
const mode = cfg.mode;
const selfT = (ctx.targetTokens || []).some((x) => x && x.id === caster.id);
if (!targets.length && !selfT && mode !== 'bind') { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t; const dir = K.dirOf(TOK, 'c');
const ALL = TG.concat(selfT ? ['c'] : []); const NT = ALL.length;
const at = (k, pos) => pos === 'feet' ? K.feet(tl, k) : K.mid(tl, k);
const fx = (key, tt, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; m.clip(key, tt, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * (d.ro ? 1.9 : 1) * U, z: o.z || 50, add: !!o.add, filter: o.filter }); };
const hurt = (tt, k) => { m.tint(tt, 220, k, '#ffffff', (u) => 0.6 * (1 - u)); const d = -K.dirOf(TOK, k); m.hold(tt, tt + 300, (e, S) => { const q = S.tok[k]; if (q) q.dx += d * Math.sin(e / 300 * Math.PI * 4) * 9 * U * (1 - e / 300); }); };
const flashA = (tt, k) => m.tint(tt, 220, k, '#ffffff', (u) => 0.6 * (1 - u));
const R = t.rel;
K.step(m, E, U, dir, 'c', 0, 0, t.back || R, 46);
K.circle(tl, m, U, 'c', 380, R - 380, cfg.hue, { dx: dir * 46 * U, scale: t.scale });
if (mode === 'glacies') {
  // frost burst on each target, 160 ms apart; damage on each burst (impact 200)
  TG.forEach((k, i) => { fx('ice1', R + i * 160, at(k, 'mid')); hurt(R + i * 160 + 200, k); });
} else if (mode === 'iceberg') {
  const k = TG[0] || 'c';
  fx('ice2', R, at(k, 'feet'), { scale: 1.75 }); m.shake(R + 200, 380, 14 * U); hurt(R + 200, k);
} else if (mode === 'heal') {
  ALL.forEach((k, i) => fx('heal', R + i * 140, at(k, 'feet')));
} else if (mode === 'cleanse') {
  ALL.forEach((k, i) => fx('cure', R + i * 140, at(k, 'feet')));
} else if (mode === 'dispel') {
  const k = ALL[0]; const c = at(k, 'mid');
  fx('neutral', R, c); flashA(R + 67, k); K.shards(tl, m, R + 67, c, '#ffd36a', 16, 160, U, 11);
} else if (mode === 'shroud') {
  // The player picks the element at resolve and the shot cannot see it: the crest
  // plays UNTINTED (053_powerup_3's own colour) with the circle at its native hue.
  ALL.forEach((k, i) => fx('pu3', R + i * 140, at(k, 'mid')));
} else if (mode === 'weapon') {
  // Same: no element known here, so the sparks and the power-up keep 052's native gold.
  const k = ALL[0]; const f = K.feet(tl, k); const hand = { x: f.x + K.dirOf(TOK, k) * 34 * U, y: f.y - TOK[k].h * 0.45 };
  K.twinkles(m, R, hand, K.tintF(cfg.hue, 4, 1.3), 7, 30, U);
  fx('pu2', R + 400, at(k, 'feet'));
} else if (mode === 'bind') {
  // class default: big gold circle, a light pillar at the summon spot, white flash
  m.dim(0, 500, 0.35);
  fx('pillar', R, K.summonSpot(tl, 'c'), { scale: 1.4 });
  m.flash(R + 1200, 100, 300, '#ffffff', 0.6);
  m.undim(R + 2467, 500, 0.35);
}
await tl.run(T, { total: t.total, sfx: (cfg.sfx || []).filter((c) => !c.n || c.n <= NT), onStart: K.ready });
oni.fireDone();
