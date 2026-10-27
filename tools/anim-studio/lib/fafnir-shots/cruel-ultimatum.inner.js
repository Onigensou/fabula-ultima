// Zero Power: Cruel Ultimatum — ONE CUT (inner script, runs on every client).
// A direct port of the approved mockup (Fafnir Action Shots, revision 26):
// the same tracks, the same numbers. cfg.element = 'bolt' | 'fire'.
// No backticks anywhere in this file (it is embedded in a String.raw template).
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const el = cfg.element === 'fire' ? 'fire' : 'bolt';
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }

const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null } };
const TG = [];
targets.forEach((t, i) => { const k = 't' + i; TG.push(k); tokens[k] = { token: t, foot: cfg.partyFoot || 0.97 }; });
const tl = oni.timeline({
  tokens,
  images: { sky: A.skyImg, cutin: A.cutinImg },
  clips: A.clips || {},
  // her sheet's Leap / Fly sprite rows win; the bundled redraws are the fallback
  poses: { faf: { crouch: { prop: 'sprite_leap', url: A.crouchArt, foot: 0.985 }, air: { prop: 'sprite_fly', url: A.airArt, foot: 0.985 } } },
  hurtFor: (name) => (A.hurtBase ? A.hurtBase + encodeURIComponent(name) + '/' + encodeURIComponent(name) + '_Hurt.webm' : null),
});
await tl.load();

const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, rng = tl.rng;
const TOK = tl.TOK, IMG = tl.IMG, feet = tl.feet, STAGE = tl.STAGE, REST = tl.REST, D = tl.draw;
const T = []; const m = tl.mk(T);
const F = TOK.faf; const ff = feet(F); const dir = F.dir || 1;
// the party centroid (the mockup's 1700 x 600 over the two PCs)
const PC = { x: TG.reduce((s, k) => s + TOK[k].x, 0) / TG.length, y: TG.reduce((s, k) => s + TOK[k].y, 0) / TG.length };

