// ── Nox Ghoul + Nox Hound kit: prepended to ghoul-hound-ghoul.inner.js / ghoul-hound-hound.inner.js by
// lib/nox-ghoul-hound-signatures.js. Port of the approved Nox Legion mockup (part-ghoul-hound.js + the r2 / r4
// sound overrides, v8, 2026-11-20). LIVE board: the camera is never touched. The caster is painted by this kit
// from a per-shot BODY(t) state (moveActor / lean / squash / glow filter + afterimages), the real token stays
// hidden while the shot owns it. Every number is mockup px on a 1682 px stage, scaled by KP = stage width / 1682.
// The mockup assumed the monster on the left facing right: DIR mirrors everything for the other side.
// Storage rule: no backticks, no dollar-brace anywhere in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
if (!caster) { oni.fireDone(); return; }
const tokens = { k: { token: caster } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
const CL = A.clips || {};
const tl = oni.timeline({ tokens, clips: CL, images: {}, live: true, depthRef: 'k' });
await tl.load();
const E = tl.E, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK, feet = tl.feet;
const X = { lin: E.lin, out: E.outQ, in: E.inQ, quad: E.ioQ, sine: E.sine, outCubic: E.outC, inCubic: E.inC };
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 1357);
const rnd = (a, b) => a + (b - a) * R();
const T = [], sfx = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (did) return; did = true; try { fn(); } catch (e) { console.warn('[NoxGH] once threw', e); } } }); };
// mockup sfx(key, vol, rate, stopAfter): the mockup played vol * .75 (cfg.volume); rate / stopAfter go through oni.sfx
const VOL = cfg.volume == null ? 0.75 : cfg.volume;
const S_ = (at, key, v, rate, fadeAfter) => { const url = A.sfx && A.sfx[key]; if (!url) return;
  if (rate || fadeAfter) once(at, () => { oni.sfx(url, { volume: v * VOL, rate: rate || 1, fadeAfter: fadeAfter || 0, fadeMs: 300 }); });
  else sfx.push({ at, url, v: v * VOL }); };
// a sound that rings past the shot's end (a tell whose free attack follows at once): the fade runs on its own timer,
// not oni.sfx's fadeAfter (that timer is cleared by the shot's dispose, which would leave the sound unfaded)
const S_long = (at, key, v, rate, fadeAfter) => { const url = A.sfx && A.sfx[key]; if (!url) return;
  once(at, () => { const a = oni.sfx(url, { volume: v * VOL, rate: rate || 1 }); if (!a || !fadeAfter) return;
    setTimeout(() => { const v0 = a.volume; let k = 0; const iv = setInterval(() => { k++; try { a.volume = Math.max(0, v0 * (1 - k / 10)); } catch (e) {} if (k >= 10) { clearInterval(iv); try { a.pause(); } catch (e) {} } }, 30); }, fadeAfter); }); };
const K = TOK.k, kf = feet(K);
const ftOf = (k) => feet(TOK[k]);
const center = (k) => ({ x: TOK[k].x, y: TOK[k].y });            // mockup center() / bodyAt(): middle of the art box
const OYt = (k) => TOK[k].y + TOK[k].h / 2;                        // mockup OY: the bottom of the art box
const floorOf = (k) => { const f = ftOf(k); return { x: f.x, y: f.y - 4 * KP }; };   // mockup feet(): OY - 4
// toward the party: the first target, else the friendly tokens on the board, else its facing
const DIR = (() => {
  if (FOES.length) return TOK[FOES[0]].x >= K.x ? 1 : -1;
  const pcs = ((canvas.tokens && canvas.tokens.placeables) || []).filter((t) => t && t.document && t.document.disposition === 1 && t !== caster);
  if (pcs.length) return (pcs.reduce((s, t) => s + t.center.x, 0) / pcs.length) >= K.x ? 1 : -1;
  return K.dir || 1;
})();
// mockup lean(a, k * a.baseFlip) on the enemy side (baseFlip -1, facing right) -> degrees here, mirrored by DIR
const L = (k) => -k * DIR;
const hueF = (h) => 'sepia(1) saturate(5) hue-rotate(' + (h - 38) + 'deg) brightness(1.35)';
const glowF = (rgb, px) => 'drop-shadow(0 0 {' + px + '}px rgba(' + rgb + ',.95)) drop-shadow(0 0 {2}px rgba(' + rgb + ',.9))';

