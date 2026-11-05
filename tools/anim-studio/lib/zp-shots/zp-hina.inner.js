// Hina — Zero Power: A Million Possibility (mockup v17, cfg locked 2026-11-06).
// Fortune telling: a ripple reads the whole field and locks onto everyone it passes,
// an absurd pinned dive into her crystal ball (a screen-space zoom of a board
// snapshot: the LIVE board never moves the camera), a void of half-seen futures of
// everyone on the field (their real art and pose art, random pose / angle / size),
// a snap pull-back that shows it was inside the ball she holds (portrait tilted and
// turning into place), whiteout, and the game's buff beat on her.
// Mockup units: a 1682 x 788 screen, battlers ~170 px tall; screen sizes x (H / 788).
// cfg: rippleMs, voidMs, spawnMs, diveMs, diveZoom, revealDown, revealScale, revealMs,
// revealTilt, revealHold, sfx[] (absolute ms), t (the beat times, from the sig).
if (!caster) { K.ready(); oni.fireDone(); return; }

// ── tokens: Hina 'c', and everyone else on the board as future sources 'f0..' ──
const POSE_PROPS = ['sprite_hurt', 'sprite_ko', 'sprite_crisis', 'sprite_sleep', 'sprite_guard', 'sprite_attack', 'sprite_cast', 'sprite_walk', 'sprite_walk_up_left'];
const tokens = { c: { token: caster } }; const poses = {}; const FK = [];
const seen = new Set([caster.id]);
for (const t of (canvas.tokens && canvas.tokens.placeables) || []) {
  if (seen.has(t.id) || !t.visible || !t.mesh || (t.document && t.document.hidden)) continue; seen.add(t.id);
  const k = 'f' + FK.length; FK.push(k); tokens[k] = { token: t };
  const pp = {}; for (const p of POSE_PROPS) pp[p] = { prop: p }; poses[k] = pp;
}
const tl = oni.timeline({ tokens, poses, clips: A.clips || {}, images: A.images || {}, live: true, depthRef: 'c' });
await tl.load();
const T = []; const m = tl.mk(T); const TOK = tl.TOK; const E = tl.E;
const U = ((TOK.c && TOK.c.h) || 170) / 170;
const t = cfg.t;                     // beat times (ms), computed in zp-sig-hina.js
const dir = K.dirOf(TOK, 'c');
const hf = tl.feet(TOK.c);
const RS = (tl.STAGE.w || 1682) / 1682; // the mockup's field was the 1682 px stage

// ── Wind-up: the screen dims, the shipped full-body cut-in ──
m.dim(0, 200, 0.55);
ZP.cutin(tl, m, 0, 'cut');

