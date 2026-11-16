// ── Geist · Shadowbringers (approved mockup: b4/r3b beats 2-3, r6 implosion, r13 + r14 dark vortex burst) ──
// FULL-TAKEOVER timeline (cfg.live = false, like Rebellious Wing): the engine owns the board, paints every token
// and drives the camera from S.cam. No white glints / starfield anywhere in this skill (the mockup skips twinkles).
//   1. Darkness implodes (0):   pxfx_dark_implosion into his core, the field dims to .82, a low rumble, the camera
//                               pushes in (1000 ms sine) while he squashes down.
//   2. Violet burst (B1):       pxfx_dark_plasma on his core, a violet flash, shake 14.
//   3. Beam into the sky (B2):  pxfx_dark_column at his feet.
//   4. Dark vortex (B):         camera "Wide hold"; a whole-screen dim (.62, map AND party) under the VFX; Geist lifted
//                               above everything (brighter, pulsing crimson outline, trembling); pxfx_dark_plasma at his
//                               core + pxfx_dark_vortex at his feet stretched 1.55x sideways; at +120 the blast (dark-red
//                               flash, shake 30 + rumble 7, early wisp bursts); a ramp of black + red DarkWisps and red
//                               lightning streaks cracking out of him; strikes at +550/+950/+1380; at +2380 everything
//                               settles back (camera, dims, Geist), at +3080 the buff beat and the gate.
// Mockup px (1682 px stage) scale by KP; screen-space shakes by the viewport width / 1682.
const B1 = cfg.beatBurst, B2 = cfg.beatBeam, B = cfg.beatVortex;
const BOT = K.y + K.h / 2;                                   // mockup OY: the bottom of his art box
const CORE = { x: K.x, y: K.y };                             // mockup bodyAt / center: OY - hgt * .5
const FT = { x: K.x, y: BOT - 4 * KP };                      // mockup feet(): OY - 4
const SP = Math.max(0.4, ((tl.view && tl.view().W) || 1682) / 1682);
const pxW = (key, scale) => (CL[key] ? CL[key].w * 0.55 * scale * KP : 0);
// piecewise value track: segs = [t0, ms, to, ease]; a later tween starts from where the value is
function sbTw(init, segs) {
  const L = segs.slice().sort((a, b) => a[0] - b[0]); const starts = [];
  const valAt = (i, t) => { if (i < 0) return init; const sg = L[i]; if (t < sg[0]) return valAt(i - 1, t); const u = sg[1] > 0 ? Math.min(1, Math.max(0, (t - sg[0]) / sg[1])) : 1; return lerp(starts[i], sg[2], (sg[3] || E.lin)(u)); };
  for (let i = 0; i < L.length; i++) starts.push(i === 0 ? init : valAt(i - 1, L[i][0]));
  return (t) => { let i = L.length - 1; while (i >= 0 && t < L[i][0]) i--; return valAt(i, t); };
}
// the visible viewport in world px under the current transform (the overlay covers the whole view)
const visOf = (g) => { const M = g.getTransform(); const a = M.a || 1, d = M.d || 1, e = M.e || 0, f = M.f || 0; const cw = (g.canvas && g.canvas.width) || 0, ch = (g.canvas && g.canvas.height) || 0; return { x0: -e / a, y0: -f / d, x1: (cw - e) / a, y1: (ch - f) / d, z: Math.abs(a) }; };
const A3 = (v) => (v > 0 ? Math.min(1, v) : 0).toFixed(3);

// ── timing anchors of the vortex beat (mockup r13 waits) ──
const BLAST = B + 120, ST1 = B + 550, ST2 = B + 950, ST3 = B + 1380, CALM = B + 1880, SETTLE = B + 2380, FADE = cfg.restMs, GATE = SETTLE + FADE;
const W0 = cfg.wisp, SK0 = cfg.streaks;

