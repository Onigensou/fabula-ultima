// Geist (legacy boss) · shared kit for every Geist shot (inner script, prepended to each move file).
// Port of the approved legacy-boss mockup (session 9c564c42 lb/, part-b4 + overrides r3b/r6/r7).
// LIVE board: oni.timeline({ live: true }), the camera is never touched (the 3D stage keeps its
// parallax), only the bodies a beat moves or flashes are painted; a body that crosses the floor is
// depth-scaled by the engine (dx/dy -> depthRatio). Mockup px are on the 1682 px Training Ground
// stage and are scaled by KP = stage width / 1682; numbers ported from the shipped July scripts are
// scene px and stay raw. Storage rule: no backticks and no dollar-brace anywhere in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
if (!caster) { oni.fireDone(); return; }
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
if (cfg.needsTarget && !FOES.length) { oni.fireDone(); return; }
const CL = A.clips || {};
// LIVE board for every move; cfg.live === false = the full-takeover timeline (camera driven through S.cam),
// used by the Shadowbringers cinematic only
const tl = oni.timeline({ tokens, clips: CL, live: cfg.live !== false, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet, glowC = tl.draw.glowCircle;
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 4417);
const rnd = (a, b) => a + (b - a) * R();
const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(R() * arr.length))];
const T = [], SFX = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (!did) { did = true; try { fn(); } catch (e) { console.warn('[geist] cue threw', e); } } } }); };
const S_ = (at, key, v) => { const url = (A.sfx || {})[key]; if (url) SFX.push({ at: Math.round(at), url, v: v * (cfg.volume == null ? 1 : cfg.volume) }); };
const K = TOK.k, kf = feet(K);
const sceneW = (canvas.scene && canvas.scene.width) || (canvas.dimensions && canvas.dimensions.sceneWidth) || 0;
const DIR = FOES.length ? (TOK[FOES[0]].x >= K.x ? 1 : -1) : (sceneW / 2 >= caster.center.x ? 1 : -1);
const DARK = '180,110,255', PINK = '235,120,230';
// mockup body box: height = token art height, width = half of it (hb 160 / wb 80)
const center = (k) => { const Tk = TOK[k], f = feet(Tk); return { x: f.x, y: f.y - Tk.h * 0.5 }; };
const head = (k) => { const Tk = TOK[k], f = feet(Tk); return { x: f.x, y: f.y - Tk.h * 0.92 }; };
const bw = (k) => TOK[k].h * 0.5;
const dS = (from, to) => tl.depthRatio(from, to);
// a point just in front of a target, on Geist's side (asura's standoff: no overlap)
const frontOf = (k) => { const tf = feet(TOK[k]); return { x: tf.x - DIR * (TOK[k].w * 0.45 + K.w * 0.5), y: tf.y + 4 * KP }; };

// ── Geist's body: a move sets KMOVE(t) -> { x, y (drawn feet), rot (deg, + = toward DIR) } or null (at rest) ──
let KMOVE = null;
m.hold(0, 600000, (t, S) => { if (!KMOVE) return; const p = KMOVE(t); if (!p) return; const d = S.tok.k;
  d.dx = p.x - kf.x; d.dy = p.y - kf.y; if (p.rot) d.rot = p.rot * Math.PI / 180 * DIR; });
// a keyframed path: segs = [{ t0, t1, from:{x,y}, to:{x,y}, ease, rot0, rot1 }] in time order; null outside
const pathOf = (segs) => (t) => { let last = null; for (const s of segs) { if (t < s.t0) break; last = s; if (t <= s.t1) { const u = (s.ease || E.lin)(seg(t, s.t0, s.t1)); const a = s.from || s.to, b = s.to || s.from;
    return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), rot: lerp(s.rot0 || 0, s.rot1 == null ? (s.rot0 || 0) : s.rot1, u) }; } }
  if (!last || last.end) return null; const b = last.to || last.from; return { x: b.x, y: b.y, rot: last.rot1 == null ? (last.rot0 || 0) : last.rot1 }; };