// ── Ripple scan: three floor rings from her feet; the first locks onto everyone it passes ──
const RIP = t.ripple, RIPPLE_SQ = 0.34, RMAX = 1900 * RS;
m.clip('mc', RIP, { x: hf.x, y: hf.y, w: 112 * 0.7 * 1.1 * U, sy: 0.38, z: 2, add: true, filter: K.tintF(265, 4, 1.25) });
[0, 280, 560].forEach((delay) => m.hold(RIP + delay, RIP + delay + cfg.rippleMs, (e, S) => {
  const u = e / cfg.rippleMs; const r = RMAX * E.outQ(u); const a = 1 - u;
  S.world.push({ z: 3, draw: (g) => { g.save(); g.translate(hf.x, hf.y); g.scale(1, RIPPLE_SQ); g.globalCompositeOperation = 'lighter';
    const gr = g.createRadialGradient(0, 0, Math.max(0, r - 60 * RS), 0, 0, r + 6 * RS); gr.addColorStop(0, 'rgba(140,100,255,0)'); gr.addColorStop(0.75, 'rgba(150,110,255,' + (0.25 * a) + ')'); gr.addColorStop(0.97, 'rgba(235,225,255,' + (0.95 * a) + ')'); gr.addColorStop(1, 'rgba(235,225,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r + 6 * RS, 0, 6.2832); g.fill(); g.restore(); } });
}));
// lock time: the first ring reaches the target's feet (floor distance, perspective squashed)
const ringsEnd = RIP + 560 + cfg.rippleMs;
const lockAt = (k) => { const f = tl.feet(TOK[k]); const d = Math.hypot(f.x - hf.x, (f.y - hf.y) / RIPPLE_SQ); if (d >= RMAX) return ringsEnd; return RIP + cfg.rippleMs * (1 - Math.sqrt(1 - d / RMAX)); };
const pulseAt = ringsEnd + 250, retEnd = t.dive + cfg.diveMs;
for (const k of FK) {
  const at = lockAt(k); const T0 = TOK[k];
  m.tint(at, 400, k, '#9a6cff', (u) => 0.6 * (1 - u));
  m.hold(at, retEnd, (e, S) => { const f = tl.feet(T0); const w = T0.w + 24 * U, h = T0.h + 18 * U;
    let s = 1 + 0.6 * (1 - E.outC(Math.min(1, e / 220))), a = Math.min(1, e / 220), br = 1;
    const pe = e + at - pulseAt; if (pe >= 0 && pe < 500) { const q = Math.sin(pe / 500 * Math.PI); s *= 1 + 0.12 * q; br = 1 + q; }
    S.world.push({ z: 60, draw: (g) => { g.save(); g.translate(f.x, f.y - h / 2); g.scale(s, s); g.globalAlpha = a; const L = 22 * U, x0 = -w / 2, y0 = -h / 2;
      g.strokeStyle = br > 1.05 ? '#ffffff' : '#cbb6ff'; g.lineWidth = 3 * U; g.shadowColor = '#8a5cff'; g.shadowBlur = 6 * U * br; g.lineCap = 'square';
      for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [-x0, y0, -1, 1], [x0, -y0, 1, -1], [-x0, -y0, -1, -1]]) { g.beginPath(); g.moveTo(cx, cy + sy * L); g.lineTo(cx, cy); g.lineTo(cx + sx * L, cy); g.stroke(); }
      g.restore(); } });
  });
}

// ── Into the crystal ball: a board snapshot zooms absurdly deep, pinned on her ball ──
// (PIXI renders the stage once into a texture at the dive's first frame.)
let SNAP = null, snapTried = false;
const snap = () => { if (snapTried) return SNAP; snapTried = true; try { const r = canvas.app.renderer; const Wv = r.screen.width, Hv = r.screen.height; const rt = PIXI.RenderTexture.create({ width: Wv, height: Hv, resolution: 1 }); r.render(canvas.stage, { renderTexture: rt, clear: true }); SNAP = r.extract.canvas(rt); try { rt.destroy(true); } catch (e) {} } catch (e) { console.warn('[ZP][Hina] snapshot failed', e); SNAP = null; } return SNAP; };
const ballW = { x: hf.x + dir * TOK.c.w * 0.1, y: hf.y - TOK.c.h * 0.5 };
const D0 = t.dive, V0 = D0 + cfg.diveMs;
m.hold(D0, V0, (e, S) => {
  const img = snap(); S.hideBoard = true; const u = e / cfg.diveMs;
  S.screen.push({ draw: (g) => { const W = g.W, H = g.H;
    if (img) { const p = tl.toScreen(ballW.x, ballW.y); const ez = u * u * u * u; const z = Math.exp(Math.log(cfg.diveZoom) * ez); const k = 1 - Math.min(1, u * 1.6);
      const cx = W / 2 + (p.x - W / 2) * k, cy = H / 2 + (p.y - H / 2) * k; const iw = img.width, ih = img.height;
      g.save(); g.translate(cx, cy); g.scale(z * W / iw, z * H / ih); g.translate(-p.x * iw / W, -p.y * ih / H); g.drawImage(img, 0, 0); g.restore(); }
    const b = u < 0.8 ? 0 : (u - 0.8) / 0.2; if (b > 0) { g.save(); g.globalAlpha = E.sine(b); g.fillStyle = '#000'; g.fillRect(-20, -20, W + 40, H + 40); g.restore(); } } });
});

// ── The void: Hina's painting with a slow drift, purple dust, and the futures ──
const F0 = t.futures, RV = t.reveal, W0 = t.white;
const VC = document.createElement('canvas'); const VX = VC.getContext('2d');
const rr = tl.rng(97);
// dust: 50 already there, then 2 every 180 ms until the hold ends
const DUST = [];
for (let i = 0; i < 50; i++) DUST.push({ b: V0 - rr() * 2000, life: 3000 + rr() * 6000, x: rr(), y: rr(), vx: (rr() - 0.5) * 0.04, vy: (rr() - 0.5) * 0.04, r: 1 + rr() * 1.6 });
for (let tt = V0; tt < W0; tt += 180) for (let j = 0; j < 2; j++) DUST.push({ b: tt, life: 3000 + rr() * 3000, x: rr(), y: rr(), vx: (rr() - 0.5) * 0.04, vy: (rr() - 0.5) * 0.04, r: 1 + rr() * 1.6 });
// futures: one every spawnMs for voidMs, each a random source, pose, spot, angle, size
const tsc = (y) => { const den = 440 - 84.8; const num = Math.max(y - 84.8, den * 0.05); return Math.min(1.12, Math.max(0.6, Math.pow(num / den, 0.335))); };
const FUT = [];
if (FK.length) for (let tt = 0; tt < cfg.voidMs; tt += cfg.spawnMs) {
  const k = FK[Math.floor(rr() * FK.length)]; const P = tl.POSE[k] ? Object.values(tl.POSE[k]) : []; const pick = Math.floor(rr() * (P.length + 1));
  const yf = (250 + rr() * 520) / 788, xf = (140 + rr() * 1402) / 1682;
  FUT.push({ b: F0 + tt, k, pose: pick < P.length ? P[pick] : null, xf, yf, rot: (rr() * 2 - 1) * Math.PI, flip: rr() < 0.5 ? -1 : 1, size: tsc(yf * 788) * (0.6 + rr() * 1.1) });
}
const stageScale = () => (canvas.stage && canvas.stage.scale ? canvas.stage.scale.x : 1);
function drawVoid(now, W, H) {
  if (VC.width !== Math.round(W) || VC.height !== Math.round(H)) { VC.width = Math.round(W); VC.height = Math.round(H); }
  const g = VX; const sc = H / 788; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, VC.width, VC.height);
  const kd = Math.min(1, Math.max(0, (now - F0) / (cfg.voidMs + 1200))); const z = Math.exp(Math.log(1.12) * kd);
  g.save(); g.translate(W / 2, H / 2); g.rotate(-1.2 * kd * Math.PI / 180); g.scale(z, z); g.translate(-(W / 2 + 16 * sc * kd), -H / 2);
  g.fillStyle = '#05020c'; g.fillRect(-W, -H, W * 3, H * 3);
  const bg = tl.IMG.voidbg; if (bg) { const iw = bg.naturalWidth || bg.width, ih = bg.naturalHeight || bg.height; const s = Math.max(W / iw, H / ih); g.drawImage(bg, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s); }
  // futures: half see-through, rotated about their middle
  for (const f of FUT) { const age = now - f.b; if (age < 0 || age >= 1930) continue;
    const a = age < 180 ? 0.5 * E.outQ(age / 180) : age < 1680 ? 0.5 : 0.5 * (1 - E.inQ((age - 1680) / 250));
    const T0 = TOK[f.k]; const art = f.pose ? f.pose.img : tl.art(f.k); if (!art || !T0) continue;
    const baseH = T0.h * stageScale() * f.size; const h = f.pose ? baseH * f.pose.h / T0.h : baseH; const aw = art.naturalWidth || art.videoWidth || art.width || 1, ah = art.naturalHeight || art.videoHeight || art.height || 1; const w = h * aw / ah;
    const x = f.xf * W, y = f.yf * H;
    g.save(); g.translate(x, y - h / 2); g.rotate(f.rot); g.scale(f.flip, 1); g.globalAlpha = a; try { g.drawImage(art, -w / 2, -h / 2, w, h); } catch (e) {} g.restore(); }
  // dust
  g.globalCompositeOperation = 'lighter';
  for (const d of DUST) { const age = now - d.b; if (age < 0 || age >= d.life) continue; const u = age / d.life;
    const x = d.x * W + d.vx * age * sc, y = d.y * H + d.vy * age * sc; const a = Math.sin(u * Math.PI) * (0.5 + 0.5 * Math.sin(age / 120 + d.x * 1682)); if (a <= 0) continue; const r = d.r * sc;
    g.fillStyle = 'rgba(200,180,255,' + a + ')'; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); ZP.glow(g, x, y, r * 4, '200,180,255', a * 0.35); }
  g.restore(); g.globalCompositeOperation = 'source-over';
}
// full screen until the reveal; black on top until it fades out (V0 + 250 .. + 900)
m.hold(V0, RV, (e, S) => { const now = V0 + e; S.hideBoard = true;
  S.screen.push({ draw: (g) => { drawVoid(now, g.W, g.H); g.drawImage(VC, 0, 0, g.W, g.H);
    const b = e < 250 ? 1 : e < 900 ? 1 - E.sine((e - 250) / 650) : 0; if (b > 0) { g.save(); g.globalAlpha = b; g.fillStyle = '#000'; g.fillRect(-20, -20, g.W + 40, g.H + 40); g.restore(); } } });
});

