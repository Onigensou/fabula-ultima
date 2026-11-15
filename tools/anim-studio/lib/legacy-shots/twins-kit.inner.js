// ── Legacy twins kit (Jack + Jill, + the shared Mug / Cleaving Strike Rauben also uses) ──────────────
// Prepended (after the Zero Power kit) by legacy-twins-signatures.js. A canvas-2D port of the mockup's
// shared kit ("Legacy boss animations" mockup, part-common.js + the round-3 afterimage / comic puff):
// a keyframed body for the caster, afterimage ghosts, a stepped particle field (ground / field / hit
// layers), projectiles with glow trails, rings, cracks, dust, twinkles, wisps, coins, the impact frame,
// radial speed lines and the pixel-crisp Zero Power cut-in.
// LIVE board: the camera is never touched; only bodies a beat moves are painted. Every mockup number is
// in mockup px on a 1682 px stage and is scaled by KP (stage width / 1682) and the depth ratio.
// Mirroring: the mockup's enemy faces right; every x offset and rotation is multiplied by DIR.
// No backticks and no dollar-brace anywhere in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
if (!caster) { oni.fireDone(); return; }
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
const CL = A.clips || {};
// cfg.live false = FULL TAKEOVER (the shot owns the board and drives S.cam: Apex Arrow's push-in); else LIVE board
const LIVE = cfg.live !== false;
const tl = oni.timeline(LIVE ? { tokens, clips: CL, images: A.images || {}, live: true, depthRef: 'k' } : { tokens, clips: CL, images: A.images || {} });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet;
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 2525);
const rnd = (a, b) => a + (b - a) * R();
const T = [], sfx = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (!did) { did = true; try { fn(); } catch (e) { console.warn('[ONI][twins] cue threw', e); } } } }); };
const S_ = (at, url, v) => { if (url) sfx.push({ at: Math.round(at), url, v: v * (cfg.volume == null ? 0.75 : cfg.volume) }); };
const SX = (at, key, v) => S_(at, (A.sfx || {})[key], v);
const DEG = Math.PI / 180;
const K = TOK.k, KF = feet(K);
// facing: toward the first target; with none (a self-cast) the way the caster's art faces
const DIR = FOES.length ? (TOK[FOES[0]].x >= K.x ? 1 : -1) : (K.dir || 1);
const DR = (pt) => tl.depthRatio(KF, pt);                               // size at pt vs the caster's spot
const HB = (k) => TOK[k].h * TOK[k].foot;                               // body height above the feet
const tFeet = (k) => feet(TOK[k]);
const tCenter = (k) => { const f = feet(TOK[k]); return { x: f.x, y: f.y - HB(k) * 0.5 }; };
// a spot in front of a target, on the caster's side (the mockup's front(t, gap))
const front = (k, gap) => { const f = tFeet(k); return { x: f.x - DIR * gap * KP * DR(f), y: f.y }; };
// EASE names as the mockup has them
const EZ = { lin: E.lin, quad: E.ioQ, out: E.outQ, in: E.inQ, outCubic: E.outC, sine: E.sine };
const EOUTBACK = (u) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };

// ── the caster's body: keyframed channels ─────────────────────────────────────────────────
// dx / dy (scene px), lift (scene px), rot (deg, the mockup's enemy sign), sx / sy, hop (an arc on top
// of the lift), pivot (0 = feet, 1 = the mockup's 50% 55% spin pivot).
const chan = (v0) => ({ v0, segs: [] });
const valAt = (c, t) => { let v = c.v0; for (const s of c.segs) { if (t < s.t0) break; const u = s.t1 > s.t0 ? Math.min(1, (t - s.t0) / (s.t1 - s.t0)) : 1; v = s.fn ? (t >= s.t1 ? s.fn(1) : s.fn(u)) : (t >= s.t1 ? s.to : lerp(s.from, s.to, s.ease(u))); } return v; };
const key = (c, at, ms, to, ease) => { const from = valAt(c, at); c.segs.push({ t0: at, t1: at + Math.max(0, ms), from, to, ease: ease || E.lin }); c.segs.sort((a, b) => a.t0 - b.t0); };
const keyFn = (c, at, ms, fn) => { c.segs.push({ t0: at, t1: at + Math.max(1, ms), fn }); c.segs.sort((a, b) => a.t0 - b.t0); };
const BODY = { dx: chan(0), dy: chan(0), lift: chan(0), hop: chan(0), rot: chan(0), sx: chan(1), sy: chan(1), pivot: chan(0) };
let BODY_END = 0;
// pose at t: what the engine draws, plus the un-pivoted lift (anchor points use that, as the mockup does)
function pose(t) {
  const dx = valAt(BODY.dx, t), dy = valAt(BODY.dy, t), lift = valAt(BODY.lift, t) + valAt(BODY.hop, t);
  const rot = valAt(BODY.rot, t) * DIR * DEG, sx = valAt(BODY.sx, t), sy = valAt(BODY.sy, t);
  let air = lift, ddx = dx;
  if (valAt(BODY.pivot, t) >= 0.5 && rot) { const r = (dx || dy) ? tl.depthRatio(KF, { x: KF.x + dx, y: KF.y + dy }) : 1; const ph = K.h * (K.foot - 0.55) * r * sy; ddx -= ph * Math.sin(rot); air += ph * (1 - Math.cos(rot)); }
  return { dx: ddx, dy, air, rot, sx, sy, lift, bx: dx };
}
// moves (mockup: moveActor / goHome / lean / squash / liftTo / spin)
const moveTo = (at, ms, pt, ease, o) => { o = o || {}; key(BODY.dx, at, ms, pt.x - KF.x, ease || EZ.sine); key(BODY.dy, at, ms, pt.y - KF.y, ease || EZ.sine); if (o.hop) { const h = o.hop * KP; keyFn(BODY.hop, at, ms, (u) => Math.sin(u * Math.PI) * h); } if (o.trail) for (const f of [0.31, 0.62, 0.93]) ghostAt(at + ms * f, o.ghost || {}); return at + ms; };
const goHome = (at, ms, o) => moveTo(at, ms, KF, EZ.quad, o);
const lean = (at, ms, deg, ease) => { key(BODY.rot, at, ms, deg, ease || EZ.out); return at + ms; };
const squash = (at, ms, sx, sy, ease) => { key(BODY.sx, at, ms, sx, ease || EZ.out); key(BODY.sy, at, ms, sy, ease || EZ.out); return at + ms; };
const liftTo = (at, ms, h, ease) => { key(BODY.lift, at, ms, h * KP, ease || EZ.outCubic); return at + ms; };
const pivot = (at, mid) => key(BODY.pivot, at, 0, mid ? 1 : 0);
// anchor points on the caster (mockup hand(a) / bodyAt(a) / feet(a)), at time t
const casterPt = (t, u, v) => { const p = pose(t), r = (p.bx || p.dy) ? tl.depthRatio(KF, { x: KF.x + p.bx, y: KF.y + p.dy }) : 1; return { x: KF.x + p.bx + DIR * K.w * u * r, y: KF.y + p.dy - p.lift - HB('k') * v * r }; };
const hand = (t) => casterPt(t, 0.3, 0.62);
const bodyAt = (t) => casterPt(t, 0, 0.5);
const cFeet = (t) => casterPt(t, 0, 0);
const headAt = (t) => casterPt(t, 0, 0.95);

// ── art copies: afterimage ghosts, scaling copies, a glow ring behind the body ──────────────
const ART = tl.art('k');
const bake = (filter, pad) => { if (!ART) return null; const w = ART.naturalWidth || ART.videoWidth || ART.width, h = ART.naturalHeight || ART.videoHeight || ART.height; if (!w || !h) return null; pad = pad || 0;
  const c = document.createElement('canvas'); c.width = w + pad * 2; c.height = h + pad * 2; const x = c.getContext('2d'); try { x.filter = filter || 'none'; x.drawImage(ART, pad, pad, w, h); } catch (e) { return null; } return { cv: c, pad, w, h }; };