/* ───────── the cutaway ───────── */
const col = el === 'bolt' ? '#c9a5ff' : '#ffb070', flashC = el === 'bolt' ? '#cfa8ff' : '#ffd9a0';
const PX = (g) => g.H / 788;
const GAP = 0.6;
const PANf = () => { const img = IMG.sky; const V = tl.view(); if (!img) return 1.25; const W = V.W, H = V.H; const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; const s = Math.max(W / iw, H / ih) * 1.16; return 0.5 + ih * s / H / 2 - 0.015 + GAP; };
// P00 portrait cut-in (0-1600): her idle art slides in from the left, facing the party
m.beat(0, 'zero power cut-in'); m.dim(0, 180, 0.55); m.undim(1340, 260, 0.55);
m.hold(0, 1600, (tl2, S) => { const k = tl2 < 340 ? E.outC(tl2 / 340) : tl2 < 1240 ? 1 : 1 - E.inQ((tl2 - 1240) / 340); S.screen.push({ draw: (g) => { const art = tl.art('faf'); if (!art) return; const h = g.H * 0.9, w = h * F.w / F.h; const x = lerp(-w, g.W * 0.09, k), y = g.H * 0.84 - h; g.save(); g.translate(x + w, y); g.scale(-1, 1); g.drawImage(art, 0, 0, w, h); g.restore(); } }); });
// P01 the operator closes on her
m.cam(1600, 900, { cx: F.x + 120 * dir, cy: F.y - 40, zoom: 1.25 }); m.beat(1600, 'the camera closes on her');
// P02 crouch -> jolt (dust, the ground shakes, the party is knocked into their hurt poses) -> hover -> climb; the camera FOLLOWS her
m.tw(3000, 300, (u, S) => { S.tok.faf.pose = 'crouch'; S.tok.faf.sy = 1 - 0.05 * E.outQ(u); S.tok.faf.dy = 6 * u; });
m.dust(3300, F.x, ff.y + 10, 1000, 'takeoff'); m.beat(3300, 'take-off · the ground shakes');
m.shake(3300, 900, 22); m.hold(3300, 4900, (tl2, S) => { for (const k of TG) S.tok[k].hurt = true; });
m.tw(3300, 340, (u, S) => { const k = E.outC(u); S.tok.faf.pose = 'air'; S.tok.faf.sy = 0.95 + 0.17 * k; S.tok.faf.sx = 1 - 0.06 * k; S.tok.faf.dy = 6 - 230 * k; });
m.hold(3640, 5840, (tl2, S) => { S.tok.faf.pose = 'air'; });
m.hold(3640, 4740, (tl2, S) => { S.tok.faf.sy = 1; S.tok.faf.sx = 1; S.tok.faf.dy = -224 + Math.sin(tl2 / 1000 * 1.1 * Math.PI * 2) * 10; });
m.hold(3640, 6900, (tl2, S) => { const abs = tl2 + 3640; S.cam = { cx: F.x + 120 * dir, cy: F.y - 40 - 190, zoom: lerp(1.25, 1, E.sine(seg(abs, 4740, 6600))) }; });
m.tw(4740, 1300, (u, S) => { const k = E.inQ(u); const bob = Math.sin((1100 + u * 1300) / 1000 * 1.1 * Math.PI * 2) * 10 * (1 - k); S.tok.faf.sy = 1 + 0.1 * k; S.tok.faf.dy = -224 + bob - 1400 * k; });
// P03 ONE MOVE up: the board slides down out of frame while the sky slides in from above, the speed-line wipe hiding the seam
m.beat(5300, 'she rockets up · the camera races after her');
m.hold(5840, 23600, (tl2, S) => { S.tok.faf.hidden = true; });
m.hold(4740, 6900, (tl2, S) => { const u = seg(tl2, 0, 2160); const p = E.ioC(u); S._panV = (u < 0.5 ? 12 * u * u : 12 * (1 - u) * (1 - u)) / 3; const PAN = PANf(); S.panY = p * PAN; S._skyOy = (p - 1) * PAN; S._pan = p; S.dim = Math.max(S.dim, 0.75 * E.inQ(p)); S.screen.push({ draw: (g) => { const W = g.W, H = g.H; const top = (S.panY || 0) * H; const f = H * 0.32; const b = g.createLinearGradient(0, top - 2, 0, top + f); b.addColorStop(0, 'rgba(5,3,10,1)'); b.addColorStop(0.35, 'rgba(5,3,10,.85)'); b.addColorStop(1, 'rgba(5,3,10,0)'); g.save(); g.fillStyle = b; g.fillRect(0, top - H, W, H + f); g.restore(); } }); });
m.hold(6900, 18250, (tl2, S) => { S.hideBoard = true; S._skyOy = 0; });
// P04 the sky: hold on the storm. Strikes on a storm cadence; a slow push-in.
const strikes = [[7300, 1], [8300, 0.8], [9500, 0.9], [10700, 1], [11900, 0.7], [13100, 0.9], [14300, 0.8], [15500, 1], [16700, 0.85]];
const flashAt = (tl2) => { let f = 0; for (const [a, s] of strikes) { const u = tl2 - a; if (u < 0) continue; const env = u < 40 ? u / 40 : u < 90 ? 1 - 0.7 * (u - 40) / 50 : u < 130 ? 0.3 + 0.7 * (u - 90) / 40 : Math.max(0, 1 - (u - 130) / 380); f = Math.max(f, s * env); } return f; };
m.beat(6900, 'the storm');
m.hold(4740, 18300, (tl2, S) => { const abs = tl2 + 4740; const push = 1 + 0.07 * seg(abs, 6900, 17200); const fl = flashAt(abs); const rec = E.ioQ(seg(abs, 17200, 18000));
  S.screen.push({ draw: (g) => { const W = g.W, H = g.H; const oy = (S._skyOy || 0); const pan = S._pan || 0;
    if (Math.abs(oy) > 0.002 && IMG.sky) { D.drawSkyPan(g, IMG.sky, W, H, push * 1.16 * (1 + 0.06 * rec), oy * H, H * 0.34, H * 0.05 * Math.sin(pan * Math.PI), 2.5 * PX(g)); }
    else { g.save(); g.filter = 'blur(' + ((2.5 + 3 * rec) * PX(g)).toFixed(1) + 'px)'; D.drawCover(g, IMG.sky, W, H, push * 1.16 * (1 + 0.06 * rec), 0, oy * H, 1); g.restore(); }
    if (fl > 0) { g.save(); g.globalAlpha = 0.5 * fl; g.fillStyle = col; g.fillRect(0, 0, W, H); g.restore(); }
    const r = rng(71); g.save(); g.globalAlpha = 0.7; for (let i = 0; i < 14; i++) { const x = ((r() * W + (12 + r() * 10) * tl2 / 1000) % (W + 400)) - 200, y = r() * H * 0.6 + oy * H, rx = (140 + r() * 220), ry = rx * 0.35; const gr = g.createRadialGradient(x, y, 0, x, y, rx); gr.addColorStop(0, 'rgba(10,4,20,' + (0.5 + 0.2 * fl) + ')'); gr.addColorStop(1, 'rgba(10,4,20,0)'); g.fillStyle = gr; g.save(); g.translate(x, y); g.scale(1, ry / rx); g.translate(-x, -y); g.fillRect(x - rx, y - rx, rx * 2, rx * 2); g.restore(); } g.restore();
    if (Math.abs(oy) < 0.01) { const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.max(W, H) * 0.62); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.7)'); g.fillStyle = v; g.fillRect(0, 0, W, H); }
  } }); });
