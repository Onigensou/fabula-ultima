// Hina: the wisp spells (approved mockup, Round 2). cfg.mode picks one:
//   drain   (Drain Spirit): blue circle, absorb on the target, five blue wisps 160 ms
//           apart trail back to her; silent wisps, ONE finish sound (Up4) at the end.
//   symptom (Symptom Shift): violet circle, cure on the ally, three sickly violet-green
//           wisps arc across to the other creature, power-down on it.
if (!caster) { K.ready(); oni.fireDone(); return; }
const mode = cfg.mode;
const selfT = (ctx.targetTokens || []).some((x) => x && x.id === caster.id);
if (!targets.length && !(mode === 'symptom' && selfT)) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t; const dir = K.dirOf(TOK, 'c');
const at = (k, pos) => pos === 'feet' ? K.feet(tl, k) : K.mid(tl, k);
const fx = (key, tt, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; const al = o.alpha; m.clip(key, tt, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * (d.ro ? 1.9 : 1) * U, z: o.z || 50, add: !!o.add, filter: o.filter, alpha: al ? () => al : undefined }); };
const flashA = (tt, k, a) => m.tint(tt, 220, k, '#ffffff', (u) => (a || 0.6) * (1 - u));
const R = t.rel;
K.step(m, E, U, dir, 'c', 0, 0, t.back, 46);
K.circle(tl, m, U, 'c', 380, R - 380, cfg.hue, { dx: dir * 46 * U });
const cm = K.mid(tl, 'c'); const outMid = { x: cm.x + dir * 46 * U, y: cm.y };
if (mode === 'drain') {
  const k = TG[0]; const c0 = at(k, 'mid');
  fx('absorb', R, c0, { scale: 0.8, alpha: 0.8 });
  flashA(R + 400, k);
  const BLUE = ['110,180,255', '90,160,255', '150,210,255', '120,190,255', '100,170,255'];
  BLUE.forEach((rgb, i) => {
    const end = K.wisp(m, R + 400 + i * 160, { x: c0.x + (Math.random() - 0.5) * 60 * U, y: c0.y + (Math.random() - 0.5) * 70 * U }, { x: outMid.x, y: outMid.y + (Math.random() - 0.5) * 30 * U }, { U, rgb, rad: 7, arcH: 90 + i * 22 });
    flashA(end, 'c', 0.3);
  });
  flashA(t.back, 'c', 0.7);
} else if (mode === 'symptom') {
  // which target is the ally (sickness leaves) and which receives it: the one on the
  // caster's side is the source; the other is the destination; else list order.
  // (The dark / Down2 cues still play when there is no destination.)
  const disp = caster.document && caster.document.disposition;
  const keys = TG.slice(); if (selfT) keys.push('c');
  const tokOf = (k) => TOK[k].token;
  // no one on her side in the list: the sickness leaves Hina herself
  const src = keys.find((k) => tokOf(k) && tokOf(k).document && tokOf(k).document.disposition === disp) || (keys.length === 1 ? 'c' : keys[0]);
  const dst = keys.find((k) => k !== src) || null;
  fx('cure', R, at(src, 'feet'));
  if (dst) {
    const a0 = src === 'c' ? outMid : at(src, 'mid'); const a1 = at(dst, 'mid');
    ['170,110,255', '150,230,120', '190,120,255'].forEach((rgb, i) => K.wisp(m, R + 500 + i * 180, { x: a0.x + (i - 1) * 25 * U, y: a0.y }, a1, { U, rgb, rad: 6.5, travelMs: 1000, arcH: 170 }));
    fx('pd1', t.down, at(dst, 'feet'));
  }
}
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
