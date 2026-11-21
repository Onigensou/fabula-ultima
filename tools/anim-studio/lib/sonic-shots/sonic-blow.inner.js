// ── Sonic Blow (Sonic Katar, 2026-11-21): port of the approved mockup move "sonicblow" (v2) ──
// Source: E:\Art(New Com)\DND\Fabula Ultima\Resource\Animation\Sonic Katar\src\part-sonic.js; every number below is
// read from the measured mockup timeline spec/sonic-blow-mockup-timeline.json (run "sonicblow-8of8", times relative
// to the start of the mockup's "Dash in" beat; the mockup's "Namecard + MP" beat is the game's own action card).
// Prepended kit: nox-shots/ghoul-hound-kit.inner.js (live board, painted caster, particles, clips, sounds).
// The REAL per-strike results drive it: oni.strikes (the chain plan) → hit / miss / crit per strike, and the plan's
// Perfect strike (strike 9) plays the Perfect beat. Each strike calls oni.hit() → the game's number / MISS / flinch /
// HP bar for that strike. No backticks, no dollar-brace (storage rule).
const C = {
  // beat starts (ms from the dash), spec beats[1..4] minus the dash start 1277.8
  DASH_MS: 430, DASH_GAP: 92, DASH_HOP: 8, DASH_SFX_VOL: 0.45, DASH_AFTER_EVERY: 55, DASH_AFTER_OP: 0.35, DASH_AFTER_MS: 260,
  SPEEDLINE_ALPHA: 0.25, SPEEDLINE_N: 16, DUST_N: 8, DUST_S: 0.8,
  STRIKE_BEAT: 592.1,                  // 1869.9 - 1277.8
  RO_VOL: 0.6, RO_FX_SCALE: 1.10, RO_RATE: 0.725,          // spec clip ro_sonicblow (1.10·t.s at the feet, rate .725)
  STRIKE_AT: [64.3, 184.0, 303.5, 423.7, 541.3, 659.0, 780.1, 898.3],   // spec sbStrike times from the strike beat
  SB_ANG: [-30, 150, 20, -160, 60, -110, 100, -60, 10, 170], ANG_NOISE: 8,
  LEAN_EVEN: 14, LEAN_ODD: -12, LEAN_MS: 50, STEP_EVEN: 8, STEP_ODD: -6, STEP_MS: 60,
  KATAR_VOL: 0.35, HIT_VOL: 0.4,
  SLASH_HIT: { L: 0.62, w: 18, rgb: '255,120,190', ms: 220 }, SLASH_MISS: { L: 0.45, w: 12, rgb: '200,215,235', ms: 180 }, SLASH_CORE: 0.32,
  HIT_FX_SCALE: 0.55, HIT_FX_RATE: 1.3, SPARKS_HIT: 6, SPARKS_CRIT: 14,
  CRIT_FLASH: { peak: 0.25, inMs: 20, outMs: 90 }, CRIT_RAYS: { n: 12, r0: 18, r1: 200, ms: 200 },
  SHAKE_HIT: 3, SHAKE_CRIT: 6, SHAKE_MS: 90, MISS_SWAY: [10, 18], MISS_SWAY_MS: 70, MISS_BACK_MS: 160,
  JIT_X: 18, JIT_UP: -26, JIT_DN: 18,
  PERFECT_BEAT: 1180.7,                // 3050.6 - 1869.9 (from the strike beat)
  PF_DIM: 0.45, PF_DIM_MS: 260, PF_DIM_RGB: '18,6,8', PF_CRIT_VOL: 0.5, PF_HIT_VOL: 0.55,
  PF_WHITE: 0.6, PF_WHITE_IN: 70, PF_WHITE_OUT: 160, PF_FX_AT: 76.2, PF_FX_SCALE: 1.485, PF_FX_RATE: 1.4,
  PF_FX_FILTER: 'sepia(.6) saturate(2.2) hue-rotate(-18deg) brightness(1.25)',
  PF_HIT_AT: 243.9, PF_RAYS: { n: 30, r0: 30, r1: 520, ms: 380, rgb: '255,236,200' }, PF_SPARKS: 26, PF_SHAKE: 11, PF_SHAKE_MS: 340,
  PF_UNDIM_AT: 946.7, PF_UNDIM_MS: 400, PF_BEAT_END: 946.8, NO_PF_BEAT: 100,
  HOME_MS: 520, HOME_HOP: 14, HOME_TAIL: 450,       // backHome quiet: NO jump sound (approved v2)
  GOLD: '255,214,120', PINK: '255,120,190',
};
// timeline trace for the mockup diff (tools/snapshot-runner/checks: globalThis.__SB_TRACE = [] before the action)
const T0W = { v: null };
const TR = (at, ev) => once(at, () => { try { const a = globalThis.__SB_TRACE; if (!Array.isArray(a)) return; const now = performance.now(); if (T0W.v == null) T0W.v = now - at; a.push(Object.assign({ atMs: Math.round((now - T0W.v) * 10) / 10, plannedMs: at }, ev)); } catch (e) {} });
const SFX = (at, key, v) => { S_(at, key, v); TR(at, { type: 'sfx', key, vol: v }); };
const FX = (key, at, pt, scale, o) => { TR(at, { type: 'clip', key, scale, rate: (o && o.rate) || 1, filter: (o && o.filter) || '' }); return fx(key, at, pt, scale, o); };
TR(0, { type: 'beat', name: 'Dash in' });
const tk = FOES[0];
if (!tk) { oni.fireDone(); return; }
const ST = Array.isArray(oni.strikes) ? oni.strikes : [];
const outOf = (s) => (s && s.outcomes ? s.outcomes.find((o) => o && o.tokenUuid === TOK[tk].token.document.uuid) || s.outcomes[0] : null) || null;
const plain = ST.filter((s) => !s.perfect);
const perfect = ST.find((s) => s.perfect) || null;
const N = Math.max(1, plain.length || 8);
const sT = dT(tk);                                           // the mockup's t.s (target depth, caster = 1)
const hgt = TOK[tk].h;
const cen = center(tk);
const feetT = floorOf(tk);