// ── art copies of a body (afterimages, shimmer, shades) ──
function drawArt(g, k, x, y, o) {
  const art = tl.art(k); if (!art) return; const Tk = TOK[k]; const s = o.s || 1;
  g.save(); g.translate(x, y); if (o.rot) g.rotate(o.rot * Math.PI / 180 * DIR); g.scale(Tk.flip * s, s); g.globalAlpha = o.a;
  if (o.filter) g.filter = o.filter; if (o.comp) g.globalCompositeOperation = o.comp;
  g.drawImage(art, -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h); g.restore();
}
const hueF = (hue) => 'sepia(1) saturate(5) hue-rotate(' + (hue - 38) + 'deg) brightness(1.35)';
const GH = [];
// one afterimage of Geist where KMOVE puts him at time at (mockup afterimage: opacity .5, 380 ms, hue tint)
const ghost = (at, o) => { o = o || {}; const p = (KMOVE && KMOVE(at)) || { x: kf.x, y: kf.y, rot: 0 }; GH.push({ t0: at, ms: o.ms || 380, op: o.op == null ? 0.5 : o.op, x: p.x, y: p.y, rot: p.rot || 0, filter: o.filter || hueF(o.hue == null ? 280 : o.hue), comp: o.comp || null, z: o.z == null ? 3 : o.z }); };
const trail = (t0, ms, step, o) => { for (let f = step; f <= 1.0001; f += step) ghost(t0 + ms * f, o); };
const ghostLayer = (z) => m.hold(0, 600000, (t, S) => { const live = GH.filter((q) => q.z === z && t >= q.t0 && t <= q.t0 + q.ms); if (!live.length) return;
  S.world.push({ z, draw: (g) => { for (const q of live) { const u = (t - q.t0) / q.ms; drawArt(g, 'k', q.x, q.y, { a: q.op * (1 - u), rot: q.rot, filter: q.filter, comp: q.comp, s: dS(kf, q) }); } } }); });
ghostLayer(3); ghostLayer(31);

// ── flinch (battler-pose FULL_FLINCH, as the mockup's hitReact) + the hurt loop, painted on the live board ──
const FLINCH = {
  normal: { ms: 300, move: [[0, 1, 1, 0], [0.12, 1.12, 0.88, 0], [0.30, 0.97, 1.03, -7], [0.50, 1, 1, 6], [0.70, 1, 1, -4], [0.85, 1, 1, 3], [1, 1, 1, 0]], bright: [[0, 3.6], [0.35, 1], [1, 1]] },
  strong: { ms: 480, move: [[0, 1, 1, 0], [0.10, 1.22, 0.80, 0], [0.26, 0.90, 1.10, -13], [0.44, 1, 1, 11], [0.62, 1, 1, -7], [0.80, 1, 1, 5], [1, 1, 1, 0]], bright: [[0, 4], [0.20, 1], [0.40, 3.2], [0.60, 1], [1, 1]] },
};
const stopAt = (st, u, col) => { for (let i = 1; i < st.length; i++) if (u <= st[i][0]) { const a = st[i - 1], b = st[i]; const v = (u - a[0]) / Math.max(1e-6, b[0] - a[0]); return lerp(a[col], b[col], 1 - (1 - v) * (1 - v)); } return st[st.length - 1][col]; };
// away = recoil direction (+1 = along DIR); jitter = the shipped scripts' target clone shake (px, decays)
const hurtOn = (k, at, tier, o) => { o = o || {}; const sp = FLINCH[tier] || FLINCH.normal; const hold = Math.max(o.hold || 600, sp.ms); const away = o.away == null ? 1 : o.away;
  m.hold(at, at + hold, (e, S) => { const q = S.tok[k]; if (!q) return; if (o.pose !== false) q.hurt = true;
    if (e < sp.ms) { const u = e / sp.ms; q.sx *= stopAt(sp.move, u, 1); q.sy *= stopAt(sp.move, u, 2); q.dx += -stopAt(sp.move, u, 3) * away * DIR * KP;
      const b = stopAt(sp.bright, u, 1); if (b > 1.05) { const a = Math.min(1, (b - 1) / 3); if (a > q.tintA) { q.tint = '#ffffff'; q.tintA = a; } } }
    if (o.jitter && e < o.jitterMs) { const amp = o.jitter * (1 - e / o.jitterMs); q.dx += rnd(-amp, amp); q.dy += rnd(-amp, amp); } }); };
// the mockup's flashActor: a coloured glow that fades (painted copy, so the real token is untouched after)
const flashK = (at, color, ms, k) => { k = k || 'k'; m.tint(at, ms, k, color, (u) => 0.8 * (1 - u)); m.hold(at, at + ms, (e, S) => { const q = S.tok[k]; if (q) q.glow = Math.max(q.glow, 1 - e / ms); }); };

// ── particles (canvas 2D, world space). kinds: free | home | burst | swirl | ember | shard | star ──
const PT = [];
const partLayer = (z, comp) => m.hold(0, 600000, (t, S) => { let any = false; for (const p of PT) if ((p.z || 30) === z && t >= p.t0 && t <= p.t0 + p.life) { any = true; break; } if (!any) return;
  S.world.push({ z, draw: (g) => { g.save(); g.globalCompositeOperation = comp;
    for (const p of PT) { if ((p.z || 30) !== z) continue; const age = t - p.t0; if (age < 0 || age > p.life) continue; const u = age / p.life; drawP(g, p, u, age); }
    g.restore(); } }); });