const GHOST = {};
const ghostImg = (o) => { const f = o.filter || (o.hue == null ? 'brightness(1.6) saturate(.4)' : 'sepia(1) saturate(5) hue-rotate(' + (o.hue - 38) + 'deg) brightness(1.35)'); if (!(f in GHOST)) GHOST[f] = bake(f, 0); return GHOST[f]; };
// draw a copy of the caster's art at pose p (es = extra scale about the feet)
function drawCopy(g, B, p, alpha, es) {
  if (!B || alpha <= 0) return; es = es || 1;
  const r = (p.dx || p.dy) ? tl.depthRatio(KF, { x: KF.x + p.dx, y: KF.y + p.dy }) : 1;
  const padW = B.pad * K.w / B.w, padH = B.pad * K.h / B.h;
  g.save(); g.translate(K.x + p.dx, KF.y + p.dy - p.air); if (p.rot) g.rotate(p.rot); g.scale(K.flip * p.sx * r * es, p.sy * r * es); g.globalAlpha = alpha;
  g.drawImage(B.cv, -K.w / 2 - padW, -K.h * K.foot - padH, K.w + padW * 2, K.h + padH * 2); g.restore();
}
// one ghost spawned at 'at' showing the pose of that moment, fading over o.ms (mockup afterimage)
const GHOSTS = [];
function ghostAt(at, o) { o = o || {}; GHOSTS.push({ at, ms: o.ms || 380, op: o.opacity == null ? 0.5 : o.opacity, img: ghostImg(o) }); }
// ghosts every 'every' ms from 'from' to 'to' (mockup trailWhile)
function trail(from, to, every, o) { for (let t = from; t < to; t += every) ghostAt(t, o); }
m.hold(0, 1e9, (t, S) => { if (!GHOSTS.length) return; S.world.push({ z: 4, draw: (g) => { for (const q of GHOSTS) { const age = t - q.at; if (age < 0 || age > q.ms) continue; drawCopy(g, q.img, pose(q.at), q.op * (1 - age / q.ms)); } } }); });

// ── the stepped particle field (mockup addP / frame): positions scene px, velocities mockup px/ms ──
// layers: ground (under the battlers), field (over them), hit (over everything on the board)
const PL = { ground: [], field: [], hit: [] };
const LZ = { ground: 2, field: 24, hit: 46 };
const addP = (layer, p) => { PL[layer].push(Object.assign({ t: 0, life: 1000, vx: 0, vy: 0, g: 0, drag: 1 }, p)); };
const spawn = (at, fn) => once(at, fn);
let lastT = null;
m.hold(0, 1e9, (t, S) => {
  const dt = lastT == null ? 0 : Math.max(0, Math.min(50, t - lastT)); lastT = t;
  for (const L in PL) { const arr = PL[L]; for (let i = arr.length - 1; i >= 0; i--) { const p = arr[i]; p.t += dt;
    if (p.t >= p.life || p.dead) { arr.splice(i, 1); continue; }
    if (p.update) p.update(p, dt); else { p.vy += p.g * dt; const f = Math.pow(p.drag, dt / 16); p.vx *= f; p.vy *= f; p.x += p.vx * dt * KP; p.y += p.vy * dt * KP; } }
    if (arr.length) S.world.push({ z: LZ[L], draw: (g) => { for (const p of arr) { g.save(); g.globalCompositeOperation = p.comp || 'lighter'; try { p.draw(g, p, Math.min(1, p.t / p.life)); } catch (e) {} g.restore(); } } }); }
});
// mockup glow(c, x, y, r, rgb, a): a radial gradient disc
const glow = (g, x, y, r, rgb, a) => { if (!(r > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };

// floor ring (ellipse) growing r0 -> r1
function ring(at, pt, o) { o = o || {}; const rgb = o.rgb || '255,255,255', r0 = o.r0 == null ? 10 : o.r0, r1 = o.r1 == null ? 160 : o.r1, ms = o.ms || 600, sy = o.sy == null ? 0.3 : o.sy, w = o.w || 6, layer = o.layer || 'ground';
  spawn(at, () => { const s = KP * DR(o.ref || pt); addP(layer, { x: pt.x, y: pt.y, life: ms, update: () => {}, draw: (g, p, t) => { const r = lerp(r0, r1, E.outC(t)) * s; g.strokeStyle = 'rgba(' + rgb + ',' + (1 - t) + ')'; g.lineWidth = w * (1 - t * 0.6) * s; g.beginPath(); g.ellipse(p.x, p.y, r, r * sy, 0, 0, 7); g.stroke(); } }); }); }
// floor cracks
function crack(at, pt) { spawn(at, () => { const s = KP * DR(pt); const segs = Array.from({ length: 7 }, () => [rnd(0, 6.283), rnd(30, 80)]);
  addP('ground', { x: pt.x, y: pt.y, life: 1600, comp: 'source-over', update: () => {}, draw: (g, p, t) => { g.strokeStyle = 'rgba(30,18,10,' + (t > 0.7 ? (1 - t) / 0.3 * 0.8 : 0.8) + ')'; g.lineWidth = 3 * s; for (const sg of segs) { const a = sg[0], L = sg[1]; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + Math.cos(a) * L * s * 0.5, p.y + Math.sin(a) * L * s * 0.16); g.lineTo(p.x + Math.cos(a + 0.3) * L * s, p.y + Math.sin(a + 0.3) * L * s * 0.32); g.stroke(); } } }); }); }
// dust puffs kicked up from a point
function dustBurst(at, pt, o) { o = o || {}; const n = o.n || 14, rgb = o.rgb || '190,170,140'; spawn(at, () => { const s = (o.s || 1) * DR(pt);
  for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2); addP('field', { x: pt.x + rnd(-10, 10) * s * KP, y: pt.y, vx: Math.cos(an) * rnd(0.08, 0.25) * s, vy: Math.sin(an) * rnd(0.02, 0.1) * s, drag: 0.97, life: rnd(500, 900), r: rnd(8, 18) * s * KP, comp: 'source-over',
    draw: (g, p, t) => { g.fillStyle = 'rgba(' + rgb + ',' + (0.45 * (1 - t)) + ')'; g.beginPath(); g.arc(p.x, p.y, p.r * (1 + t), 0, 7); g.fill(); } }); } }); }
