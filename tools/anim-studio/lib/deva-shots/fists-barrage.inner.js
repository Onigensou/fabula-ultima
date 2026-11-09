// Deva · Fists of Fury / Fists of Focus (inner script, every client).
// Port of the approved mockup ("Deva action animations" artifact, v16, wide cone, full screen).
// She blinks out (fade + squeeze into a thin vertical line, Stare sfx) and reappears in front of the
// party; the camera pushes in on the midpoint; a wind-up; then a wide cone of energy fists bursts from
// her, each accelerating and swelling until it leaves the frame; a share is aimed at the party and lands
// with Guilty Gear Strive hit sparks; every struck enemy holds its hurt loop; Chain strikes reveal on
// their cue; a hard closing impact; the camera eases back and she blinks home.
// Perf: fists and sparks are canvas drawImage of textures baked ONCE (glow included), never live filters.
// Every number lives in cfg (mockup px, scaled by stage width / 1682). No backticks in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }
const BLUE = cfg.form === 'focus';

const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const PARTY = [];
targets.forEach((t, i) => { const k = 't' + i; PARTY.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
const tl = oni.timeline({ tokens, clips: { powerup: A.powerup } });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK, feet = tl.feet, glow = tl.draw.glowCircle;
const KP = (tl.STAGE.w || 1682) / 1682;          // mockup px -> scene px
const R = tl.rng(cfg.seed || 4242);
const rnd = (a, b) => a + (b - a) * R();
const pick = (arr) => arr[Math.floor(R() * arr.length)];

// ── baked textures ──
const imgOf = (src) => new Promise((ok) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h)); return c; };
// the fist, scaled up once, with the mockup's CSS filter chain baked in (main copy carries the extra white glow)
async function bakeFist(src, rgb, bright) {
  const im = await imgOf(src); if (!im) return null;
  const S = cfg.fistBake, pad = 14 * S, w = im.width * S + pad * 2, h = im.height * S + pad * 2;
  const make = (white) => { const c = canvasOf(w, h), x = c.getContext('2d');
    x.filter = 'saturate(1.4) brightness(' + bright + ') drop-shadow(0 0 ' + (4 * S) + 'px rgba(' + rgb + ',1)) drop-shadow(0 0 ' + S + 'px #fff)' + (white ? ' drop-shadow(0 0 ' + (4 * S) + 'px #fff)' : '');
    x.drawImage(im, pad, pad, im.width * S, im.height * S); return c; };
  return { main: make(true), trail: make(false), padK: pad / (im.height * S), ar: im.width / im.height };
}
// a GG mask sheet, downscaled once to ~frameW per frame, tinted (multiply over its own alpha) per colour
async function bakeSheet(def, colors) {
  const im = await imgOf(def.url); if (!im) return null;
  const k = Math.min(1, def.frameW / (im.width / def.cols)), W0 = im.width * k, H0 = im.height * k;
  const base = canvasOf(W0, H0); base.getContext('2d').drawImage(im, 0, 0, W0, H0);
  const out = { cols: def.cols, rows: def.rows, frames: def.frames, fw: base.width / def.cols, fh: base.height / def.rows, tint: { '#fff': base } };
  for (const col of colors) { const c = canvasOf(base.width, base.height), x = c.getContext('2d'); x.drawImage(base, 0, 0); x.globalCompositeOperation = 'multiply'; x.fillStyle = col; x.fillRect(0, 0, c.width, c.height); x.globalCompositeOperation = 'destination-in'; x.drawImage(base, 0, 0); out.tint[col] = c; }
  return out;
}
const COL = BLUE ? cfg.blue : cfg.red;
const [FIST, ...SHEETS] = await Promise.all([
  bakeFist(BLUE ? A.fistBlue : A.fistRed, COL.rgb, COL.bright),
  ...['burst01', 'burst07', 'burst05', 'spark01'].map((k) => bakeSheet(A.sheets[k], [COL.spark])),
]);
const GG = { burst01: SHEETS[0], burst07: SHEETS[1], burst05: SHEETS[2], spark01: SHEETS[3] };

// ── tracks ──
const T = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (!did) { did = true; fn(); } } }); };
const C = cfg.t;

