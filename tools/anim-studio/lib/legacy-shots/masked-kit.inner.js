// ── Masked Girl (Kalina) kit: prepended to every masked-*.inner.js shot by legacy-masked-signatures.js ──
// Port of the approved legacy boss mockup (part-b1 + r3/r4/r5/r6 overrides). LIVE board: the camera is never
// touched; Kalina is painted by this kit from a per-shot BODY(t) state (her own art or a pose sprite), so poses,
// afterimages, ghost trails and filters all work; the real token stays hidden while the shot owns her.
// Every number is mockup px on a 1682 px stage, scaled by KP = stage width / 1682. No backticks, no dollar-brace.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
if (!caster) { oni.fireDone(); return; }
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
// cast focus (Zero Power): everyone else on the board becomes a timeline token so it can fade out
const BYST = [];
if (cfg.focus) {
  const skip = new Set([caster.id]); for (const t of targets) skip.add(t.id); let n = 0;
  for (const t of (canvas.tokens && canvas.tokens.placeables) || []) { if (skip.has(t.id) || !t.visible || !t.mesh || (t.document && t.document.hidden)) continue; const k = 'b' + (n++); BYST.push(k); tokens[k] = { token: t }; }
}
const CL = A.clips || {};
// LIVE board for the on-board moves; cfg.live === false = the full-takeover timeline (camera driven through S.cam),
// used by the Zero Power cinematic only
const tl = oni.timeline({ tokens, clips: CL, images: A.images || {}, live: cfg.live !== false, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK, feet = tl.feet;
// the mockup's extra easings
const X = { lin: E.lin, out: E.outQ, in: E.inQ, quad: E.ioQ, sine: E.sine, outCubic: E.outC, inCubic: E.inC,
  outBack: (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); } };
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 1357);
const rnd = (a, b) => a + (b - a) * R();
const T = [], sfx = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (did) return; did = true; try { fn(); } catch (e) { console.warn('[MG] once threw', e); } } }); };
const S_ = (at, key, v) => { const url = A.sfx && A.sfx[key]; if (url) sfx.push({ at, url, v: v * (cfg.volume == null ? 0.9 : cfg.volume) }); };
const K = TOK.k, kf = feet(K);
const boxB = (k) => TOK[k].y + TOK[k].h / 2;                 // mockup OY: the bottom of a battler's art box
const center = (k) => ({ x: TOK[k].x, y: TOK[k].y });         // mockup center(): middle of the art box
const ftOf = (k) => feet(TOK[k]);
// toward the party: the first target, else the friendly tokens on the board, else her facing
const DIR = (() => {
  if (FOES.length) return TOK[FOES[0]].x >= K.x ? 1 : -1;
  const pcs = ((canvas.tokens && canvas.tokens.placeables) || []).filter((t) => t && t.document && t.document.disposition === 1 && t !== caster);
  if (pcs.length) return (pcs.reduce((s, t) => s + t.center.x, 0) / pcs.length) >= K.x ? 1 : -1;
  return K.dir || 1;
})();
const viewTop = () => { let top = tl.STAGE.y; try { const v = tl.camView(null); if (v && Number.isFinite(v.top)) top = Math.min(top, v.top); } catch (e) {} return top; };