// ── camera: push in on the implosion, "Wide hold" over the vortex, back to rest (zoom eased in log space) ──
const REST = { cx: tl.REST.cx, cy: tl.REST.cy, zoom: 1 };
const P1 = { cx: K.x + DIR * cfg.pushIn.dx * KP, cy: BOT - cfg.pushIn.dy * KP, zoom: cfg.pushIn.zoom };
const WIDE = { cx: tl.STAGE.x + tl.STAGE.w / 2 + DIR * cfg.wide.dx * KP, cy: BOT - cfg.wide.dy * KP, zoom: cfg.wide.zoom };
const camMix = (a, b, e) => ({ cx: lerp(a.cx, b.cx, e), cy: lerp(a.cy, b.cy, e), zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), e)) });
const camAt = (t) => {
  if (t < cfg.pushIn.ms) return camMix(REST, P1, E.sine(seg(t, 0, cfg.pushIn.ms)));
  if (t < B) return P1;
  if (t < B + cfg.wide.ms) return camMix(P1, WIDE, E.outC(seg(t, B, B + cfg.wide.ms)));
  if (t < SETTLE) return WIDE;
  return camMix(WIDE, REST, E.sine(seg(t, SETTLE, SETTLE + FADE)));
};

// ── his body: the squash of the implosion (1000 ms sine), released on the burst (120 ms) ──
const sxT = sbTw(1, [[0, 1000, 1.06, E.sine], [B1, 120, 1, E.outQ]]);
const syT = sbTw(1, [[0, 1000, 0.9, E.sine], [B1, 120, 1, E.outQ]]);
m.hold(0, B1 + 200, (t, S) => { const q = S.tok.k; if (q) { q.sx *= sxT(t); q.sy *= syT(t); } });

// ── field dim (under the battlers, as the mockup's #fdim): .82 on the implosion, .7 on the blast, out on the settle ──
const fdimT = sbTw(0, [[0, 500, cfg.fieldDim, E.sine], [BLAST, 300, cfg.blastDim, E.sine], [SETTLE, 800, 0, E.sine]]);
// rumble: 2 from the implosion, 7 from the blast, off at CALM (screen px)
const rumbleAt = (t) => (t < BLAST ? 2 : t < CALM ? 7 : 0) * SP;

// ── Geist on top for the burst (mockup geistOnTop): k rises over 300 ms (outCubic), falls over the settle (sine) ──
const topK = (t) => (t < B ? 0 : t < SETTLE ? E.outC(seg(t, B, B + 300)) : 1 - E.sine(seg(t, SETTLE, GATE)));
const ART = tl.art('k');
function paintTop(g, t, k, jx, jy) {
  if (!ART) return; const f = feet(K); const z = visOf(g).z; const px = (n) => (n * KP * z).toFixed(2) + 'px';
  const p = 0.75 + 0.25 * Math.sin((t - B) / 1000 * 7.5);
  g.save(); g.translate(K.x + jx, f.y + jy); g.scale(K.flip, 1);
  if (k > 0.001) g.filter = 'brightness(' + (1 + 0.45 * k).toFixed(3) + ') contrast(' + (1 + 0.1 * k).toFixed(3) + ')'
    + ' drop-shadow(0 0 ' + px(1.5 * k) + ' rgba(255,40,60,' + (0.95 * k).toFixed(2) + '))'
    + ' drop-shadow(0 0 ' + px(6 * p * k) + ' rgba(230,10,40,' + (0.85 * k).toFixed(2) + '))'
    + ' drop-shadow(0 0 ' + px(16 * p * k) + ' rgba(150,0,25,' + (0.7 * k).toFixed(2) + '))';
  g.drawImage(ART, -K.w / 2, -K.h * K.foot, K.w, K.h); g.restore();
}

