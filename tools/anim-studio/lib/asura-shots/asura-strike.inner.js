// Asura · Asura Strike (inner script, every client).
// Port of the approved mockup ("Asura Action Animations" artifact, v3.12).
// The field darkens; the camera zooms onto him as his four blades ignite one by one (motes drift in, the
// in-game lit-blade slash starts on each blade, a trickle of element particles); the fourth lights and all
// four overcharge (lit-blade slashes x4 with a glow at the combo tempo) while copies of him swell off his
// body in the four colours; he roars, crouches, then blinks beside each party member for
// a cut that hangs in the air (camera zooms in among the party). He lands behind them; silence; the cuts
// release: an impact frame, a whiteout, four element bursts (the damage), a storm of screen-wide tapered
// blades while the camera snaps back out, the screen burns white; he leaps home and his blades go dark.
// Every number lives in cfg (mockup px, scaled by stage width / 1682). No backticks in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
if (!caster) { oni.fireDone(); return; }

// the party: Asura Strike targets Self; its four strikes pick random foes after the gate, so the cuts go to
// the foes on the board (one per element, cycling when fewer than four)
const disp = caster.document && caster.document.disposition;
const foes = (canvas.tokens.placeables || []).filter((t) => t && t !== caster && t.actor && t.visible && !(t.document && t.document.hidden) && t.document.disposition !== disp)
  .sort((a, b) => a.center.y - b.center.y);
const tokens = { k: { token: caster, foot: cfg.casterFoot, poses: null } };
const PARTY = [];
foes.forEach((t, i) => { const k = 't' + i; PARTY.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
const CL = A.clips || {};
const tl = oni.timeline({ tokens, clips: CL, poses: { k: { dark: { url: A.darkIdle } } } });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK, feet = tl.feet, glow = tl.draw.glowCircle;
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 7717);
const rnd = (a, b) => a + (b - a) * R();
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const C = cfg.t, ELS = cfg.order, EL = cfg.el;

// ── the lit-blade cue clips, decoded once (60 fps copies; the Forge 15 fps original if the copy is missing) ──
const CUE = {};
await Promise.all(ELS.map(async (el) => { const q = A.cue[el];
  let d = null; try { d = await tl.decode(q.url, { fps: 60, scale: 0.6 }); } catch (e) { d = null; }
  if (!d || !d.frames || !d.frames.length) { try { d = await tl.decode(q.fallback, { fps: 15, scale: 0.6 }); } catch (e) { d = null; } }
  CUE[el] = d; }));

// ── geometry ──
const T = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (!did) { did = true; fn(); } } }); };
const K = TOK.k, kf = feet(K);
const PC = PARTY.length ? { x: PARTY.reduce((s, k) => s + TOK[k].x, 0) / PARTY.length, y: PARTY.reduce((s, k) => s + feet(TOK[k]).y, 0) / PARTY.length } : { x: kf.x + 900 * KP, y: kf.y };
const DIR = PC.x >= K.x ? 1 : -1;
const center = (k) => { const Tk = TOK[k], f = feet(Tk); return { x: f.x, y: f.y - Tk.h * 0.5 }; };
const FAR = PARTY.length ? (DIR > 0 ? Math.max(...PARTY.map((k) => TOK[k].x)) : Math.min(...PARTY.map((k) => TOK[k].x))) : PC.x;
const BEHIND = { x: FAR + DIR * cfg.behind * KP, y: PC.y + 20 * KP };
// one cut per strike. A Chain cast (Chain 4 seek) hands us the planned strikes: each cut goes to that
// strike's real target (a seek redirect included) and remembers how it landed; a preview (no plan) spreads
// the four cuts over the foes on the board.
const keyOfUuid = (u) => PARTY.find((k) => TOK[k].token && TOK[k].token.document && TOK[k].token.document.uuid === u) || null;
const STRIKES = Array.isArray(oni.strikes) ? oni.strikes : [];
const HITS = ELS.map((el, i) => {
  const s = STRIKES[i], o = s && s.outcomes ? (s.outcomes.find((x) => x && x.kind !== 'lost') || s.outcomes[0]) : null;
  const k = (o && keyOfUuid(o.tokenUuid)) || (PARTY.length ? PARTY[i % PARTY.length] : null);
  const kind = o ? o.kind : 'hit';
  return { el, k, kind, pierce: !!(o && o.pierce), landed: !o || kind === 'hit' || kind === 'absorb' || kind === 'immune' || kind === 'block' };
}).filter((h) => h.k);
if (!HITS.length) { oni.fireDone(); return; }
const side = (i) => (i % 2 ? 1 : -1);                       // which side of the target he lands on
const cutSpot = (i) => { const k = HITS[i].k, f = feet(TOK[k]); return { x: f.x + side(i) * DIR * TOK[k].w * 0.9, y: f.y + 6 * KP }; };
const cutAt = (i) => C.cuts + i * cfg.cut;