// ── poses: the pose system keeps the idle art's PIXEL size (scale = her drawn width / her art width) ──
const natW = (im) => (im && (im.videoWidth || im.naturalWidth || im.width)) || 0;
const natH = (im) => (im && (im.videoHeight || im.naturalHeight || im.height)) || 0;
const ART0 = tl.art('k');
const PX = K.w / (natW(ART0) || K.w);
function footOf(im) {
  try { const w = natW(im), h = natH(im); if (!w || !h) return null; const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, w, h).data;
    for (let y = h - 1; y >= 0; y--) for (let i = 0; i < w; i++) if (d[(y * w + i) * 4 + 3] > 128) return (y + 1) / h; return null; } catch (e) { return null; }
}
const POSES = { idle: { key: 'idle', img: ART0, w: K.w, h: K.h, foot: K.foot } };
function addPose(key, img) { if (!img || !natW(img)) return; POSES[key] = { key, img, w: natW(img) * PX, h: natH(img) * PX, foot: footOf(img) || K.foot }; }
for (const k of (cfg.poses || [])) addPose(k, tl.IMG['pose_' + k]);
// the winged battler (Kalina_Battler002.webm) as a playing video
if (A.winged) {
  const v = await new Promise((ok) => { const el = document.createElement('video'); el.crossOrigin = 'anonymous'; el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
    let done = false; const fin = (r) => { if (done) return; done = true; ok(r); };
    el.addEventListener('loadeddata', () => fin(el)); el.addEventListener('error', () => fin(null)); setTimeout(() => fin(el.readyState >= 2 ? el : null), 5000); el.src = A.winged; });
  if (v) { try { v.play().catch(() => {}); } catch (e) {} addPose('winged', v); }
}
const poseOf = (k) => POSES[k] || POSES.idle;
// a pose's art box in board px at a body state (mockup OX/OY/hgt/wid while that art is on)
function boxOf(s) { const P = poseOf(s.pose), d = s.d || 1; const top = s.y - s.air - P.h * d * P.foot; return { x: s.x, top, bottom: top + P.h * d, h: P.h * d, w: P.w * d }; }
const handOf = (s) => { const b = boxOf(s); return { x: b.x + DIR * b.w * 0.3, y: b.bottom - b.h * 0.62 }; };
const bodyMid = (s) => { const b = boxOf(s); return { x: b.x, y: b.bottom - b.h * 0.5 }; };

// ── her body: the shot sets BODY = (t) => state; the kit paints it (afterimages and ghost trails behind) ──
const st0 = () => ({ x: kf.x, y: kf.y, air: 0, pose: 'idle', sx: 1, sy: 1, rot: 0, alpha: 1, hidden: false, filter: '', d: 1 });
let BODY = null;
const AFTER = [];   // afterimages: { t0, ms, op, filter } = a snapshot of the body at t0, fading out
const TRAILS = [];  // guest ghost trails: { t0, t1, n, lag, op, pose }
const HAS_SH = (() => { try { const f1 = caster.document.flags && caster.document.flags['fabula-ultima-companion']; const f2 = caster.actor && caster.actor.flags && caster.actor.flags['fabula-ultima-companion']; return !!((f1 && f1.spriteShadow) || (f2 && f2.spriteShadow)); } catch (e) { return false; } })();
const BAKE = new Map();
function baked(P, filter) {
  if (!filter) return P.img; const key = P.key + '|' + filter; let c = BAKE.get(key); if (c) return c;
  const w = natW(P.img), h = natH(P.img); if (!w || !h) return P.img;
  c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.filter = filter; x.drawImage(P.img, 0, 0, w, h); BAKE.set(key, c); return c;
}
// depth: a body that crosses the floor is drawn at the size of where it stands
const DCACHE = new Map();
const depthAt = (x, y) => { const key = Math.round(x) + '|' + Math.round(y); let d = DCACHE.get(key); if (d == null) { d = tl.depthRatio(kf, { x, y }); DCACHE.set(key, d); } return d; };
function bodyAt(t) { const s = Object.assign(st0(), BODY ? BODY(t) : {}); s.d = (s.x !== kf.x || s.y !== kf.y) ? depthAt(s.x, s.y) : 1; return s; }
// mockup px (filter lengths) -> canvas px of the overlay under the current transform
const fpx = (g, n) => { let a = 1; try { a = g.getTransform().a; } catch (e) {} return Math.max(0, n * KP * a); };
function paint(g, s, img, a, filter) {
  const P = poseOf(s.pose); g.save(); g.translate(s.x, s.y - s.air); if (s.rot) g.rotate(s.rot * Math.PI / 180);
  g.scale(K.flip * s.sx * s.d, s.sy * s.d); g.globalAlpha = a; if (filter) g.filter = filter;
  g.drawImage(img || P.img, -P.w / 2, -P.h * P.foot, P.w, P.h); g.restore();
}
function bodyTrack(total, z) {
  m.hold(0, total, (t, S) => {
    if (!BODY) return; const s = bodyAt(t); const q = S.tok.k;
    if (s.hidden || s.alpha <= 0) q.hidden = true;
    else { q.pose = 'blank'; q.dx = s.x - kf.x; q.dy = s.y - kf.y; q.air = s.air; if (Math.abs(q.dy) > 0.5) q.noShadow = true; }
    if (HAS_SH && !s.hidden && Math.abs(s.y - kf.y) > 0.5) S.world.push({ z: 2, draw: (g) => { const lk = Math.min(1, s.air / K.h); g.save(); g.globalAlpha = 0.32 * (1 - 0.45 * lk); g.fillStyle = '#000'; g.beginPath(); g.ellipse(s.x, s.y, K.w * 0.3 * s.d * (1 - 0.35 * lk), K.w * 0.09 * s.d * (1 - 0.35 * lk), 0, 0, 6.2832); g.fill(); g.restore(); } });
    S.world.push({ z: z || 20, draw: (g) => {
      for (const a of AFTER) { const age = t - a.t0; if (age < 0 || age >= a.ms) continue; const s2 = a.s || (a.s = bodyAt(a.t0)); if (s2.hidden) continue; paint(g, s2, baked(poseOf(s2.pose), a.filter), a.op * (1 - X.sine(age / a.ms))); }
      for (const tr of TRAILS) { if (t < tr.t0 || t > tr.t1 + tr.n * tr.lag + 60) continue;
        for (let i = tr.n - 1; i >= 0; i--) { const ts = t - (i + 1) * tr.lag; if (ts < tr.t0) continue; const s2 = bodyAt(ts); if (s2.hidden) continue; const u = i / Math.max(1, tr.n - 1);
          const P = poseOf(tr.pose || s2.pose); paint(g, Object.assign({}, s2, { pose: P.key }), baked(P, 'brightness(' + (0.55 * (1 - u)).toFixed(3) + ') sepia(1) hue-rotate(175deg) saturate(' + (6 * (1 - u) + 0.01).toFixed(3) + ')'), tr.op); } }
      if (!s.hidden && s.alpha > 0) paint(g, s, null, s.alpha, s.filter ? s.filter.replace(/\{(\d+(\.\d+)?)\}/g, (mm, n) => fpx(g, Number(n)).toFixed(2) + 'px') : '');
    } });
  });
}
const BLANK = document.createElement('canvas'); BLANK.width = 2; BLANK.height = 2;
(tl.POSE.k = tl.POSE.k || {}).blank = { img: BLANK, foot: 1, w: 0.01, h: 0.01 };
// afterimages every 'every' ms over [t0, t1)
const afterimages = (t0, t1, every, op, ms, filter) => { for (let t = t0; t < t1; t += every) AFTER.push({ t0: t, ms, op, filter: filter || 'brightness(1.6) saturate(.4)' }); };