// ── Dash in ──
const D0 = 0;
SFX(D0, 'dash', C.DASH_SFX_VOL);
dustBurst(D0, floorOf('k'), { n: C.DUST_N, s: C.DUST_S });
const fpt = frontOf(tk, C.DASH_GAP);
moveTo(D0, C.DASH_MS, fpt, X.quad, C.DASH_HOP);
for (let t = D0; t < D0 + C.DASH_MS; t += C.DASH_AFTER_EVERY) AFTER.push({ t0: t, ms: C.DASH_AFTER_MS, op: C.DASH_AFTER_OP, filter: 'brightness(1.6) saturate(.4)' });
// screen speed lines (mockup speedLines: screen-wide streaks along the dash direction)
{ const ang = DIR > 0 ? 0 : Math.PI, lines = Array.from({ length: C.SPEEDLINE_N }, () => ({ u: R(), off: rnd(-1, 1), len: rnd(0.15, 0.45), sp: rnd(0.0015, 0.003), w: rnd(1, 3.2) }));
  m.hold(D0, D0 + C.DASH_MS, (e, S) => S.screen.push({ draw: (g) => { const W = g.W, H = g.H, k = H / 788, ca = Math.cos(ang), sa = Math.sin(ang);
    for (const l of lines) { const u = (l.u + l.sp * e) % 1.6 - 0.3; g.strokeStyle = 'rgba(255,255,255,' + (C.SPEEDLINE_ALPHA * (0.4 + l.w / 4)) + ')'; g.lineWidth = l.w * k;
      const along = (u * 2 - 1) * 1300 * k, perp = l.off * 900 * k, x0 = W / 2 + ca * along - sa * perp, y0 = H / 2 + sa * along + ca * perp;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + ca * l.len * 900 * k, y0 + sa * l.len * 900 * k); g.stroke(); } } })); }

// ── tapered blade slash (mockup slashSheet + bladePoly) ──
function bladePoly(c, ax, ay, bx, by, w) { const L = Math.hypot(bx - ax, by - ay); if (L < 1 || w <= 0) return; const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux, NN = 24, top = [], bot = [];
  for (let i = 0; i <= NN; i++) { const u = i / NN; let h = w / 2 * Math.pow(Math.sin(Math.PI * u), 0.7); if (u > 0.6) h *= 1 - (u - 0.6) * 0.5; const px = ax + (bx - ax) * u, py = ay + (by - ay) * u; top.push([px + nx * h, py + ny * h]); bot.push([px - nx * h, py - ny * h]); }
  c.beginPath(); c.moveTo(top[0][0], top[0][1]); for (const p of top) c.lineTo(p[0], p[1]); for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i][0], bot[i][1]); c.closePath(); c.fill(); }
function slashSheet(at, pt, ang, o) { const ca = Math.cos(ang), sa = Math.sin(ang), L = o.L, w = o.w;
  part({ t0: at, life: o.ms, x: pt.x, y: pt.y, pos: () => pt, layer: 'hit', draw: (c, x, y, t) => { const hu = X.outCubic(Math.min(1, t / 0.22)), tu = t < 0.18 ? 0 : Math.pow((t - 0.18) / 0.82, 2);
    const h = -L + 2 * L * hu, tl2 = -L + 2 * L * tu; if (h - tl2 < 2) return; const ww = w * (1 - 0.5 * t), a = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    const hx = x + ca * h, hy = y + sa * h, tx = x + ca * tl2, ty = y + sa * tl2;
    c.fillStyle = 'rgba(' + o.rgb + ',' + (0.22 * a) + ')'; bladePoly(c, hx, hy, tx, ty, ww * 2.4);
    c.fillStyle = 'rgba(' + o.rgb + ',' + (0.85 * a) + ')'; bladePoly(c, hx, hy, tx, ty, ww);
    c.fillStyle = 'rgba(255,255,255,' + (0.95 * a) + ')'; bladePoly(c, hx, hy, tx, ty, ww * C.SLASH_CORE); } }); }
