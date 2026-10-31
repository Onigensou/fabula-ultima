// Kirin · Divine Railstream (inner script, every client).
// Port of the approved mockup ("Divine Railstream Upgrade" artifact, revision 7).
// The Kirin charges at the horn and rears; the beam leaves along the horn and the
// camera follows it up while the board fades to black; the beam vanishes in a
// flash; streams of lightning race at the lens from where the flash was; one bolt
// reaches the lens and covers the view, and the board snaps in behind it. Then the
// barrage: every oni.hit() tick is a volley on all targets. The party turns to
// silhouettes as the white rises and the white consumes them. Damage gate at the
// last tick (offset timing). Every number lives in cfg.
// Clips are decoded to frames first: this shot overlaps too many to run as videos.
// No backticks in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const C = cfg.t;
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }

const tokens = { k: { token: caster, foot: cfg.casterFoot, hurt: null } };
const PARTY = [];
targets.forEach((t, i) => { const k = 't' + i; PARTY.push(k); tokens[k] = { token: t, foot: cfg.partyFoot, hurt: null }; });
const tl = oni.timeline({ tokens, clips: {} });
await tl.load();

const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK, feet = tl.feet, D = tl.draw;
const glow = D.glowCircle, BLUE = cfg.blue;

// ── frames ──
const LIB = {};
const HURT = {};
await Promise.all([
  ...Object.entries(A.clips).map(async ([key, def]) => {
    try { const d = await tl.decode(def.url, { fps: def.fps, scale: def.scale || 1, dur: def.dur }); LIB[key] = Object.assign({}, def, d); }
    catch (e) { console.warn('[Railstream] clip failed', key, e); }
  }),
  ...PARTY.map(async (k) => {
    const url = TOK[k].token?.actor?.system?.props?.sprite_hurt;
    if (!url) return;
    try { HURT[k] = await tl.decode(url, { fps: 15 }); } catch (e) { console.warn('[Railstream] hurt failed', k, e); }
  }),
]);

const derived = new Map();
const cached = (F, key, make) => { let m = derived.get(F); if (!m) { m = {}; derived.set(F, m); } return m[key] || (m[key] = make()); };
const sizeOf = (F) => ({ w: F.videoWidth || F.naturalWidth || F.width || 2, h: F.videoHeight || F.naturalHeight || F.height || 2 });
const blank = (F) => { const s = sizeOf(F), c = document.createElement('canvas'); c.width = s.w; c.height = s.h; return { c, x: c.getContext('2d'), w: s.w, h: s.h }; };
// recolour, keeping the clip's luminance
const tintedFrame = (F, color) => cached(F, color, () => { const b = blank(F); b.x.drawImage(F, 0, 0); b.x.globalCompositeOperation = 'color'; b.x.fillStyle = color; b.x.fillRect(0, 0, b.w, b.h); b.x.globalCompositeOperation = 'destination-in'; b.x.drawImage(F, 0, 0); return b.c; });
const solidFrame = (F, color) => cached(F, 'solid' + color, () => { const b = blank(F); b.x.drawImage(F, 0, 0); b.x.globalCompositeOperation = 'source-in'; b.x.fillStyle = color; b.x.fillRect(0, 0, b.w, b.h); return b.c; });
// a stream fades in at the far end and has a soft leading end
const softEnd = (F) => cached(F, 'soft', () => { const b = blank(F); b.x.drawImage(F, 0, 0); b.x.globalCompositeOperation = 'destination-in'; const gr = b.x.createLinearGradient(0, b.h * 0.04, 0, b.h * 0.72); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.09, 'rgba(0,0,0,1)'); gr.addColorStop(0.78, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); b.x.fillStyle = gr; b.x.fillRect(0, 0, b.w, b.h); return b.c; });
// the perspective taper, baked once per frame one pixel row at a time: one image per copy, so no strip seams
const taperFrame = (F) => cached(F, 'taper', () => { const y0 = Math.round(F.height * 0.14), h = Math.round(F.height * 0.58), c = document.createElement('canvas'); c.width = F.width; c.height = h; const x = c.getContext('2d'); for (let y = 0; y < h; y++) { const ws = F.width * lerp(0.1, 1, y / h); x.drawImage(F, 0, y0 + y, F.width, 1, (F.width - ws) / 2, y, ws, 1); } return c; });
// the beam's base dissolves into the glow at the horn instead of ending on a flat edge
const softBase = (F) => cached(F, 'base', () => { const b = blank(F); b.x.drawImage(F, 0, 0); b.x.globalCompositeOperation = 'destination-out'; const gr = b.x.createLinearGradient(0, b.h * 0.52, 0, b.h * 0.6); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)'); b.x.fillStyle = gr; b.x.fillRect(0, b.h * 0.52, b.w, b.h * 0.48); return b.c; });
// silhouette: solid black from the opaque pixels only, so a soft shadow painted into a hurt clip does not become a grey disc
const silFrame = (F) => cached(F, 'sil', () => { const b = blank(F); try { b.x.drawImage(F, 0, 0); const id = b.x.getImageData(0, 0, b.w, b.h), d = id.data; for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = d[i + 3] > 170 ? 255 : 0; } b.x.putImageData(id, 0, 0); return b.c; } catch (e) { return solidFrame(F, '#000'); } });
const frameAt = (L, tt, loop) => { const n = L.frames.length, u = loop ? ((tt % L.dur) + L.dur) % L.dur : Math.min(tt, L.dur - 1); return L.frames[Math.max(0, Math.min(n - 1, Math.floor(u / L.dur * n)))]; };