// ── the caster's art (idle only: the pose system keeps the idle art's pixel size) ──
const natW = (im) => (im && (im.videoWidth || im.naturalWidth || im.width)) || 0;
const natH = (im) => (im && (im.videoHeight || im.naturalHeight || im.height)) || 0;
const ART0 = tl.art('k');
const P0 = { key: 'idle', img: ART0, w: K.w, h: K.h, foot: K.foot };
// depth: a body that crosses the floor is drawn at the size of where it stands (mockup a.s = tokenScaleAt(y))
const DCACHE = new Map();
const depthAt = (x, y) => { const key = Math.round(x) + '|' + Math.round(y); let d = DCACHE.get(key); if (d == null) { d = tl.depthRatio(kf, { x, y }); DCACHE.set(key, d); } return d; };
const dT = (k) => { const f = ftOf(k); return depthAt(f.x, f.y); };
// mockup front(t, gap): the attacker's side of a target, at its feet row
const frontOf = (k, gap) => { const f = ftOf(k); return { x: f.x - DIR * gap * KP * dT(k), y: f.y }; };

// ── body motion: moveActor / dashTo / goHome segments (eased position + hop), tween tracks for lean / squash ──
const MV = [];
const moveTo = (at, ms, pt, ease, hop) => { const pv = MV[MV.length - 1]; MV.push({ at, ms, x0: pv ? pv.x : kf.x, y0: pv ? pv.y : kf.y, x: pt.x, y: pt.y, ease: ease || X.quad, hop: hop || 0 }); return at + ms; };
function moveState(t) { let x = kf.x, y = kf.y, air = 0;
  for (const mv of MV) { if (t < mv.at) break; const u = mv.ease(clamp01((t - mv.at) / mv.ms)); x = lerp(mv.x0, mv.x, u); y = lerp(mv.y0, mv.y, u); air = t < mv.at + mv.ms ? Math.sin(u * Math.PI) * mv.hop * KP : 0; }
  return { x, y, air }; }
// a value track built from tweens: segs = [t0, ms, to, ease]; a later tween takes over from where the value is
function tw(init, segs) {
  const S = segs.slice().sort((a, b) => a[0] - b[0]); const starts = [];
  const valAt = (i, t) => { if (i < 0) return init; const sg = S[i]; if (t < sg[0]) return valAt(i - 1, t); const u = sg[1] > 0 ? clamp01((t - sg[0]) / sg[1]) : 1; return lerp(starts[i], sg[2], (sg[3] || X.lin)(u)); };
  for (let i = 0; i < S.length; i++) starts.push(i === 0 ? init : valAt(i - 1, S[i][0]));
  return (t) => { let i = S.length - 1; while (i >= 0 && t < S[i][0]) i--; return valAt(i, t); };
}
const steps = (init, list) => (t) => { let v = init; for (const sp of list) if (t >= sp[0]) v = sp[1]; return v; };
// the shot fills these, then calls finishBody()
const ROT = [], SX = [], SY = [], FILT = [];
let JIT = null;   // extra x offset (Zombie Bite's head shake)
const st0 = () => ({ x: kf.x, y: kf.y, air: 0, sx: 1, sy: 1, rot: 0, alpha: 1, hidden: false, filter: '', d: 1 });
let BODY = null;
function finishBody() {
  const rotT = tw(0, ROT), sxT = tw(1, SX), syT = tw(1, SY), fT = steps('', FILT.slice().sort((a, b) => a[0] - b[0]));
  BODY = (t) => { const p = moveState(t); return { x: p.x + (JIT ? JIT(t) : 0), y: p.y, air: p.air, rot: rotT(t), sx: sxT(t), sy: syT(t), filter: fT(t) }; };
}
function bodyAt(t) { const s = Object.assign(st0(), BODY ? BODY(t) : {}); s.d = (s.x !== kf.x || s.y !== kf.y) ? depthAt(s.x, s.y) : 1; return s; }
// the caster's art box at t (mockup OX / OY / hgt / wid; the hop bob is not part of it, as in the mockup)
const cbox = (t) => { const s = bodyAt(t); const h = K.h * s.d, w = K.w * s.d; return { x: s.x, bot: s.y + h * (1 - K.foot), h, w }; };
const tbox = (k) => ({ x: TOK[k].x, bot: OYt(k), h: TOK[k].h, w: TOK[k].w });
const headOf = (b) => ({ x: b.x + DIR * b.w * 0.12, y: b.bot - b.h * 0.82 });     // mockup headAt()

