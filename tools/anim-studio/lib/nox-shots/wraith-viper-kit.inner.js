// ── Nox Wraith + Nox Viper kit (Nox Legion port, 2026-11-20) ──
// Prepended to wraith-viper-wraith.inner.js / wraith-viper-viper.inner.js by nox-wraith-viper-signatures.js.
// Port of the approved Nox Legion mockup (claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU v8: part-base, part-r4, part-r5 and
// the legacy common kit). Every helper schedules timeline tracks at an absolute time (ms) instead of running in real
// time. Sizes are mockup px on a 1682 px stage times KP; s = the depth factor of the body an effect sits on (the
// mockup's a.s, relative to the caster). The caster (and a Soul Fragment, painted with the mockup's fragment look) is
// painted by this kit from a per-shot BODY(t) state like the Masked Girl kit, so fades, lifts, glows, squash and
// afterimages work. LIVE board unless cfg.live === false (full takeover, camera driven through S.cam).
// Layers (the mockup page order): pxClip back = under the battlers (z 3), battlers (z 20), plain clips (z 26),
// pxClip front / light (z 28 / 29), hit particles (z 30). No backticks, no dollar-brace.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const NS = 'fabula-ultima-companion';
const caster = ctx.casterToken;
if (!caster) { oni.fireDone(); return; }
const RGB = cfg.rgb || {};
const JADE = RGB.JADE || '95,224,180', JADE_HOT = RGB.JADE_HOT || '200,255,232', VENOM = RGB.VENOM || '120,220,90';
// the mockup's FRAG_F with its drop-shadow length as a {px} placeholder (scaled to the board like every mockup px)
const FRAG_F = 'sepia(1) saturate(2.2) hue-rotate(70deg) brightness(1.55) drop-shadow(0 0 {6} rgba(166,255,156,.85))';