// ── tracks ──
const T = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (!did) { did = true; fn(); } } }); };
// o: x,y scene px (or screen:{x,y} fractions + wh) | w | rot | sx,sy | tint | add | z | alpha(u) | pivot | loop+hold | live(tl,S) | crop:[a,b] | range:[a,b] | topY(tl) | toY | softBase
function clip(key, t0, o) {
  const L = LIB[key]; if (!L) return;
  const dur = o.hold != null ? o.hold : L.dur;
  T.push({ t0, t1: t0 + dur, fn: (tt, S) => {
    const a = o.alpha ? o.alpha(clamp01(tt / dur), tt) : 1; if (a <= 0) return;
    let F0;
    if (o.range) { const c = o.range[1] - o.range[0] + 1; F0 = L.frames[o.range[0] + Math.floor((((tt % L.dur) + L.dur) % L.dur) / L.dur * c)]; }
    else F0 = frameAt(L, o.loopOffset ? tt + o.loopOffset : tt, !!o.loop);
    if (o.softBase) F0 = softBase(F0);
    const F = o.tint ? tintedFrame(F0, o.tint) : F0;
    const draw = (g) => {
      const p = o.live ? o.live(tt, S, g) : null; if (o.live && !p) return;
      const rot = o.rot || 0, sx = p && p.sx != null ? p.sx : (o.sx || 1), cr = o.crop || [0, 1], aspect = L.h * (cr[1] - cr[0]) / L.w;
      let x, y, dw, dh;
      if (o.screen) { dh = g.H * (p && p.wh != null ? p.wh : o.wh); dw = dh / aspect; x = (p && p.x != null ? p.x : o.screen.x) * g.W; y = (p && p.y != null ? p.y : o.screen.y) * g.H; }
      else { dw = p && p.w != null ? p.w : o.w; dh = dw * aspect; x = p && p.x != null ? p.x : o.x; y = p && p.y != null ? p.y : o.y; }
      g.save();
      if (o.topY) { const yy = o.topY(tt, S); g.beginPath(); g.rect(x - 5000, yy, 10000, 8000); g.clip(); }
      g.translate(x, y); if (rot) g.rotate(rot); g.scale(sx, o.sy || 1); g.globalAlpha = a; if (o.add) g.globalCompositeOperation = 'lighter';
      const pax = o.pivot ? o.pivot.x : L.ax, pay = o.pivot ? o.pivot.y : L.ay;
      // toY: keep the burst at native size and stretch only the bolt above it, so the streak runs past the top of the frame
      if (o.toY != null) { const c = 0.7, yTop = o.toY - y; g.drawImage(F, 0, F.height * c, F.width, F.height * (1 - c), -pax * dw, -(pay - c) * dh, dw, (1 - c) * dh); g.drawImage(F, 0, F.height * 0.14, F.width, F.height * (c - 0.14), -pax * dw, yTop, dw, -(pay - c) * dh - yTop + 1); }
      else g.drawImage(F, 0, F.height * cr[0], F.width, F.height * (cr[1] - cr[0]), -pax * dw, -pay * dh, dw, dh);
      g.restore();
    };
    if (o.screen) S.screen.push({ draw }); else S.world.push({ z: o.z == null ? 10 : o.z, draw });
  } });
}
// an impact's debris: hot sparks thrown up and falling, glowing motes drifting up, dark rock chips
function sparks(at, x, y, n, R) {
  const ps = [...Array(n)].map(() => ({ a: -Math.PI * (0.08 + R() * 0.84), v: 240 + R() * 620, life: 360 + R() * 420, w: 1.6 + R() * 3, c: R() < 0.45 ? '#ffffff' : R() < 0.6 ? '#a8d8ff' : '#6fb8ff' }));
  const mo = [...Array(Math.ceil(n / 3))].map(() => ({ dx: (R() - 0.5) * 150, vy: -(50 + R() * 130), life: 520 + R() * 420, r: 6 + R() * 10 }));
  const ch = [...Array(Math.ceil(n / 4))].map(() => ({ a: -Math.PI * (0.2 + R() * 0.6), v: 200 + R() * 340, s: 4 + R() * 6, spin: R() * 12, life: 460 + R() * 300 }));
  const G = 1250;
  T.push({ t0: at, t1: at + 950, fn: (tt, S) => { S.world.push({ z: 37, draw: (g) => {
    const s = tt / 1000; g.save();
    for (const c of ch) { if (tt > c.life) continue; g.save(); g.translate(x + Math.cos(c.a) * c.v * s, y + Math.sin(c.a) * c.v * s + 0.5 * G * s * s); g.rotate(c.spin * s); g.globalAlpha = 1 - tt / c.life; g.fillStyle = '#1a2230'; g.fillRect(-c.s / 2, -c.s / 2, c.s, c.s * 0.7); g.restore(); }
    g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
    for (const p of ps) { if (tt > p.life) continue; const s0 = Math.max(0, s - 0.035); g.globalAlpha = 1 - tt / p.life; g.strokeStyle = p.c; g.lineWidth = p.w; g.beginPath(); g.moveTo(x + Math.cos(p.a) * p.v * s0, y + Math.sin(p.a) * p.v * s0 + 0.5 * G * s0 * s0); g.lineTo(x + Math.cos(p.a) * p.v * s, y + Math.sin(p.a) * p.v * s + 0.5 * G * s * s); g.stroke(); }
    g.restore();
    for (const q of mo) { if (tt > q.life) continue; glow(g, x + q.dx, y - 8 + q.vy * s, q.r, '#8fcaff', (1 - tt / q.life) * 0.8); }
  } }); } });
}