// ── painting the caster (afterimages behind it) ──
const AFTER = [];
const HAS_SH = (() => { try { const f1 = caster.document.flags && caster.document.flags['fabula-ultima-companion']; const f2 = caster.actor && caster.actor.flags && caster.actor.flags['fabula-ultima-companion']; return !!((f1 && f1.spriteShadow) || (f2 && f2.spriteShadow)); } catch (e) { return false; } })();
const BAKE = new Map();
function baked(filter) {
  if (!filter) return P0.img; let c = BAKE.get(filter); if (c) return c;
  const w = natW(P0.img), h = natH(P0.img); if (!w || !h) return P0.img;
  c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.filter = filter; x.drawImage(P0.img, 0, 0, w, h); BAKE.set(filter, c); return c;
}
const fpx = (g, n) => { let a = 1; try { a = g.getTransform().a; } catch (e) {} return Math.max(0, n * KP * a); };
function paint(g, s, img, a, filter) {
  if (!P0.img) return; g.save(); g.translate(s.x, s.y - s.air); if (s.rot) g.rotate(s.rot * Math.PI / 180);
  g.scale(K.flip * s.sx * s.d, s.sy * s.d); g.globalAlpha = a; if (filter) g.filter = filter;
  g.drawImage(img || P0.img, -P0.w / 2, -P0.h * P0.foot, P0.w, P0.h); g.restore();
}
function bodyTrack(total) {
  m.hold(0, total, (t, S) => {
    if (!BODY) return; const s = bodyAt(t); const q = S.tok.k;
    q.pose = 'blank'; q.dx = s.x - kf.x; q.dy = s.y - kf.y; q.air = s.air; if (Math.abs(q.dy) > 0.5) q.noShadow = true;
    if (HAS_SH && Math.abs(s.y - kf.y) > 0.5) S.world.push({ z: 2, draw: (g) => { const lk = Math.min(1, s.air / K.h); g.save(); g.globalAlpha = 0.32 * (1 - 0.45 * lk); g.fillStyle = '#000'; g.beginPath(); g.ellipse(s.x, s.y, K.w * 0.3 * s.d * (1 - 0.35 * lk), K.w * 0.09 * s.d * (1 - 0.35 * lk), 0, 0, 6.2832); g.fill(); g.restore(); } });
    S.world.push({ z: 20, draw: (g) => {
      for (const a of AFTER) { const age = t - a.t0; if (age < 0 || age >= a.ms) continue; const s2 = a.s || (a.s = bodyAt(a.t0)); paint(g, s2, baked(a.filter), a.op * (1 - X.sine(age / a.ms))); }
      paint(g, s, null, 1, s.filter ? s.filter.replace(/\{(\d+(\.\d+)?)\}/g, (mm, n) => fpx(g, Number(n)).toFixed(2) + 'px') : '');
    } });
  });
}
const BLANK = document.createElement('canvas'); BLANK.width = 2; BLANK.height = 2;
(tl.POSE.k = tl.POSE.k || {}).blank = { img: BLANK, foot: 1, w: 0.01, h: 0.01 };
// mockup trailWhile(a, move, every, { hue, opacity }): an afterimage every 'every' ms while the move runs (380 ms fade)
const afterimages = (t0, t1, every, op, hue) => { for (let t = t0; t < t1; t += every) AFTER.push({ t0: t, ms: 380, op, filter: hueF(hue) }); };

