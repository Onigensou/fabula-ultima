// Bolt spells cast by anyone (gear + class parents, 2026-11-06). cfg.mode picks one:
//   fulgur       — tier 1: the Glacies-style cast (step out, yellow circle), then a
//                  SMALL spark burst on each target, 140 ms apart.
//   thunderstorm — Rumbling Staves' Chain 3 seek: the same cast, then three bolts
//                  from the sky, one per planned strike, each on the strike's REAL
//                  target (the plan already followed any redirect). oni.hit() on
//                  each bolt's contact frame reveals that strike's number. A miss
//                  strikes the ground beside the target; a lost strike draws nothing.
// No plan (Preview Bench): the bolts pick random targets so the shot still reads.
// Storage rules: no backticks and no dollar-brace anywhere in this file.
if (!caster) { K.ready(); oni.fireDone(); return; }
const mode = cfg.mode;
if (!targets.length) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t; const dir = K.dirOf(TOK, 'c');
const R = t.rel;
const fx = (key, tt, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; m.clip(key, tt, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * U, z: o.z || 50, add: !!o.add }); };
const hurt = (tt, k) => { m.tint(tt, 220, k, '#fff6b0', (u) => 0.65 * (1 - u)); const d = -K.dirOf(TOK, k); m.hold(tt, tt + 300, (e, S) => { const q = S.tok[k]; if (q) q.dx += d * Math.sin(e / 300 * Math.PI * 4) * 9 * U * (1 - e / 300); }); };
const once = (at, fn) => { let done = false; m.hold(at, 1e9, () => { if (done) return; done = true; try { fn(); } catch (e) { console.warn('[gear-bolt] cue threw', e); } }); };
K.step(m, E, U, dir, 'c', 0, 0, t.back || R, 46);
K.circle(tl, m, U, 'c', 380, R - 380, cfg.hue, { dx: dir * 46 * U, scale: t.scale });
if (mode === 'fulgur') {
  // tier 1: a small crackle on each target (005 hit clip at ~55 %), damage on the burst
  TG.forEach((k, i) => { const at = R + i * 140; fx('spark', at, K.mid(tl, k), { scale: t.sparkScale, add: true }); hurt(at + 120, k); });
} else if (mode === 'thunderstorm') {
  const byUuid = {}; targets.forEach((tok, i) => { byUuid[tok.document.uuid] = TG[i]; });
  const plan = oni.strikes || [];
  const n = plan.length || t.bolts;
  for (let i = 0; i < n; i++) {
    const at = R + i * t.gap;
    const s = plan[i]; const o = s && s.outcomes ? s.outcomes[0] : null;
    const k = (o && byUuid[o.tokenUuid]) || TG[Math.floor(Math.random() * TG.length)];
    const kind = o ? o.kind : 'hit';
    if (kind !== 'lost' && kind !== 'skip') {
      const f = K.feet(tl, k);
      const p = kind === 'miss' ? { x: f.x + (i % 2 ? 1 : -1) * TOK[k].w * 0.55, y: f.y } : f;
      fx('bolt', at, p, { scale: t.boltScale, add: true, z: 60 });
      m.flash(at + t.contact, 40, 140, '#fffbe0', 0.22);
      m.shake(at + t.contact, 220, 7 * U);
      if (kind !== 'miss') hurt(at + t.contact, k);
    }
    // one cue per planned strike, in order, even for a miss or a lost bolt
    once(at + t.contact, () => oni.hit({ paced: true }));
  }
}
await tl.run(T, { total: t.total, sfx: (cfg.sfx || []).filter((c) => !c.n || c.n <= (mode === 'fulgur' ? TG.length : 99)), onStart: K.ready });
oni.fireDone();