// a value track built from tweens: segs = [t0, ms, to, ease]; a later tween takes over from where the value is
function tw(init, segs) {
  const S = segs.slice().sort((a, b) => a[0] - b[0]); const starts = [];
  const valAt = (i, t) => { if (i < 0) return init; const sg = S[i]; if (t < sg[0]) return valAt(i - 1, t); const u = sg[1] > 0 ? clamp01((t - sg[0]) / sg[1]) : 1; return lerp(starts[i], sg[2], (sg[3] || X.lin)(u)); };
  for (let i = 0; i < S.length; i++) starts.push(i === 0 ? init : valAt(i - 1, S[i][0]));
  return (t) => { let i = S.length - 1; while (i >= 0 && t < S[i][0]) i--; return valAt(i, t); };
}
// a step track: [[t, value], ...] -> the last value whose t has passed
const steps = (init, list) => (t) => { let v = init; for (const sp of list) if (t >= sp[0]) v = sp[1]; return v; };

// ── particles (world space; 'ground'/'field' sit under the real tokens, 'hit' above everything) ──
const PS = [];
const LAYER_Z = { ground: 2, field: 4, hit: 30 };
const part = (p) => { p.z = LAYER_Z[p.layer || 'hit']; PS.push(p); return p; };
function posOf(p, age) {
  let dx, dy; const vx = p.vx || 0, vy = p.vy || 0;
  if (p.drag && p.drag < 1) { const L = Math.log(p.drag) / 16; const f = (Math.exp(L * age) - 1) / L; dx = vx * f; dy = vy * f; } else { dx = vx * age; dy = vy * age; }
  dy += 0.5 * (p.g || 0) * age * age; return { x: p.x + dx * KP, y: p.y + dy * KP };
}
function particleTrack(total) {
  m.hold(0, total, (t, S) => {
    for (const z of [2, 4, 30]) { let any = false; for (const p of PS) if (p.z === z && t >= p.t0 && t < p.t0 + p.life) { any = true; break; } if (!any) continue;
      S.world.push({ z, draw: (g) => { for (const p of PS) { if (p.z !== z) continue; const age = t - p.t0; if (age < 0 || age >= p.life) continue; const pt = p.pos ? p.pos(age) : posOf(p, age); g.save(); g.globalCompositeOperation = p.comp || 'lighter'; p.draw(g, pt.x, pt.y, age / p.life, age, p); g.restore(); } } }); }
  });
}
const glw = (g, x, y, r, rgb, a) => { if (!(r > 0) || !(a > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
// mockup ring(): an expanding floor ellipse
const ring = (at, pt, o) => { o = o || {}; const rgb = o.rgb || '255,255,255', r0 = o.r0 == null ? 10 : o.r0, r1 = o.r1 == null ? 160 : o.r1, ms = o.ms || 600, sy = o.sy || 0.3, w = o.w || 6, s = o.s || 1;
  part({ t0: at, life: ms, x: pt.x, y: pt.y, layer: o.layer || 'ground', draw: (g, x, y, u) => { const r = lerp(r0, r1, X.outCubic(u)) * s * KP; g.strokeStyle = 'rgba(' + rgb + ',' + (1 - u) + ')'; g.lineWidth = w * (1 - u * 0.6) * s * KP; g.beginPath(); g.ellipse(x, y, r, r * sy, 0, 0, 6.2832); g.stroke(); } }); };
// mockup floorShadow(): a dark ellipse that grows under a target until 'end'
const floorShadow = (at, end, pt, o) => { o = o || {}; const r = o.r || 60, grow = o.grow || 600, to = o.to == null ? 0.55 : o.to, s = o.s || 1;
  part({ t0: at, life: Math.max(1, end - at), x: pt.x, y: pt.y, layer: 'ground', comp: 'source-over', draw: (g, x, y, u, age) => { const k = X.in(clamp01(age / grow)); g.fillStyle = 'rgba(0,0,0,' + (to * k) + ')'; g.beginPath(); g.ellipse(x, y, Math.max(0.1, r * k * s * KP), Math.max(0.1, r * k * s * KP * 0.32), 0, 0, 6.2832); g.fill(); } }); };
const crack = (at, pt, s) => { s = s || 1; const segs = Array.from({ length: 7 }, () => [rnd(0, 6.2832), rnd(30, 80)]);
  part({ t0: at, life: 1600, x: pt.x, y: pt.y, layer: 'ground', comp: 'source-over', draw: (g, x, y, u) => { g.strokeStyle = 'rgba(30,18,10,' + (u > 0.7 ? (1 - u) / 0.3 * 0.8 : 0.8) + ')'; g.lineWidth = 3 * s * KP; for (const sg of segs) { const a = sg[0], L = sg[1] * KP; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L * s * 0.5, y + Math.sin(a) * L * s * 0.16); g.lineTo(x + Math.cos(a + 0.3) * L * s, y + Math.sin(a + 0.3) * L * s * 0.32); g.stroke(); } } }); };
const dustBurst = (at, pt, o) => { o = o || {}; const n = o.n || 14, s = o.s || 1, rgb = o.rgb || '190,170,140';
  for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2), r = rnd(8, 18) * s; part({ t0: at, life: rnd(500, 900), x: pt.x + rnd(-10, 10) * s * KP, y: pt.y, vx: Math.cos(an) * rnd(0.08, 0.25) * s, vy: Math.sin(an) * rnd(0.02, 0.1) * s, drag: 0.97, layer: 'field', comp: 'source-over',
    draw: (g, x, y, u) => { g.fillStyle = 'rgba(' + rgb + ',' + (0.45 * (1 - u)) + ')'; g.beginPath(); g.arc(x, y, r * (1 + u) * KP, 0, 6.2832); g.fill(); } }); } };