// ── Soul Fragments (soul-tithe.js): a token flagged soulFragment, owner = flags soulFragmentOwner (actor uuid);
// its mark AE carries soulCalledRound / soulReturned. An eaten or paid-out one is skipped. ──
const PLACE = (canvas.tokens && canvas.tokens.placeables) || [];
const flagsOf = (t) => { try { return (t.document.flags && t.document.flags[NS]) || {}; } catch (e) { return {}; } };
const isFrag = (t) => { try { const af = t.actor && t.actor.flags && t.actor.flags[NS]; return flagsOf(t).soulFragment === true || !!(af && af.conflictObject === 'soul-fragment'); } catch (e) { return false; } };
const markOf = (t) => { try { const e = t.actor.effects.find((x) => x.flags && x.flags[NS] && x.flags[NS].soulFragmentMark === true); return e ? e.flags[NS] : null; } catch (e) { return null; } };
const hpOf = (t) => { try { return Number(t.actor.system.props.current_hp) || 0; } catch (e) { return 0; } };
const FRAGS = PLACE.filter((t) => t && t.center && t.mesh && !(t.document && t.document.hidden) && isFrag(t) && (markOf(t) || {}).soulReturned !== true);
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster && !isFrag(t));
let FRAG = null;
if (cfg.frag === 'owner' && targets[0]) {
  // Soul Ripper: the target's own fragment (none yet = the first wound spawns it at resolve: skip that part)
  const u = targets[0].actor ? targets[0].actor.uuid : null; FRAG = FRAGS.find((t) => u && flagsOf(t).soulFragmentOwner === u) || null;
} else if (cfg.frag === 'eat') {
  // Devour Soul: consumeFragment's pick ("largest" current HP among the fragments that have Called), or a fragment the action targets
  const named = (ctx.targetTokens || []).find((t) => t && FRAGS.includes(t)); if (named) FRAG = named;
  else for (const t of FRAGS) { const mk = markOf(t); if (!mk || !(Number(mk.soulCalledRound) > 0) || hpOf(t) <= 0) continue; if (!FRAG || hpOf(t) > hpOf(FRAG)) FRAG = t; }
}
const LIVE = cfg.live !== false;
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
if (FRAG) tokens.f = { token: FRAG };
// full takeover paints every token: the other fragments get the fragment look too (the plain texture is the owner's art)
const OTHERF = [];
if (!LIVE) FRAGS.forEach((t, i) => { if (t === FRAG) return; const k = 'g' + i; OTHERF.push(k); tokens[k] = { token: t }; });
const CL = A.clips || {};
const tl = oni.timeline({ tokens, clips: CL, images: {}, live: LIVE, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK, feet = tl.feet;
const X = { lin: E.lin, out: E.outQ, in: E.inQ, quad: E.ioQ, sine: E.sine, outCubic: E.outC, inCubic: E.inC,
  outBack: (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); } };
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 2026);
const rnd = (a, b) => a + (b - a) * R();
const T = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (did) return; did = true; try { fn(); } catch (e) { console.warn('[Nox WV] once threw', e); } } }); };
// the mockup's sfx(key, vol, rate): volume = vol * .75 (cfg.volume), playback rate kept
const VOL = cfg.volume == null ? 0.75 : cfg.volume;
const S_ = (at, key, v, rate) => { const url = A.sfx && A.sfx[key]; if (!url) return; once(at, () => { try { oni.sfx(url, { volume: Math.min(1, v * VOL), rate: rate || 1 }); } catch (e) {} }); };
const K0 = TOK.k, kf = feet(K0);
const deg = (d) => d * Math.PI / 180;
// toward the party: the first target, else the friendly tokens on the board, else the caster's facing
const DIR = (() => {
  if (FOES.length) return TOK[FOES[0]].x >= K0.x ? 1 : -1;
  const pcs = PLACE.filter((t) => t && t.document && t.document.disposition === 1 && t !== caster);
  if (pcs.length) return (pcs.reduce((s, t) => s + t.center.x, 0) / pcs.length) >= caster.center.x ? 1 : -1;
  return K0.dir || 1;
})();
// depth: size at a floor point relative to the caster's feet (the mockup's a.s)
const DC = new Map();
const depthFrom = (from, pt) => { const key = Math.round(from.x) + ',' + Math.round(from.y) + '|' + Math.round(pt.x) + ',' + Math.round(pt.y); let d = DC.get(key); if (d == null) { d = tl.depthRatio(from, pt); DC.set(key, d); } return d; };
const depthAt = (pt) => depthFrom(kf, pt);
const Sd = (k) => depthAt(feet(TOK[k]));
// a token's art box where it stands (mockup OX / OY = box bottom / hgt / wid) and the points the mockup reads off it
const boxT = (k) => { const q = TOK[k]; return { x: q.x, bottom: q.y + q.h / 2, h: q.h, w: q.w }; };
const PT = {
  body: (b) => ({ x: b.x, y: b.bottom - b.h * 0.5 }),
  hand: (b) => ({ x: b.x + DIR * b.w * 0.3, y: b.bottom - b.h * 0.62 }),
  head: (b) => ({ x: b.x + DIR * b.w * 0.12, y: b.bottom - b.h * 0.82 }),
  at: (b, f) => ({ x: b.x, y: b.bottom - b.h * f }),
};
// mockup front(t, gap): in front of a party battler, on the enemy side
const front = (k, gap) => { const f = feet(TOK[k]); return { x: f.x - DIR * gap * KP * Sd(k), y: f.y }; };

// a value track built from tweens: segs = [t0, ms, to, ease]; a later tween takes over from where the value is
function tw(init, segs) {
  const S = segs.slice().sort((a, b) => a[0] - b[0]); const starts = [];
  const valAt = (i, t) => { if (i < 0) return init; const sg = S[i]; if (t < sg[0]) return valAt(i - 1, t); const u = sg[1] > 0 ? clamp01((t - sg[0]) / sg[1]) : 1; return lerp(starts[i], sg[2], (sg[3] || X.lin)(u)); };
  for (let i = 0; i < S.length; i++) starts.push(i === 0 ? init : valAt(i - 1, S[i][0]));
  return (t) => { let i = S.length - 1; while (i >= 0 && t < S[i][0]) i--; return valAt(i, t); };
}