const bez = (a, c, b, e) => ({ x: (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * c.x + e * e * b.x, y: (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * c.y + e * e * b.y });
function drawP(g, p, u, age) {
  const col = (a) => 'rgba(' + p.rgb + ',' + a + ')';
  if (p.kind === 'home') { const e = E.inQ(u), e0 = E.inQ(Math.max(0, u - 0.06)); const q = bez(p.from, p.ctl, p.to, e), q0 = bez(p.from, p.ctl, p.to, e0);
    glowC(g, q.x, q.y, p.r * 3.5 * KP, col(1), 0.95); g.strokeStyle = col(0.5); g.lineWidth = p.r * KP; g.beginPath(); g.moveTo(q0.x, q0.y); g.lineTo(q.x, q.y); g.stroke(); return; }
  if (p.kind === 'burst') { const v = E.outC(u); glowC(g, p.x + Math.cos(p.an) * p.dd * v, p.y + Math.sin(p.an) * p.dd * v, p.r, col(1), 0.95 * (1 - v)); return; }
  if (p.kind === 'swirl') { const a = p.a0 + u * 7; glowC(g, p.x + Math.cos(a) * p.R0 * (1 - u), p.y - (30 + u * 30) * KP + Math.sin(a) * p.R0 * 0.4 * (1 - u), 7 * KP, col(1), 1 - u); return; }
  if (p.kind === 'ember') { const x = p.x + p.vx * age * KP + Math.sin(age / 300) * 6 * KP, y = p.y + p.vy * age * KP; glowC(g, x, y, p.r * 3 * KP, col(1), Math.sin(u * Math.PI) * 0.9); return; }
  if (p.kind === 'shard') { const x = p.x + p.vx * age * KP, y = p.y + (p.vy * age + 0.5 * 0.0012 * age * age) * KP; const s = p.s * KP;
    g.save(); g.translate(x, y); g.rotate(p.rot + p.vr * age); g.globalAlpha = 1 - u; g.fillStyle = col(1); g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.6, 0); g.lineTo(0, s * 0.9); g.lineTo(-s * 0.5, 0); g.fill(); g.restore(); return; }
  if (p.kind === 'star') { const k = Math.sin(u * Math.PI) * p.s * KP; glowC(g, p.x, p.y, k * 2.5, col(1), 0.7); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(p.x, p.y - k * 1.6); g.lineTo(p.x + k * 0.3, p.y); g.lineTo(p.x, p.y + k * 1.6); g.lineTo(p.x - k * 0.3, p.y); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(p.x - k * 1.6, p.y); g.lineTo(p.x, p.y + k * 0.3); g.lineTo(p.x + k * 1.6, p.y); g.lineTo(p.x, p.y - k * 0.3); g.closePath(); g.fill(); return; }
  if (p.kind === 'ring') { const r = lerp(p.r0, p.r1, E.outC(u)); g.strokeStyle = col(1 - u); g.lineWidth = p.w * (1 - u * 0.6); g.beginPath(); g.ellipse(p.x, p.y, r, r * p.sy, 0, 0, Math.PI * 2); g.stroke(); return; }
  if (p.kind === 'slash') { const k = E.outC(Math.min(1, u * 1.6)); g.save(); g.translate(p.x, p.y); g.scale(DIR, 1); g.rotate(p.ang); g.globalAlpha = 1 - Math.max(0, (u - 0.45) / 0.55);
    const L = p.len, w = p.w; g.fillStyle = col(0.9); g.beginPath(); g.moveTo(-L / 2, 0); g.quadraticCurveTo(0, -w * 1.6 * k, L / 2 * k, 0); g.quadraticCurveTo(0, -w * 0.4, -L / 2, 0); g.fill();
    glowC(g, 0, -w * 0.5, L * 0.45, col(1), 0.35); g.restore(); return; }
  if (p.kind === 'disc') { const r = p.size * 0.5 * E.outC(u); glowC(g, p.x, p.y, r, col(1), 1 - u); return; }
  // free: velocity px/ms (mockup units) + gravity, linear fade
  const x = p.x + p.vx * age * KP, y = p.y + (p.vy * age + 0.5 * (p.g || 0) * age * age) * KP; glowC(g, x, y, p.r * 3 * KP, col(1), (1 - u) * (p.a == null ? 0.9 : p.a));
}
partLayer(2, 'source-over'); partLayer(30, 'lighter');
// the mockup kit, in absolute time
const homing = (at, from, to, rgb, o) => { o = o || {}; const arc = (o.arc == null ? 120 : o.arc) * KP; const ctl = { x: (from.x + to.x) / 2 + rnd(-arc, arc), y: Math.min(from.y, to.y) - rnd(arc * 0.3, arc) };
  const life = (o.ms || 900) * rnd(0.85, 1.15); PT.push({ kind: 'home', t0: at, life, from, to, ctl, rgb, r: o.r || 4 }); return at + life; };
const windWisps = (at, to, o) => { for (let i = 0; i < o.n; i++) { const a = rnd(0, Math.PI * 2); homing(at, { x: to.x + Math.cos(a) * o.r * KP, y: to.y + Math.sin(a) * o.r * 0.6 * KP }, to, o.rgb, { ms: o.ms, arc: 60, r: 2 }); } };
const shards = (at, pt, rgb, n, spread) => { for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), sp = rnd(0.15, spread) * 0.75; PT.push({ kind: 'shard', t0: at, life: rnd(600, 1000), x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 0.15, rot: rnd(0, 6), vr: rnd(-0.02, 0.02) / 16, s: rnd(5, 11), rgb }); } };
const ember = (at, x, y, rgb, o) => { o = o || {}; PT.push({ kind: 'ember', t0: at, life: o.life || rnd(1400, 2600), x, y, vx: o.vx == null ? rnd(-0.03, 0.03) : o.vx, vy: o.vy == null ? rnd(-0.12, -0.05) : o.vy, r: o.r || rnd(2, 5), rgb }); };
const twinkles = (at, pt, o) => { for (let i = 0; i < o.n; i++) PT.push({ kind: 'star', t0: at, life: rnd(500, 900), x: pt.x + rnd(-o.r, o.r) * KP, y: pt.y + rnd(-o.r, o.r) * 0.8 * KP, s: rnd(5, 11), rgb: o.rgb }); };
const ring = (at, pt, o) => { PT.push({ kind: 'ring', z: 2, t0: at, life: o.ms || 600, x: pt.x, y: pt.y, r0: (o.r0 == null ? 10 : o.r0) * KP * (o.s || 1), r1: (o.r1 || 160) * KP * (o.s || 1), sy: o.sy || 0.3, w: (o.w || 6) * KP * (o.s || 1), rgb: o.rgb || '255,255,255' }); };
// shipped particle burst (14-22 additive motes thrown out of the impact point)
const burst = (at, pt, n, spread, ms, rgb) => { for (let i = 0; i < n; i++) PT.push({ kind: 'burst', t0: at, life: ms, x: pt.x, y: pt.y, an: rnd(0, Math.PI * 2), dd: spread * (0.4 + R() * 0.6), r: (10 + R() * 22) / 2, rgb }); };

