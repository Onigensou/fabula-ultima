// Hina: Bind and Summon -- The Wandering Flame (approved mockup, Hina exclusive).
// Ember-red dim, fire-red hexagram circle, a fire pillar behind her, the Wandering
// Flame descends out of the sky trailing embers into a hover in front of her (toward
// centre stage), roars (shake, wings flare), dissolves into six crimson wisps that pour
// into her; fire burst + red power-up at her feet; she keeps a burning aura a moment.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, U, E } = B;
const t = cfg.t; const dir = K.dirOf(TOK, 'c'); const SC = tl.SCENE; const C = TOK.c;
const fx = (key, tt, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; m.clip(key, tt, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * (d.ro ? 1.9 : 1) * U, z: o.z || 50, add: !!o.add, filter: o.filter }); };
const tdim = (at, inMs, to, color, outAt, outMs) => m.hold(at, outAt + outMs, (e, S) => { const tt = at + e; const a = tt < at + inMs ? to * E.sine(e / inMs) : tt < outAt ? to : to * (1 - E.sine((tt - outAt) / outMs)); S.world.push({ z: 0, draw: (g) => { g.save(); g.globalAlpha = a; g.fillStyle = color; g.fillRect(SC.x - SC.w, SC.y - SC.h, SC.w * 3, SC.h * 3); g.restore(); } }); });
const R = t.rel, F = t.fin;
tdim(0, 600, 0.55, '#1c0602', t.dimOut, 600);
K.step(m, E, U, dir, 'c', 0, 0, F, 46);
K.circle(tl, m, U, 'c', 380, R - 380, 12, { dx: dir * 46 * U });
const f = K.feet(tl, 'c'); const out = { x: f.x + dir * 46 * U, y: f.y }; const outMid = { x: out.x, y: out.y - C.h * 0.5 };
// fire pillar just behind her (ground layer)
fx('pillar', R, { x: out.x - dir * 60 * U, y: f.y - 2 * U }, { scale: 1.2, add: true, z: 2, filter: 'hue-rotate(-35deg) saturate(1.6)' });
// the Flame: 320 x 467 (mockup px), mirrored to face the enemy; home = 190 px toward the
// enemy and up to 150 px toward the stage's vertical centre from her feet
const img = tl.IMG.wflame; const W = 320 * U, H = 467 * U;
const vy = Math.max(-150 * U, Math.min(150 * U, tl.REST.cy - f.y));
const home = { x: out.x + dir * 190 * U, y: f.y + vy };
const D0 = R, D1 = R + 1200, D2 = R + 1700, D3 = R + 2600;
const posAt = (e) => {
  if (e < D1) { const u = E.outQ((e - D0) / 1200); return { x: home.x - dir * 120 * U * (1 - u), y: home.y - 540 * U * (1 - u) }; }
  const b = Math.min(e, D2); return { x: home.x, y: home.y + Math.sin((b - D1) / 400) * 8 * U };
};
if (img) m.hold(D0, D3, (e0, S) => {
  const e = D0 + e0; const p = posAt(e); let a = 1, glow = 22, br = 1.1;
  if (e >= D1 && e < D2) { const s = Math.sin((e - D1) / 500 * Math.PI); glow = 22 + 30 * s; br = 1.1 + 0.5 * s; }
  else if (e >= D2) { const u = (e - D2) / 900; a = 1 - E.inQ(u); glow = 40; br = 1.6 + u; }
  S.world.push({ z: 45, draw: (g) => { if (a <= 0) return; g.save(); g.translate(p.x, p.y); g.scale(dir < 0 ? -1 : 1, 1); g.globalAlpha = a; g.shadowColor = '#ff6a1f'; g.shadowBlur = glow * U; g.filter = 'brightness(' + br.toFixed(2) + ')'; g.drawImage(img, -W / 2, -H, W, H); g.restore(); } });
});
// embers off the Flame while it descends (one GG twinkle every 120 ms)
for (let e = D0; e < D1; e += 120) { const p = posAt(e); K.twinkles(m, e, { x: p.x, y: p.y - H * 0.3 }, K.tintF(20, 4, 1.3), 1, 60, U); }
m.shake(D1, 500, 10 * U);
// six crimson wisps pour from the Flame into her
const c0 = { x: home.x, y: home.y - H * 0.55 };
['255,80,95', '255,120,90', '255,150,135', '255,95,60', '255,175,120', '255,110,70'].forEach((rgb, i) => K.wisp(m, D2 + i * 110, { x: c0.x + (Math.random() - 0.5) * 140 * U, y: c0.y + (Math.random() - 0.5) * 160 * U }, outMid, { U, rgb, rad: 6.5, liftMs: 220, travelMs: 700, arcH: 40 }));
// the Avatar's power: flash, fire burst, red power-up, a burning aura kept till t.auraEnd
m.flash(F, 75, 225, '#ffb070', 0.35);
fx('fire1', F, out, { scale: 0.8 });
fx('pu2', F, out, { filter: 'hue-rotate(-45deg) saturate(1.5)' });
m.hold(F, t.auraEnd, (e, S) => { const k = e > t.auraEnd - F - 250 ? (t.auraEnd - F - e) / 250 : Math.min(1, e / 150); const q = S.tok.c; const x = f.x + q.dx, y = f.y + q.dy - C.h * 0.5;
  S.world.push({ z: 4, draw: (g) => { const r = C.h * 0.55; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,90,31,' + (0.5 * k).toFixed(3) + ')'); gr.addColorStop(0.6, 'rgba(255,90,31,' + (0.18 * k).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(255,90,31,0)'); g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill(); g.restore(); } });
  if (0.2 * k > q.tintA) { q.tint = '#ffb27a'; q.tintA = 0.2 * k; } });
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