const twinkles = (at, pt, o) => { o = o || {}; const n = o.n || 10, r = o.r == null ? 80 : o.r, rgb = o.rgb || '160,230,255';
  for (let i = 0; i < n; i++) { const sz = rnd(5, 11); part({ t0: at, life: rnd(500, 900), x: pt.x + rnd(-r, r) * KP, y: pt.y + rnd(-r, r) * 0.8 * KP, layer: o.layer || 'hit',
    draw: (g, x, y, u) => { const k = Math.sin(u * Math.PI) * sz * KP; glw(g, x, y, k * 2.5, rgb, 0.7); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x, y - k * 1.6); g.lineTo(x + k * 0.3, y); g.lineTo(x, y + k * 1.6); g.lineTo(x - k * 0.3, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - k * 1.6, y); g.lineTo(x, y + k * 0.3); g.lineTo(x + k * 1.6, y); g.lineTo(x, y - k * 0.3); g.closePath(); g.fill(); } }); } };
// mockup windWisps(): motes curving in to a point (homing, ease-in)
const wisps = (at, to, o) => { o = o || {}; const n = o.n || 14, r = o.r || 220, rgb = o.rgb || '200,255,225', ms = o.ms || 700, arc = 60;
  for (let i = 0; i < n; i++) { const a = rnd(0, 6.2832), from = { x: to.x + Math.cos(a) * r * KP, y: to.y + Math.sin(a) * r * 0.6 * KP }; const cx = (from.x + to.x) / 2 + rnd(-arc, arc) * KP, cy = Math.min(from.y, to.y) - rnd(arc * 0.3, arc) * KP; const life = ms * rnd(0.85, 1.15);
    const at2 = (age) => { const tt = X.in(Math.min(1, age / life)), u = 1 - tt; return { x: u * u * from.x + 2 * u * tt * cx + tt * tt * to.x, y: u * u * from.y + 2 * u * tt * cy + tt * tt * to.y }; };
    part({ t0: at, life, pos: at2, draw: (g, x, y, u, age) => { const pv = at2(Math.max(0, age - 16)); glw(g, x, y, 2 * 3.5 * KP, rgb, 0.95); g.strokeStyle = 'rgba(' + rgb + ',.5)'; g.lineWidth = 2 * KP; g.beginPath(); g.moveTo(pv.x, pv.y); g.lineTo(x, y); g.stroke(); } }); } };