// geometry
const K = TOK.k, kf = feet(K);
const PC = { x: PARTY.reduce((s, k) => s + TOK[k].x, 0) / PARTY.length, y: PARTY.reduce((s, k) => s + TOK[k].y, 0) / PARTY.length };
const DIR = PC.x >= K.x ? 1 : -1;                                   // toward the party
const DEST = { x: kf.x + DIR * cfg.step * KP, y: kf.y + 8 * KP };   // her feet after the blink
const DS = tl.depthRatio(kf, DEST);                                 // her size there
const center = (k) => { const Tk = TOK[k], f = feet(Tk); return { x: f.x, y: f.y - Tk.h * 0.5 }; };
const hgt = (k) => TOK[k].h;
const devaAt = (t) => t >= C.tpShow && t < C.homeShow ? { x: DEST.x, y: DEST.y, s: DS } : { x: kf.x, y: kf.y, s: 1 };
const devaSrc = (t) => { const p = devaAt(t); return { x: p.x + DIR * K.w * p.s * rnd(0.25, 0.6) * 0.5, y: p.y - K.h * p.s * rnd(0.4, 0.75) }; };

// who is hit, and when the Chain strikes land
const strikes = oni.strikes || [];
const outcomeOf = (t) => (strikes[0] && strikes[0].outcomes || []).find((o) => o.tokenUuid === (t.document && t.document.uuid)) || null;
const HITS = PARTY.filter((k, i) => { const o = outcomeOf(targets[i]); return !o || o.kind === 'hit'; });
const B0 = C.barrage, DUR = cfg.dur, CLOSE = B0 + DUR + C.closeAfter;
const N = strikes.length;
const STRIKE_AT = Array.from({ length: N }, (_, i) => B0 + DUR * 0.06 + DUR * 0.88 * (i + 0.5) / Math.max(1, N));
const dirTo = (k, from) => { const c = center(k), a = from || devaSrc(B0); return Math.atan2(c.y - a.y, c.x - a.x); };

// ── master curve: camera, her body (blink + lean), hurt hold, rumble ──
const MID = { x: (DEST.x + PC.x) / 2, y: ((DEST.y - K.h * DS * 0.5) + (PC.y - 60 * KP)) / 2 };
const sq = (u) => ({ sx: lerp(1, 0.04, u), sy: lerp(1, 1.45, u), a: 1 - u });
m.hold(0, C.total + 1, (t, S) => {
  // camera
  const zin = E.outC(seg(t, C.zoomFrom, C.zoomFrom + cfg.zoomMs)), zout = E.outC(seg(t, C.zoomOutFrom, C.zoomOutFrom + 600)), z = zin * (1 - zout);
  S.cam = { cx: lerp(tl.REST.cx, MID.x, z), cy: lerp(tl.REST.cy, MID.y, z), zoom: lerp(1, cfg.zoom, z) };
  // her body
  const d = S.tok.k; const p = devaAt(t);
  d.dx = p.x - kf.x; d.dy = p.y - kf.y;
  let q = null;
  if (t < C.tpOut) q = sq(E.inQ(seg(t, 0, cfg.tp)));
  else if (t < C.tpShow) q = sq(1);
  else if (t < C.tpShow + cfg.tp * 1.1) q = sq(1 - E.outC(seg(t, C.tpShow, C.tpShow + cfg.tp * 1.1)));
  else if (t >= C.homeFrom && t < C.homeOut) q = sq(E.inQ(seg(t, C.homeFrom, C.homeOut)));
  else if (t >= C.homeOut && t < C.homeShow) q = sq(1);
  else if (t >= C.homeShow) q = sq(1 - E.outC(seg(t, C.homeShow, C.homeShow + cfg.tp * 1.1)));
  d.sx = (q ? q.sx : 1) * p.s; d.sy = (q ? q.sy : 1) * p.s; d.alpha = q ? q.a : 1;
  // lean: back on the wind-up, forward through the barrage, upright before the blink home
  const back = -10 * E.outQ(seg(t, C.windup, C.windup + 420)), fwd = 19 * E.outQ(seg(t, B0, B0 + 120)), up = -9 * E.sine(seg(t, C.homeFrom - 260, C.homeFrom - 60));
  d.rot = (back + fwd + up) * Math.PI / 180 * DIR;
  // every enemy the barrage connects with holds its hurt loop until the closing impact settles
  if (t >= STRIKE_AT0() && t < CLOSE + 450) for (const k of HITS) S.tok[k].hurt = true;
  // knockback on the closing impact
  if (t >= CLOSE && t < CLOSE + 540) { const kb = t < CLOSE + 160 ? E.outQ(seg(t, CLOSE, CLOSE + 160)) : 1 - E.ioQ(seg(t, CLOSE + 160, CLOSE + 540)); for (const k of HITS) S.tok[k].dx += DIR * 30 * KP * kb; }
  // rumble through the barrage
  if (t >= B0 && t < B0 + DUR + 500) S.shake = Math.max(S.shake, 3);
});
function STRIKE_AT0() { return B0 + DUR * 0.06 * 0.5; }