// ── painted bodies: bodyOf(key, (t) => state); state in board px, x/y = the feet; skip = leave the real token alone ──
const HOME = {}, BODY = {}, AFTER = [];
const BLANK = document.createElement('canvas'); BLANK.width = 2; BLANK.height = 2;
function bodyOf(k, fn) { if (!TOK[k]) return; HOME[k] = feet(TOK[k]); BODY[k] = fn; (tl.POSE[k] = tl.POSE[k] || {}).blank = { img: BLANK, foot: 1, w: 0.01, h: 0.01 }; }
// the hover the real token is drawn with (Flying / idle Float lift): a painted copy carries it
const HOV = {};
const hover = (k) => { if (k in HOV) return HOV[k]; let v = 0; try { const q = TOK[k], api = globalThis.FUCompanion.api.spriteShadow.airborne; if (q && q.token && api && typeof api.liftOf === 'function') v = Math.max(0, Number(api.liftOf(q.token)) || 0) * (q.m3d || 1); } catch (e) { v = 0; } HOV[k] = v; return v; };
function stAt(k, t) {
  const h = HOME[k]; const s = Object.assign({ x: h.x, y: h.y, air: 0, sx: 1, sy: 1, rot: 0, alpha: 1, hidden: false, skip: false, filter: '' }, BODY[k] ? BODY[k](t) : {});
  s.d = (s.x !== h.x || s.y !== h.y) ? depthFrom(h, s) : 1; s.air += hover(k); return s;
}
function boxS(k, s) { const q = TOK[k], d = s.d; const top = s.y - s.air - q.h * d * q.foot; return { x: s.x, top, bottom: top + q.h * d, h: q.h * d, w: q.w * d }; }
const natW = (im) => (im && (im.videoWidth || im.naturalWidth || im.width)) || 0;
const natH = (im) => (im && (im.videoHeight || im.naturalHeight || im.height)) || 0;
const BAKE = new Map();
function baked(k, filter) {
  const art = tl.art(k); if (!filter || !art) return art; const key = k + '|' + filter; let c = BAKE.get(key); if (c) return c;
  const w = natW(art), h = natH(art); if (!w || !h) return art;
  c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.filter = filter; x.drawImage(art, 0, 0, w, h); BAKE.set(key, c); return c;
}
// mockup px in a filter string ({n}) -> canvas px of the overlay under the board transform
const fpx = (g, n) => { let a = 1; try { a = Math.abs(g.getTransform().a); } catch (e) {} return Math.max(0, n * KP * a); };
const fil = (g, f) => (f ? f.replace(/\{(\d+(\.\d+)?)\}/g, (mm, n) => fpx(g, Number(n)).toFixed(2) + 'px') : '');
function paint(g, k, s, img, a, filter) {
  const q = TOK[k], art = img || tl.art(k); if (!art) return;
  g.save(); g.translate(s.x, s.y - s.air); if (s.rot) g.rotate(s.rot); g.scale(q.flip * s.sx * s.d, s.sy * s.d); g.globalAlpha = Math.max(0, Math.min(1, a)); if (filter) g.filter = filter;
  g.drawImage(art, -q.w / 2, -q.h * q.foot, q.w, q.h); g.restore();
}
const HAS_SH = (k) => { try { const t = TOK[k].token; const f1 = t.document.flags && t.document.flags[NS]; const f2 = t.actor && t.actor.flags && t.actor.flags[NS]; return !!((f1 && f1.spriteShadow) || (f2 && f2.spriteShadow)); } catch (e) { return false; } };
function bodyTrack(k, total) {
  const sh = HAS_SH(k), H = HOME[k], q0 = TOK[k];
  m.hold(0, total, (t, S) => {
    const s = stAt(k, t); if (s.skip) return; const q = S.tok[k]; if (!q) return;
    if (s.hidden || s.alpha <= 0) q.hidden = true;
    else { q.pose = 'blank'; q.dx = s.x - H.x; q.dy = s.y - H.y; q.air = s.air; q.alpha = Math.min(1, s.alpha); if (Math.abs(q.dy) > 0.5) q.noShadow = true; }
    if (sh && !s.hidden && Math.abs(s.y - H.y) > 0.5) S.world.push({ z: 2, draw: (g) => { const lk = Math.min(1, s.air / q0.h); g.save(); g.globalAlpha = 0.32 * (1 - 0.45 * lk) * Math.min(1, s.alpha); g.fillStyle = '#000'; g.beginPath(); g.ellipse(s.x, s.y, q0.w * 0.3 * s.d * (1 - 0.35 * lk), q0.w * 0.09 * s.d * (1 - 0.35 * lk), 0, 0, 6.2832); g.fill(); g.restore(); } });
    const z = 20 + 0.9 * clamp01((s.y - tl.STAGE.y) / Math.max(1, tl.STAGE.h));
    S.world.push({ z, draw: (g) => {
      for (const a of AFTER) { if (a.k !== k) continue; const age = t - a.t0; if (age < 0 || age >= a.ms) continue; const s2 = a.s || (a.s = stAt(k, a.t0)); if (s2.hidden || s2.skip) continue; paint(g, k, s2, baked(k, a.filter), a.op * (1 - X.sine(age / a.ms)), ''); }
      if (!s.hidden && s.alpha > 0) paint(g, k, s, null, s.alpha, fil(g, s.filter));
    } });
  });
}
// mockup afterimage(a, { opacity, ms, filter }) at time t0 (a snapshot of the painted body, fading out)
const afterimage = (k, t0, op, ms, filter) => AFTER.push({ k, t0, op, ms, filter: filter || 'brightness(1.6) saturate(.4)' });