function sparks(at, pt, n, rgb, sp) { for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), v = rnd(0.25, sp), w = rnd(1.2, 2.6);
  part({ t0: at, life: rnd(260, 520), x: pt.x, y: pt.y, vx: Math.cos(an) * v, vy: Math.sin(an) * v - 0.12, g: 0.0016, drag: 0.955, layer: 'hit', draw: (c, x, y, t, age, p) => {
    c.strokeStyle = 'rgba(' + (t < 0.3 ? '255,255,240' : rgb) + ',' + (1 - t) + ')'; c.lineWidth = w * KP; c.beginPath(); c.moveTo(x - p.vx * 26 * KP, y - p.vy * 26 * KP); c.lineTo(x, y); c.stroke(); } }); } }
function impactRays(at, pt, o) { const rays = Array.from({ length: o.n }, () => [rnd(0, Math.PI * 2), rnd(0.01, 0.035), rnd(0.6, 1)]);
  part({ t0: at, life: o.ms, x: pt.x, y: pt.y, pos: () => pt, layer: 'hit', draw: (c, x, y, t) => { const a = 1 - t, R0 = o.r0 + (o.r1 - o.r0) * 0.25 * X.out(t), R1 = o.r1 * (0.6 + 0.4 * X.outCubic(t));
    c.fillStyle = 'rgba(' + (o.rgb || '255,255,255') + ',' + (a * 0.85) + ')'; for (const r of rays) { const an = r[0], w = r[1], k = r[2];
      c.beginPath(); c.moveTo(x + Math.cos(an) * R0, y + Math.sin(an) * R0); c.lineTo(x + Math.cos(an - w) * R1 * k, y + Math.sin(an - w) * R1 * k); c.lineTo(x + Math.cos(an + w) * R1 * k, y + Math.sin(an + w) * R1 * k); c.fill(); } } }); }
const flashAt = (at, color, peak, inMs, outMs) => m.flash(at, inMs, outMs, color, peak);
const HIT = (at, ev) => { TR(at, Object.assign({ type: 'hit' }, ev || {})); once(at, () => oni.hit({ paced: true })); };

// ── 8 strikes: the RO Sonic Blow sound + effect, then each strike rolled by the game ──
const B2 = D0 + C.STRIKE_BEAT;
TR(B2, { type: 'beat', name: '8 strikes' });
SFX(B2, 'ro_sonicblow', C.RO_VOL);
FX('ro_sonicblow', B2, feetT, C.RO_FX_SCALE, { rate: C.RO_RATE, z: 26 });
const leanAt = []; const slideAt = [];
const strikeAt = (i) => B2 + (i < C.STRIKE_AT.length ? C.STRIKE_AT[i] : C.STRIKE_AT[C.STRIKE_AT.length - 1] + (i - C.STRIKE_AT.length + 1) * 118);
for (let i = 0; i < N; i++) {
  const at = strikeAt(i), o = outOf(plain[i]) || { kind: 'hit' };
  const hit = o.kind === 'hit' || o.kind === 'absorb' || o.kind === 'immune', crit = hit && !!o.isCrit;
  ROT.push([at, C.LEAN_MS, L(i % 2 ? C.LEAN_ODD : C.LEAN_EVEN), X.out]);
  slideAt.push([at, i % 2 ? C.STEP_ODD : C.STEP_EVEN]);
  if (i % 2 === 0) AFTER.push({ t0: at, ms: 200, op: 0.35, filter: 'brightness(1.6) saturate(.4)' });
  SFX(at, i % 2 ? 'ro_katar' : 'ro_katar2', C.KATAR_VOL);
  const j = { x: cen.x + rnd(-C.JIT_X, C.JIT_X) * sT * KP, y: cen.y + rnd(C.JIT_UP, C.JIT_DN) * sT * KP };
  const ang = (C.SB_ANG[i % C.SB_ANG.length] + rnd(-C.ANG_NOISE, C.ANG_NOISE)) * Math.PI / 180;
  const sl = hit ? C.SLASH_HIT : C.SLASH_MISS;
  slashSheet(at, j, ang, { L: hgt * sl.L, w: sl.w * sT * KP, rgb: sl.rgb, ms: sl.ms });
  if (hit) {
    SFX(at, 'ro_hitdagger', C.HIT_VOL);
    FX('001_hit_physical', at, j, C.HIT_FX_SCALE, { rate: C.HIT_FX_RATE, z: 27 });
    sparks(at, j, crit ? C.SPARKS_CRIT : C.SPARKS_HIT, crit ? C.GOLD : C.PINK, crit ? 1 : 0.6);
    if (crit) { flashAt(at, '#ffffff', C.CRIT_FLASH.peak, C.CRIT_FLASH.inMs, C.CRIT_FLASH.outMs); impactRays(at, j, { n: C.CRIT_RAYS.n, r0: C.CRIT_RAYS.r0 * sT * KP, r1: C.CRIT_RAYS.r1 * sT * KP, ms: C.CRIT_RAYS.ms }); }
    shake(at, crit ? C.SHAKE_CRIT : C.SHAKE_HIT, C.SHAKE_MS);
  } else {
    const sway = -DIR * rnd(C.MISS_SWAY[0], C.MISS_SWAY[1]) * sT * KP;
    m.hold(at, at + C.MISS_SWAY_MS + C.MISS_BACK_MS, (e, S) => { const q = S.tok[tk]; if (!q) return; q.dx += e < C.MISS_SWAY_MS ? sway * X.quad(e / C.MISS_SWAY_MS) : sway * (1 - X.quad((e - C.MISS_SWAY_MS) / C.MISS_BACK_MS)); });
  }
  HIT(at, { i: i + 1, kind: o.kind, crit, lean: i % 2 ? C.LEAN_ODD : C.LEAN_EVEN });
}
const lastStrike = strikeAt(N - 1);
ROT.push([lastStrike + 118, 120, 0, X.out]);