// four-point star twinkles
function twinkles(at, pt, o) { o = o || {}; const n = o.n || 10, r = (o.r == null ? 80 : o.r) * KP, rgb = o.rgb || '160,230,255', layer = o.layer || 'hit';
  spawn(at, () => { for (let i = 0; i < n; i++) addP(layer, { x: pt.x + rnd(-r, r), y: pt.y + rnd(-r, r) * 0.8, life: rnd(500, 900), s: rnd(5, 11) * KP, update: () => {},
    draw: (g, p, t) => { const k = Math.sin(t * Math.PI) * p.s; glow(g, p.x, p.y, k * 2.5, rgb, 0.7); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(p.x, p.y - k * 1.6); g.lineTo(p.x + k * 0.3, p.y); g.lineTo(p.x, p.y + k * 1.6); g.lineTo(p.x - k * 0.3, p.y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(p.x - k * 1.6, p.y); g.lineTo(p.x, p.y + k * 0.3); g.lineTo(p.x + k * 1.6, p.y); g.lineTo(p.x, p.y - k * 0.3); g.closePath(); g.fill(); } }); }); }
// sparks thrown out and falling (mockup shards)
function shards(at, pt, rgb, n, spread, layer) { spawn(at, () => { for (let i = 0; i < n; i++) { const an = rnd(0, 6.283), sp = rnd(0.15, spread);
  addP(layer || 'hit', { x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 0.2, g: 0.0012, drag: 0.985, life: rnd(600, 1000), rot: rnd(0, 6), vr: rnd(-0.02, 0.02), s: rnd(5, 11) * KP,
    draw: (g, p, t) => { p.rot += p.vr * 16; g.translate(p.x, p.y); g.rotate(p.rot); g.globalAlpha = 1 - t; g.fillStyle = 'rgba(' + rgb + ',1)'; g.beginPath(); g.moveTo(0, -p.s); g.lineTo(p.s * 0.6, 0); g.lineTo(0, p.s * 0.9); g.lineTo(-p.s * 0.5, 0); g.fill(); } }); } }); }
// a rising ember (call inside a spawn)
const ember = (layer, x, y, rgb, o) => addP(layer, Object.assign({ x, y, vx: rnd(-0.03, 0.03), vy: rnd(-0.12, -0.05), life: rnd(1400, 2600), r: rnd(2, 5) }, o || {}, { draw: (g, p, t) => { const a = Math.sin(t * Math.PI); glow(g, p.x + Math.sin(p.t / 300) * 6 * KP, p.y, p.r * 3 * KP, rgb, a * 0.9); } }));
// a floating mote (call inside a spawn)
const dust = (layer, x, y, rgb, o) => addP(layer, Object.assign({ x, y, vx: rnd(-0.02, 0.02), vy: rnd(-0.02, 0.02), life: rnd(1800, 3400), r: rnd(1, 2.6) }, o || {}, { draw: (g, p, t) => { const a = Math.sin(t * Math.PI) * (0.5 + 0.5 * Math.sin(p.t / 120 + p.x)); g.fillStyle = 'rgba(' + rgb + ',' + a + ')'; g.beginPath(); g.arc(p.x, p.y, p.r * KP, 0, 7); g.fill(); glow(g, p.x, p.y, p.r * 4 * KP, rgb, a * 0.35); } }));
// motes homing in on a point along an arc (mockup windWisps / homing)
function wisps(at, to, o) { o = o || {}; const n = o.n || 14, rr = (o.r || 220) * KP, rgb = o.rgb || '200,255,225', ms = o.ms || 700, arc = 60 * KP;
  spawn(at, () => { for (let i = 0; i < n; i++) { const a = rnd(0, 6.283), from = { x: to.x + Math.cos(a) * rr, y: to.y + Math.sin(a) * rr * 0.6 }; const cx = (from.x + to.x) / 2 + rnd(-arc, arc), cy = Math.min(from.y, to.y) - rnd(arc * 0.3, arc);
    addP('hit', { x: from.x, y: from.y, life: ms * rnd(0.85, 1.15), r: 2, update: (p) => { const k = E.inQ(Math.min(1, p.t / p.life)), u = 1 - k; p.px = p.x; p.py = p.y; p.x = u * u * from.x + 2 * u * k * cx + k * k * to.x; p.y = u * u * from.y + 2 * u * k * cy + k * k * to.y; },
      draw: (g, p) => { glow(g, p.x, p.y, p.r * 3.5 * KP, rgb, 0.95); g.strokeStyle = 'rgba(' + rgb + ',.5)'; g.lineWidth = p.r * KP; g.beginPath(); g.moveTo(p.px == null ? p.x : p.px, p.py == null ? p.y : p.py); g.lineTo(p.x, p.y); g.stroke(); } }); } }); }
// comic dust puff (round blobs with a dark outline that pop, grow and fade; round 3)
function comicPuff(at, pt, o) { o = o || {}; const s = (o.s || 1), up = o.up || 0, n = o.n || 4;
  spawn(at, () => { for (let i = 0; i < n; i++) { const r0 = rnd(7, 13) * s * KP;
    addP('field', { x: pt.x + rnd(-14, 14) * s * KP, y: pt.y - rnd(0, 8) * s * KP, vx: rnd(-0.06, 0.06) * s, vy: -rnd(0.01, 0.05) * s - up, drag: 0.97, life: rnd(420, 650), comp: 'source-over',
      draw: (g, p, t) => { const r = r0 * (0.6 + EOUTBACK(Math.min(1, t * 2.2)) * 0.7) * (1 - t * 0.3); g.globalAlpha = t > 0.6 ? (1 - t) / 0.4 : 1;
        g.fillStyle = '#3a2d26'; g.beginPath(); g.arc(p.x, p.y, r + 2.2 * KP, 0, 7); g.fill(); g.fillStyle = '#f2ece2'; g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill();
        g.fillStyle = '#c9bfb2'; g.beginPath(); g.arc(p.x + r * 0.25, p.y + r * 0.3, r * 0.55, 0, 7); g.fill(); } }); } }); }
// a crescent slash drawn across a point (no clip), ang = the cut's angle (mockup sign, mirrored here)
function crescent(at, pt, o) { o = o || {}; const ang = (o.ang == null ? -0.5 : o.ang), len = (o.len || 160) * KP, w = (o.w || 26) * KP, rgb = o.rgb || '255,255,255', ms = o.ms || 260;
  spawn(at, () => addP('hit', { x: pt.x, y: pt.y, life: ms, update: () => {}, draw: (g, p, t) => { const k = E.outC(Math.min(1, t * 1.6)); g.translate(p.x, p.y); if (DIR < 0) g.scale(-1, 1); g.rotate(ang); g.globalAlpha = 1 - Math.max(0, (t - 0.45) / 0.55);
    g.fillStyle = 'rgba(' + rgb + ',.9)'; g.beginPath(); g.moveTo(-len / 2, 0); g.quadraticCurveTo(0, -w * 1.6 * k, len / 2 * k, 0); g.quadraticCurveTo(0, -w * 0.4, -len / 2, 0); g.fill(); glow(g, 0, -w * 0.5, len * 0.45, rgb, 0.35); } })); }

// ── projectiles (tip at 0,0 pointing +x, mockup SHAPE units scaled by KP) ──
const SHAPE = {
  arrow: (len, rgb, head) => (g) => { glow(g, -6, 0, 26, rgb, 0.55); g.globalCompositeOperation = 'source-over';
    g.strokeStyle = '#6b4a2a'; g.lineWidth = 3; g.beginPath(); g.moveTo(-len, 0); g.lineTo(-8, 0); g.stroke();
    g.fillStyle = head; g.beginPath(); g.moveTo(4, 0); g.lineTo(-10, -5); g.lineTo(-10, 5); g.closePath(); g.fill();
    g.fillStyle = 'rgb(' + rgb + ')'; g.beginPath(); g.moveTo(-len + 14, 0); g.lineTo(-len, -7); g.lineTo(-len + 4, 0); g.lineTo(-len, 7); g.closePath(); g.fill(); },
  lance: (len, rgb) => (g) => { glow(g, -len * 0.3, 0, len * 0.5, rgb, 0.5); g.fillStyle = 'rgba(' + rgb + ',.85)';
    g.beginPath(); g.moveTo(10, 0); g.lineTo(-len * 0.25, -6); g.lineTo(-len, -1.5); g.lineTo(-len, 1.5); g.lineTo(-len * 0.25, 6); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(6, 0); g.lineTo(-len * 0.3, -2.5); g.lineTo(-len * 0.8, 0); g.lineTo(-len * 0.3, 2.5); g.closePath(); g.fill(); },
  coin: (r) => (g, el) => { g.globalCompositeOperation = 'source-over'; const k = Math.abs(Math.cos(el / 70)); g.fillStyle = '#e8b32a'; g.beginPath(); g.ellipse(0, 0, r * Math.max(0.15, k), r, 0, 0, 7); g.fill(); g.fillStyle = '#fff3b0'; g.fillRect(-1, -r * 0.6, 2, r * 0.5); },
};
// fly from -> to over ms (o.ease, o.arc mockup px, o.stay ms in the floor, o.trail rgb glow trail, o.z)
function fly(at, from, to, ms, draw, o) {
  o = o || {}; const ease = o.ease || E.lin, arc = (o.arc || 0) * KP, sc = KP * (o.scale || 1);
  const posAt = (e) => { const u = ease(Math.max(0, Math.min(1, e / ms))); return { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - arc * Math.sin(Math.PI * u) }; };
  const angAt = (e) => { const a = posAt(Math.max(0, e - 8)), b = posAt(Math.min(ms, e + 8)); return Math.atan2(b.y - a.y, b.x - a.x); };
  const z = o.z == null ? 46 : o.z, stay = o.stay || 0, end = ms + stay + (o.trail ? 260 : 0);
  T.push({ t0: at, t1: at + end, fn: (e, S) => { S.world.push({ z, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter';
    if (o.trail) for (let k = 1; k <= 16; k++) { const ee = e - k * 16; if (ee < 0 || ee > ms) continue; const age = e - ee; if (age > 260) continue; const p = posAt(ee); glow(g, p.x, p.y, 8 * KP, o.trail, 0.55 * (1 - age / 260)); }
    if (e < ms) { const p = posAt(e); g.translate(p.x, p.y); g.rotate(angAt(e)); g.scale(sc, sc); draw(g, e); }
    else if (stay && e < ms + stay) { const p = posAt(ms), u = (e - ms) / stay; g.globalCompositeOperation = 'source-over'; g.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1; g.translate(p.x, p.y); g.rotate(angAt(ms)); g.scale(sc, sc); draw(g, e); }
    g.restore(); } }); } });
  return at + ms;
}
// coins from one point to another (IP steal); returns when the first lands
function coinsTo(at, from, to, n, ms) { ms = ms || 650; SX(at, 'coin', 0.45); for (let i = 0; i < n; i++) fly(at + i * 70, { x: from.x + rnd(-12, 12) * KP, y: from.y }, to, ms, SHAPE.coin(7), { ease: E.sine, arc: rnd(70, 130), z: 46 }); return at + ms; }