const feathersOut = (at, pt, o) => { o = o || {}; const n = o.n || 16, rgb = o.rgb || '255,255,255', spread = o.spread || 0.35, s = o.s || 1;
  for (let i = 0; i < n; i++) { const an = rnd(0, 6.2832), sp = rnd(0.05, spread), rot0 = rnd(0, 6), vr = rnd(-0.004, 0.004), L = rnd(9, 16) * s;
    part({ t0: at, life: rnd(1100, 1900), x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp * 0.7, g: 0.00025, drag: 0.975, layer: o.layer || 'hit', comp: 'source-over',
      draw: (g, x, y, u, age) => { g.globalAlpha = u > 0.6 ? (1 - u) / 0.4 : 1; g.translate(x + Math.sin(age / 260) * 5 * KP, y); g.rotate(rot0 + vr * age); const l = L * KP; g.fillStyle = 'rgb(' + rgb + ')'; g.beginPath(); g.ellipse(0, 0, l, l * 0.28, 0, 0, 6.2832); g.fill(); g.strokeStyle = 'rgba(120,140,170,.6)'; g.lineWidth = KP; g.beginPath(); g.moveTo(-l, 0); g.lineTo(l, 0); g.stroke(); } }); } };
const ember = (at, x, y, rgb, o) => { o = o || {}; const r = o.r || rnd(2, 5);
  part(Object.assign({ t0: at, life: rnd(1400, 2600), x, y, vx: rnd(-0.03, 0.03), vy: rnd(-0.12, -0.05), layer: 'hit' }, o, { draw: (g, px, py, u, age) => { glw(g, px + Math.sin(age / 300) * 6 * KP, py, r * 3 * KP, rgb, Math.sin(u * Math.PI) * 0.9); } })); };