// ── Perfect (every strike landed): the plan's extra gold strike ──
const B3 = B2 + C.PERFECT_BEAT;
let B4 = B3 + C.NO_PF_BEAT;
TR(B3, { type: 'beat', name: 'Perfect' });
if (perfect) {
  m.hold(B3, B3 + C.PF_UNDIM_AT + C.PF_UNDIM_MS, (e, S) => { const v = e < C.PF_DIM_MS ? C.PF_DIM * X.sine(e / C.PF_DIM_MS) : e < C.PF_UNDIM_AT ? C.PF_DIM : C.PF_DIM * (1 - X.sine((e - C.PF_UNDIM_AT) / C.PF_UNDIM_MS)); if (v > S.dim) { S.dim = v; S.dimRGB = C.PF_DIM_RGB; } });
  SFX(B3, 'crit', C.PF_CRIT_VOL); SFX(B3, 'ro_hitdagger', C.PF_HIT_VOL);
  m.hold(B3, B3 + C.PF_FX_AT + C.PF_WHITE_OUT, (e, S) => { const a = e < C.PF_WHITE_IN ? C.PF_WHITE * X.sine(e / C.PF_WHITE_IN) : e < C.PF_FX_AT ? C.PF_WHITE : C.PF_WHITE * (1 - X.sine((e - C.PF_FX_AT) / C.PF_WHITE_OUT)); if (a > S.flash.a) S.flash = { a, c: '#ffffff' }; });
  FX('ro_sonicblow', B3 + C.PF_FX_AT, feetT, C.PF_FX_SCALE, { rate: C.PF_FX_RATE, filter: C.PF_FX_FILTER, z: 28 });
  const ph = B3 + C.PF_HIT_AT;
  impactRays(ph, cen, { n: C.PF_RAYS.n, r0: C.PF_RAYS.r0 * sT * KP, r1: C.PF_RAYS.r1 * sT * KP, ms: C.PF_RAYS.ms, rgb: C.PF_RAYS.rgb });
  sparks(ph, cen, C.PF_SPARKS, C.GOLD, 1.3);
  shake(ph, C.PF_SHAKE, C.PF_SHAKE_MS);
  HIT(ph, { i: 'perfect', kind: 'hit', crit: true });
  B4 = B3 + C.PF_BEAT_END;
}

// ── Back: a silent hop home (v2: no Jump1) ──
TR(B4, { type: 'beat', name: 'Back' });
moveTo(B4, C.HOME_MS, kf, X.quad, C.HOME_HOP);
TR(B4 + C.HOME_MS, { type: 'homeEnd' });
const total = B4 + C.HOME_MS + C.HOME_TAIL;
// the per-strike step (mockup slide(a, a.dx + face(a) * (8 | -6), 60): cumulative on top of the dash position),
// carried home by the hop
JIT = (t) => { let dx = 0; for (const s2 of slideAt) { if (t < s2[0]) break; dx += s2[1] * KP * DIR * X.quad(clamp01((t - s2[0]) / C.STEP_MS)); } return t >= B4 ? dx * (1 - X.quad(clamp01((t - B4) / C.HOME_MS))) : dx; };
finishBody();
await runShot(total, B2 + C.STRIKE_AT[0]);