// ── pre-rendered stamps (built once): DarkWisp halo+core per kind in three size buckets; the early-burst stamp ──
const mkCanvas = (n) => { const c = document.createElement('canvas'); c.width = n; c.height = n; return c; };
const STAMP = { black: [], red: [] }, BUCKETS = [32, 64, 128];
for (const kind of ['black', 'red']) for (const n of BUCKETS) {
  const cv = mkCanvas(n), c = cv.getContext('2d'), h = n / 2;
  if (kind === 'black') {
    // halo r = rad * 4.5 (the stamp edge): a dark disc with a crimson rim; core r = rad * 1.9: a black pit (normal blend)
    let gr = c.createRadialGradient(h, h, 0, h, h, h); gr.addColorStop(0, 'rgba(8,0,4,0.9)'); gr.addColorStop(0.45, 'rgba(20,2,10,0.7)'); gr.addColorStop(0.62, 'rgba(170,16,46,0.5)'); gr.addColorStop(1, 'rgba(90,0,20,0)');
    c.fillStyle = gr; c.fillRect(0, 0, n, n);
    const cr = h * 1.9 / 4.5; gr = c.createRadialGradient(h, h, 0, h, h, cr); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.beginPath(); c.arc(h, h, cr, 0, 6.2832); c.fill();
  } else {
    // halo r = rad * 7: a red glow; core r = rad * 1.9: hot crimson (both added)
    c.globalCompositeOperation = 'lighter';
    let gr = c.createRadialGradient(h, h, 0, h, h, h); gr.addColorStop(0, 'rgba(225,28,58,0.55)'); gr.addColorStop(0.35, 'rgba(225,28,58,0.18)'); gr.addColorStop(1, 'rgba(225,28,58,0)');
    c.fillStyle = gr; c.fillRect(0, 0, n, n);
    const cr = h * 1.9 / 7; gr = c.createRadialGradient(h, h, 0, h, h, cr); gr.addColorStop(0, 'rgba(255,110,130,1)'); gr.addColorStop(0.5, 'rgba(240,40,70,0.75)'); gr.addColorStop(1, 'rgba(225,28,58,0)'); c.fillStyle = gr; c.beginPath(); c.arc(h, h, cr, 0, 6.2832); c.fill();
  }
  STAMP[kind].push(cv);
}
const stampFor = (kind, devPx) => { const L = STAMP[kind]; for (let i = 0; i < BUCKETS.length; i++) if (BUCKETS[i] >= devPx) return L[i]; return L[L.length - 1]; };
const DW = {};
for (const kind of ['black', 'red']) {
  const n = 64, cv = mkCanvas(n), c = cv.getContext('2d'), h = n / 2; const gr = c.createRadialGradient(h, h, 0, h, h, h);
  if (kind === 'black') { gr.addColorStop(0, 'rgba(6,0,4,0.95)'); gr.addColorStop(0.28, 'rgba(18,2,10,0.85)'); gr.addColorStop(0.42, 'rgba(150,14,40,0.55)'); gr.addColorStop(0.6, 'rgba(90,6,24,0.18)'); gr.addColorStop(1, 'rgba(40,0,10,0)'); }
  else { gr.addColorStop(0, 'rgba(255,120,140,0.95)'); gr.addColorStop(0.18, 'rgba(235,40,70,0.8)'); gr.addColorStop(0.45, 'rgba(160,10,40,0.3)'); gr.addColorStop(1, 'rgba(80,0,20,0)'); }
  c.fillStyle = gr; c.fillRect(0, 0, n, n); DW[kind] = cv;
}