// ── clips ──
// Additive pixelfx _light layers are alpha-less (glow on black). Canvas 'lighter' onto the transparent overlay
// adds alpha too, so the black would turn into an opaque box: an SVG luminance-to-alpha filter makes black
// transparent before the add (staging 2026-11-16: Torcleaver / Temper Tantrum black boxes).
const LUMA_FILTER = (() => { const id = 'oni-luma-alpha'; try { if (!document.getElementById(id)) { const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute'; svg.style.pointerEvents = 'none'; const f = document.createElementNS(ns, 'filter'); f.setAttribute('id', id); f.setAttribute('color-interpolation-filters', 'sRGB'); const cm = document.createElementNS(ns, 'feColorMatrix'); cm.setAttribute('type', 'matrix'); cm.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1 1 1 0 0'); f.appendChild(cm); svg.appendChild(f); document.body.appendChild(svg); } } catch (e) {} return 'url(#' + id + ')'; })();
const fx = (key, at, pt, w, o) => { if (!CL[key]) return null; return m.clip(key, at, Object.assign({ x: pt.x, y: pt.y, w, z: 40 }, o || {})); };
// a pixelfx export: back under the battlers, front over them, light added over the front (canvas 'lighter', never a screen-blended video)
const pxfx = (base, at, pt, w, o) => { o = o || {}; const z = o.z || 40;
  fx(base + '_back', at, pt, w, Object.assign({}, o, { z: 2 })); fx(base + '_front', at, pt, w, Object.assign({}, o, { z })); fx(base + '_light', at, pt, w, Object.assign({}, o, { z: z + 1, add: true, filter: LUMA_FILTER })); };
const buffBeat = (at) => { const c = CL.powerup; if (c) fx('powerup', at, kf, c.w * 0.55 * KP, { z: 38 }); S_(at, 'powerup', 0.47); };

// ── run: the damage gate fires at gateAt (and again, harmlessly, when the shot ends) ──
async function go(total, gateAt) {
  if (gateAt != null) once(gateAt, () => oni.fireDone());
  await tl.run(T, { total, sfx: SFX, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
  oni.fireDone();
}
