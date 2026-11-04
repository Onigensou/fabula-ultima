// Stubborn Scion (Bodyguards) — approved mockup (v8, round 3), reaction cut.
// Plays when Keren is TARGETED, before the enemy's attack animation, so the
// mockup's enemy rush / swing / run-back are left out (the real attack follows).
// Leichi and Leilan drop in from above in front of her (SE_BTL_HighJump, land
// thud SE_JUMPLANDA + dash-smoke dust + small shake), raise the jade hex barrier
// (Shield1; the mockup's hexBarrier drawn on canvas in scene space), a ripple
// runs across the hexes with the guard clang (SE_GUARDC) as if braced, a small
// shove, hold ~600 ms, the barrier fades, they hop away and vanish in smoke
// (Teleport). No "Be careful!" text, no number: gate null.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, U, E } = B;
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const cf = K.feet(tl, 'c');
const flip = -dir; // their art faces left like the party's (mockup draws them unflipped)
const spots = [{ x: cf.x + dir * 115 * U, y: cf.y - 25 * U }, { x: cf.x + dir * 75 * U, y: cf.y + 45 * U }];
const imgs = [tl.IMG.leichi, tl.IMG.leilan];
const drop = 650 * U;
const G = imgs.map((img, i) => {
  const iw = (img && (img.naturalWidth || img.width)) || 150, ih = (img && (img.naturalHeight || img.height)) || 250;
  return { img, w: iw * 1.15 * U, h: ih * 1.15 * U, s: spots[i], start: i * 110 };
});
// guard position + alpha at e (ms since 0)
const gpos = (gd, e) => {
  const s = gd.s;
  if (e < gd.start + t.fall) { const u = E.inQ(Math.max(0, (e - gd.start) / t.fall)); return { x: s.x, y: s.y - drop * (1 - u), a: 1 }; }
  if (e >= t.shove && e < t.shove + 200) { const u = E.outQ((e - t.shove) / 200); return { x: s.x - dir * 14 * U * Math.sin(u * Math.PI), y: s.y, a: 1 }; }
  if (e >= t.hop) { const u = E.outQ(Math.min(1, (e - t.hop) / 260)); return { x: s.x + dir * 20 * U * u, y: s.y - 40 * U * Math.sin(u * Math.PI), a: 1 - u }; }
  return { x: s.x, y: s.y, a: 1 };
};
m.hold(0, t.hop + 261, (e, S) => S.world.push({ z: 30, draw: (g) => {
  for (const gd of G) { if (!gd.img || e < gd.start) continue; const p = gpos(gd, e); if (p.a <= 0) continue;
    g.save(); g.translate(p.x, p.y); g.scale(flip, 1); g.globalAlpha = p.a; g.filter = 'drop-shadow(0 4px 3px rgba(0,0,0,.35))'; g.drawImage(gd.img, -gd.w / 2, -gd.h, gd.w, gd.h); g.restore(); }
} }));
// landing dust + thud
m.shake(t.land, 200, 5 * U);
for (const gd of G) m.clip('dashsmoke', t.land, { x: gd.s.x, y: gd.s.y - 10 * U, w: 1024 * 0.85 * 0.3 * U, z: 31, filter: 'brightness(.85)' });
// the jade hex barrier (mockup hexBarrier: 150 x 330, hex r 16, rgb 120,230,210)
const bw = 150 * U, bh = 330 * U, bc = { x: spots[0].x + dir * 85 * U, y: cf.y - 150 * U };
const rip = { x: bw / 2, y: bh / 2 - 20 * U };
const RGB = '120,230,210';
const barrier = (g, e, alpha, scx, flash) => {
  g.save(); g.translate(bc.x, bc.y); g.scale(scx, 1); g.translate(-bw / 2, -bh / 2);
  g.globalCompositeOperation = 'lighter'; g.globalAlpha = alpha; if (flash > 0) g.filter = 'brightness(' + (1 + flash).toFixed(2) + ')';
  g.save(); g.beginPath(); g.ellipse(bw / 2, bh / 2, bw / 2 - 2 * U, bh / 2 - 2 * U, 0, 0, 6.3); g.clip();
  const fill = g.createRadialGradient(bw / 2, bh / 2, 10 * U, bw / 2, bh / 2, bw / 2); fill.addColorStop(0, 'rgba(' + RGB + ',.05)'); fill.addColorStop(1, 'rgba(' + RGB + ',.35)'); g.fillStyle = fill; g.fillRect(0, 0, bw, bh);
  const r = 16 * U, hx = r * 1.732, hy = r * 1.5; const k = (e - t.hit) / 500;
  g.lineWidth = 1.6 * U;
  for (let y = -r, row = 0; y < bh + r; y += hy, row++) for (let x = (row % 2) * hx / 2 - hx; x < bw + hx; x += hx) {
    let a = 0.25 + 0.15 * Math.sin(e / 300 + x / U * 0.05 + y / U * 0.04);
    if (k >= 0) { const d = Math.hypot(x - rip.x, y - rip.y); a += Math.max(0, 1 - Math.abs(d - k * bw) / (30 * U)) * (1 - Math.min(1, k)) * 1.2; }
    g.strokeStyle = 'rgba(' + RGB + ',' + Math.min(1, a).toFixed(3) + ')'; g.beginPath();
    for (let i = 0; i < 6; i++) { const an = Math.PI / 3 * i + Math.PI / 6; const px = x + r * Math.cos(an), py = y + r * Math.sin(an); if (i) g.lineTo(px, py); else g.moveTo(px, py); }
    g.closePath(); g.stroke();
  }
  g.restore();
  g.strokeStyle = 'rgba(' + RGB + ',.9)'; g.lineWidth = 3 * U; g.beginPath(); g.ellipse(bw / 2, bh / 2, bw / 2 - 3 * U, bh / 2 - 3 * U, 0, 0, 6.3); g.stroke();
  g.restore();
};
m.hold(t.land, t.fade + 300, (e0, S) => {
  const e = e0 + t.land;
  const up = E.outQ(Math.min(1, e0 / 300));
  const alpha = e < t.fade ? up : Math.max(0, 1 - (e - t.fade) / 300);
  const scx = 0.3 + 0.7 * up;
  const flash = (e >= t.hit && e < t.hit + 220) ? 1 - E.outQ((e - t.hit) / 220) : 0;
  S.world.push({ z: 35, draw: (g) => barrier(g, e, alpha, scx, flash) });
});
// the braced hit: sparks at the impact point on the barrier
K.twinkles(m, t.hit, { x: bc.x - bw / 2 + rip.x, y: bc.y - bh / 2 + rip.y }, K.tintF(165, 4, 1.3), 4, 25, U);
// they vanish in smoke
for (const gd of G) m.clip('smoke11', t.hop, { x: gd.s.x, y: gd.s.y - gd.h * 0.5, w: 170 * 0.85 * 2.2 * U, z: 36, hold: t.total - t.hop, filter: 'brightness(.85)', alpha: (u) => 1 - Math.max(0, (u - 0.6) / 0.4) });
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