// ── particles (world space; 'ground'/'field' sit under the battlers, 'hit' above everything) ──
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
// mockup ring(): an expanding floor ellipse (r0 / r1 / w in mockup px, times s)
const ring = (at, pt, o) => { o = o || {}; const rgb = o.rgb || '255,255,255', r0 = o.r0 == null ? 10 : o.r0, r1 = o.r1 == null ? 160 : o.r1, ms = o.ms || 600, sy = o.sy || 0.3, w = o.w || 6, s = (o.s || 1) * KP;
  part({ t0: at, life: ms, x: pt.x, y: pt.y, layer: o.layer || 'ground', draw: (g, x, y, u) => { const r = Math.max(0.1, lerp(r0, r1, X.outCubic(u)) * s); g.strokeStyle = 'rgba(' + rgb + ',' + (1 - u) + ')'; g.lineWidth = Math.max(0.5, w * (1 - u * 0.6) * s); g.beginPath(); g.ellipse(x, y, r, r * sy, 0, 0, 6.2832); g.stroke(); } }); };
// mockup shards(layer, pt, rgb, n, spread)
const shards = (at, layer, pt, rgb, n, spread) => { for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), sp = rnd(0.15, spread);
  part({ t0: at, life: rnd(600, 1000), x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 0.2, g: 0.0012, drag: 0.985, layer, rot0: rnd(0, 6), vr: rnd(-0.02, 0.02), sz: rnd(5, 11),
    draw: (g, x, y, u, age, p) => { const s = p.sz * KP; g.translate(x, y); g.rotate(p.rot0 + p.vr * age); g.globalAlpha = 1 - u; g.fillStyle = 'rgba(' + rgb + ',1)'; g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.6, 0); g.lineTo(0, s * 0.9); g.lineTo(-s * 0.5, 0); g.fill(); } }); } };
// mockup fumes(t, rgb, n): slow motes rising off a body (dust particles on the field layer)
const fumes = (at, k, rgb, n) => { const b = boxT(k); for (let i = 0; i < n; i++) {
  part({ t0: at, life: rnd(900, 1500), x: b.x + rnd(-b.w * 0.35, b.w * 0.35), y: b.bottom - b.h * rnd(0.15, 0.75), vx: rnd(-0.02, 0.02), vy: -rnd(0.03, 0.07), r: rnd(3, 7), layer: 'field',
    draw: (g, x, y, u, age, p) => { const a = Math.sin(u * Math.PI) * (0.5 + 0.5 * Math.sin(age / 120 + p.x)); g.fillStyle = 'rgba(' + rgb + ',' + a + ')'; g.beginPath(); g.arc(x, y, p.r * KP, 0, 6.2832); g.fill(); glw(g, x, y, p.r * 4 * KP, rgb, a * 0.35); } }); } };