// ── projectiles (mockup fly(): drawn along their travel, tip at the point) ──
// draw(g, age) paints in mockup px with the tip at (0, 0) pointing +x; trail(at, x, y) spawns particles along the path
function fly(at, from, to, o) {
  const ms = o.ms || 450, ease = o.ease || X.lin, arc = o.arc || 0;
  const posAt = (age) => { const u = ease(Math.min(1, age / ms)); return { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - arc * KP * Math.sin(Math.PI * u) }; };
  const angAt = (age) => { const a = posAt(Math.max(0, age - 8)), b = posAt(Math.min(ms, age + 8)); return Math.atan2(b.y - a.y, b.x - a.x); };
  const endAng = angAt(ms);
  m.hold(at, at + ms, (age, S) => { const p = posAt(age), an = angAt(age); S.world.push({ z: o.z || 32, draw: (g) => { g.save(); g.translate(p.x, p.y); g.rotate(an); g.scale(KP, KP); o.draw(g, age); g.restore(); } }); });
  if (o.trail) for (let a = 0; a < ms; a += 16) { const p = posAt(a); o.trail(at + a, p.x, p.y); }
  if (o.stay) m.hold(at + ms, at + ms + o.stay, (age, S) => { const u = age / o.stay; S.world.push({ z: 4, draw: (g) => { g.save(); g.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1; g.translate(to.x, to.y); g.rotate(endAng); g.scale(KP, KP); o.draw(g, ms + age); g.restore(); } }); });
  return at + ms;
}
// mockup SHAPE.spear(len, glowRgb)
const spearShape = (len, glowRgb) => (g) => { g.globalCompositeOperation = 'source-over';
  if (glowRgb) glw(g, -len * 0.4, 0, len * 0.6, glowRgb, 0.35);
  g.strokeStyle = '#5a3a22'; g.lineWidth = 5; g.beginPath(); g.moveTo(-len, 0); g.lineTo(-16, 0); g.stroke();
  g.strokeStyle = '#8a5d3a'; g.lineWidth = 2; g.beginPath(); g.moveTo(-len, -1); g.lineTo(-16, -1); g.stroke();
  g.fillStyle = '#e6e9ef'; g.beginPath(); g.moveTo(6, 0); g.lineTo(-20, -8); g.lineTo(-14, 0); g.lineTo(-20, 8); g.closePath(); g.fill();
  g.fillStyle = '#9aa3b2'; g.beginPath(); g.moveTo(6, 0); g.lineTo(-14, 0); g.lineTo(-20, 8); g.closePath(); g.fill();
  g.fillStyle = '#3c8a4a'; g.fillRect(-26, -3, 6, 6); };
// a spear charged with green wind: spear + green glow + spinning wind rings round the shaft (mockup WIND_SPEAR)
const WIND_SPEAR = (() => { const sp = spearShape(130, '110,255,160'); return (g, age) => { sp(g); g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) { g.strokeStyle = 'rgba(150,255,190,' + (0.75 - i * 0.15) + ')'; g.lineWidth = 2.2; g.beginPath(); g.ellipse(-26 - i * 32, 0, 9, 15, 0, age / 35 + i, age / 35 + i + 3.6); g.stroke(); }
  glw(g, 4, 0, 16, '200,255,220', 0.8); }; })();
// green wind trail behind a spear (mockup windTrail)
const windTrail = (at, x, y) => { part({ t0: at, life: 260, x, y, layer: 'field', draw: (g, px, py, u) => glw(g, px, py, 9 * KP, '120,255,170', 0.6 * (1 - u)) });
  if (R() < 0.5) part({ t0: at, life: 380, x, y, vx: rnd(-0.05, 0.05), vy: rnd(-0.05, 0.05), layer: 'field', draw: (g, px, py, u, age) => { g.strokeStyle = 'rgba(170,255,200,' + (0.6 * (1 - u)) + ')'; g.lineWidth = 1.5 * KP; g.beginPath(); g.arc(px, py, (6 + u * 10) * KP, age / 40, age / 40 + 3); g.stroke(); } }); };

// ── clips (mockup clip(key, pt, { scale })): size = source px * scale * the library factor (MV/JB .55, RO 1.1) ──
const clipW = (key, scale) => (CL[key] ? CL[key].w * scale * CL[key].k * KP : 0);
const fx = (key, at, pt, scale, o) => { if (!CL[key]) return; m.clip(key, at, Object.assign({ x: pt.x, y: pt.y, w: clipW(key, scale), z: 26 }, o || {})); };

