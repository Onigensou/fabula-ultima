// Hina: Lift off -- the jetpack gag (approved mockup, Round 2).
// A pack pops onto her back; two weak sputters and a 12 px hop that drops back with a
// tilt; second try roars, she shoots up 70 px with a wobble, hovers bobbing with
// exhaust puffs, then (as the mockup does) settles back down so the real token,
// restored at the end of the run, does not jump.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, U, E } = B;
const dir = K.dirOf(TOK, 'c'); const C = TOK.c; const f = K.feet(tl, 'c');
const fx = (key, tt, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; m.clip(key, tt, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * (d.ro ? 1.9 : 1) * U, z: o.z || 50, filter: o.filter }); };
// her lift (mockup px, up = negative), tilt (deg) and the pack's power, as functions of t
const lift = (e) => {
  if (e >= 1130 && e < 1350) return -12 * Math.sin(E.outQ((e - 1130) / 220) * Math.PI);
  if (e >= 1990 && e < 2640) return -70 * E.outQ((e - 1990) / 650);
  if (e >= 2640 && e < 4440) return -70 - Math.sin((e - 2640) / 1800 * Math.PI * 2) * 7;
  if (e >= 4440 && e < 4940) return -70 * (1 - E.ioQ((e - 4440) / 500));
  return 0;
};
const tilt = (e) => {
  if (e >= 1350 && e < 1770) return -4;
  if (e >= 1990 && e < 2640) { const u = E.outQ((e - 1990) / 650); return Math.sin(u * 18) * 4 * (1 - u); }
  return 0;
};
const power = (e) => {
  if (e >= 450 && e < 610) return 0.35 * Math.sin(E.outQ((e - 450) / 160) * Math.PI);
  if (e >= 790 && e < 950) return 0.35 * Math.sin(E.outQ((e - 790) / 160) * Math.PI);
  if (e >= 1130 && e < 1350) return 0.4 * Math.sin(E.outQ((e - 1130) / 220) * Math.PI);
  if (e >= 1770 && e < 1990) return E.outQ((e - 1770) / 220);
  if (e >= 1990 && e < 2640) return 1;
  if (e >= 2640 && e < 4440) return 0.8 + 0.2 * Math.sin((e - 2640) / 1800 * 20);
  if (e >= 4440 && e < 4940) return 0.8 * (1 - E.ioQ((e - 4440) / 500));
  return 0;
};
// the pack rides on her back (behind her facing), at 52% of her height
const back = -dir * 22 * U;
const packAt = (e) => ({ x: f.x + back, y: f.y - C.h * 0.52 + lift(e) * U });
m.hold(0, 4941, (e, S) => {
  const q = S.tok.c; q.air -= lift(e) * U; q.rot += tilt(e) * Math.PI / 180;
  const p = packAt(e); const pw = power(e);
  S.world.push({ z: 54, draw: (g) => {
    if (pw > 0.02) for (let i = 0; i < 2; i++) {
      const j = 1 + 0.25 * Math.sin(e / 30 + i * 2); const sx = 0.6 + 0.4 * pw, sy = pw * j * 1.4;
      g.save(); g.translate(p.x + (-8 + i * 16) * U, p.y + 20 * U); g.scale(sx * U, sy * U); g.globalCompositeOperation = 'lighter';
      // the CSS flame: a 26 x 70 drop, elliptical gradient centred at 50% 20% (farthest corner)
      g.translate(0, 14); g.scale(18.4, 79);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1); gr.addColorStop(0, '#fff'); gr.addColorStop(0.12, '#fff'); gr.addColorStop(0.22, '#9fe3ff'); gr.addColorStop(0.45, '#ffb347'); gr.addColorStop(0.65, 'rgba(255,90,20,0.7)'); gr.addColorStop(0.8, 'rgba(255,60,0,0)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(0, 21 / 79, 13 / 18.4, 35 / 79, 0, 0, 6.283); g.fill(); g.restore();
    }
  } });
  S.world.push({ z: 55, draw: (g) => {
    const w = 34 * U, h = 44 * U; g.save(); g.translate(p.x, p.y);
    const gr = g.createLinearGradient(-w / 2, 0, w / 2, 0); gr.addColorStop(0, '#6f7a84'); gr.addColorStop(0.4, '#b7c2cc'); gr.addColorStop(1, '#6f7a84');
    g.fillStyle = gr; g.strokeStyle = '#2a1a0e'; g.lineWidth = 2 * U; g.beginPath();
    if (g.roundRect) g.roundRect(-w / 2, -h / 2, w, h, 6 * U); else g.rect(-w / 2, -h / 2, w, h);
    g.fill(); g.stroke(); g.restore();
  } });
});
K.twinkles(m, 0, packAt(0), K.tintF(50, 4, 1.3), 2, 8, U);
// exhaust puffs (GG smoke, greyed) under the pack
const puff = (tt, dyPx, s) => fx('smoke', tt, { x: f.x + back, y: f.y + (dyPx + lift(tt)) * U }, { scale: s * 3, filter: 'brightness(.75)', z: 53 });
puff(610, -20, 0.3); puff(950, -20, 0.3); puff(1350, -20, 0.4);
fx('dash', 1770, f, { scale: 0.45, filter: 'brightness(.8)', z: 12 });
m.shake(1990, 400, 6 * U);
puff(3400, -10, 0.22); puff(4160, -10, 0.22);
await tl.run(T, { total: 5000, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