// teleport sparkle at both ends of each blink
const sparkle = (at, ptFn) => { const ps = [...Array(10)].map(() => ({ a: R() * 6.283, v: 60 + R() * 180, s: 5 + R() * 6, life: 600 + R() * 400 }));
  T.push({ t0: at, t1: at + 1000, fn: (tt, S) => { const p = ptFn(); S.world.push({ z: 26, draw: (g) => { const s = tt / 1000; g.save(); g.globalCompositeOperation = 'lighter'; for (const q of ps) { if (tt > q.life) continue; g.globalAlpha = 1 - tt / q.life; g.fillStyle = 'rgb(' + COL.mote + ')'; const x = p.x + Math.cos(q.a) * q.v * s * KP, y = p.y + Math.sin(q.a) * q.v * s * KP - 0.2 * tt * KP * 0.1; g.save(); g.translate(x, y); g.rotate(q.a + tt / 200); g.beginPath(); g.moveTo(0, -q.s); g.lineTo(q.s * 0.6, 0); g.lineTo(0, q.s * 0.9); g.lineTo(-q.s * 0.5, 0); g.fill(); g.restore(); } g.restore(); } }); } }); };
const bodyMid = (x, y, s) => ({ x, y: y - K.h * s * 0.5 });
sparkle(0, () => bodyMid(kf.x, kf.y, 1)); sparkle(C.tpShow, () => bodyMid(DEST.x, DEST.y, DS));
sparkle(C.homeFrom, () => bodyMid(DEST.x, DEST.y, DS)); sparkle(C.homeShow, () => bodyMid(kf.x, kf.y, 1));

// wind-up aura (MV Powerup 1, tinted to her form)
m.clip('powerup', C.windup, { x: DEST.x, y: DEST.y, w: 335 * KP * DS * (A.powerup.w / 508), z: 6, filter: COL.aura });

// ── the fists ──
// a fist flies from 'from' to 'to'; anchor = its knuckles (the image bottom), so the body trails behind
function fist(at, from, to, o) {
  if (!FIST) return;
  const ms = o.ms, dir = Math.atan2(to.y - from.y, to.x - from.x) - Math.PI / 2, h0 = o.h * KP;
  T.push({ t0: at, t1: at + ms + (o.linger || 0), fn: (tt, S) => {
    const lin = o.linger && tt >= ms ? seg(tt, ms, ms + o.linger) : 0, u = Math.min(1, tt / ms), e = o.ease(u);
    const x = lerp(from.x, to.x, e), y = lerp(from.y, to.y, e), sc = lerp(1, o.grow, e) * (1 + 0.12 * lin);
    const a = o.peak * (lin ? 1 - lin : Math.min(1, u / 0.12, o.hold ? 1 : (1 - u) / 0.3)); if (a <= 0) return;
    S.world.push({ z: o.z, draw: (g) => {
      const h = h0 * sc, w = h * FIST.ar, padH = h * FIST.padK, fullH = h + padH * 2, fullW = w + padH * 2;
      g.save(); g.translate(x, y); g.rotate(dir);
      for (let k = o.trail; k >= 1; k--) { g.globalAlpha = a * 0.45 / k; g.drawImage(FIST.trail, -fullW / 2, -h - padH - k * 0.38 * h, fullW, fullH); }
      g.globalAlpha = a; g.drawImage(FIST.main, -fullW / 2, -h - padH, fullW, fullH);
      g.restore();
    } });
  } });
}