// ── the DarkWisp ramp (r14 wispRamp + DarkWisp over the ported defeat Wisp): units = token heights from his core
// (OY - hgt * .55), velocities in token heights / s; low drag .45, a curl of +-1.4..3.6 rad/s loosening 60 % over
// life plus a sine wobble, a 22-point trail, free over the whole viewport, faded within 8 % of its edge ──
const WR = { x: K.x, y: BOT - K.h * 0.55, h: K.h };
const WISPS = [];
function newWisp(o, kind) {
  return { kind, x: o.x, y: o.y, life: o.life, age: 0, core: o.core, minCore: 4 * KP, vx: 0, vy: 0, op: 1, gone: false,
    phase: rnd(0, 6.28), freq: rnd(0.6, 1.3), sway: rnd(2.5, 4.5), rise: rnd(1.3, 1.9), trail: [[o.x, o.y]], lastPush: 0, maxTrail: 22,
    curl: (R() < 0.5 ? -1 : 1) * (1.4 + R() * 2.2), wig: 2 + R() * 2.5 };
}
function wispUpdate(w, dt) {
  w.age += dt; const s = dt / 1000;
  const ax = Math.sin((w.age / 1000) * w.freq * 6.283 + w.phase) * w.sway;
  w.vx += ax * s; w.vy -= w.rise * s; const k = Math.exp(-0.45 * s); w.vx *= k; w.vy *= k;
  const life = w.age / w.life, turn = (w.curl * (1 - 0.6 * life) + Math.sin((w.age / 1000) * w.freq * 6.283 * 1.3 + w.phase) * w.wig) * s;
  const cs = Math.cos(turn), sn = Math.sin(turn), vx = w.vx; w.vx = vx * cs - w.vy * sn; w.vy = vx * sn + w.vy * cs;
  w.x += w.vx * s; w.y += w.vy * s;
  if (w.age - w.lastPush >= 16) { w.trail.push([w.x, w.y]); w.lastPush = w.age; if (w.trail.length > w.maxTrail) w.trail.shift(); }
  return w.age < w.life && !w.gone;
}
// trails as plain strokes in bands of 3 segments (one stroke per band, its width / alpha at the band middle)
function bandStroke(g, w, from, n, rgb, alphaOf, widthOf) {
  const t = w.trail;
  for (let i = from; i < n; i += 3) { const j = Math.min(n - 1, i + 2), mid = (i + j) / 2; const al = alphaOf(mid); if (!(al > 0.002)) continue;
    g.strokeStyle = 'rgba(' + rgb + ',' + A3(al) + ')'; g.lineWidth = Math.max(0.01, widthOf(mid));
    g.beginPath(); g.moveTo(WR.x + t[i - 1][0] * WR.h, WR.y + t[i - 1][1] * WR.h); for (let q = i; q <= j; q++) g.lineTo(WR.x + t[q][0] * WR.h, WR.y + t[q][1] * WR.h); g.stroke(); }
}
function wispDraw(g, w, v) {
  const px = WR.x + w.x * WR.h, py = WR.y + w.y * WR.h;
  const mm = Math.min(px - v.x0, v.x1 - px, py - v.y0, v.y1 - py), band = (v.x1 - v.x0) * 0.08;
  if (mm < -80 * KP) { w.gone = true; return; }
  const edge = Math.max(0, Math.min(1, mm / band)); const k = w.age / w.life;
  const a = Math.min(1, w.age / 120) * (k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1) * edge * w.op; if (!(a > 0)) return;
  const rad = Math.max(w.minCore, w.core * WR.h) * (1 - 0.35 * k), n = w.trail.length, black = w.kind === 'black';
  if (n > 1) {
    bandStroke(g, w, 1, n, black ? '12,1,7' : '225,28,58', (i) => (black ? 0.75 : 0.45) * (i / n) * a, (i) => rad * 2.4 * (i / n));
    const h0 = Math.max(1, Math.floor(n * 0.5));
    bandStroke(g, w, h0, n, black ? '170,18,48' : '255,140,160', (i) => 0.55 * ((i - n * 0.5) / (n * 0.5)) * a, (i) => Math.max(1.2 * KP, rad * 0.6 * ((i - n * 0.5) / (n * 0.5))));
  }
  const hr = rad * (black ? 4.5 : 7); g.globalAlpha = Math.min(1, a); g.drawImage(stampFor(w.kind, hr * 2 * v.z), px - hr, py - hr, hr * 2, hr * 2); g.globalAlpha = 1;
}
{ const t0 = B + W0.delay, END = W0.dur + W0.life * 1.2 + 200; let last = 0, acc = 0;
  m.hold(t0, t0 + END, (e, S) => {
    const dt = Math.max(0, Math.min(50, e - last)); last = e;
    if (e < W0.dur) { const u = e / W0.dur, ramp = u * u * (3 - 2 * u), rate = W0.rate0 + (W0.rate1 - W0.rate0) * Math.pow(u, 1.4); acc += rate * dt / 1000;
      while (acc >= 1) { acc -= 1; const ang = rnd(-Math.PI, Math.PI * 0.12), sp = (2.4 + 5.2 * ramp) * rnd(0.7, 1.25) * W0.speed;
        const w = newWisp({ x: rnd(-0.18, 0.18), y: rnd(-0.25, 0.2), life: W0.life * rnd(0.8, 1.2), core: (0.035 + 0.055 * ramp) * W0.size }, R() < W0.black ? 'black' : 'red');
        w.vx = Math.cos(ang) * sp * 1.25; w.vy = Math.sin(ang) * sp * 0.7; w.rise = rnd(0.4, 0.8); w.op = W0.op; WISPS.push(w); } }
    for (let i = WISPS.length - 1; i >= 0; i--) if (!wispUpdate(WISPS[i], dt)) WISPS.splice(i, 1);
    if (!WISPS.length) return;
    S.world.push({ z: 62, draw: (g) => { const v = visOf(g); g.save(); g.lineCap = 'round';
      g.globalCompositeOperation = 'source-over'; for (const w of WISPS) if (w.kind === 'black') wispDraw(g, w, v);
      g.globalCompositeOperation = 'lighter'; for (const w of WISPS) if (w.kind !== 'black') wispDraw(g, w, v);
      g.restore(); } });
  }); }