// ── particles (world space; 'ground'/'field' sit under the real tokens, 'hit' above everything) ──
const PS = [];
const LAYER_Z = { ground: 2, field: 4, hit: 30 };
const part = (p) => { p.z = LAYER_Z[p.layer || 'hit']; PS.push(p); return p; };
function posOf(p, age) {
  let dx, dy; const vx = p.vx || 0, vy = p.vy || 0;
  if (p.drag && p.drag < 1) { const Lg = Math.log(p.drag) / 16; const f = (Math.exp(Lg * age) - 1) / Lg; dx = vx * f; dy = vy * f; } else { dx = vx * age; dy = vy * age; }
  dy += 0.5 * (p.g || 0) * age * age; return { x: p.x + dx * KP, y: p.y + dy * KP };
}
function particleTrack(total) {
  m.hold(0, total, (t, S) => {
    for (const z of [2, 4, 30]) { let any = false; for (const p of PS) if (p.z === z && t >= p.t0 && t < p.t0 + p.life) { any = true; break; } if (!any) continue;
      S.world.push({ z, draw: (g) => { for (const p of PS) { if (p.z !== z) continue; const age = t - p.t0; if (age < 0 || age >= p.life) continue; const pt = posOf(p, age); g.save(); g.globalCompositeOperation = p.comp || 'lighter'; p.draw(g, pt.x, pt.y, age / p.life, age, p); g.restore(); } } }); }
  });
}
const glw = (g, x, y, r, rgb, a) => { if (!(r > 0) || !(a > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
// mockup dustBurst()
const dustBurst = (at, pt, o) => { o = o || {}; const n = o.n || 14, s = o.s || 1, rgb = o.rgb || '190,170,140';
  for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2), r = rnd(8, 18) * s; part({ t0: at, life: rnd(500, 900), x: pt.x + rnd(-10, 10) * s * KP, y: pt.y, vx: Math.cos(an) * rnd(0.08, 0.25) * s, vy: Math.sin(an) * rnd(0.02, 0.1) * s, drag: 0.97, layer: 'field', comp: 'source-over',
    draw: (g, x, y, u) => { g.fillStyle = 'rgba(' + rgb + ',' + (0.45 * (1 - u)) + ')'; g.beginPath(); g.arc(x, y, r * (1 + u) * KP, 0, 6.2832); g.fill(); } }); } };
// mockup twinkles()
const twinkles = (at, pt, o) => { o = o || {}; const n = o.n || 10, r = o.r == null ? 80 : o.r, rgb = o.rgb || '160,230,255';
  for (let i = 0; i < n; i++) { const sz = rnd(5, 11); part({ t0: at, life: rnd(500, 900), x: pt.x + rnd(-r, r) * KP, y: pt.y + rnd(-r, r) * 0.8 * KP, layer: 'hit',
    draw: (g, x, y, u) => { const k = Math.sin(u * Math.PI) * sz * KP; glw(g, x, y, k * 2.5, rgb, 0.7); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x, y - k * 1.6); g.lineTo(x + k * 0.3, y); g.lineTo(x, y + k * 1.6); g.lineTo(x - k * 0.3, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - k * 1.6, y); g.lineTo(x, y + k * 0.3); g.lineTo(x + k * 1.6, y); g.lineTo(x, y - k * 0.3); g.closePath(); g.fill(); } }); } };
// mockup drip(a, rgb, n, { ms }): drops off a body (boxAt(t) = its art box when each drop spawns)
const drip = (at, boxAt, rgb, n, ms) => { for (let i = 0; i < n; i++) { const t0 = at + i * ms / n, b = boxAt(t0), r = rnd(1.6, 3.2);
  part({ t0, life: rnd(500, 800), x: b.x + rnd(-b.w * 0.3, b.w * 0.3), y: b.bot - b.h * rnd(0.3, 0.7), vy: 0.02, g: 0.0012, layer: 'field', comp: 'source-over',
    draw: (g, x, y, u) => { g.fillStyle = 'rgba(' + rgb + ',' + (1 - u * 0.7) + ')'; g.beginPath(); g.ellipse(x, y, r * 0.8 * KP, r * 1.5 * KP, 0, 0, 6.2832); g.fill(); } }); } };