// one fist landing on a target: tinted spike splash with a white core along the hit direction, a directional
// puff, the odd crackle, hot streak sparks flying on through (all baked sheets; drawn above the bodies)
function sheetFx(at, key, pt, o) {
  const d = GG[key]; if (!d) return; const cv = d.tint[o.color || '#fff'];
  T.push({ t0: at, t1: at + o.ms, fn: (tt, S) => { const u = tt / o.ms, f = Math.min(d.frames - 1, Math.floor(u * d.frames)), al = (o.alpha || 1) * (u > 0.75 ? (1 - u) / 0.25 : 1);
    S.world.push({ z: 32, draw: (g) => { g.save(); g.translate(pt.x, pt.y); g.rotate(o.rot || 0); g.globalAlpha = al; if (o.add) g.globalCompositeOperation = 'lighter'; const w = o.size, h = o.size * d.fh / d.fw; g.drawImage(cv, (f % d.cols) * d.fw, Math.floor(f / d.cols) * d.fh, d.fw, d.fh, -w / 2, -h / 2, w, h); g.restore(); } }); } });
}
function impact(at, k, dir, big) {
  const H0 = hgt(k) * big, c = center(k), p = { x: c.x + rnd(-0.18, 0.12) * hgt(k), y: c.y + rnd(-0.3, 0.25) * hgt(k) }, spike = () => (R() < 0.5 ? 'burst01' : 'burst07');
  sheetFx(at, spike(), p, { color: COL.spark, size: H0 * rnd(0.75, 1.05), rot: dir + Math.PI / 2 + rnd(-0.5, 0.5), ms: 210, alpha: 0.95 });
  sheetFx(at, spike(), p, { size: H0 * rnd(0.4, 0.55), rot: dir + Math.PI / 2 + rnd(-0.4, 0.4), ms: 170, add: true });
  if (R() < 0.5) sheetFx(at, 'burst05', { x: p.x + Math.cos(dir) * H0 * 0.25, y: p.y + Math.sin(dir) * H0 * 0.25 }, { color: COL.spark, size: H0 * 1.15, rot: dir, ms: 300, alpha: 0.75, add: true });
  if (R() < 0.18) sheetFx(at, 'spark01', p, { size: H0 * 0.9, rot: R() * 6.283, ms: 260, add: true });
  const st = [...Array(5)].map(() => { const an = dir + rnd(-0.9, 0.9); return { c: Math.cos(an), s: Math.sin(an), v: rnd(0.7, 1.5), life: rnd(160, 280), len: rnd(14, 34) * big }; });
  T.push({ t0: at, t1: at + 290, fn: (tt, S) => { S.world.push({ z: 33, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
    for (const q of st) { if (tt > q.life) continue; const u = tt / q.life, dist = q.v * 16 * (1 - Math.pow(0.9, tt / 16)) / 0.1 * KP, x = p.x + q.c * dist, y = p.y + q.s * dist; g.strokeStyle = 'rgba(' + COL.streak + ',' + (1 - u) + ')'; g.lineWidth = (2.6 * (1 - u) + 0.6) * KP; g.beginPath(); g.moveTo(x, y); g.lineTo(x - q.c * q.len * KP, y - q.s * q.len * KP); g.stroke(); }
    g.restore(); } }); } });
}
// flinch = a shake on the held hurt loop (a tint here would paint the idle art over the hurt pose)
const react = (at, k, strong) => { m.shakeTok(at, k, strong ? 420 : 260, (strong ? 12 : 6) * KP); };

// the barrage: spawn schedule fixed up front (deterministic on every client)
const REACH = Math.hypot(tl.STAGE.w, tl.STAGE.h) * 1.1, HALF = cfg.cone * Math.PI / 180;
const sfx = [];
{ let i = 0;
  for (let at = B0; at < B0 + DUR; at += cfg.rate) {
    i++; const o = devaSrc(at);
    if (HITS.length && R() * 100 < cfg.aim) {
      const k = pick(HITS), c = center(k), to = { x: c.x + rnd(-0.2, 0.15) * hgt(k), y: c.y + rnd(-0.3, 0.3) * hgt(k) };
      const dist = Math.hypot(to.x - o.x, to.y - o.y), ms = Math.max(90, cfg.flight * dist / REACH * rnd(0.85, 1.15));
      fist(at, o, to, { h: cfg.size * rnd(0.7, 1.15), grow: 1 + (cfg.grow - 1) * dist / REACH, ms, ease: E.inC, z: 20, peak: 1, trail: cfg.trail, hold: true, linger: 50 });
      impact(at + ms, k, Math.atan2(to.y - o.y, to.x - o.x), 0.7 * cfg.spark);
    } else {
      const a = (DIR > 0 ? 0 : Math.PI) + rnd(-HALF, HALF), d = REACH * rnd(0.85, 1.1), behind = R() < 0.2;
      fist(at, o, { x: o.x + Math.cos(a) * d, y: o.y + Math.sin(a) * d }, { h: cfg.size * rnd(0.65, 1.2), grow: cfg.grow * rnd(0.85, 1.15), ms: cfg.flight * rnd(0.75, 1.25), ease: E.inC, z: behind ? 3 : 20, peak: behind ? 0.6 : rnd(0.8, 1), trail: cfg.trail });
    }
    if (i % 4 === 0) sfx.push({ at, url: i % 8 ? A.sfx.blowA : A.sfx.blowB, v: 0.28 * cfg.volume });
  }
}
// camera jolts every 140 ms through the barrage
for (let at = B0; at < B0 + DUR; at += 140) m.shake(at, 110, cfg.jolt * KP);
// per-target hit clocks: each struck enemy takes cfg.ticks visual impacts spread over the barrage
for (const k of HITS) for (let i = 0; i < cfg.ticks; i++) {
  const at = B0 + DUR * 0.06 + DUR * 0.88 * (i + rnd(0.1, 0.9)) / cfg.ticks;
  impact(at, k, dirTo(k) + rnd(-0.25, 0.25), cfg.spark);
  if (i % 3 === 0) react(at, k, false);
  if (i % 2) sfx.push({ at, url: i % 4 === 1 ? A.sfx.blowA : A.sfx.blowB, v: 0.4 * cfg.volume });
}
// Chain strikes reveal on their cue (numbers, flinch and HP bar come from the resolve side)
STRIKE_AT.forEach((at) => once(at, () => oni.hit({ numbersOnly: true })));