// mockup jawSnap(pt, { s, rgb, glowRgb, ms }): two rows of bone fangs snap shut on a point
const jawSnap = (at, pt, o) => { o = o || {}; const s = (o.s || 1) * KP, rgb = o.rgb || '235,228,210', glowRgb = o.glowRgb || '255,255,255', ms = o.ms || 460;
  part({ t0: at, life: ms, x: pt.x, y: pt.y, layer: 'hit', comp: 'source-over', pos: () => pt, draw: (c, px, py, t) => {
    const k = t < 0.3 ? X.inCubic(t / 0.3) : 1, gap = 46 * s * (1 - k), a = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = a; const n = 5, wd = 15 * s;
    for (const dir of [-1, 1]) { const y0 = py + dir * (gap + 4 * s); c.strokeStyle = 'rgba(40,20,20,.9)'; c.lineWidth = 2 * KP;
      c.beginPath(); c.moveTo(px - n * wd / 2 - 6 * s, y0 + dir * 7 * s); c.lineTo(px + n * wd / 2 + 6 * s, y0 + dir * 7 * s); c.lineTo(px + n * wd / 2 + 6 * s, y0); c.lineTo(px - n * wd / 2 - 6 * s, y0); c.closePath(); c.fillStyle = 'rgba(70,28,34,.9)'; c.fill();
      c.fillStyle = 'rgb(' + rgb + ')'; for (let i = 0; i < n; i++) { const x = px - n * wd / 2 + i * wd + wd / 2, L = (i === 0 || i === n - 1 ? 22 : 13) * s; c.beginPath(); c.moveTo(x - wd * 0.42, y0); c.lineTo(x, y0 - dir * L); c.lineTo(x + wd * 0.42, y0); c.closePath(); c.fill(); c.stroke(); } }
    if (t > 0.28 && t < 0.5) { c.globalCompositeOperation = 'lighter'; glw(c, px, py, 70 * s, glowRgb, 0.8 * (1 - (t - 0.28) / 0.22)); } } }); };
// mockup soulStream(from, to, { n, ms, spread, rgb, arc }): jade soul-light homing from one point to another
const soulStream = (at, from, to, o) => { o = o || {}; const n = o.n || 16, ms = o.ms || 800, spread = (o.spread == null ? 30 : o.spread) * KP, rgb = o.rgb || JADE, arc = (o.arc == null ? 90 : o.arc) * KP;
  for (let i = 0; i < n; i++) { const t0 = at + i * ms / n * 0.6; const f = { x: from.x + rnd(-spread, spread), y: from.y + rnd(-spread, spread) }; const life = ms * rnd(0.7, 1) * rnd(0.85, 1.15), r = rnd(2.5, 4.5);
    const cx = (f.x + to.x) / 2 + rnd(-arc, arc), cy = Math.min(f.y, to.y) - rnd(arc * 0.3, arc);
    const pos = (age) => { const tt = X.in(Math.min(1, age / life)), u = 1 - tt; return { x: u * u * f.x + 2 * u * tt * cx + tt * tt * to.x, y: u * u * f.y + 2 * u * tt * cy + tt * tt * to.y }; };
    part({ t0, life, pos, layer: 'hit', draw: (g, x, y, u, age) => { const pv = pos(Math.max(0, age - 16)); glw(g, x, y, r * 3.5 * KP, rgb, 0.95); g.strokeStyle = 'rgba(' + rgb + ',.5)'; g.lineWidth = r * KP; g.beginPath(); g.moveTo(pv.x, pv.y); g.lineTo(x, y); g.stroke(); } }); } };