for (const [a, s] of strikes) { m.hold(a, a + 260, (tl2, S) => { S.shake = Math.max(S.shake, 5 * s * (1 - tl2 / 260)); }); }
// P05 the silhouette fades in, already charging: black at first, lit more and more by the charge at her jaw and by the strikes
m.beat(11000, 'a silhouette in the storm');
m.hold(11000, 18300, (tl2, S) => { const abs = tl2 + 11000; const fade = E.sine(seg(tl2, 0, 3200)); const ch = E.inQ(seg(abs, 13000, 17200)); const fl = flashAt(abs); const rec = E.ioQ(seg(abs, 17200, 18000)); const sc = lerp(1, 0.6, rec);
  const sz = 1.5, px = 0.42 - 0.07 * rec, py0 = 0.70 - 0.09 * rec; const blur = 4 * rec; const fore = 1.25; const top = 0.80, bot = 1.18;
  S.screen.push({ draw: (g) => { const W = g.W, H = g.H; const img = IMG.cutin, dark = tl.tinted('cutin', '#06020c'); if (!img || !dark) return; const py = py0 + (S._skyOy || 0); const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; const h = H * sz * sc, w = h * iw / ih; const cx = W * px, cy = H * py;
    g.save(); g.globalAlpha = fade; if (blur > 0) g.filter = 'blur(' + (blur * PX(g)).toFixed(1) + 'px)'; D.drawKeystone(g, dark, cx, cy, w, h, top, bot, 56, fore); g.restore();
    const lit = Math.min(1, 0.06 * fade + 0.85 * Math.pow(ch, 1.6) + 0.25 * fl); g.save(); g.globalAlpha = fade * lit; if (blur > 0) g.filter = 'blur(' + (blur * PX(g)).toFixed(1) + 'px)'; D.drawKeystone(g, img, cx, cy, w, h, top, bot, 56, fore); g.restore();
    if (fl > 0) { g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.35 * fl * fade; D.drawKeystone(g, tl.tinted('cutin', '#c9a5ff'), cx, cy, w, h, top, bot, 56, fore); g.restore(); }
    const ms = lerp(top, bot, 0.285); S._mouth = { x: cx + (0.58 - 0.5) * w * ms, y: cy - h / 2 + h * Math.pow(0.285, fore), h, sc }; } }); });