// radial speed lines from her front, in screen space
const LINES = [...Array(cfg.lines)].map(() => ({ u: R(), off: R() * 2 - 1, len: 0.15 + R() * 0.3, sp: 0.0015 + R() * 0.0015, w: 1 + R() * 2.2 }));
const LSRC = { x: DEST.x + DIR * K.w * DS * 0.21, y: DEST.y - K.h * DS * 0.58 };
m.hold(B0, B0 + DUR + 200, (tt, S) => { const a = 0.55 * (1 - seg(tt, DUR, DUR + 200)); const src = LSRC; S.screen.push({ draw: (g) => {
  const vp = tl.toScreen(src.x, src.y), Hs = g.H / 788; g.save(); g.lineCap = 'round';
  for (const l of LINES) { const u = ((l.u + l.sp * tt) % 1.6) - 0.3, an = (DIR > 0 ? 0 : Math.PI) + l.off * Math.PI, r0 = u * 1100 * Hs, r1 = r0 + l.len * 700 * Hs; g.strokeStyle = 'rgba(' + COL.lines + ',' + (a * (0.4 + l.w / 4)) + ')'; g.lineWidth = l.w * Hs; g.beginPath(); g.moveTo(vp.x + Math.cos(an) * r0, vp.y + Math.sin(an) * r0); g.lineTo(vp.x + Math.cos(an) * r1, vp.y + Math.sin(an) * r1); g.stroke(); }
  g.restore(); } }); });

// ── the closing impact: no giant fist, the blow lands hard on everyone the barrage connected with ──
m.flash(CLOSE, 25, 220, '#ffffff', 0.28); m.shake(CLOSE, 380, 12 * KP);
for (const k of HITS) { impact(CLOSE, k, dirTo(k), 1.8 * cfg.spark); react(CLOSE, k, true); }
sfx.push({ at: CLOSE, url: A.sfx.blowL, v: 0.9 * cfg.volume });

// Focus: the torn-out MP streams back to her
if (BLUE) {
  const motes = [];
  for (const k of HITS) for (let i = 0; i < 8; i++) motes.push({ k, d: R() * 200, ox: rnd(-14, 14), oy: rnd(-14, 14), arc: rnd(-70, 70) });
  m.hold(CLOSE + 450, CLOSE + 1250, (tt, S) => { S.world.push({ z: 34, draw: (g) => { const to = bodyMid(DEST.x, DEST.y, DS); for (const q of motes) { const u = clamp01((tt - q.d) / 800); if (u <= 0 || u >= 1) continue; const c = center(q.k), e = E.inQ(u), cx = (c.x + to.x) / 2 + q.arc * KP, cy = Math.min(c.y, to.y) - 60 * KP; const x = (1 - e) * (1 - e) * (c.x + q.ox) + 2 * (1 - e) * e * cx + e * e * to.x, y = (1 - e) * (1 - e) * (c.y + q.oy) + 2 * (1 - e) * e * cy + e * e * to.y; glow(g, x, y, 10 * KP, 'rgba(' + COL.mote + ',1)', 0.9); } } }); });
  sfx.push({ at: CLOSE + 450, url: A.sfx.absorb, v: 0.6 * cfg.volume });
}

// sounds of the blinks and the wind-up
sfx.push({ at: 0, url: A.sfx.teleport, v: 0.6 * cfg.volume }, { at: C.homeFrom, url: A.sfx.teleport, v: 0.6 * cfg.volume });
sfx.push({ at: C.windup, url: BLUE ? A.sfx.magic : A.sfx.powerup, v: 0.5 * cfg.volume });

once(CLOSE, () => oni.fireDone());
await tl.run(T, { total: C.total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