// ── who is hit, and when the ticks land ──
const strikes = oni.strikes || [];
const N = strikes.length || cfg.ticks;
const outcomeOf = (t) => (strikes[0]?.outcomes || []).find((o) => o.tokenUuid === t.document?.uuid) || null;
const HITS = PARTY.filter((k, i) => { const o = outcomeOf(targets[i]); return !o || o.kind === 'hit'; });
// the gap shrinks 3:1 across the barrage so it accelerates, scaled to end on lastTick
const TICKS = (() => { const raw = []; let acc = 0; for (let i = 0; i < N; i++) { raw.push(acc); acc += lerp(3, 1, N > 1 ? i / (N - 1) : 0); } const end = raw[N - 1] || 1; return raw.map((v) => C.firstTick + (C.lastTick - C.firstTick) * v / end); })();
for (const at of TICKS) once(at, () => oni.hit({ numbersOnly: true }));

// ── geometry ──
const K = TOK.k, kf = feet(K), REAR = cfg.rearDeg * Math.PI / 180 * K.flip;
const squashK = (t) => t > 8600 ? 0 : E.ioQ(seg(t, 0, C.chargeEnd));
const rearK = (t) => t > 8600 ? 0 : E.ioQ(seg(t, C.rearFrom, C.rearTo));
const artPt = (u, v, t) => { const q = squashK(t); return { x: K.flip * (1 - 0.02 * q) * (u - 0.5) * K.w, y: (v - K.foot) * K.h * (1 + 0.05 * q) }; };
const rotPt = (p, th) => { const c = Math.cos(th), s = Math.sin(th); return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; };
// rotation about the feet point, moved so the hind feet stay planted
const rearOff = (t) => { const th = REAR * rearK(t), a = artPt(0.7, K.foot, t), r = rotPt(a, th); return { th, dx: a.x - r.x, dy: a.y - r.y }; };
const worldPt = (u, v, t) => { const o = rearOff(t), r = rotPt(artPt(u, v, t), o.th); return { x: kf.x + o.dx + r.x, y: kf.y + o.dy + r.y }; };
const tipAt = (t) => worldPt(0.02, 0.075, t);
const HORN = tipAt(C.chargeEnd), hornBase = worldPt(0.25, 0.2, C.chargeEnd);
// a rigid sprite can only rear so far before it looks like it is falling over, so the beam meets the horn partway
const LEAN = Math.atan2(HORN.x - hornBase.x, hornBase.y - HORN.y) * 0.75, leanTan = Math.tan(LEAN);
const PC = { x: PARTY.reduce((s, k) => s + TOK[k].x, 0) / PARTY.length, y: PARTY.reduce((s, k) => s + TOK[k].y, 0) / PARTY.length };
const panCurve = (t) => t < C.cutAt ? C.panDist * E.ioQ(seg(t, C.panUpFrom, C.panUpTo)) : 0;
const R = tl.rng(777);
const huge = { x: -6000, y: -6000, w: 20000, h: 20000 };

