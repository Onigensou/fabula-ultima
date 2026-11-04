// Create Phantasm: Numen (Keren: Crysta) — approved mockup (v8, round 4, the
// final moon cut-in). Keren channels on a violet hexagram circle (Magic4); cut to
// night (screen space: navy radial sky + stars, 400 ms); the procedural full moon
// rises in (600 ms, Saint4); Crysta's ANIMATED battler fades in on the moon as a
// black silhouette and holds ~0.9 s; SNAP (Teleport): it squeezes into a vertical
// line (260 ms) and bursts into moonlight shards; the moon drops to black (300),
// black beat (200); back to battle (280): a moonlight streak hits the summon spot
// (Saint3) and Crysta stretches in from a vertical line (300 ms, slight
// overshoot); sparkle ring + twinkles; Keren steps back; Crysta holds 1.2 s and
// fades (the mockup's ending; BD places the real Numen token after the shot).
// The "Numen · Crysta" tag is dropped (no text in shots). No number: gate null.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, U, E } = B;
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
K.step(m, E, U, dir, 'c', 0, 0, t.settle, 46);
K.circle(tl, m, U, 'c', t.cast, t.castHold, 275, { dx: dir * 46 * U });
const V = tl.IMG.crysta || null;
if (V && typeof V.play === 'function') { try { V.muted = true; V.loop = true; const p = V.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
const vdim = () => ({ w: (V && (V.videoWidth || V.naturalWidth || V.width)) || 226, h: (V && (V.videoHeight || V.naturalHeight || V.height)) || 292 });
const R = tl.rng(4242);
const STARS = []; for (let i = 0; i < 220; i++) STARS.push({ x: R(), y: R(), r: R() * 1.5 + 0.3, a: 0.4 + R() * 0.6 });
const ORBS = []; for (let i = 0; i < 26; i++) ORBS.push({ c: i % 3 ? '#e8eeff' : '#bcd0ff', s: 8 + R() * 10, ang: R() * 6.28, d: 120 + R() * 260, y0: R() - 0.5 });
// procedural full moon (mockup moonCanvas, R = 230 at a 788 px tall stage), seeded
let MOON = null, MOONH = 0;
const buildMoon = (Rr) => {
  const k = Rr / 230, s = Math.ceil(Rr * 2 + 160 * k), c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d'), mm = s / 2; const r = tl.rng(77);
  const halo = g.createRadialGradient(mm, mm, Rr * 0.9, mm, mm, Rr + 80 * k); halo.addColorStop(0, 'rgba(255,248,220,.55)'); halo.addColorStop(1, 'rgba(255,248,220,0)');
  g.fillStyle = halo; g.beginPath(); g.arc(mm, mm, Rr + 80 * k, 0, 6.3); g.fill();
  const disc = g.createRadialGradient(mm - Rr * 0.25, mm - Rr * 0.25, Rr * 0.1, mm, mm, Rr); disc.addColorStop(0, '#fffdf2'); disc.addColorStop(0.75, '#efe8cf'); disc.addColorStop(1, '#d9cfae');
  g.fillStyle = disc; g.beginPath(); g.arc(mm, mm, Rr, 0, 6.3); g.fill();
  g.save(); g.beginPath(); g.arc(mm, mm, Rr, 0, 6.3); g.clip();
  const rnd = (a, b) => a + r() * (b - a);
  for (let i = 0; i < 7; i++) { const x = mm + rnd(-Rr * 0.6, Rr * 0.5), y = mm + rnd(-Rr * 0.5, Rr * 0.4), rr = rnd(Rr * 0.15, Rr * 0.32);
    const mg = g.createRadialGradient(x, y, 0, x, y, rr); mg.addColorStop(0, 'rgba(150,140,115,.35)'); mg.addColorStop(1, 'rgba(150,140,115,0)'); g.fillStyle = mg; g.beginPath(); g.arc(x, y, rr, 0, 6.3); g.fill(); }
  for (let i = 0; i < 40; i++) { const x = mm + rnd(-Rr, Rr), y = mm + rnd(-Rr, Rr), rr = rnd(3 * k, Rr * 0.06);
    g.fillStyle = 'rgba(140,130,105,.25)'; g.beginPath(); g.arc(x, y, rr, 0, 6.3); g.fill(); g.fillStyle = 'rgba(255,255,245,.25)'; g.beginPath(); g.arc(x - rr * 0.3, y - rr * 0.3, rr * 0.7, 0, 6.3); g.fill(); }
  g.restore();
  return c;
};
const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// ── the night cut-in (screen space) ──
const cut = (g, e) => {
  const W = g.W, H = g.H, sc = H / 788, MX = W / 2, MY = 300 * sc;
  const cutA = e < t.cutIn + 400 ? E.sine(clamp((e - t.cutIn) / 400)) : e >= t.back ? 1 - E.sine(clamp((e - t.back) / 280)) : 1;
  if (cutA <= 0) return;
  g.save(); g.globalAlpha = cutA;
  // sky: radial-gradient(ellipse at 50% 35%, #0d1430, #03040c 70%)
  const cx = W / 2, cy = H * 0.35, rx = Math.hypot(W / 2, 0) * 1.414, ry = H * 0.65 * 1.414;
  g.save(); g.translate(cx, cy); g.scale(1, ry / rx); const sk = g.createRadialGradient(0, 0, 0, 0, 0, rx); sk.addColorStop(0, '#0d1430'); sk.addColorStop(0.7, '#03040c'); sk.addColorStop(1, '#03040c'); g.fillStyle = sk; g.fillRect(-rx - 4, -rx - 4, rx * 2 + 8, rx * 2 + 8); g.restore();
  for (const s of STARS) { g.fillStyle = 'rgba(230,236,255,' + s.a.toFixed(2) + ')'; g.beginPath(); g.arc(s.x * W, s.y * H, s.r * sc, 0, 6.3); g.fill(); }
  // the moon
  if (e >= t.moon && e < t.black + 300) {
    if (!MOON || MOONH !== H) { MOON = buildMoon(230 * sc); MOONH = H; }
    const u = E.outQ(clamp((e - t.moon) / 600)); const ms = MOON.width * (0.9 + 0.1 * u);
    g.save(); g.globalAlpha = cutA * u; g.drawImage(MOON, MX - ms / 2, MY - ms / 2, ms, ms); g.restore();
  }
  // Crysta's animated silhouette on the moon, then the SNAP
  const D = vdim(); const sh = 340 * sc, sw = sh * D.w / D.h, sy0 = MY + 30 * sc;
  if (V && e >= t.silIn && e < t.burst) {
    const a = 0.92 * E.sine(clamp((e - t.silIn) / 400));
    const u = e >= t.snap ? E.inQ(clamp((e - t.snap) / 260)) : 0;
    g.save(); g.translate(MX, sy0); g.scale(1 - 0.97 * u, 1 + 0.3 * u); g.globalAlpha = cutA * a; g.filter = 'brightness(0)'; g.drawImage(V, -sw / 2, -sh / 2, sw, sh); g.restore();
  }
  if (e >= t.burst && e < t.burst + 180) {
    const u = E.outQ((e - t.burst) / 180); const lw = 6 * sc * (1 + 3 * u), top = sy0 - sh * 0.65, lh = sh * 1.3;
    g.save(); g.globalAlpha = cutA * (1 - u); g.shadowColor = '#dfe8ff'; g.shadowBlur = 18 * sc;
    const lg = g.createLinearGradient(0, top, 0, top + lh); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, '#ffffff'); lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg; g.fillRect(MX - lw / 2, top, lw, lh); g.restore();
  }
  if (e >= t.burst && e < t.burst + 550) {
    const u = E.outQ((e - t.burst) / 550);
    g.save(); g.globalCompositeOperation = 'lighter';
    for (const o of ORBS) { const x = MX + Math.cos(o.ang) * o.d * sc * u, y = sy0 + o.y0 * sh * 0.9 + Math.sin(o.ang) * o.d * 0.6 * sc * u + 40 * sc * u * u; const rr = o.s * sc / 2;
      const gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.18, '#ffffff'); gr.addColorStop(0.4, o.c); gr.addColorStop(0.72, 'rgba(0,0,0,0)');
      g.globalAlpha = cutA * (1 - u); g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
    g.restore();
  }
  // the moon drops to black
  if (e >= t.black) { g.globalAlpha = cutA * E.inQ(clamp((e - t.black) / 300)); g.fillStyle = '#000'; g.fillRect(-20, -20, W + 40, H + 40); }
  g.restore();
};
m.hold(t.cutIn, t.back + 281, (e0, S) => { const e = e0 + t.cutIn; S.screen.push({ draw: (g) => cut(g, e) }); });
// ── back to battle: the streak and Crysta's arrival at the summon spot ──
const P = K.summonSpot(tl, 'c');
const flipC = -dir;
m.hold(t.streak, t.settle, (e0, S) => {
  const e = e0 + t.streak; const D = vdim(); const ch = D.h * 1.45 * U;
  const a = e < t.stretch ? E.outQ(clamp((e - t.streak) / 120)) : 1 - E.outQ(clamp((e - t.stretch) / 300));
  const sx = e < t.stretch ? 1 : 1 + 4 * E.outQ(clamp((e - t.stretch) / 300));
  S.world.push({ z: 45, draw: (g) => {
    const w = 8 * U * sx, top = P.y - ch * 1.6, h = ch * 1.6;
    g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = a; g.shadowColor = '#dfe8ff'; g.shadowBlur = 22;
    const lg = g.createLinearGradient(0, top, 0, P.y); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.7, '#ffffff'); lg.addColorStop(1, '#ffffff');
    g.fillStyle = lg; g.fillRect(P.x - w / 2, top, w, h); g.restore();
  } });
});
if (V) m.hold(t.stretch, t.total, (e0, S) => {
  const e = e0 + t.stretch; const D = vdim(); const cw = D.w * 1.45 * U, ch = D.h * 1.45 * U;
  let sx = 1, sy = 1, f = 'drop-shadow(0 0 4px #dfe6ff)', a = 1;
  if (e < t.settle) { const u = E.outQ(clamp((e - t.stretch) / 300)); sx = u < 0.8 ? 0.04 + 1.11 * (u / 0.8) : 1.15 - 0.15 * ((u - 0.8) / 0.2); sy = u < 0.8 ? 1.55 - 0.6 * (u / 0.8) : 0.95 + 0.05 * ((u - 0.8) / 0.2); f = 'brightness(' + (2.6 - 1.6 * u).toFixed(2) + ') drop-shadow(0 0 ' + (12 * (1 - u) + 4).toFixed(1) + 'px #dfe6ff)'; }
  if (e > t.total - 400) a = clamp((t.total - e) / 400);
  S.world.push({ z: 30, draw: (g) => { g.save(); g.translate(P.x, P.y); g.scale(flipC * sx, sy); g.globalAlpha = a; g.filter = f; g.drawImage(V, -cw / 2, -ch, cw, ch); g.restore(); } });
});
// sparkle ring + twinkles as she settles
m.hold(t.settle, t.settle + 450, (e, S) => {
  const u = E.outQ(e / 450); const r = (30 + 110 * u) * U;
  S.world.push({ z: 2, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 1 - u; g.strokeStyle = 'rgba(220,232,255,.9)'; g.lineWidth = 4 * U; g.shadowColor = '#dfe8ff'; g.shadowBlur = 14; g.beginPath(); g.ellipse(P.x, P.y, r, r * 0.4, 0, 0, 6.283); g.stroke(); g.restore(); } });
});
K.twinkles(m, t.settle, { x: P.x, y: P.y - vdim().h * 1.45 * U * 0.5 }, K.tintF(220, 4, 1.3), 8, 70, U);
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