// ── the early burst wisps (r13 darkWispBurst): stamp-based, a 5-point trail, drag 2.6, sway, drifting up ──
function darkWispBurst(at, o) {
  const ox = K.x, oy = BOT - K.h * 0.55, hh = K.h, list = [];
  for (let i = 0; i < o.count; i++) { const ang = rnd(-Math.PI, Math.PI * 0.15), sp = rnd(0.5, 1.3) * (Math.abs(Math.cos(ang)) * 0.6 + 0.45);
    list.push({ at: Math.pow(R(), 1.3) * o.spawnMs, life: rnd(1500, 2600), x: ox + rnd(-0.35, 0.35) * hh, y: oy + rnd(-0.4, 0.3) * hh, vx: Math.cos(ang) * sp * 1700 * KP, vy: Math.sin(ang) * sp * 800 * KP,
      kind: R() < o.black ? 'black' : 'red', ph: rnd(0, 6.3), sway: rnd(60, 140) * KP, size: rnd(0.9, 1.6), tr: [], age: -1 }); }
  let last = 0; const END = o.spawnMs + 2700;
  m.hold(at, at + END, (e, S) => {
    const dt = Math.max(0, Math.min(50, e - last)) / 1000; last = e; let alive = 0;
    for (const w of list) { if (e < w.at) { alive++; continue; } if (w.age < 0) w.age = 0; w.age += dt * 1000; if (w.age >= w.life) continue; alive++;
      const drag = Math.exp(-2.6 * dt); w.vx = w.vx * drag + Math.sin(w.age / 1000 * 4 + w.ph) * w.sway * dt; w.vy = w.vy * drag - 90 * KP * dt; w.x += w.vx * dt; w.y += w.vy * dt;
      w.tr.push([w.x, w.y]); if (w.tr.length > 5) w.tr.shift(); }
    if (!alive) return;
    S.world.push({ z: 61, draw: (g) => { g.save(); g.lineCap = 'round';
      for (const pass of ['black', 'red']) { g.globalCompositeOperation = pass === 'black' ? 'source-over' : 'lighter';
        for (const w of list) { if (w.kind !== pass || w.age < 0 || w.age >= w.life) continue; const k = w.age / w.life;
          const al = Math.min(1, w.age / 120) * (k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1), r = 10 * w.size * (1 - 0.35 * k) * KP;
          if (w.tr.length > 1) { g.beginPath(); g.moveTo(w.tr[0][0], w.tr[0][1]); for (let i = 1; i < w.tr.length; i++) g.lineTo(w.tr[i][0], w.tr[i][1]);
            g.strokeStyle = pass === 'black' ? 'rgba(14,1,8,' + A3(0.7 * al) + ')' : 'rgba(220,30,60,' + A3(0.5 * al) + ')'; g.lineWidth = r * 0.6; g.stroke();
            if (pass === 'black') { g.strokeStyle = 'rgba(170,20,50,' + A3(0.35 * al) + ')'; g.lineWidth = r * 0.18; g.stroke(); } }
          g.globalAlpha = al; const sz = r * 5; g.drawImage(DW[pass], w.x - sz / 2, w.y - sz / 2, sz, sz); g.globalAlpha = 1; } }
      g.restore(); } });
  });
}