// ── his body over time: where his feet are, which way he faces, his lean and squash ──
// face: +1 = facing the party from his home side, -1 = turned the other way
function asuraAt(t) {
  let p = { x: kf.x, y: kf.y }, face = 1, rot = 0, kx = 1, ky = 1, air = 0;
  if (t >= C.crouch && t < C.cuts) { const u = E.outC(seg(t, C.crouch, C.cuts)); rot = -9 * u; kx = lerp(1, 1.12, u); ky = lerp(1, 0.84, u); }
  if (t >= C.cuts && t < C.land) { const i = Math.min(3, Math.floor((t - C.cuts) / cfg.cut)); if (i < HITS.length) { p = cutSpot(i); face = side(i) < 0 ? 1 : -1; rot = side(i) * -12 * E.outC(seg(t, cutAt(i), cutAt(i) + 60)); } }
  if (t >= C.land && t < C.leap + 180) { p = BEHIND; face = -1; }
  if (t >= C.leap && t < C.leap + 180) { const u = seg(t, C.leap, C.leap + 90), v = seg(t, C.leap + 90, C.leap + 180); kx = lerp(1, 1.1, u) + (0.92 - 1.1) * v; ky = lerp(1, 0.88, u) + (1.08 - 0.88) * v; }
  if (t >= C.leap + 180 && t < C.landHome) { const u = seg(t, C.leap + 180, C.landHome), e = E.sine(u); p = { x: lerp(BEHIND.x, kf.x, e), y: lerp(BEHIND.y, kf.y, e) }; face = -1; air = Math.sin(u * Math.PI) * 140 * KP; kx = 0.92; ky = 1.08; }
  if (t >= C.landHome) { const u = seg(t, C.landHome, C.landHome + 80), v = seg(t, C.landHome + 80, C.landHome + 300); kx = v > 0 ? lerp(1.14, 1, E.outC(v)) : lerp(1, 1.14, u); ky = v > 0 ? lerp(0.86, 1, E.outC(v)) : lerp(1, 0.86, u); }
  const s = (p.x === kf.x && p.y === kf.y) ? 1 : tl.depthRatio(kf, p);
  return { x: p.x, y: p.y, face, rot: rot * Math.PI / 180 * DIR * face, kx, ky, s, air };
}
// a point on his sprite (u, v = shares of the art facing its native way) where it is drawn at time t
function onAsura(t, u, v) { const a = asuraAt(t), sx = K.flip * a.face * a.kx * a.s, sy = a.ky * a.s;
  const lx = (u - 0.5) * K.w, ly = -K.h * K.foot + v * K.h; const c = Math.cos(a.rot), sn = Math.sin(a.rot);
  const x = lx * sx, y = ly * sy; return { x: a.x + x * c - y * sn, y: a.y - a.air + x * sn + y * c }; }
const bladePt = (t, el) => onAsura(t, EL[el].blade[0], EL[el].blade[1]);