// ── clips (sizes: the mockup's scale × the library factor × KP; depth from the engine) ──

// Additive pixelfx _light layers are alpha-less (glow on black). Canvas 'lighter' onto the transparent overlay
// adds alpha too, so the black would turn into an opaque box: an SVG luminance-to-alpha filter makes black
// transparent before the add (staging 2026-11-16: Torcleaver / Temper Tantrum black boxes).
const LUMA_FILTER = (() => { const id = 'oni-luma-alpha'; try { if (!document.getElementById(id)) { const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute'; svg.style.pointerEvents = 'none'; const f = document.createElementNS(ns, 'filter'); f.setAttribute('id', id); f.setAttribute('color-interpolation-filters', 'sRGB'); const cm = document.createElementNS(ns, 'feColorMatrix'); cm.setAttribute('type', 'matrix'); cm.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1 1 1 0 0'); f.appendChild(cm); svg.appendChild(f); document.body.appendChild(svg); } } catch (e) {} return 'url(#' + id + ')'; })();
const clipW = (k, scale) => CL[k].w * scale * (CL[k].k || 0.55) * KP;
const clipAt = (k, at, pt, scale, o) => { if (!CL[k]) return null; return m.clip(k, at, Object.assign({ x: pt.x, y: pt.y, w: clipW(k, scale), z: 40 }, o || {})); };
// a pixelfx export: back layer under the battlers, front over them, light additive over them
const pxClip = (base, at, pt, scale, o) => { o = o || {}; const out = [];
  if (CL[base + '_back']) out.push(clipAt(base + '_back', at, pt, scale, { z: 3 }));
  if (CL[base + '_front']) out.push(clipAt(base + '_front', at, pt, scale, { z: o.z || 40 }));
  if (CL[base + '_light']) out.push(clipAt(base + '_light', at, pt, scale, { z: (o.z || 40) + 1, add: true, filter: LUMA_FILTER }));
  return out; };