// ── red streaks (r14 redStreaks): semi-transparent jagged bolts (main + 2-4 forks, 3 stroke passes, added) cracking
// out of his core, 5/s ramping to cfg rate over the burst; each lives 120-220 ms and flickers ──
{ const ox = K.x, oy = BOT - K.h * 0.5, live = [];
  const bolt = (x0, y0, x1, y1, depth, jag) => { let pts = [[x0, y0], [x1, y1]]; for (let d = 0; d < depth; d++) { const nx = [pts[0]]; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); nx.push([(a[0] + b[0]) / 2 + rnd(-1, 1) * L * jag, (a[1] + b[1]) / 2 + rnd(-1, 1) * L * jag]); nx.push(b); } pts = nx; } return pts; };
  const make = (u, born) => { const ang = rnd(-Math.PI * 0.95, Math.PI * 0.05), r0 = rnd(20, 120) * KP, L = rnd(260, 620) * (0.7 + 0.6 * u) * KP, x0 = ox + Math.cos(ang) * r0, y0 = oy + Math.sin(ang) * r0 * 0.6;
    const main = bolt(x0, y0, x0 + Math.cos(ang) * L, y0 + Math.sin(ang) * L * 0.6, 5, 0.28), paths = [main]; const nf = 2 + Math.floor(R() * 3);
    for (let i = 0; i < nf; i++) { const p = main[2 + Math.floor(R() * (main.length - 4))], fa = ang + rnd(-0.9, 0.9), fl = rnd(60, 180) * KP; paths.push(bolt(p[0], p[1], p[0] + Math.cos(fa) * fl, p[1] + Math.sin(fa) * fl * 0.6, 3, 0.35)); }
    return { paths, born, life: rnd(120, 220), al: rnd(0.3, 0.55) * SK0.op }; };
  const t0 = B + SK0.delay; let last = 0, acc = 0;
  m.hold(t0, t0 + SK0.dur + 260, (e, S) => {
    const dt = Math.max(0, Math.min(50, e - last)); last = e;
    if (e < SK0.dur) { const u = e / SK0.dur; acc += (Math.min(5, SK0.rate) + Math.max(0, SK0.rate - 5) * u) * dt / 1000; while (acc >= 1) { acc -= 1; live.push(make(u, e)); } }
    for (let i = live.length - 1; i >= 0; i--) if (e - live[i].born > live[i].life) live.splice(i, 1);
    if (!live.length) return;
    S.world.push({ z: 60, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const s of live) { const age = e - s.born; const k = (1 - age / s.life) * ((Math.floor(age / 30) % 2) ? 0.6 : 1) * s.al;
        s.paths.forEach((p, j) => { const main = j === 0; g.beginPath(); g.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
          g.strokeStyle = 'rgba(200,10,40,' + A3(0.45 * k) + ')'; g.lineWidth = (main ? 9 : 5) * KP; g.stroke();
          g.strokeStyle = 'rgba(255,50,80,' + A3(0.8 * k) + ')'; g.lineWidth = (main ? 3 : 1.6) * KP; g.stroke();
          if (main) { g.strokeStyle = 'rgba(255,150,170,' + A3(0.7 * k) + ')'; g.lineWidth = 1.2 * KP; g.stroke(); } }); }
      g.restore(); } });
  }); }