// ── master curve: his body, the camera, the dim, hurt holds, rumble ──
const CAM_AURA = { x: kf.x + DIR * 40 * KP, y: kf.y - K.h * 0.55 };
m.hold(0, C.total + 1, (t, S) => {
  const a = asuraAt(t), d = S.tok.k;
  d.dx = a.x - kf.x; d.dy = a.y - kf.y; d.air = a.air; d.sx = a.face * a.kx * a.s; d.sy = a.ky * a.s; d.rot = a.rot;
  if (t >= C.landHome + 80) d.pose = 'dark';
  // camera: zoom onto him while the blades ignite; in among the party for the cuts; snap back out at the release
  let cam = { cx: tl.REST.cx, cy: tl.REST.cy, zoom: 1 };
  const z0 = E.outC(seg(t, C.ign0, C.ign0 + 650));
  if (t < C.cuts) cam = { cx: lerp(tl.REST.cx, CAM_AURA.x, z0), cy: lerp(tl.REST.cy, CAM_AURA.y, z0), zoom: lerp(1, cfg.auraZoom, z0) };
  else if (t < C.land) { const i = Math.min(HITS.length - 1, Math.floor((t - C.cuts) / cfg.cut)), c = center(HITS[i].k), prev = i === 0 ? { cx: CAM_AURA.x, cy: CAM_AURA.y, zoom: cfg.auraZoom } : null;
    const tgt = { cx: c.x + side(i) * DIR * 30 * KP, cy: c.y - 10 * KP, zoom: cfg.zoom + i * 0.03 }; const u = E.outC(seg(t, cutAt(i), cutAt(i) + (i === 0 ? 160 : 110)));
    const from = prev || (() => { const pc = center(HITS[i - 1].k); return { cx: pc.x + side(i - 1) * DIR * 30 * KP, cy: pc.y - 10 * KP, zoom: cfg.zoom + (i - 1) * 0.03 }; })();
    cam = { cx: lerp(from.cx, tgt.cx, u), cy: lerp(from.cy, tgt.cy, u), zoom: lerp(from.zoom, tgt.zoom, u) }; }
  else if (t < C.release + 140) { const last = center(HITS[HITS.length - 1].k), from = { cx: last.x, cy: last.y - 10 * KP, zoom: cfg.zoom + 0.09 }, to = { cx: (PC.x + BEHIND.x) / 2, cy: PC.y - 60 * KP, zoom: cfg.zoom + 0.08 }; const u = E.outC(seg(t, C.land, C.land + 160));
    cam = { cx: lerp(from.cx, to.cx, u), cy: lerp(from.cy, to.cy, u), zoom: lerp(from.zoom, to.zoom, u) }; }
  else { const from = { cx: (PC.x + BEHIND.x) / 2, cy: PC.y - 60 * KP, zoom: cfg.zoom + 0.08 }, u = E.outC(seg(t, C.release + 140, C.release + 140 + cfg.zoomOut));
    cam = { cx: lerp(from.cx, tl.REST.cx, u), cy: lerp(from.cy, tl.REST.cy, u), zoom: lerp(from.zoom, 1, u) }; }
  S.cam = cam;
  // the dim: .5 from the start, deeper in the silence, lifting through the release and the leap
  let dim = 0.5 * E.sine(seg(t, 0, 700));
  if (t >= C.release - 120) dim = lerp(0.62, 0.25, seg(t, C.release + 190, C.release + 490));
  else if (t >= C.land + cfg.hush) dim = lerp(0.5, 0.62, seg(t, C.land + cfg.hush, C.land + cfg.hush + 120));
  if (t >= C.leap) dim = Math.min(dim, lerp(0.25, 0.15, seg(t, C.leap, C.leap + 500)));
  if (t >= C.landHome + 300) dim = lerp(0.15, 0, seg(t, C.landHome + 300, C.landHome + 1100));
  S.dim = Math.max(S.dim, dim);
  // the struck hold their hurt loop through the bursts (a strike that missed outright does not)
  if (t >= C.bursts && t < C.bursts + 900) for (const h of HITS) if (h.landed) S.tok[h.k].hurt = true;
  // rumble: storm rumble while he charges, the release rumble through the blades
  if (t < C.land) S.shake = Math.max(S.shake, 1.5 * KP);
  if (t >= C.bursts && t < C.wout + cfg.wbuild) S.shake = Math.max(S.shake, 4 * KP);
});
// vignette (screen) while he charges and cuts
m.hold(0, C.leap + 600, (tt, S) => { const a = 0.75 * E.sine(seg(tt, 0, 700)) * (1 - seg(tt, C.leap, C.leap + 600)); if (a <= 0) return;
  S.screen.push({ draw: (g) => { const gr = g.createRadialGradient(g.W / 2, g.H / 2, g.H * 0.35, g.W / 2, g.H / 2, g.H * 0.95); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,' + (0.85 * a) + ')'); g.fillStyle = gr; g.fillRect(0, 0, g.W, g.H); } }); });

// ── particles: a deterministic list, drawn additively in world space ──
const P = [];
// p: { t0, life, x, y, vx, vy, g, r, rgb, fade } (mockup px per ms, scaled at draw) or a homing mote { home: fn(t) }
function particle(o) { P.push(o); }
m.hold(0, C.total + 1, (t, S) => { S.world.push({ z: 30, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter';
  for (const p of P) { const age = t - p.t0; if (age < 0 || age > p.life) continue; const u = age / p.life;
    let x, y;
    if (p.home) { const to = p.home(t), e = E.inQ(u), cx = (p.x + to.x) / 2 + p.arc, cy = Math.min(p.y, to.y) - 40 * KP; x = (1 - e) * (1 - e) * p.x + 2 * (1 - e) * e * cx + e * e * to.x; y = (1 - e) * (1 - e) * p.y + 2 * (1 - e) * e * cy + e * e * to.y; }
    else { x = p.x + p.vx * age * KP; y = p.y + (p.vy * age + 0.5 * (p.g || 0) * age * age) * KP; }
    glow(g, x, y, p.r * KP * (p.home ? 2.4 : 2.2), 'rgba(' + p.rgb + ',1)', (p.fade === false ? 1 : 1 - u) * 0.95); }
  g.restore(); } }); });
// element motes drifting in to a point
const gatherTo = (at, el, toFn, n, ms) => { for (let i = 0; i < n; i++) { const p0 = toFn(at), an = rnd(0, 6.283), r = rnd(90, 180) * KP;
  particle({ t0: at, life: ms * rnd(0.7, 1.1), x: p0.x + Math.cos(an) * r, y: p0.y + Math.sin(an) * r * 0.7, home: toFn, arc: rnd(-60, 60) * KP, r: rnd(2, 4), rgb: EL[el].rgb }); } };
const shards = (at, pt, rgb, n, spread) => { for (let i = 0; i < n; i++) { const an = rnd(0, 6.283), sp = rnd(0.15, spread); particle({ t0: at, life: rnd(350, 700), x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, g: 0.0006, r: rnd(1.5, 3.2), rgb }); } };

// ── ignition: subtle per blade, then all four overcharge ──
const sfx = [];
const S_ = (at, key, v) => sfx.push({ at, url: A.sfx[key], v: v * cfg.volume });
S_(0, 'thunder10', 0.55); m.flash(0, 40, 300, 'rgb(190,140,255)', 0.25);
ELS.forEach((el, i) => { const at = C.ign0 + i * cfg.ignite;
  gatherTo(at, el, (tt) => bladePt(tt, el), 10, 650); S_(at, EL[el].s1, 0.25); S_(at, 'sword1', 0.18);
  m.tint(at, 200, 'k', 'rgb(' + EL[el].rgb + ')', (u) => 0.6 * (1 - u));
  // the blade keeps shedding its element until he moves: 1 small particle per 70 ms, 2 bigger ones once overcharged
  for (let tt = at; tt < C.cuts; tt += 70) { const hot = tt >= C.full, n = hot ? 2 : 1, gk = hot ? 1.35 : 1, sp = hot ? 1.5 : 0.7, p0 = bladePt(tt, el);
    for (let j = 0; j < n; j++) { const x = p0.x + rnd(-14, 14) * gk * KP, y = p0.y + rnd(-10, 22) * gk * KP, r = rnd(1.5, 3) * gk;
      if (el === 'fire') particle({ t0: tt, life: rnd(1400, 2600), x, y, vx: rnd(-0.03, 0.03) * sp, vy: rnd(-0.12, -0.06) * sp, r, rgb: EL[el].rgb });
      else if (el === 'ice') particle({ t0: tt, life: rnd(900, 1500), x, y, vx: rnd(-0.03, 0.03) * sp, vy: rnd(0.01, 0.04) * sp, r, rgb: EL[el].rgb });
      else if (el === 'bolt') particle({ t0: tt, life: rnd(250, 500), x, y, vx: rnd(-0.15, 0.15) * sp, vy: rnd(-0.15, 0.05) * sp, r, rgb: EL[el].rgb });
      else particle({ t0: tt, life: rnd(900, 1500), x, y, vx: rnd(0.04, 0.1) * sp * (R() < 0.5 ? -1 : 1), vy: rnd(-0.06, -0.02) * sp, r, rgb: EL[el].rgb }); } } });
// full ignition
S_(C.full, 'explode2', 0.45); S_(C.full, 'magic4', 0.5); S_(C.full, 'powerup', 0.55); S_(C.full, 'thunder3', 0.35);
m.flash(C.full, 30, 200, '#ffffff', 0.3); m.shake(C.full, 450, 10 * KP);
ELS.forEach((el) => { const p = bladePt(C.full, el); shards(C.full, p, EL[el].rgb, 18, 0.6);
  m.clip('twinkle', C.full, { x: p.x, y: p.y, w: CL.twinkle.w * 1.8 * CL.twinkle.k * KP, z: 31, add: true, filter: 'sepia(1) saturate(7) hue-rotate(' + (EL[el].hue - 38) + 'deg) brightness(1.4)' }); });

// ── the lit-blade cues on his blades: from each ignite until the blades go dark; x boost + glow + x1.6 tempo while overcharged ──
ELS.forEach((el, i) => { const q = A.cue[el], from = C.ign0 + i * cfg.ignite;
  m.hold(from, C.landHome + 80, (tt, S) => { const d = CUE[el]; if (!d) return; const t = from + tt, hot = t >= C.full && t < C.cuts;
    const rate = hot ? 1.6 : 1, period = q.period / rate, ph = (tt % period) * rate; if (ph >= d.dur) return;
    const F = d.frames[Math.min(d.frames.length - 1, Math.floor(ph / d.dur * d.frames.length))]; if (!F) return;
    const a = asuraAt(t), boost = hot ? cfg.boost : 1;
    S.world.push({ z: 22, draw: (g) => {
      const sx = K.flip * a.face * a.kx * a.s, sy = a.ky * a.s;
      g.save(); g.translate(a.x, a.y - a.air); g.rotate(a.rot); g.scale(sx, sy);
      g.translate(-K.w / 2 + q.x * K.w, -K.h * K.foot + q.y * K.h); g.rotate(q.angle * Math.PI / 180);
      const h = K.h * q.size * boost, w = h * F.width / F.height; g.globalAlpha = q.op;
      if (hot) g.filter = 'drop-shadow(0 0 ' + (8 / Math.max(0.3, a.s)).toFixed(1) + 'px rgb(' + EL[el].rgb + '))';
      g.drawImage(F, -q.ax * w, -q.ay * h, w, h); g.restore(); } }); }); });

// ── the aura: copies of him swell off his body in the four colours, from full ignition until he moves ──
const ghostCache = {};
const ghostOf = (el) => { if (ghostCache[el]) return ghostCache[el]; const art = tl.art('k'); if (!art) return null;
  const w = art.videoWidth || art.naturalWidth || art.width, h = art.videoHeight || art.naturalHeight || art.height; if (!w || !h) return null;
  const c = document.createElement('canvas'); c.width = w + 24; c.height = h + 24; const x = c.getContext('2d');
  x.filter = 'sepia(1) saturate(7) hue-rotate(' + (EL[el].hue - 38) + 'deg) brightness(1.7) drop-shadow(0 0 6px rgb(' + EL[el].rgb + '))'; x.drawImage(art, 12, 12, w, h);
  ghostCache[el] = { c, pad: 12, w, h }; return ghostCache[el]; };
{ let n = 0; for (let at = C.full; at < C.cuts; at += 120) { const el = ELS[n++ % 4];
  m.hold(at, at + 720, (tt, S) => { const u = tt / 720, gh = ghostOf(el); if (!gh) return; const a = asuraAt(at), sc = 1 + 0.55 * E.outC(u), al = 0.8 * (1 - E.outC(u));
    S.world.push({ z: 4, draw: (g) => { const sx = K.flip * a.face * a.s * sc, sy = a.s * sc; const piv = { x: a.x, y: a.y - K.h * a.s * (K.foot - 0.7) };
      g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = al; g.translate(piv.x, piv.y); g.scale(sx, sy);
      const k = K.w / gh.w; g.drawImage(gh.c, -K.w / 2 - gh.pad * k, -K.h * 0.7 - gh.pad * k, (gh.w + 2 * gh.pad) * k, (gh.h + 2 * gh.pad) * k); g.restore(); } }); }); } }

// ── roar (no cut-in: the boss line carries the "boss moment" on the first cast — user 2026-11-11) ──
S_(C.roar, 'monster5', 0.7); m.shake(C.roar, 600, 10 * KP);
m.clip('powerup', C.roar, { x: kf.x, y: kf.y, w: CL.powerup.w * 1.4 * CL.powerup.k * KP, z: 3, filter: cfg.redF });
m.clip('burst02', C.roar, { x: kf.x, y: kf.y - K.h * 0.5, w: CL.burst02.w * 1.4 * CL.burst02.k * KP, z: 32, add: true, filter: cfg.redF });
ELS.forEach((el) => gatherTo(C.roar, el, () => ({ x: kf.x, y: kf.y - K.h * 0.5 }), 8, 600));

// ── crouch ──
S_(C.crouch, 'swingF', 0.5);

// ── the blink cuts ──
const bladeLine = (g, x0, y0, x1, y1, w, rgb, a) => {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, N = 24;
  const path = (ww) => { const top = [], bot = []; for (let i = 0; i <= N; i++) { const u = i / N, cx = x0 + dx * u, cy = y0 + dy * u, h = ww * Math.pow(Math.sin(Math.PI * u), 0.7) * (u < 0.6 ? 1 : 1 - (u - 0.6) * 0.5) / 2; top.push([cx + nx * h, cy + ny * h]); bot.push([cx - nx * h, cy - ny * h]); }
    g.beginPath(); g.moveTo(top[0][0], top[0][1]); for (const p of top) g.lineTo(p[0], p[1]); for (let i = bot.length - 1; i >= 0; i--) g.lineTo(bot[i][0], bot[i][1]); g.closePath(); };
  g.save(); g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(' + rgb + ',' + (0.22 * a) + ')'; path(w * 2.4); g.fill();
  g.fillStyle = 'rgba(' + rgb + ',' + (0.85 * a) + ')'; path(w); g.fill();
  g.fillStyle = 'rgba(255,255,255,' + (0.95 * a) + ')'; path(w * 0.3); g.fill(); g.restore(); };
S_(C.cuts, 'swingA', 0.5);
m.clip('dashsmoke', C.cuts, { x: kf.x, y: kf.y, w: CL.dashsmoke.w * 1.2 * CL.dashsmoke.k * KP, z: 6, add: true, alpha: () => 0.7 });
const AFTER = [];   // afterimage moments: { at, el }
HITS.forEach((h, i) => { const at = cutAt(i), e = EL[h.el], c = center(h.k), ts = TOK[h.k].h / Math.max(1, K.h) * 1.2;
  AFTER.push({ at: at - 1, hue: e.hue });
  m.clip('px_' + h.el, at, { x: c.x - 30 * KP, y: c.y + 40 * KP, w: CL['px_' + h.el].w * 2.1 * CL['px_' + h.el].k * KP, z: 40, rot: e.ang * 0.4 * Math.PI / 180, flip: side(i) * DIR > 0 });
  m.clip('ggslash', at, { x: c.x, y: c.y, w: CL.ggslash.w * 0.9 * CL.ggslash.k * KP, z: 41, rot: e.ang * Math.PI / 180, add: true, filter: 'sepia(1) saturate(6) hue-rotate(' + (e.hue - 38) + 'deg) brightness(1.3)' });
  // the cut hangs in the air until the release
  const len = (300 + 160) * KP, an = e.ang * Math.PI / 180, ddx = Math.cos(an) * len / 2, ddy = Math.sin(an) * len / 2;
  m.hold(at, C.release + 190, (tt, S) => { const grow = Math.min(1, tt / 70), pulse = (at + tt) >= C.land + cfg.hush ? 0.4 : 0, kk = 0.8 + 0.2 * Math.sin(tt / 60) + pulse;
    S.world.push({ z: 42, draw: (g) => bladeLine(g, c.x - ddx, c.y - ddy, c.x - ddx + 2 * ddx * grow, c.y - ddy + 2 * ddy * grow, 16 * KP * kk, e.rgb, Math.min(1, kk)) }); });
  S_(at, pick(['slash1', 'slash2', 'slash3']), 0.6); S_(at, e.s2, 0.35); m.shake(at, 140, 6 * KP);
  // element speed lines across the screen for this cut
  m.hold(at, at + cfg.cut, (tt, S) => S.screen.push({ draw: (g) => { const ca = Math.cos(an), sa = Math.sin(an), Hs = g.H / 788; g.save(); g.lineCap = 'round'; const r2 = tl.rng(i * 97 + 3);
    for (let n = 0; n < 30; n++) { const off = (r2() * 2 - 1) * 900 * Hs, along = ((r2() + tt / 400) % 1.3 - 0.3) * 2600 * Hs - 1300 * Hs, ln = (0.15 + r2() * 0.3) * 900 * Hs, w = 1 + r2() * 2.2;
      const x0 = g.W / 2 + ca * along - sa * off, y0 = g.H / 2 + sa * along + ca * off; g.strokeStyle = 'rgba(' + e.rgb + ',' + (0.45 * (0.4 + w / 4)) + ')'; g.lineWidth = w * Hs; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + ca * ln, y0 + sa * ln); g.stroke(); }
    g.restore(); } })); });
AFTER.push({ at: C.land - 1, hue: 0 });
// leap home: afterimages along the arc
for (let at = C.leap + 180; at < C.landHome; at += Math.max(30, cfg.jump * 0.14)) AFTER.push({ at, hue: 0, leap: true });
for (const af of AFTER) { const a = asuraAt(af.at); m.hold(af.at, af.at + 420, (tt, S) => { const art = tl.art('k'); if (!art) return; const al = 0.6 * (1 - tt / 420);
  S.world.push({ z: 5, draw: (g) => { g.save(); g.globalAlpha = al; g.filter = 'sepia(1) saturate(5) hue-rotate(' + (af.hue - 38) + 'deg) brightness(1.35)'; g.translate(a.x, a.y - a.air); g.rotate(a.rot); g.scale(K.flip * a.face * a.kx * a.s, a.ky * a.s); g.drawImage(art, -K.w / 2, -K.h * K.foot, K.w, K.h); g.restore(); } }); }); }

// ── behind them: silence, the sheathe click ──
S_(C.land, 'earth5', 0.35);
m.clip('smoke11', C.land, { x: BEHIND.x, y: BEHIND.y, w: CL.smoke11.w * 1.3 * CL.smoke11.k * KP, z: 6, add: true, alpha: () => 0.6 });
S_(C.land + cfg.hush, 'sword4', 0.55);

// ── release: the impact frame, a whiteout, the four bursts, the screen-wide blades, the burn to white ──
S_(C.release, 'crit', 0.8); S_(C.release, 'explosion2', 0.7); S_(C.release, 'thunder3', 0.5);
const impactPhase = (from, to, bg, fg) => m.hold(from, to, (tt, S) => S.over.push({ draw: (g) => {
  g.save(); g.fillStyle = bg; g.fillRect(-20, -20, g.W + 40, g.H + 40);
  const pts = HITS.map((h) => tl.toScreen(center(h.k).x, center(h.k).y)), cx = pts.reduce((s, p) => s + p.x, 0) / Math.max(1, pts.length), cy = pts.reduce((s, p) => s + p.y, 0) / Math.max(1, pts.length);
  const r3 = tl.rng(from); g.fillStyle = fg; for (let n = 0; n < 46; n++) { const an = r3() * 6.283, w = 0.006 + r3() * 0.024, r0 = (90 + r3() * 130) * (g.H / 788);
    g.beginPath(); g.moveTo(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0); g.lineTo(cx + Math.cos(an - w) * 3000, cy + Math.sin(an - w) * 3000); g.lineTo(cx + Math.cos(an + w) * 3000, cy + Math.sin(an + w) * 3000); g.fill(); }
  const sc = tl.camView(S).scale;
  for (const h of HITS) { const Tk = TOK[h.k], f = feet(Tk), p = tl.toScreen(f.x, f.y), sil = tl.tinted(h.k, fg); if (!sil) continue; const w = Tk.w * sc, hh = Tk.h * sc;
    g.save(); g.translate(p.x, p.y); g.scale(Tk.flip, 1); g.drawImage(sil, -w / 2, -hh * Tk.foot, w, hh); g.restore(); }
  g.restore(); } }));
impactPhase(C.release, C.release + 70, '#000', '#fff'); impactPhase(C.release + 70, C.release + 140, '#fff', '#000');
// white: in 50 ms, hold, out 380 ms
m.hold(C.release + 140, C.release + 140 + 50 + cfg.white + 380, (tt, S) => { const a = tt < 50 ? tt / 50 : tt < 50 + cfg.white ? 1 : 1 - (tt - 50 - cfg.white) / 380; S.white = Math.max(S.white, a); });
// the four bursts, 110 ms apart, on the four strike targets. Each one reveals its strike (oni.hit: number,
// flinch, HP bar from the Chain presenter). A Pierce half-hit gets a smaller burst; a clean miss only a puff.
HITS.forEach((h, i) => { const at = C.bursts + i * 110, e = EL[h.el], c = center(h.k), f = feet(TOK[h.k]);
  once(at, () => oni.hit({ numbersOnly: true }));
  if (!h.landed) { m.clip('smoke11', at, { x: c.x, y: c.y + 20 * KP, w: CL.smoke11.w * 0.8 * CL.smoke11.k * KP, z: 44, add: true, alpha: () => 0.5 }); S_(at, 'swingC', 0.4); return; }
  const big = h.pierce ? 0.6 : 1;
  m.clip('px_' + h.el, at, { x: c.x - 40 * KP, y: c.y + 40 * KP, w: CL['px_' + h.el].w * 2.6 * big * CL['px_' + h.el].k * KP, z: 44, rot: rnd(-15, 15) * Math.PI / 180, flip: R() < 0.5 });
  m.clip('mv_' + h.el, at, { x: c.x, y: c.y, w: CL['mv_' + h.el].w * 1.5 * big * CL['mv_' + h.el].k * KP, z: 45 });
  if (!h.pierce) m.clip('ro_' + h.el, at, { x: f.x, y: h.el === 'fire' ? f.y : c.y, w: CL['ro_' + h.el].w * (h.el === 'fire' ? 0.7 : 1) * CL['ro_' + h.el].k * KP, z: 43, add: true });
  m.clip('hit_' + h.el, at, { x: c.x, y: c.y, w: CL['hit_' + h.el].w * 1.2 * big * CL['hit_' + h.el].k * KP, z: 46, add: true });
  shards(at, c, e.rgb, h.pierce ? 9 : 18, 0.6); shards(at, c, '255,255,255', h.pierce ? 4 : 8, 0.45);
  m.flash(at, 20, 110, 'rgb(' + e.rgb + ')', 0.35 * big); S_(at, e.s1, 0.55 * big); });
m.shake(C.bursts, Math.max(900, cfg.seq * 0.6), cfg.shake * KP);
// the screen-wide blades: the first four cross at once (one per element), the rest keep cutting through the release
for (let n = 0; n < cfg.strokes; n++) { const el = ELS[n % 4], at = C.release + 140 + (n < 4 ? 0 : cfg.seq * (n - 3) / Math.max(1, cfg.strokes - 3) * rnd(0.85, 1));
  const ang = (EL[el].ang + rnd(-30, 30) + (n % 3 === 2 ? 90 : 0)) * Math.PI / 180, off = rnd(-170, 170), ms = rnd(480, 660), width = rnd(34, 58);
  m.hold(at, at + ms, (tt, S) => S.screen.push({ draw: (g) => { const Hs = g.H / 788, u = tt / ms, ca = Math.cos(ang), sa = Math.sin(ang), cx = g.W / 2 - sa * off * Hs, cy = g.H / 2 + ca * off * Hs, L = 1150 * Hs * (g.W / g.H) / (1682 / 788);
    const head = Math.min(1, u / 0.22), tail = Math.max(0, (u - 0.18) / 0.82);
    bladeLine(g, cx - ca * L + ca * 2 * L * tail * tail, cy - sa * L + sa * 2 * L * tail * tail, cx - ca * L + ca * 2 * L * E.outC(head), cy - sa * L + sa * 2 * L * E.outC(head), width * Hs * (1 - u * 0.5), EL[el].rgb, 1 - Math.max(0, (u - 0.6) / 0.4)); } }));
  if (n >= 4 && n % 2) S_(at, pick(['slash1', 'slash2', 'slash3', 'swingC']), 0.35); }
// so many cuts the world burns white: build, hold, clear
S_(C.wout, 'flash2', 0.5); S_(C.wout, 'slashL', 0.45);
m.hold(C.wout, C.leap, (tt, S) => { const a = tt < cfg.wbuild ? E.inQ(tt / cfg.wbuild) : tt < cfg.wbuild + cfg.wsil ? 1 : 1 - (tt - cfg.wbuild - cfg.wsil) / 520; S.white = Math.max(S.white, a); });

// ── leap home; the blades go dark ──
S_(C.leap, 'swingF', 0.45);
S_(C.landHome, 'earth5', 0.5); m.shake(C.landHome, 240, 8 * KP);
for (let i = 0; i < 2; i++) { const x = kf.x + (i ? 40 : -40) * KP; for (let j = 0; j < 6; j++) particle({ t0: C.landHome, life: rnd(600, 1000), x, y: kf.y - 4 * KP, vx: rnd(-0.06, 0.06), vy: rnd(-0.05, -0.01), r: rnd(1.5, 3), rgb: '200,190,220' }); }
S_(C.landHome + 80, 'darkness5', 0.35);
for (let i = 0; i < 40; i++) { const el = pick(ELS); particle({ t0: C.landHome + 80 + rnd(0, 300), life: rnd(1600, 2800), x: kf.x + rnd(-260, 260) * KP, y: kf.y - rnd(200, 420) * KP, vx: rnd(-0.04, 0.04), vy: rnd(0.02, 0.07), r: rnd(2, 4), rgb: EL[el].rgb }); }

// the damage gate sits just after the fourth burst's reveal; the shot keeps running to the end
once(C.bursts + 3 * 110 + 60, () => oni.fireDone());
await tl.run(T, { total: C.total, sfx, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