// ── screen: dim, white, the impact frame, radial speed lines, the cut-in ──
const DIM = chan(0), WHITE = chan(0);
const fdim = (at, ms, to) => key(DIM, at, ms, to, E.sine);
const whiteTo = (at, ms, to) => key(WHITE, at, ms, to, E.sine);
m.hold(0, 1e9, (t, S) => { const d = valAt(DIM, t); if (d > S.dim) S.dim = d; const w = valAt(WHITE, t); if (w > 0 && w > S.flash.a) S.flash = { a: w, c: '#ffffff' }; });
const scr = (pt) => tl.toScreen(pt.x, pt.y);
const scrScale = (pt) => { const a = tl.toScreen(pt.x, pt.y), b = tl.toScreen(pt.x + 100, pt.y); return Math.abs(b.x - a.x) / 100 || 1; };
// anime impact frame: black with the targets in white and a burst of lines, then white with them in black
function impactFrame(at, keys, ms) {
  ms = ms || 70; const burst = Array.from({ length: 46 }, () => ({ a: rnd(0, 6.283), w: rnd(0.006, 0.03), r0: rnd(90, 220) }));
  m.hold(at, at + ms * 2, (e, S) => { S.screen.push({ draw: (g) => { const second = e >= ms; const Hs = g.H / 788;
    g.save(); g.fillStyle = second ? '#fff' : '#000'; g.fillRect(-20, -20, g.W + 40, g.H + 40);
    const cs = keys.map((k) => scr(tCenter(k))); const cen = cs.reduce((s, p) => ({ x: s.x + p.x / cs.length, y: s.y + p.y / cs.length }), { x: 0, y: 0 });
    g.fillStyle = second ? '#000' : '#fff'; for (const b of burst) { g.beginPath(); g.moveTo(cen.x + Math.cos(b.a) * b.r0 * Hs, cen.y + Math.sin(b.a) * b.r0 * Hs); g.lineTo(cen.x + Math.cos(b.a - b.w) * 1900 * Hs, cen.y + Math.sin(b.a - b.w) * 1900 * Hs); g.lineTo(cen.x + Math.cos(b.a + b.w) * 1900 * Hs, cen.y + Math.sin(b.a + b.w) * 1900 * Hs); g.fill(); }
    for (const k of keys) { const Tk = TOK[k], c = tl.tinted(k, second ? '#000' : '#fff'); if (!c) continue; const f = feet(Tk), p = scr(f), s = scrScale(f); g.save(); g.translate(p.x, p.y); g.scale(Tk.flip * s, s); g.drawImage(c, -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h); g.restore(); }
    g.restore(); } }); });
  return at + ms * 2;
}
// radial speed lines from a board point (mockup speedLines(true, { vp, color, alpha }))
function speedLines(from, to, vpPt, color, alpha) {
  const L = Array.from({ length: 26 }, () => ({ u: R(), off: rnd(-1, 1), len: rnd(0.15, 0.45), sp: rnd(0.0015, 0.003), w: rnd(1, 3.2) }));
  m.hold(from, to, (e, S) => { S.screen.push({ draw: (g) => { const vp = scr(vpPt), Hs = g.H / 788; g.save(); g.globalCompositeOperation = 'lighter';
    for (const l of L) { const u = ((l.u + l.sp * e + 0.3) % 1.6) - 0.3, a = l.off * Math.PI, r0 = u * 1100 * Hs, r1 = r0 + l.len * 700 * Hs; g.strokeStyle = 'rgba(' + color + ',' + (alpha * (0.4 + l.w / 4)) + ')'; g.lineWidth = l.w * Hs; g.beginPath(); g.moveTo(vp.x + Math.cos(a) * r0, vp.y + Math.sin(a) * r0); g.lineTo(vp.x + Math.cos(a) * r1, vp.y + Math.sin(a) * r1); g.stroke(); }
    g.restore(); } }); });
}
// the shipped Zero Power cut-in (ZP.cutin timings and CSS easings), drawn pixel-crisp for sprite art
function cutinPx(at, imgKey) {
  const inMs = 650, hold = 850, outMs = 650, end = inMs + hold + outMs;
  m.hold(at, at + end, (e, S) => { const img = tl.IMG[imgKey]; if (!img) return; S.screen.push({ draw: (g) => {
    const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1; const h = g.H * 0.92, w = h * iw / ih;
    const x = e < inMs ? -1.2 * g.W * (1 - ZP.cssOut(e / inMs)) : e < inMs + hold ? 0 : 1.2 * g.W * ZP.cssIn((e - inMs - hold) / outMs);
    g.save(); g.imageSmoothingEnabled = false; g.globalAlpha = 1; g.drawImage(img, x, g.H - h, w, h); g.restore(); } }); });
  SX(at, 'overdrive', 0.9);
  return at + end;
}