// ── screen: camera, field dim, top dim, Geist on top, rumble, flashes ──
const TOP_END = GATE;
const total = Math.max(B + 3480, B + W0.delay + W0.dur + W0.life * 1.2 + 250, GATE + (CL.powerup ? CL.powerup.dur : 0) + 100);
m.hold(0, total, (t, S) => {
  S.cam = camAt(t);
  const fd = fdimT(t); if (fd > 0.001) S.dim = Math.max(S.dim, fd);
  const ru = rumbleAt(t); if (ru > 0) S.shake = Math.max(S.shake, ru);
});
m.hold(B, TOP_END, (e, S) => {
  const t = B + e, k = topK(t), q = S.tok.k; if (q) q.hidden = true;     // the engine's copy of him steps aside; he is painted at z 70
  const jx = k > 0.05 ? (Math.random() * 2 - 1) * 2.6 * k * KP : 0, jy = k > 0.05 ? (Math.random() * 2 - 1) * 1.6 * k * KP : 0;
  // the whole-screen dim over the map AND the party (z 5: above every painted token, under every effect)
  if (k > 0.001) S.world.push({ z: 5, draw: (g) => { const v = visOf(g), mx = (v.x1 - v.x0) * 0.1, my = (v.y1 - v.y0) * 0.1; g.save(); g.globalCompositeOperation = 'source-over'; g.fillStyle = 'rgba(5,0,10,' + (cfg.topDim * k).toFixed(3) + ')'; g.fillRect(v.x0 - mx, v.y0 - my, v.x1 - v.x0 + 2 * mx, v.y1 - v.y0 + 2 * my); g.restore(); } });
  S.world.push({ z: 70, draw: (g) => paintTop(g, t, k, jx, jy) });
});
const sbFlash = (at, color, peak, inMs, outMs) => m.hold(at, at + inMs + outMs, (e, S) => { const a = e < inMs ? peak * e / inMs : peak * (1 - E.outQ((e - inMs) / outMs)); if (a > S.flash.a) S.flash = { a, c: color }; });

// ── 1. darkness implodes ──
S_(0, 'darkness5', 0.5);
pxfx('pxfx_dark_implosion', 0, CORE, pxW('pxfx_dark_implosion_front', cfg.implodeScale));
// ── 2. violet burst ──
S_(B1, 'execution', 0.6);
pxfx('pxfx_dark_plasma', B1, CORE, pxW('pxfx_dark_plasma_front', cfg.burstScale));
sbFlash(B1, '#b080ff', 0.45, 30, 320);
m.shake(B1, 420, 14 * SP);
// ── 3. beam into the sky ──
S_(B2, 'magic4', 0.5);
pxfx('pxfx_dark_column', B2, FT, pxW('pxfx_dark_column_front', cfg.columnScale));
// ── 4. dark vortex ──
S_(B, 'darkness5', 0.5); S_(B, 'execution', 0.5);
// the plasma at his core (no back layer), the vortex at his feet stretched sideways, both above the top dim
const plW = pxW('pxfx_dark_plasma_front', cfg.plasmaScale);
fx('pxfx_dark_plasma_front', B, CORE, plW, { z: 44 });
fx('pxfx_dark_plasma_light', B, CORE, plW, { z: 45, add: true, filter: LUMA_FILTER });
const VX = { x: K.x, y: BOT + 6 * KP }, vxW = pxW('pxfx_dark_vortex_front', cfg.vortexScale);
fx('pxfx_dark_vortex_front', B, VX, vxW, { z: 46, sx: cfg.vortexSx });
fx('pxfx_dark_vortex_light', B, VX, vxW, { z: 47, sx: cfg.vortexSx, add: true, filter: LUMA_FILTER });
// the blast
sbFlash(BLAST, '#5a0818', 0.3, 30, 360);
S_(BLAST, 'explosion2', 0.6); S_(BLAST, 'darkness4', 0.45);
darkWispBurst(BLAST, { count: 60, spawnMs: 800, black: 0.55 });
darkWispBurst(BLAST + 500, { count: 30, spawnMs: 600, black: 0.4 });
m.shake(BLAST, 1000, 30 * SP);
// the three red strikes
S_(ST1, 'thunder3', 0.5); m.shake(ST1, 220, 14 * SP);
S_(ST2, 'thunder8', 0.45); m.shake(ST2, 220, 12 * SP);
S_(ST3, 'thunder3', 0.4); m.shake(ST3, 220, 12 * SP);
S_(CALM, 'darkness3', 0.4);
// settle: camera back, dims out, Geist back (SETTLE .. GATE), then the buff beat + the gate
buffBeat(GATE);
await go(total, GATE);