// ── screen: a level track for the white flash and the field dim (mockup whiteTo / fdim) ──
const levelTrack = (fn, apply) => (total) => m.hold(0, total, (t, S) => { const v = fn(t); if (v > 0.001) apply(S, v); });
const whiteLevel = (fn, total) => levelTrack(fn, (S, v) => { if (v > S.flash.a) S.flash = { a: v, c: '#ffffff' }; })(total);
const dimLevel = (fn, total) => levelTrack(fn, (S, v) => { S.dim = Math.max(S.dim, v); })(total);
const flashC = (at, color, peak, inMs, outMs) => m.hold(at, at + inMs + outMs, (e, S) => { const a = e < inMs ? peak * e / inMs : peak * (1 - X.out((e - inMs) / outMs)); if (a > S.flash.a) S.flash = { a, c: color }; });
const shake = (at, px, ms) => m.shake(at, ms, px * KP);
const rumble = (t0, t1, px) => m.hold(t0, t1, (e, S) => { S.shake = Math.max(S.shake, px * KP); });
// cast focus: fade the bystanders (and any targets) out at 'at' over ms, back from 'back' over backMs
const focus = (at, ms, back, backMs) => { for (const k of BYST.concat(cfg.focusTargets === false ? [] : FOES)) m.hold(at, back + backMs, (e, S) => { const q = S.tok[k]; if (!q) return; const t = e + at; let a; if (t < at + ms) a = 1 - (t - at) / Math.max(1, ms); else if (t < back) a = 0; else a = Math.min(1, (t - back) / Math.max(1, backMs)); if (a < 1) { if (a <= 0.001) q.hidden = true; else q.alpha *= a; } }); };

// ── the shipped Zero Power cut-in (as zp-shots/_zpkit ZP.cutin): full-body image 92% of the view tall on the bottom
// edge, left -120% -> 0 (CSS ease-out 650 ms), hold 850 ms, -> 120% (CSS ease-in 650 ms); Overdrive is a sfx cue ──
const bez = (x1, y1, x2, y2, x) => { let t = x; for (let i = 0; i < 8; i++) { const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx; const f = ((ax * t + bx) * t + cx) * t - x; const d = (3 * ax * t + 2 * bx) * t + cx; if (Math.abs(d) < 1e-6) break; t -= f / d; } const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by; return ((ay * t + by) * t + cy) * t; };
const cutin = (at, key) => { const inMs = 650, hold = 850, outMs = 650, end = inMs + hold + outMs;
  m.hold(at, at + end, (e, S) => { const img = tl.IMG[key]; if (!img) return; S.screen.push({ draw: (g) => {
    const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1; const h = g.H * 0.92, w = h * iw / ih;
    const x = e < inMs ? -1.2 * g.W * (1 - bez(0, 0, 0.58, 1, e / inMs)) : e < inMs + hold ? 0 : 1.2 * g.W * bez(0.42, 0, 1, 1, (e - inMs - hold) / outMs);
    g.save(); g.globalAlpha = 1; g.drawImage(img, x, g.H - h, w, h); g.restore(); } }); });
  return at + end; };

// ── the Jump -> Skyfall contract: her token's alpha (0 while Flying off-screen, 1 when she lands) ──
// Every client snaps its own mesh at once (the shot still owns her body, so nothing pops); ONE GM (the active GM)
// persists it on the TokenDocument, as the old scripts did; the local value is held until the document agrees.
const isHostGM = () => { const u = game.user; if (!u || !u.isGM) return false; const a = game.users && game.users.activeGM; return a ? a.id === u.id : true; };
function tokenAlpha(tok, a) {
  if (!tok) return;
  try { if (tok.mesh) tok.mesh.alpha = a; } catch (e) {}
  if (isHostGM()) { try { const p = tok.document.update({ alpha: a }, { animate: false }); if (p && p.catch) p.catch((e) => console.warn('[MG] alpha update failed', e)); } catch (e) { console.warn('[MG] alpha update threw', e); } }
  const tk = canvas.app && canvas.app.ticker; if (!tk) return; const t0 = performance.now();
  const hold = () => { let docA = 1; try { docA = Number(tok.document.alpha); } catch (e) {} if (tok.destroyed || !tok.mesh || Math.abs(docA - a) < 0.01 || performance.now() - t0 > 4000) { tk.remove(hold); return; } try { tok.mesh.alpha = a; } catch (e) {} };
  tk.add(hold);
}
// run the shot: damage gate at 'gate' (null = at the end), the start hook on the first frame
async function runShot(total, gate) {
  bodyTrack(total, cfg.bodyZ); particleTrack(total);
  if (gate != null) once(gate, () => oni.fireDone());
  await tl.run(T, { total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
  oni.fireDone();
}