// ── master curves: everything the camera and curtains do, as functions of t ──
m.hold(0, C.total + 1, (t, S) => {
  S.panY = panCurve(t);
  const boardBlack = t < C.cutAt ? E.sine(seg(t, C.blackFrom, C.blackTo)) : 0;
  S.dim = t < C.flashAt ? 0.6 * E.sine(seg(t, 0, 800)) : t < C.clearFrom ? (t < C.cutAt ? 0.6 : 0.42) : 0.42 * (1 - E.sine(seg(t, C.clearFrom, C.clearTo)));
  const tip = tipAt(t), horn = { cx: tip.x - 40 + leanTan * S.panY * tl.STAGE.h / C.zoomHorn, cy: tip.y + 70, zoom: C.zoomHorn }, party = { cx: PC.x - 30, cy: PC.y - 30, zoom: C.zoomParty };
  if (t < 8600) { const k = E.sine(seg(t, 0, 1800)); S.cam = { cx: lerp(tl.REST.cx, horn.cx, k), cy: lerp(tl.REST.cy, horn.cy, k), zoom: lerp(1, horn.zoom, k) }; }
  else if (t < C.curtainTo + 200) S.cam = party;   // both cuts happen under full black / full white
  const q = squashK(t), o = rearOff(t), mk = S.tok.k;
  mk.sy = 1 + 0.05 * q; mk.sx = 1 - 0.02 * q; mk.rot = o.th; mk.dx = o.dx; mk.dy = o.dy;
  // the board fades under the effect layer, so the beam stays lit in the dark; the scene's top edge dissolves instead of showing a seam
  if (S.panY > 0.01) S.world.push({ z: 1, draw: (g) => { const a = seg(S.panY, 0, 0.35), top = tl.SCENE.y, gr = g.createLinearGradient(0, top, 0, top + 520); gr.addColorStop(0, 'rgba(0,0,0,' + a + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(huge.x, top, huge.w, 520); g.fillStyle = 'rgba(0,0,0,' + a + ')'; g.fillRect(huge.x, huge.y, huge.w, top - huge.y); } });
  if (boardBlack > 0) S.world.push({ z: 5, draw: (g) => { g.fillStyle = 'rgba(0,0,0,' + boardBlack + ')'; g.fillRect(huge.x, huge.y, huge.w, huge.h); } });
  // the white comes up over everything on the board, silhouettes above it, then light eats them
  const white = E.sine(seg(t, C.whiteFrom, C.whiteTo)) * (1 - E.sine(seg(t, C.clearFrom, C.clearTo)));
  if (white > 0) S.world.push({ z: 60, draw: (g) => { g.fillStyle = 'rgba(244,249,255,' + white + ')'; g.fillRect(huge.x, huge.y, huge.w, huge.h); } });
  // hurt loops, drawn from decoded frames so the silhouette matches the pose exactly
  const black = t < C.clearFrom ? E.sine(seg(t, C.silFrom, C.silTo)) : 0, eat = E.sine(seg(t, C.eatFrom, C.eatTo));
  for (const k of PARTY) {
    const tk = S.tok[k], Tk = TOK[k], f = feet(Tk), hurt = HITS.includes(k) && t >= C.firstTick && t < C.clearFrom;
    const HF = hurt && HURT[k] ? frameAt(HURT[k], t, true) : null;
    if (HF) tk.img = HF;
    if (black > 0) { const art = HF || tl.art(k); if (art) { const s = sizeOf(art), hh = Tk.h, hw = HF ? hh * s.w / s.h : Tk.w, dx = tk.dx, dy = tk.dy; S.world.push({ z: 61, draw: (g) => {
      g.save(); g.translate(Tk.x + dx, f.y + dy); g.scale(Tk.flip, 1); g.globalAlpha = black * (1 - eat); g.drawImage(silFrame(art), -hw / 2, -Tk.h * Tk.foot, hw, hh); g.restore();
      if (eat > 0) { const gr = g.createRadialGradient(Tk.x, Tk.y, 0, Tk.x, Tk.y, Tk.h * (0.25 + 1.1 * eat)); gr.addColorStop(0, 'rgba(244,249,255,' + eat + ')'); gr.addColorStop(1, 'rgba(244,249,255,0)'); g.fillStyle = gr; g.fillRect(Tk.x - Tk.h * 1.5, Tk.y - Tk.h * 1.5, Tk.h * 3, Tk.h * 3); }
    } }); } }
  }
});

// ── 1 · charge ──
m.beat(0, '1 charge at the horn');
for (const [at, w] of [[300, 300], [1200, 380], [2100, 470], [2850, 560]]) clip('chaincast', at, { x: 0, y: 0, w, z: 30, add: true, pivot: { x: 0.5, y: 0.5 }, live: (tt) => tipAt(at + tt) });
m.hold(300, C.chargeEnd + 400, (tt, S) => { const k = E.ioQ(seg(tt, 0, 2900)), fl = 1 + Math.sin(tt / 47) * 0.08, p = tipAt(300 + tt); S.world.push({ z: 31, draw: (g) => { glow(g, p.x, p.y, 190 * k * fl, '#4a9dff', 0.85); glow(g, p.x, p.y, 74 * k * fl, '#eaf6ff', 1); } }); S.shake = Math.max(S.shake, 4.5 * seg(tt, 1200, 2900)); });
const motes = [...Array(44)].map(() => ({ a: R() * 6.283, r: 150 + R() * 300, d: R() * 1900, s: 0.55 + R() * 0.7 }));
m.hold(200, C.chargeEnd, (tt, S) => { S.world.push({ z: 29, draw: (g) => { for (const q of motes) { const u = seg(tt, q.d, q.d + 900); if (u <= 0 || u >= 1) continue; const rr = q.r * (1 - E.ioQ(u)), p = tipAt(200 + tt); glow(g, p.x + Math.cos(q.a) * rr, p.y + Math.sin(q.a) * rr * 0.8, 11 * q.s, '#a8d8ff', Math.sin(u * 3.14)); } } }); });

// ── 2 · skyward: the clip is cropped above its burst and revealed upward, so it has a real leading edge ──
m.beat(C.chargeEnd, '2 beam skyward');
m.flash(C.chargeEnd, 60, 500, '#bfe2ff', 0.42); m.shake(C.chargeEnd, 1300, 13);
const beamTop = (tt) => HORN.y - 40 - E.outQ(seg(tt, 0, 700)) * 560 - E.ioQ(seg(tt, 500, 3400)) * 2100;
const beamAlpha = (u, tt) => tt < 80 ? tt / 80 : 1;
const thin = (tt) => 1 - 0.62 * E.ioQ(seg(tt + C.chargeEnd, 7200, C.flashAt));
const beam = { x: HORN.x, y: HORN.y, w: 700, sy: 4, rot: -0.049 + LEAN, softBase: true, z: 40, add: true, tint: BLUE, crop: [0, 0.6], pivot: { x: 0.457, y: 1 }, loop: true, hold: C.flashAt - C.chargeEnd, alpha: beamAlpha, topY: beamTop, live: (tt) => ({ sx: thin(tt) }) };
clip('laser', C.chargeEnd, beam);
clip('laser', C.chargeEnd, Object.assign({}, beam, { loopOffset: 430, tint: '#cfe9ff', w: 540, alpha: (u, tt) => 0.8 * beamAlpha(u, tt) }));
m.hold(C.chargeEnd, C.flashAt, (tt, S) => { const fl = 1 + Math.sin(tt / 31) * 0.1, fade = 1 - seg(tt, 2600, 3500); S.world.push({ z: 42, draw: (g) => { glow(g, HORN.x, HORN.y, 210 * fl * fade, '#6fb8ff', 0.8); glow(g, HORN.x, HORN.y, 84 * fl * fade, '#ffffff', 1); } }); });
// sparks fixed in the world along the beam: the camera moves past them, so they fall through frame and sell the climb
const beamSparks = [...Array(120)].map(() => { const up = R() * 1750; return { x: HORN.x + up * leanTan + (R() - 0.5) * 760, y: HORN.y - up, s: 0.5 + R() * 1.2, p: R() * 6.283 }; });
m.hold(C.chargeEnd + 300, C.flashAt, (tt, S) => { S.world.push({ z: 43, draw: (g) => { for (const q of beamSparks) glow(g, q.x, q.y, 7 * q.s, '#bfe2ff', 0.45 + 0.45 * Math.sin(tt / 70 + q.p)); } }); });
// speed lines only while the camera moves
const vel = (t) => { const d = 20; return Math.abs(panCurve(t + d) - panCurve(t - d)) / (2 * d); };
m.hold(C.panUpFrom, C.panUpTo, (tt, S) => { const a = Math.min(0.42, vel(tt + C.panUpFrom) * 560); S.screen.push({ draw: (g) => D.vlines(g, tt, a, '#6fb8ff') }); });

// ── 3 · the flash in the dark, then a beat of nothing ──
m.beat(C.flashAt, '3 the beam vanishes in a flash');
m.flash(C.flashAt, 40, 420, '#bcdcff', 0.2); m.shake(C.flashAt, 700, 12);
clip('flash', C.flashAt - 30, { screen: { x: C.vpX, y: C.vpY }, wh: 1.1, add: true, alpha: (u) => 1 - E.inQ(u) });
m.hold(C.flashAt, C.rainFrom + 200, (tt, S) => { const a = 1 - E.outQ(seg(tt, 0, 1250)); S.screen.push({ draw: (g) => { glow(g, g.W * C.vpX, g.H * C.vpY, g.H * (0.2 + 1.0 * E.outC(seg(tt, 0, 500))), '#6fb8ff', 0.85 * a); glow(g, g.W * C.vpX, g.H * C.vpY, g.H * 0.22, '#ffffff', a); } }); });

// ── 4 · streams at the lens: same build as Cruel Ultimatum Bolt's streak. The far end stays pinned at the point where the
// flash was, the near end races outward, and three jittered copies make one unbroken stream. Only at the end does the tail let go. ──
m.beat(C.rainFrom, '4 lightning falls from above');
const streamFrame = (tt, j) => { const L = LIB.thunder1; return taperFrame(tintedFrame(softEnd(L.frames[2 + (Math.floor((tt % L.dur) / L.dur * 5) + j) % 5]), BLUE)); };
const perspBolt = (at, a, ms, wk, b) => { if (!LIB.thunder1) return; T.push({ t0: at, t1: Math.min(at + ms, C.cutAt - 170), fn: (tt, S) => {
  const u = tt / ms, near = 0.22 * Math.pow(cfg.streamReach, u), far = 0.012 + near * 0.42 * Math.pow(seg(u, 0.62, 1), 2), wide = 0.12 * Math.pow(14, u) * wk, al = b * Math.min(1, u / 0.1) * (1 - seg(u, 0.92, 1)), jit = Math.sin(tt / 37) * 0.025;
  const copies = [[streamFrame(tt, 0), jit, 1], [streamFrame(tt, 2), 0.04 - jit, 0.55], [streamFrame(tt, 3), -0.04 + jit, 0.55]];
  S.screen.push({ draw: (g) => { const H = g.H, ww = wide * H; g.save(); g.translate(C.vpX * g.W, C.vpY * H); g.globalCompositeOperation = 'lighter'; for (const [F, off, ca] of copies) { g.save(); g.rotate(a - Math.PI / 2 + off); g.globalAlpha = al * ca; g.drawImage(F, -ww / 2, far * H, ww, (near - far) * H); g.restore(); } g.restore(); } });
} }); };
{ let at = C.rainFrom, i = 0; while (at < C.cutAt - 520) { const k = seg(at, C.rainFrom, C.cutAt), big = i % 4 === 2, ms = big ? cfg.streamMsBig : cfg.streamMs + R() * cfg.streamMsSpread; perspBolt(at, Math.PI / 2 + (R() - 0.5) * 4.4, ms, big ? 3.1 : 1.5 + R() * 0.9, big ? 1 : 0.85 + R() * 0.15); if (big) { m.flash(at + ms * 0.78, 30, 180, '#9fd0ff', 0.08); m.shake(at + ms * 0.78, 260, 7); } at += lerp(cfg.streamGap0, cfg.streamGap1, k) * (0.7 + R() * 0.6); i++; } }
m.hold(C.rainFrom - 150, C.cutAt - 170, (tt, S) => { const a = seg(tt, 0, 500); S.screen.push({ draw: (g) => { const fl = 1 + Math.sin(tt / 43) * 0.12; glow(g, C.vpX * g.W, C.vpY * g.H, g.H * 0.17 * fl, '#5aa8ff', 0.55 * a); glow(g, C.vpX * g.W, C.vpY * g.H, g.H * 0.05 * fl, '#ffffff', 0.9 * a); } }); });

// ── 5 · one bolt comes right up to the lens until it covers the whole view; the board snaps in behind it at cutAt ──
m.beat(C.cutAt - 430, '5 a bolt at the lens cuts to the battlefield');
if (LIB.thunder1) T.push({ t0: C.cutAt - 430, t1: C.cutAt + 200, fn: (tt, S) => {
  const k = E.inQ(seg(tt, 0, 430)), al = 1 - seg(tt, 430, 630), F = taperFrame(tintedFrame(softEnd(LIB.thunder1.frames[4 + Math.floor(tt / 70) % 2]), '#bfe2ff'));
  S.screen.push({ draw: (g) => { const H = g.H, ww = (1.5 + 40 * k) * H, near = (3 + 3 * k) * H; g.save(); g.translate(g.W * C.vpX, g.H * C.vpY); g.globalCompositeOperation = 'lighter'; g.globalAlpha = al; g.rotate(0.12); g.drawImage(F, -ww / 2, -0.45 * near, ww, near); g.drawImage(F, -ww / 2, -0.45 * near, ww, near); g.restore(); } });
} });
m.flash(C.cutAt - 150, 150, 420, '#e6f4ff', 1); m.shake(C.cutAt - 200, 650, 18);

// ── 6 · the barrage ──
m.beat(C.firstTick, '6 the barrage');
const topW = PC.y - 30 - tl.STAGE.h / 2 / C.zoomParty - 240;   // well above the frame, shake included, so no streak ever shows a top end
const flashTok = (at, ms, k) => { T.push({ t0: at, t1: at + ms, fn: (tt, S) => { const a = (1 - tt / ms) * 0.55, tk = S.tok[k], img = tk.img; if (!img) return; const Tk = TOK[k], f = feet(Tk), hw = Tk.h * img.width / img.height, dx = tk.dx, dy = tk.dy; S.world.push({ z: 33, draw: (g) => { g.save(); g.translate(Tk.x + dx, f.y + dy); g.scale(Tk.flip, 1); g.globalCompositeOperation = 'lighter'; g.globalAlpha = a; g.drawImage(solidFrame(img, '#cfeaff'), -hw / 2, -Tk.h * Tk.foot, hw, Tk.h); g.restore(); } }); } }); };
const strike = (at, k, big) => {
  const T0 = TOK[k], f = feet(T0), hit = HITS.includes(k), ox = hit ? (R() - 0.5) * 18 : (R() < 0.5 ? -1 : 1) * (75 + R() * 30), w = (big ? 490 : 440) + R() * 90;
  clip('thunder1', at, { x: f.x + ox, y: f.y, w, z: 34, tint: BLUE, add: true, range: [2, 6], hold: 640, toY: topW, alpha: (u) => (big ? 0.68 : 0.78) * (u > 0.7 ? (1 - u) / 0.3 : 1) });
  sparks(at, f.x + ox, f.y, big ? 26 : 14, R);
  if (hit) { clip('hit', at + 40, { x: T0.x + (R() - 0.5) * 24, y: T0.y + (R() - 0.5) * 30, w: 170 + R() * 70, z: 36, tint: BLUE, add: true, alpha: () => 0.75 }); m.shakeTok(at, k, big ? 460 : 320, big ? 14 : 9); if (HURT[k]) flashTok(at, big ? 300 : 220, k); else m.tint(at, big ? 300 : 220, k, '#cfeaff'); }
};
// every tick is a volley: all targets are struck on the frame the number lands; lighter single strikes fill the gaps
TICKS.forEach((at) => { PARTY.forEach((k) => strike(at, k, true)); m.flash(at, 30, 220, '#a9d6ff', 0.16); m.shake(at, 300, 9); });
{ let at = C.firstTick + 200, i = 0; while (at < C.lastTick - 120) { const k = seg(at, C.firstTick, C.lastTick); if (!TICKS.some((x) => Math.abs(x - at) < 110)) { strike(at, PARTY[i % PARTY.length], false); m.flash(at, 30, 150, '#a9d6ff', 0.06); } at += lerp(520, 270, k); i++; } }
PARTY.forEach((k, i) => { const f = feet(TOK[k]); for (let at = C.firstTick + i * 260; at < C.lastTick - 300; at += 1320) clip('storm', at, { x: f.x, y: f.y, w: 500, z: 4, add: true, alpha: () => 0.85 }); });
for (let at = C.firstTick + 500; at < C.lastTick; at += lerp(280, 150, seg(at, C.firstTick, C.lastTick))) { const x = PC.x + (R() - 0.5) * 1100, y = PC.y + 40 + R() * 210; clip('thunder1', at, { x, y, w: 400 + R() * 230, z: 3, tint: BLUE, add: true, range: [2, 6], hold: 560, toY: topW, alpha: (u) => 0.72 * (u > 0.7 ? (1 - u) / 0.3 : 1) }); sparks(at, x, y, 8, R); }
for (const [at, dx] of C.pillars) clip('pillar', at, { x: PC.x + dx, y: PC.y + 50, w: 1050, z: 12, tint: BLUE, add: true, alpha: () => 0.5 });
m.hold(C.firstTick, C.lastTick + 600, (tt, S) => { S.shake = Math.max(S.shake, lerp(5, 13, seg(tt, 0, C.lastTick - C.firstTick))); });

// ── 7 · the top curtain takes the numbers and UI too, then clears onto the normal board ──
m.beat(C.silFrom, '7 silhouettes as the white rises');
m.beat(C.lastTick, '7 last tick · damage gate');
m.beat(C.eatFrom, '7 consumed by the white');
once(C.curtainFrom, () => { oni.domFlash({ color: '#ffffff', alpha: 1, fadeIn: C.curtainTo - C.curtainFrom, hold: C.clearFrom - C.curtainTo, fadeOut: C.clearTo - C.clearFrom, zIndex: 100000 }); });
m.beat(C.clearFrom, '8 back to battle');

// periodic impact sound: a hit on every tick, a softer one halfway to the next
const sfx = (cfg.sfx || []).slice();
TICKS.forEach((at, i) => { sfx.push({ at, url: cfg.impacts[i % cfg.impacts.length], v: 0.62 * cfg.volume }); if (TICKS[i + 1]) sfx.push({ at: (at + TICKS[i + 1]) / 2, url: cfg.impacts[(i + 1) % cfg.impacts.length], v: 0.36 * cfg.volume }); });

await tl.run(T, { total: C.total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
