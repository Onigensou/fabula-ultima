// Hina: the step-out actives (approved mockup). cfg.mode picks one:
//   pulse (Avatar of Vengeance: Pulse) | roar (Draconic Roar) | bimagus | book (Encyclopedia Strike)
if (!caster) { K.ready(); oni.fireDone(); return; }
const mode = cfg.mode;
if ((mode === 'pulse' || mode === 'roar' || mode === 'book') && !targets.length) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t; const dir = K.dirOf(TOK, 'c'); const NT = TG.length;
const at = (k, pos) => pos === 'feet' ? K.feet(tl, k) : K.mid(tl, k);
const fx = (key, tt, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; m.clip(key, tt, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * (d.ro ? 1.9 : 1) * U, z: o.z || 50, add: !!o.add, filter: o.filter }); };
const hurt = (tt, k) => { m.tint(tt, 220, k, '#ffffff', (u) => 0.6 * (1 - u)); const d = -K.dirOf(TOK, k); m.hold(tt, tt + 300, (e, S) => { const q = S.tok[k]; if (q) q.dx += d * Math.sin(e / 300 * Math.PI * 4) * 9 * U * (1 - e / 300); }); };
const flashA = (tt, k) => m.tint(tt, 220, k, '#ffffff', (u) => 0.6 * (1 - u));
const dist = t.dist || 46;
K.step(m, E, U, dir, 'c', 0, 0, t.back, dist);
const cf = K.feet(tl, 'c'); const out = { x: cf.x + dir * dist * U, y: cf.y };
const outMid = { x: out.x, y: out.y - TOK.c.h * 0.5 };
if (mode === 'pulse') {
  // the Avatar's red light: a glow behind her (the mockup's drop-shadow) + a warm tint,
  // rising over 400 ms and kept until the last burst is done
  const a0 = 380, a1 = t.auraEnd;
  m.hold(a0, a1, (e, S) => { const k = Math.min(1, E.sine(Math.min(1, e / 400))) * (e > a1 - a0 - 200 ? (a1 - a0 - e) / 200 : 1); const q = S.tok.c; const f = K.feet(tl, 'c'); const x = f.x + q.dx, y = f.y + q.dy - TOK.c.h * 0.5;
    S.world.push({ z: 4, draw: (g) => { const r = TOK.c.h * 0.62; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,90,31,' + (0.55 * k).toFixed(3) + ')'); gr.addColorStop(0.6, 'rgba(255,90,31,' + (0.22 * k).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(255,90,31,0)'); g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill(); g.restore(); } });
    if (0.3 * k > q.tintA) { q.tint = '#ffb27a'; q.tintA = 0.3 * k; } });
  TG.forEach((k, i) => { fx('fire1', 780 + i * 150, at(k, 'feet'), { scale: 0.75 }); flashA(780 + i * 150 + 67, k); });
} else if (mode === 'roar') {
  m.dim(0, 400, 0.4);
  fx('shout', 380, outMid, { scale: 0.55, add: true });
  m.shake(630, 600, 16 * U); TG.forEach((k) => hurt(630, k));
  TG.forEach((k, i) => fx('pd1', 1130 + i * 120, at(k, 'feet')));
  m.undim(t.back, 500, 0.4);
} else if (mode === 'bimagus') {
  // two sigil orbs (gold, blue) circle her for 1300 ms; the half of the orbit behind
  // her draws under her sprite
  const cols = ['#ffd36a', '#8fd0ff'];
  m.hold(380, 1680, (e, S) => { const u = E.sine(e / 1300);
    for (let i = 0; i < 2; i++) { const a = u * Math.PI * 4 + i * Math.PI; const x = outMid.x + Math.cos(a) * 70 * U, y = outMid.y + Math.sin(a) * 26 * U; const col = cols[i];
      S.world.push({ z: Math.sin(a) > 0 ? 60 : 4, draw: (g) => { const r = 20 * U; const gr = g.createRadialGradient(x, y, 0, x, y, r * 1.414); gr.addColorStop(0, '#fff'); gr.addColorStop(0.18, '#fff'); gr.addColorStop(0.4, col); gr.addColorStop(0.72, 'rgba(0,0,0,0)'); g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill(); g.restore(); } }); } });
  fx('pu2', 980, out);
} else if (mode === 'book') {
  // the Encyclopedia spins (900 deg) along an arc (height 150) from her hand to the target
  const k = TG[0]; const tc = at(k, 'mid'); const hand = { x: out.x + dir * 34 * U, y: out.y - TOK.c.h * 0.45 };
  m.hold(380, 1000, (e, S) => { const u = e / 620; const x = hand.x + (tc.x - hand.x) * u, y = hand.y + (tc.y - hand.y) * u - Math.sin(u * Math.PI) * 150 * U; const rot = u * 900 * Math.PI / 180;
    S.world.push({ z: 60, draw: (g) => { const w = 46 * U, h = 58 * U; g.save(); g.translate(x, y); g.rotate(rot);
      g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 4 * U; g.shadowOffsetY = 2 * U;
      g.fillStyle = '#8e4426'; g.fillRect(-w / 2, -h / 2, w, h); g.shadowColor = 'rgba(0,0,0,0)';
      g.fillStyle = '#5b2a17'; g.fillRect(-w / 2, -h / 2, w * 0.18, h);
      g.fillStyle = '#f1e2bf'; g.fillRect(w / 2 - 5 * U, -h / 2 + 2 * U, 5 * U, h - 4 * U);
      g.restore(); } }); });
  fx('hit', 1000, tc, { scale: 1.3 }); m.shake(1000, 260, 8 * U); hurt(1000, k);
  K.twinkles(m, 1000, tc, K.tintF(45, 4, 1.3), 6, 40, U);
}
await tl.run(T, { total: t.total, sfx: (cfg.sfx || []).filter((c) => !c.n || c.n <= NT), onStart: K.ready });
oni.fireDone();