// ── hits: the contact cue (BD reveals the number / flinch / HP there in a Chain) and the gate ──
const hitCue = (at) => once(at, () => oni.hit());
let GATE = null;
const gateAt = (at) => { GATE = at; once(at, () => oni.fireDone()); };
// mockup land(t, ...): the clip on the body, the sound, the contact cue
function land(at, k, o) { o = o || {}; if (o.fx) clipAt(o.fx, at, tCenter(k), o.fxScale || 1, { z: 42, add: !!o.add }); if (o.s) SX(at, o.s, o.vol == null ? 0.5 : o.vol); if (!o.noCue) hitCue(at); }
// mockup statusBeat(t): MV Powerdown at the feet
const statusBeat = (at, k) => clipAt('powerdown', at, tFeet(k), 1, { z: 41 });

// ── run: paints the body until BODY_END, then hands the token back ──
async function runShot(total) {
  // (LIVE: the engine rescales a body that crossed the floor; in a takeover the kit does it, as drawCopy does)
  m.hold(0, BODY_END, (t, S) => { const p = pose(t), d = S.tok.k; const r = !LIVE && (p.dx || p.dy) ? tl.depthRatio(KF, { x: KF.x + p.dx, y: KF.y + p.dy }) : 1; d.dx = p.dx; d.dy = p.dy; d.air = p.air; d.rot = p.rot; d.sx = p.sx * r; d.sy = p.sy * r; });
  if (GATE == null) gateAt(Math.max(0, total - 1));
  await tl.run(T, { total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
  oni.fireDone();
}