// mockup dust() (fumes)
const dustMote = (at, x, y, rgb, o) => { const r = o.r; part({ t0: at, life: o.life, x, y, vx: rnd(-0.02, 0.02), vy: o.vy, layer: 'field',
  draw: (g, px, py, u, age) => { const a = Math.sin(u * Math.PI) * (0.5 + 0.5 * Math.sin(age / 120 + px / KP)); g.fillStyle = 'rgba(' + rgb + ',' + a + ')'; g.beginPath(); g.arc(px, py, r * KP, 0, 6.2832); g.fill(); glw(g, px, py, r * 4 * KP, rgb, a * 0.35); } }); };
// mockup fumes(a, rgb, n)
const fumes = (at, b, rgb, n) => { for (let i = 0; i < n; i++) { const x = b.x + rnd(-b.w * 0.35, b.w * 0.35), y = b.bot - b.h * rnd(0.15, 0.75); dustMote(at, x, y, rgb, { vy: -rnd(0.03, 0.07), r: rnd(3, 7), life: rnd(900, 1500) }); } };
// mockup ember()
const ember = (at, x, y, rgb, o) => { const r = o.r; part({ t0: at, life: o.life, x, y, vx: rnd(-0.03, 0.03), vy: o.vy, layer: o.layer || 'hit',
  draw: (g, px, py, u, age) => { glw(g, px + Math.sin(age / 300) * 6 * KP, py, r * 3 * KP, rgb, Math.sin(u * Math.PI) * 0.9); } }); };
// mockup soulRise(a, { n = 26, ms = 1400, rgb })
const soulRise = (at, b, rgb, n, ms) => { n = n || 26; ms = ms || 1400; for (let i = 0; i < n; i++) { const x = b.x + rnd(-b.w * 0.35, b.w * 0.35), y = b.bot - b.h * rnd(0.05, 0.8);
  ember(at + i * ms / n, x, y, rgb, { vy: -rnd(0.04, 0.09), r: rnd(2, 4), life: rnd(900, 1500), layer: 'field' }); } };
// mockup crescent(pt, { ang, len, w, rgb, ms }): a crescent cut drawn across a point (mirrored by DIR)
const crescent = (at, pt, o) => { const ang = o.ang == null ? -0.5 : o.ang, len = (o.len || 160) * KP, w = (o.w || 26) * KP, rgb = o.rgb || '255,255,255', ms = o.ms || 260;
  part({ t0: at, life: ms, x: pt.x, y: pt.y, layer: 'hit', draw: (g, x, y, u) => {
    const k = X.outCubic(Math.min(1, u * 1.6)); g.translate(x, y); if (DIR < 0) g.scale(-1, 1); g.rotate(ang); g.globalAlpha = 1 - Math.max(0, (u - 0.45) / 0.55);
    g.fillStyle = 'rgba(' + rgb + ',.9)'; g.beginPath(); g.moveTo(-len / 2, 0); g.quadraticCurveTo(0, -w * 1.6 * k, len / 2 * k, 0); g.quadraticCurveTo(0, -w * 0.4, -len / 2, 0); g.fill();
    glw(g, 0, -w * 0.5, len * 0.45, rgb, 0.35); } }); };