// the speed-lines are registered AFTER the sky and the silhouette, so they draw on top of both during the wipe
m.hold(4740, 7500, (tl2, S) => { const abs = tl2 + 4740; const v = abs < 6900 ? (S._panV || 0) : 0; const a = Math.min(1, v * 1.5); if (a <= 0.01) return; S.screen.push({ draw: (g) => D.vlines(g, tl2, Math.min(1, a), col) }); S.shake = Math.max(S.shake, 9 * Math.min(1, a)); });
// P06 the charge, 4.2 s at her jaw, the frame trembling harder as it builds
m.beat(13000, 'she is charging');
const chargeKey = el === 'bolt' ? 'sparkring' : 'fireball';
m.clip(chargeKey, 13000, { screen: { x: 0.5, y: 0.5 }, wh: 0.2, loop: true, hold: 4200, live: (tl2, S) => { if (!S._mouth) return null; const k = E.ioQ(seg(tl2, 0, 3800)); return { x: S._mouth.x, y: S._mouth.y, wh: lerp(0.04, 0.36, k) * (1 + Math.sin(tl2 / 50) * 0.04), rot: el === 'fire' ? -0.5 : 0 }; } });
m.hold(13000, 17200, (tl2, S) => { const k = seg(tl2, 0, 3800); S.shake = Math.max(S.shake, 7 * k); S.screen.push({ draw: (g) => { if (!S._mouth) return; D.glowCircle(g, S._mouth.x, S._mouth.y, g.H * (0.04 + 0.16 * k), el === 'bolt' ? '#dcecff' : '#ffd9a0', 0.5 + 0.4 * k); } }); });
// P07 unleashed: at the lens for 0.8 s
m.beat(17200, 'unleashed');
const ballAt = (tl2, S, g) => { const u = seg(tl2, 0, 800); return { x: lerp(S._mouth.x, g.W * 0.5, E.ioQ(u)), y: lerp(S._mouth.y, g.H * 0.75, E.ioQ(u)), k: E.inQ(u) }; };
if (el === 'bolt') {
  m.clip('thunderball', 17200, { screen: { x: 0.5, y: 0.5 }, wh: 0.7, add: true, tint: '#b48cff', live: (tl2, S) => S._mouth ? { x: S._mouth.x, y: S._mouth.y, wh: 0.7 + 0.3 * seg(tl2, 0, 300) } : null });
  for (const [d, off] of [[0, -0.05], [60, 0], [120, 0.05]]) m.clip('thunder1', 17200 + d, { screen: { x: 0.5, y: 0.5 }, wh: 1, add: true, tint: '#c9a5ff', pivot: { x: 0.5, y: 0.16 }, loop: true, hold: 900 - d, alpha: (u) => u < 0.06 ? u / 0.06 : 1, live: (tl2, S, g) => { if (!S._mouth) return null; const b = ballAt(tl2 + d, S, g); const dx = b.x - S._mouth.x, dy = b.y - S._mouth.y; const len = Math.hypot(dx, dy) + g.H * lerp(0.15, 1.4, b.k); const dh = len / (0.858 - 0.16); const jitter = Math.sin((tl2 + d) / 37) * 0.04; return { x: S._mouth.x, y: S._mouth.y, wh: dh / g.H, rot: Math.atan2(dy, dx) - Math.PI / 2 + off + jitter, persp: { near: 1, far: lerp(0.6, 0.08, b.k) }, sx: lerp(0.45, 1.4, b.k) }; } });
}
const projKey = el === 'bolt' ? 'thunderball' : 'fireball';
m.clip(projKey, 17200, { screen: { x: 0.5, y: 0.5 }, wh: 0.3, loop: true, hold: 900, tint: el === 'bolt' ? '#b48cff' : null, add: el === 'bolt', alpha: (u) => el === 'fire' ? 0.72 : 1, live: (tl2, S, g) => { if (!S._mouth) return null; const b = ballAt(tl2, S, g); return { x: b.x, y: b.y, wh: el === 'fire' ? lerp(0.34, 3.2, b.k) : lerp(0.26, 2.6, b.k), rot: el === 'fire' ? Math.atan2(b.y - S._mouth.y, b.x - S._mouth.x) + 0.3 * Math.sin(tl2 / 120) : 0 }; } });
m.hold(17250, 18100, (tl2, S) => { const u = seg(tl2, 0, 750); S.screen.push({ draw: (g) => { if (!S._mouth) return; const b = ballAt(tl2, S, g); D.zoomLines(g, b.x, b.y, tl2, 0.1 + 0.25 * u, el === 'bolt' ? '#dcecff' : '#ffd9a0'); } }); S.shake = Math.max(S.shake, 6 + 14 * u); });
m.flash(17200, 60, 300, flashC, 0.4);
// P08 it hits the lens; white; under the white the board is back with the camera high over the party, and the white clears onto them
m.beat(18000, 'it hits the lens'); if (el === 'bolt') m.clip('thunderball', 18000, { screen: { x: 0.52, y: 0.55 }, wh: 2.4, add: true, tint: '#b48cff' }); else m.clip('fireboom', 17950, { screen: { x: 0.52, y: 0.55 }, wh: 2.2, hold: 950, alpha: (u) => 1 - seg(u, 0.6, 1) });
m.flash(18000, 80, 300, flashC, 0.6);
m.hold(18080, 19800, (tl2, S) => { const k = E.outC(seg(tl2, 0, 200)); const out = 1 - E.sine(seg(tl2, 920, 1620)); S.white = Math.max(S.white, Math.min(k, out)); });
m.hold(18250, 1e9, (tl2, S) => { S.hideBoard = false; S.black = 0; S.panY = 0; S.cam = { cx: PC.x, cy: REST.cy - 200, zoom: 1.15 }; });
m.beat(19000, 'back down to the ground'); m.hold(19000, 19800, (tl2, S) => { const k = E.outC(seg(tl2, 0, 800)); S.panY = 0.28 * (1 - k); S.cam = { cx: PC.x, cy: REST.cy - 200, zoom: lerp(1.3, 1.15, k) }; });
m.beat(19800, 'silence');
m.hold(19000, 1e9, (tl2, S) => { S.dim = Math.max(S.dim, 0.5 * (1 - seg(tl2, 10000, 10700))); });
m.hold(20300, 27100, (tl2, S) => { for (const k of TG) S.tok[k].hurt = true; });
const t0 = 20300;

