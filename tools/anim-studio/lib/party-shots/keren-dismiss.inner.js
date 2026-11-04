// Birth of the Cruel: Dismiss — approved mockup (v8). Keren gestures (step 25);
// her Minion fades in a white vanish (RO vanishing1, Teleport) and breaks into
// violet shards (Break). The Minion is her REAL summon token when one is on the
// board (a target that is hers first, else the nearest: token flags isSummon +
// summonedBy = caster actor uuid, not a phantasm, not a Numen). Without one
// (Preview Bench) the mockup's violet orb stands in at the summon spot.
// No number: gate null.
if (!caster) { K.ready(); oni.fireDone(); return; }
const NS = 'fabula-ultima-companion';
const ownerUuid = caster.actor ? caster.actor.uuid : null;
const isMinion = (tk) => {
  const f = (tk && tk.document && tk.document.flags && tk.document.flags[NS]) || {};
  const p = (tk && tk.actor && tk.actor.system && tk.actor.system.props) || {};
  return !!f.isSummon && String(f.summonedBy || '') === String(ownerUuid) && !(f.isPhantasm || p.isPhantasm) && !(f.isNumen || p.isNumen);
};
const all = (canvas.tokens && canvas.tokens.placeables) || [];
const dist = (tk) => Math.hypot(tk.center.x - caster.center.x, tk.center.y - caster.center.y);
const mn = targets.find(isMinion) || all.filter(isMinion).sort((a, b) => dist(a) - dist(b))[0] || null;
for (let i = targets.length - 1; i >= 0; i--) if (mn && targets[i].id === mn.id) targets.splice(i, 1);
const B = await boot(mn ? { mn: { token: mn } } : null);
const { tl, T, m, TOK, U, E } = B;
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
K.step(m, E, U, dir, 'c', 0, 0, t.shatter, 25);
let P, core;
if (mn) {
  P = K.feet(tl, 'mn'); core = K.mid(tl, 'mn');
  // white vanish: it whitens and fades over the 300 ms, then it is gone
  m.tint(t.vanish, t.shatter - t.vanish, 'mn', '#ffffff', (u) => Math.min(1, u * 1.4));
  m.hold(t.vanish, t.shatter, (e, S) => { S.tok.mn.alpha *= 1 - E.inQ(e / (t.shatter - t.vanish)); });
  m.hold(t.shatter, t.total + 1, (e, S) => { S.tok.mn.hidden = true; });
} else {
  P = K.summonSpot(tl, 'c'); core = { x: P.x, y: P.y - 60 * U };
  K.orb(m, t.cast, core, core, t.shatter - t.cast, 0, '#b98cff', 35, U);
}
m.clip('vanish', t.vanish, { x: P.x, y: P.y, w: 332 * 0.85 * 1.9 * U, z: 40, add: true });
K.shards(tl, m, t.shatter, core, '#b98cff', 12, 120, U, 31);
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