// mockup jawSnap(pt, { s, rgb, glowRgb, ms }): two rows of bone fangs snap shut on a point (drawn, faithful port)
const jawSnap = (at, pt, o) => { o = o || {}; const s = (o.s || 1) * KP, rgb = o.rgb || '235,228,210', glowRgb = o.glowRgb || '255,255,255', ms = o.ms || 460;
  part({ t0: at, life: ms, x: pt.x, y: pt.y, layer: 'hit', draw: (g, x, y, t) => {
    const k = t < 0.3 ? X.inCubic(t / 0.3) : 1, gap = 46 * s * (1 - k), a = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = a; const n = 5, wd = 15 * s;
    for (const dir of [-1, 1]) { const y0 = y + dir * (gap + 4 * s); g.fillStyle = 'rgb(' + rgb + ')'; g.strokeStyle = 'rgba(40,20,20,.9)'; g.lineWidth = 2 * KP;
      g.beginPath(); g.moveTo(x - n * wd / 2 - 6 * s, y0 + dir * 7 * s); g.lineTo(x + n * wd / 2 + 6 * s, y0 + dir * 7 * s); g.lineTo(x + n * wd / 2 + 6 * s, y0); g.lineTo(x - n * wd / 2 - 6 * s, y0); g.closePath(); g.fillStyle = 'rgba(70,28,34,.9)'; g.fill();
      g.fillStyle = 'rgb(' + rgb + ')';
      for (let i = 0; i < n; i++) { const xx = x - n * wd / 2 + i * wd + wd / 2, Ln = (i === 0 || i === n - 1 ? 22 : 13) * s; g.beginPath(); g.moveTo(xx - wd * 0.42, y0); g.lineTo(xx, y0 - dir * Ln); g.lineTo(xx + wd * 0.42, y0); g.closePath(); g.fill(); g.stroke(); } }
    if (t > 0.28 && t < 0.5) { g.globalCompositeOperation = 'lighter'; glw(g, x, y, 70 * s, glowRgb, 0.8 * (1 - (t - 0.28) / 0.22)); } } }); };

// ── clips (mockup clip(key, pt, { scale })): size = source px * scale * the library factor k (MV / pixelfx .55) ──
// The mockup played plain clips in its #ffx layer, which sits ABOVE the battlers (#factors) in the page: z 26 = over the battlers.
// pixelfx (mockup pxClip): back under the battlers, front over, light
// over with additive blend (the mockup used screen). o.under = the whole pixelfx stack under the battlers.
const clipW = (key, scale) => (CL[key] ? CL[key].w * scale * CL[key].k * KP : 0);
const fx = (key, at, pt, scale, o) => { if (!CL[key]) return null; return m.clip(key, at, Object.assign({ x: pt.x, y: pt.y, w: clipW(key, scale), z: 26 }, o || {})); };
const pxfx = (name, at, pt, scale, o) => { o = o || {}; const z = o.under ? [3, 4.6, 4.7] : [3, 26, 27];
  const base = { flip: !!o.flip, loop: !!o.loop }; if (o.hold != null) base.hold = o.hold; if (o.alpha) base.alpha = o.alpha;
  fx(name + '_back', at, pt, scale, Object.assign({ z: z[0] }, base));
  fx(name + '_front', at, pt, scale, Object.assign({ z: z[1] }, base));
  fx(name + '_light', at, pt, scale, Object.assign({ z: z[2], add: true }, base)); };

// ── screen ──
const dimLevel = (fn, total) => m.hold(0, total, (t, S) => { const v = fn(t); if (v > 0.001) S.dim = Math.max(S.dim, v); });
const shake = (at, px, ms) => m.shake(at, ms, px * KP);

// ── game state for the mockup's what-if toggles: does a token carry a status (by name / status id)? ──
const hasStatus = (tok, slugs) => {
  try { const a = tok && tok.actor; if (!a) return false; const list = a.appliedEffects || Array.from(a.effects || []);
    for (const e of list) { if (!e || e.disabled) continue; const names = [String(e.name || '')]; if (e.statuses) for (const sid of e.statuses) names.push(String(sid));
      for (const nm of names) { const sl = nm.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim(); if (slugs.indexOf(sl) >= 0) return true; } }
  } catch (e) {}
  return false;
};

// run the shot: damage gate at 'gate', the start hook on the first frame
async function runShot(total, gate) {
  bodyTrack(total); particleTrack(total);
  if (gate != null) once(gate, () => oni.fireDone());
  await tl.run(T, { total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
  oni.fireDone();
}