// ── The reveal: the void collapses into the ball she is holding; the portrait turns into place ──
const ORB = { cx: 408, cy: 881, r: 116, iw: 998, ih: 1076 };   // the ball inside hina_Cut-in003.png (image px)
const tilt = (cfg.revealTilt == null ? 18 : cfg.revealTilt) * Math.PI / 180;
const PULL = RV + 120, SHING = PULL + cfg.revealMs;
m.hold(RV, W0 + 1200, (e, S) => { const now = RV + e; S.hideBoard = true;
  S.screen.push({ draw: (g) => {
    const W = g.W, H = g.H, sc = H / 788; const R = ORB.r * 0.985; const S0 = Math.hypot(W / 2, H / 2) / R * 1.02;
    const s1 = cfg.revealScale * sc; const c1 = { x: W / 2, y: H - (ORB.ih - ORB.cy) * s1 + cfg.revealDown * sc };
    let s, cx, cy, rot, bgA, glassA;
    if (now < PULL) { s = S0; cx = W / 2; cy = H / 2; rot = tilt; bgA = 0; glassA = 0; }
    else if (now < SHING) { const k = E.outQ(E.outQ((now - PULL) / cfg.revealMs)); s = Math.exp(Math.log(S0) + (Math.log(s1) - Math.log(S0)) * k); cx = W / 2 + (c1.x - W / 2) * k; cy = H / 2 + (c1.y - H / 2) * k; rot = tilt * (1 - k); bgA = Math.min(1, k * 2); glassA = Math.min(1, Math.max(0, (Math.log(S0) - Math.log(s)) / Math.log(S0 / 2.2))); }
    else { const k = Math.min(1, (now - SHING) / cfg.revealHold); s = Math.exp(Math.log(s1) + (Math.log(s1 * 0.97) - Math.log(s1)) * k); cx = c1.x; cy = c1.y - 6 * sc * k; rot = 0; bgA = 1; glassA = 1; }
    drawVoid(now, W, H);
    // the room behind her
    g.save(); g.globalAlpha = bgA; const bgr = g.createRadialGradient(W * 0.52, H * 0.7, 0, W * 0.52, H * 0.7, Math.hypot(W, H) * 0.6); bgr.addColorStop(0, '#3a2378'); bgr.addColorStop(0.55, '#140a2c'); bgr.addColorStop(1, '#05020c'); g.fillStyle = bgr; g.fillRect(-20, -20, W + 40, H + 40); g.restore();
    g.save(); g.translate(cx, cy); g.rotate(rot); g.scale(s, s); g.translate(-ORB.cx, -ORB.cy);
    const img = tl.IMG.orb; if (img) g.drawImage(img, 0, 0, ORB.iw, ORB.ih);
    // the ball window: the void inside, at 1/S0 of the screen
    g.save(); g.beginPath(); g.arc(ORB.cx, ORB.cy, R, 0, 6.2832); g.clip();
    g.save(); g.translate(ORB.cx, ORB.cy); g.scale(1 / S0, 1 / S0); g.drawImage(VC, -W / 2, -H / 2, W, H); g.restore();
    if (glassA > 0) { g.globalAlpha = glassA;
      let gr = g.createRadialGradient(ORB.cx + R * 0.32, ORB.cy - R * 0.44, 0, ORB.cx + R * 0.32, ORB.cy - R * 0.44, R * 0.28); gr.addColorStop(0, 'rgba(255,255,255,.75)'); gr.addColorStop(0.43, 'rgba(255,255,255,.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(ORB.cx - R, ORB.cy - R, 2 * R, 2 * R);
      gr = g.createRadialGradient(ORB.cx, ORB.cy, 0, ORB.cx, ORB.cy, R); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.58, 'rgba(0,0,0,0)'); gr.addColorStop(0.86, 'rgba(30,10,70,.65)'); gr.addColorStop(0.98, 'rgba(190,170,255,.55)'); gr.addColorStop(1, 'rgba(190,170,255,0)'); g.fillStyle = gr; g.fillRect(ORB.cx - R, ORB.cy - R, 2 * R, 2 * R); g.globalAlpha = 1; }
    // the glint sweeps across after Metal_Shing (700 ms)
    const gq = (now - SHING) / 700; if (gq >= 0 && gq < 1) { const x0 = ORB.cx - R, span = 2 * R; const p = E.sine(gq); const gx = x0 + span * (1.5 - 2 * p) - span * 0.5;
      const lg = g.createLinearGradient(gx - R * 0.6, ORB.cy - R * 0.35, gx + R * 0.6, ORB.cy + R * 0.35); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,.6)'); lg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = lg; g.fillRect(ORB.cx - R, ORB.cy - R, 2 * R, 2 * R); }
    g.restore();
    g.restore();
  } });
});
m.shake(SHING, 280, 8 * U);
m.flash(SHING, 20, 200, '#ffffff', 0.35);

// ── Whiteout, back to battle, the game's buff beat on Hina ──
m.hold(W0, W0 + 1200 + 850, (e, S) => { const a = e < 1200 ? E.sine(e / 1200) : 1 - E.sine((e - 1200) / 850);
  S.over.push({ draw: (g) => { g.save(); g.globalAlpha = a; g.fillStyle = '#ffffff'; g.fillRect(-20, -20, g.W + 40, g.H + 40); g.restore(); } }); });
m.undim(W0 + 1200, 1, 0.55);
const BUFF = W0 + 2050;
m.clip('powerup', BUFF, { x: hf.x, y: hf.y, w: 508 * 0.55 * U, z: 50 });

await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