// mockup fly(): a projectile drawn along its travel (draw(g, age) in mockup px, tip at 0,0 pointing +x)
function fly(at, from, to, o) {
  const ms = o.ms || 450, ease = o.ease || X.lin, arc = (o.arc || 0) * KP;
  const posAt = (age) => { const u = ease(Math.min(1, age / ms)); return { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - arc * Math.sin(Math.PI * u) }; };
  const angAt = (age) => { const a = posAt(Math.max(0, age - 8)), b = posAt(Math.min(ms, age + 8)); return Math.atan2(b.y - a.y, b.x - a.x); };
  m.hold(at, at + ms, (age, S) => { const p = posAt(age), an = angAt(age); S.world.push({ z: o.z || 31, draw: (g) => { g.save(); g.translate(p.x, p.y); g.rotate(an); g.scale(KP, KP); o.draw(g, age); g.restore(); } }); });
  return at + ms;
}
// ── clips: size = source px * scale * the library factor (pixelfx / MV .55); LIVE scales by depth itself, the takeover by s ──
const fx = (key, at, pt, scale, s, o) => { const c = CL[key]; if (!c) return null; return m.clip(key, at, Object.assign({ x: pt.x, y: pt.y, w: c.w * scale * (c.k || 0.55) * KP * (LIVE ? 1 : (s || 1)), z: 26 }, o || {})); };
// mockup pxClip: back layer under the battlers, front over them, light over that (additive)
const px = (name, at, pt, scale, s, o) => { o = o || {}; const base = Object.assign({}, o); delete base.z; delete base.zl; delete base.back;
  if (o.back !== false && CL[name + '_back']) fx(name + '_back', at, pt, scale, s, Object.assign({}, base, { z: 3 }));
  if (CL[name + '_front']) fx(name + '_front', at, pt, scale, s, Object.assign({}, base, { z: o.z == null ? 28 : o.z }));
  if (CL[name + '_light']) fx(name + '_light', at, pt, scale, s, Object.assign({}, base, { z: o.zl == null ? 29 : o.zl })); };
const rumble = (t0, t1, px2) => m.hold(t0, t1, (e, S) => { S.shake = Math.max(S.shake, px2 * KP); });

// ── camera (full takeover only): the mockup's FCAM.to (x/y linear, zoom in log space) and camFollow (per-frame
// catch-up, replayed at 60 fps so every client gets the same path) ──
const CAMOPS = [];
const camTo = (at, ms, to, ease) => CAMOPS.push({ type: 'to', at, ms, to, ease: ease || X.sine });
const camFollow = (at, end, k, o) => { o = o || {}; CAMOPS.push({ type: 'follow', at, end, k, z: o.z == null ? 1.15 : o.z, kk: o.k == null ? 0.1 : o.k, up: o.up == null ? 0.55 : o.up }); };
function camTrack(total) {
  if (LIVE || !CAMOPS.length) return;
  const FRM = 1000 / 60, frames = []; let c = { x: tl.REST.cx, y: tl.REST.cy, z: 1 }; const st = new Map();
  for (let t = 0; t <= total + FRM; t += FRM) {
    for (const op of CAMOPS) {
      if (t < op.at) continue;
      if (op.type === 'to') { if (!st.has(op)) st.set(op, { x: c.x, y: c.y, z: c.z }); if (t > op.at + op.ms + FRM) continue; const s0 = st.get(op), e = op.ease(clamp01((t - op.at) / op.ms));
        const tx = op.to.x == null ? s0.x : op.to.x, ty = op.to.y == null ? s0.y : op.to.y, tz = op.to.z == null ? s0.z : op.to.z;
        c = { x: lerp(s0.x, tx, e), y: lerp(s0.y, ty, e), z: Math.exp(lerp(Math.log(s0.z), Math.log(tz), e)) }; }
      else if (t < op.end) { const s = stAt(op.k, t), b = boxS(op.k, s); const tx = b.x, ty = b.bottom - b.h * op.up; c = { x: c.x + (tx - c.x) * op.kk, y: c.y + (ty - c.y) * op.kk, z: c.z + (op.z - c.z) * op.kk * 0.6 }; }
    }
    frames.push({ cx: c.x, cy: c.y, zoom: c.z });
  }
  m.hold(0, total, (t, S) => { S.cam = frames[Math.min(frames.length - 1, Math.floor(t / FRM))]; });
}

// run the shot: damage gate at 'gate' (null = the shot fires it itself), the ready hook on the first frame
async function runShot(total, gate) {
  for (const k of Object.keys(BODY)) bodyTrack(k, total);
  particleTrack(total); camTrack(total);
  if (gate != null) once(gate, () => oni.fireDone());
  await tl.run(T, { total, sfx: [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
  oni.fireDone();
}