/* ───────── the board impact ───────── */
if (el === 'bolt') {
  const V = '#c9a5ff';
  m.beat(t0, 'impact · damage gate');
  TG.forEach((k, n) => { const P = TOK[k]; const f = feet(P); m.skybolts(t0 + n * 60, 520, f.x, f.y, 4, '#bfe8ff'); m.clip('thunderall2', t0 + n * 80, { x: P.x, y: P.y - 20, w: 560, z: 50, add: true, tint: V }); m.shakeTok(t0, k, 900, 12); });
  [[-120, -80, -120, 1700], [120, 20, 0, 1900], [0, 100, 120, 1500]].forEach(([dx, dy, d, w]) => m.clip('thunder1', t0 + d, { x: PC.x + dx, y: PC.y + dy, w, z: 48, add: true, tint: V }));
  // second and third waves while the party is still reeling
  TG.forEach((k, n) => { const P = TOK[k]; const f = feet(P); m.skybolts(t0 + 480 + n * 70, 480, f.x, f.y, 3, '#bfe8ff'); m.clip('thunderball', t0 + 520 + n * 90, { x: P.x, y: P.y - 30, w: 620, z: 50, add: true, tint: V }); m.clip('thunder1', t0 + 900 + n * 110, { x: P.x + (n % 2 ? -80 : 80), y: f.y + 10, w: 1400, z: 48, add: true, tint: V }); m.shakeTok(t0 + 520, k, 900, 10); });
  m.clip('thunderall2', t0 + 950, { x: PC.x, y: PC.y - 40, w: 900, z: 50, add: true, tint: V }); m.shake(t0 + 500, 500, 26); m.shake(t0 + 950, 500, 30);
} else {
  const vk = TG[0]; const Vt = TOK[vk]; const f = feet(Vt); const sgn = Math.sign(F.x - f.x) || -1;
  const other = TG.length > 1 ? feet(TOK[TG[1]]) : { x: f.x - 160 * sgn, y: f.y - 330 };
  // the fireball drops in from her side over 800 ms, from just above the frame, growing as it comes, a glow trail behind it and its light swelling on the ground under the victim
  const FB = 800, fbTop = (S) => tl.camView(S).top, fbAt = (u, S) => ({ x: lerp(f.x + 560 * sgn, f.x, u), y: lerp(fbTop(S) - 240, f.y - 70, u) });
  m.beat(t0 - FB, 'the fireball comes down');
  m.hold(t0 - FB, t0, (tl2, S) => { const u = Math.pow(seg(tl2, 0, FB), 1.5); S.world.push({ z: 3, draw: (g) => { const r = lerp(120, 520, u); const gr = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, r); gr.addColorStop(0, 'rgba(255,150,60,' + (0.25 + 0.45 * u) + ')'); gr.addColorStop(1, 'rgba(255,90,20,0)'); g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.save(); g.translate(f.x, f.y); g.scale(1, 0.42); g.translate(-f.x, -f.y); g.fillRect(f.x - r, f.y - r, r * 2, r * 2); g.restore(); g.restore(); } });
    S.world.push({ z: 57, draw: (g) => { for (let i = 1; i <= 6; i++) { const q = Math.max(0, u - i * 0.045); const c = fbAt(q, S); D.fireball(g, c.x, c.y, lerp(80, 330, u) * (1 - i * 0.12), tl2 + i * 40, 0.35 * (1 - i / 7)); } } }); });
  m.clip('fireball', t0 - FB, { x: f.x, y: f.y, w: 600, z: 58, loop: true, hold: FB, alpha: (u) => u < 0.12 ? u / 0.12 : 1, live: (tl2, S) => { const u = Math.pow(seg(tl2, 0, FB), 1.5); const b = fbAt(u, S); const d = fbAt(Math.min(1, u + 0.01), S); return { x: b.x, y: b.y, w: lerp(340, 1300, u), rot: Math.atan2(d.y - b.y, d.x - b.x) }; } });
  m.hold(t0 - FB, t0, (tl2, S) => { S.shake = Math.max(S.shake, 10 * seg(tl2, 0, FB)); });
  m.beat(t0, 'impact · damage gate');
  // the collision: the ball bursts at 2400 px with two side bursts, an orange flash, a shock ring racing out along the ground
  m.clip('fireboom', t0, { x: Vt.x, y: Vt.y - 60, w: 2400, z: 60 }); m.clip('fireboom', t0 + 90, { x: Vt.x - 280, y: Vt.y + 40, w: 1300, z: 60 }); m.clip('fireboom', t0 + 160, { x: Vt.x + 320, y: Vt.y - 20, w: 1100, z: 60 });
  m.flash(t0, 50, 420, '#ffb060', 0.75);
  m.hold(t0, t0 + 700, (tl2, S) => { const u = seg(tl2, 0, 700); S.world.push({ z: 4, draw: (g) => { const R = lerp(80, 1500, E.outC(u)); g.save(); g.translate(f.x, f.y); g.scale(1, 0.42); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 1 - u; g.lineWidth = lerp(90, 14, u); g.strokeStyle = '#ffd9a0'; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.stroke(); g.lineWidth = lerp(40, 6, u); g.strokeStyle = '#ff8a30'; g.beginPath(); g.arc(0, 0, R * 1.08, 0, Math.PI * 2); g.stroke(); const gr = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.9); gr.addColorStop(0, 'rgba(255,200,120,' + (0.55 * (1 - u)) + ')'); gr.addColorStop(1, 'rgba(255,120,40,0)'); g.fillStyle = gr; g.fillRect(-R, -R, R * 2, R * 2); g.restore(); } }); });
  // the ground under them is thrown up: burning chunks arc out and fall; the scorch under the victim stays
  m.hold(t0, t0 + 1300, (tl2, S) => { const r = rng(29); S.world.push({ z: 61, draw: (g) => { const Tq = tl2 / 1000; for (let n = 0; n < 34; n++) { const an = -Math.PI * (0.15 + r() * 0.7), sp = 900 + r() * 1500, sz = 22 + r() * 48, rot0 = r() * 6, spin = (r() - 0.5) * 9; const x = f.x + Math.cos(an) * sp * Tq * 0.9, y = f.y - 40 + Math.sin(an) * sp * Tq + 1900 * Tq * Tq; if (y > f.y + 140) continue; g.save(); g.translate(x, y); g.rotate(rot0 + spin * Tq); g.fillStyle = '#141019'; g.beginPath(); g.moveTo(-sz * 0.5, -sz * 0.3); g.lineTo(sz * 0.1, -sz * 0.55); g.lineTo(sz * 0.55, -sz * 0.05); g.lineTo(sz * 0.3, sz * 0.5); g.lineTo(-sz * 0.35, sz * 0.4); g.closePath(); g.fill(); g.fillStyle = 'rgba(255,140,50,' + (0.8 * (1 - seg(tl2, 300, 1200))) + ')'; g.beginPath(); g.moveTo(-sz * 0.5, -sz * 0.3); g.lineTo(sz * 0.1, -sz * 0.55); g.lineTo(sz * 0.55, -sz * 0.05); g.lineTo(sz * 0.15, -sz * 0.15); g.closePath(); g.fill(); g.restore(); } } }); });
  m.hold(t0, 1e9, (tl2, S) => { const a = 0.7 * E.outQ(seg(tl2, 0, 300)); S.world.push({ z: 2, draw: (g) => { g.save(); g.translate(f.x, f.y); g.scale(1, 0.42); const gr = g.createRadialGradient(0, 0, 0, 0, 0, 520); gr.addColorStop(0, 'rgba(10,6,8,' + a + ')'); gr.addColorStop(0.6, 'rgba(14,8,10,' + (a * 0.8) + ')'); gr.addColorStop(1, 'rgba(14,8,10,0)'); g.fillStyle = gr; g.fillRect(-520, -520, 1040, 1040); g.restore(); } }); });
  // fire everywhere: pillars in five places over a second, three fragments falling around the party, smoke, 140 embers
  m.clip('firepillar', t0 + 60, { x: f.x, y: f.y, w: 1100, z: 55 }); m.clip('firepillar', t0 + 380, { x: f.x - 330, y: f.y + 30, w: 900, z: 55 }); m.clip('firepillar', t0 + 520, { x: f.x + 300, y: f.y + 20, w: 950, z: 55 }); m.clip('firepillar', t0 + 700, { x: other.x + 40, y: other.y + 10, w: 800, z: 55 }); m.clip('firepillar', t0 + 950, { x: f.x + 80, y: f.y + 10, w: 1200, z: 55 });
  [[t0 + 220, f.x - 420, f.y + 60], [t0 + 360, f.x + 480, f.y - 40], [t0 + 500, other.x - 120, other.y + 40]].forEach(([at, x, y]) => { m.clip('comet', at, { x, y, w: 460, z: 54 }); m.flash(at + 650, 40, 260, '#ffd9a0', 0.3); m.shake(at + 650, 400, 16); });
  m.clip('smoke12', t0 + 300, { x: f.x, y: f.y + 40, w: 1400, z: 53 }); m.clip('smoke14', t0 + 500, { x: f.x, y: f.y, w: 1100, z: 56 }); m.clip('smoke14', t0 + 800, { x: f.x - 200, y: f.y + 20, w: 900, z: 56 });
  m.hold(t0, t0 + 1400, (tl2, S) => { const r = rng(13); S.world.push({ z: 62, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter'; for (let n = 0; n < 140; n++) { const an = r() * Math.PI * 2, sp = 300 + r() * 1300, k = tl2 / 1400; const x = f.x + Math.cos(an) * sp * E.outQ(k), y = f.y - 60 + Math.sin(an) * sp * 0.5 * E.outQ(k) + k * k * 320; g.globalAlpha = (1 - k) * (0.5 + r() * 0.5); g.fillStyle = r() < 0.5 ? '#ffd27a' : '#ff7a3d'; g.beginPath(); g.arc(x, y, 3 + r() * 7, 0, Math.PI * 2); g.fill(); } g.restore(); } }); });
  m.shakeTok(t0, vk, 900, 16); for (const k of TG) if (k !== vk) m.shakeTok(t0, k, 900, 9);
  // the booms keep coming while they reel
  m.clip('fireboom', t0 + 600, { x: Vt.x + 60, y: Vt.y - 40, w: 1600, z: 60 }); m.clip('fireboom', t0 + 1000, { x: Vt.x - 120, y: Vt.y - 80, w: 1900, z: 60 }); m.shake(t0 + 380, 500, 26); m.shake(t0 + 600, 500, 30); m.shake(t0 + 1000, 600, 36); m.shakeTok(t0 + 600, vk, 800, 12); for (const k of TG) if (k !== vk) m.shakeTok(t0 + 700, k, 700, 8);
}

/* ───────── the aftermath: whiteout, the valley pull-out, the second whiteout, her return ───────── */
m.hold(t0 + 1300, t0 + 2900, (tl2, S) => { S.white = Math.max(S.white, E.outC(seg(tl2, 0, 150)) * (1 - E.sine(seg(tl2, 900, 1300)))); });
m.shake(t0, 1400, 44);
const M0 = t0 + 2200;
m.beat(M0, 'the valley · tight, slanted, pulling out'); m.beat(M0 + 500, 'the bolt comes down'); m.beat(M0 + 860, 'the crater blast'); m.beat(M0 + 3200, 'the near rocks disintegrate · black on white');
const camSf = (u) => lerp(1.6, 1, E.outC(seg(u, 0, 1700))) * lerp(1, 0.84, seg(u, 1700, 5100));
m.hold(M0, M0 + 3450, (tl2, S) => { S.hideBoard = true;
  const z = lerp(3.0, 1.12, E.outC(seg(tl2, 0, 1700))) * lerp(1, 0.72, seg(tl2, 1700, 3450));
  const wob = 0.006 * Math.sin(tl2 / 70) * seg(tl2, 760, 1100) * (1 - seg(tl2, 2600, 3100));
  const rot = lerp(-0.27, -0.075, E.outC(seg(tl2, 0, 2800))) + wob;
  const ax = lerp(0.46, 0.5, E.sine(seg(tl2, 0, 2800))), ay = lerp(0.5, 0.6, E.sine(seg(tl2, 0, 2800)));
  const ember = 1 - seg(tl2, 740, 800), beam = seg(tl2, 500, 760), disc = seg(tl2, 760, 1500), k = seg(tl2, 860, 2800), wash = seg(tl2, 2700, 3150);
  const sf = camSf(tl2), fgShake = seg(tl2, 1050, 1200), fgBlur = 4 * seg(tl2, 1150, 1600) * (1 - seg(tl2, 2300, 2700)), fgBrk = 0, fgHide = tl2 >= 2700;
  S._valley = { z, rot, ax, ay };
  S.screen.push({ draw: (g) => D.mountainscape(g, el, { z, rot, ax, ay, ember, beam, disc, k, wash, tl: tl2, sf, fgShake, fgBlur, fgBrk, fgHide }) });
  S.shake = Math.max(S.shake, tl2 < 760 ? 1.5 : 16 * (1 - E.inQ(k)) + 4); });
const fcol = el === 'bolt' ? '#c9a5ff' : '#ffb070';
m.hold(M0 + 2700, M0 + 5100, (tl2, S) => { const u = tl2 + 2700; const rot = lerp(-0.27, -0.075, E.outC(seg(u, 0, 2800))); const ero = seg(u, 3200, 4700); S.over.push({ draw: (g) => D.foregroundRocks(g, { rot, sf: camSf(u), fgShake: ero > 0 ? 0.25 * (1 - ero) : 0.6, fgBlur: 0, ero, tl: u, k: 1, onWhite: true }, fcol) }); });
// pillars on the ridges, riding the valley camera
const rr = rng(37); for (let i = 0; i < 9; i++) { const xf = -0.15 + 1.3 * rr(), yf = tl.VALLEY_HY - 0.015 - 0.05 * rr(), wh0 = 0.22 + 0.3 * rr();
  const live = (tl2, S, g) => { const V = S._valley; if (!V) return null; const p = D.valleyXf(V, g, xf * g.W, yf * g.H); return { x: p.x, y: p.y, wh: wh0 * V.z, rot: V.rot }; };
  if (el === 'bolt') m.clip('thunder1', M0 + 1000 + i * 170, { screen: { x: 0.5, y: 0.5 }, wh: wh0, add: true, tint: '#c9a5ff', live }); else m.clip('firepillar', M0 + 1000 + i * 170, { screen: { x: 0.5, y: 0.5 }, wh: wh0, live }); }
m.hold(M0 + 900, M0 + 3450, (tl2, S) => { const grow = E.outQ(seg(tl2, 0, 420)), a = 1 - seg(tl2, 1800, 2250); S.screen.push({ draw: (g) => D.screenCracks(g, 0.5, 0.6, grow, a) }); });
for (const [at, ms, amp] of [[M0 + 760, 300, 22], [M0 + 1100, 400, 30], [M0 + 1700, 400, 24], [M0 + 2300, 400, 18]]) m.shake(at, ms, amp);
// the wash takes the frame; full white held; the board is back under it as the white clears
m.beat(M0 + 2700, 'white wash · held');
m.hold(M0 + 3100, M0 + 5600, (tl2, S) => { S.white = Math.max(S.white, E.outC(seg(tl2, 0, 80)) * (1 - E.sine(seg(tl2, 1800, 2500)))); });
m.hold(M0 + 4900, 1e9, (tl2, S) => { S.hideBoard = false; S.black = 0; S.cam = { cx: REST.cx, cy: REST.cy, zoom: 1 }; });
m.beat(M0 + 4900, 'back to the fight'); m.descend(M0 + 4800, 'faf');
m.hold(M0 + 4800, M0 + 6500, (tl2, S) => { S.tok.faf.pose = 'air'; }); m.hold(M0 + 6500, M0 + 6800, (tl2, S) => { S.tok.faf.pose = 'crouch'; S.tok.faf.sy = 1 - 0.04 * Math.sin(Math.PI * tl2 / 300); }); m.shake(M0 + 6500, 800, 26); m.dust(M0 + 6500, F.x, ff.y + 10, 1100, 'land');
m.beat(M0 + 7200, 'undim');
const TOTAL = cfg.totalMs || (M0 + 8000);

// readyHook: the outer emits oni:animationStart only when the tracks actually
// begin, so the director's offset gate (20.3 s) lands on the board impact and
// not a pre-roll earlier.
await tl.run(T, { total: TOTAL, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
