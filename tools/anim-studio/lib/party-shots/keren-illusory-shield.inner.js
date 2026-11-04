// Illusory Shield — approved mockup (v8, round 2). A reaction: plays when the
// danger is declared, before the enemy's animation. Target = the threatened
// creature (Keren herself when the list is empty). One of the caster's OWN
// phantasms on the field (isPhantasm + summonedBy = caster actor uuid; the one
// nearest the threatened creature) slides in front of it, the blow (white GG
// slash) hits it and it breaks: glass shards (mirage) or a pink ember burst
// (foxfire). Preview Bench (no phantasm): the skin fades in at the mockup's
// second spot and does the same. No number: gate null.
if (!caster) { K.ready(); oni.fireDone(); return; }
const NS = 'fabula-ultima-companion';
const ownerUuid = caster.actor ? caster.actor.uuid : null;
const isMine = (tk) => { const f = (tk && tk.document && tk.document.flags && tk.document.flags[NS]) || {}; return !!f.isPhantasm && String(f.summonedBy || '') === String(ownerUuid); };
const ward = targets[0] || caster;
for (let i = targets.length - 1; i >= 1; i--) targets.splice(i, 1);
const all = (canvas.tokens && canvas.tokens.placeables) || [];
const near = (tk) => Math.hypot(tk.center.x - ward.center.x, tk.center.y - ward.center.y);
const ph = all.filter((tk) => isMine(tk) && tk.id !== ward.id).sort((a, b) => near(a) - near(b))[0] || null;
const B = await boot(ph ? { ph: { token: ph } } : null);
const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t;
const skinName = cfg.skin === 'foxfire' ? 'foxfire' : 'mirage';
const wk = TG[0] || 'c';
const wf = K.feet(tl, wk);
const wdir = K.dirOf(TOK, wk);
const to = { x: wf.x + wdir * 110 * U, y: wf.y + 10 * U };
const t0 = ph ? 0 : t.fade;
const mv = t0, arrive = mv + t.move, blow = arrive + t.wait, brk = blow + t.breakAfter, total = brk + t.tail;
let hitPt;
if (ph) {
  const P0 = K.feet(tl, 'ph');
  hitPt = { x: to.x, y: to.y - TOK.ph.h / 2 };
  m.hold(mv, brk, (e, S) => { const u = E.ioQ(Math.min(1, e / t.move)); const q = S.tok.ph; q.dx += (to.x - P0.x) * u; q.dy += (to.y - P0.y) * u; });
  m.hold(brk, total + 1, (e, S) => { S.tok.ph.hidden = true; });
} else {
  const skin = K.skin(tl, skinName, U);
  const base = K.summonSpot(tl, 'c');
  const dir = K.dirOf(TOK, 'c');
  const P0 = { x: base.x + dir * 110 * U, y: base.y - 120 * U };
  const al = skinName === 'foxfire' ? 1 : 0.78;
  hitPt = { x: to.x, y: to.y - skin.h / 2 };
  K.phantasm(m, skin, 0, brk, (e) => {
    if (e < mv) return { x: P0.x, y: P0.y, a: al * E.outQ(Math.min(1, e / t.fade)), s: 1 };
    const u = E.ioQ(Math.min(1, (e - mv) / t.move)); return { x: P0.x + (to.x - P0.x) * u, y: P0.y + (to.y - P0.y) * u, a: al, s: 1 };
  }, false);
}
// the incoming blow (white GG slash), then it breaks
m.clip('slash', blow, { x: hitPt.x, y: hitPt.y, w: 512 * 0.85 * 0.45 * U, z: 52, add: true, filter: 'brightness(1.4)' });
if (skinName === 'foxfire') {
  m.clip('burst', brk, { x: hitPt.x, y: hitPt.y, w: 682 * 0.85 * 0.4 * U, z: 53, add: true, filter: K.tintF(330) });
  K.shards(tl, m, brk, hitPt, '#ff8fc4', 14, 150, U, 21);
} else K.shards(tl, m, brk, hitPt, '#d7c4ff', 18, 170, U, 21);
const sfx = [{ at: mv, url: cfg.s.evasion.url, v: cfg.s.evasion.v }, { at: blow, url: cfg.s.slash.url, v: cfg.s.slash.v }, { at: brk, url: cfg.s.brk.url, v: cfg.s.brk.v }];
await tl.run(T, { total, sfx, onStart: K.ready });
oni.fireDone();
