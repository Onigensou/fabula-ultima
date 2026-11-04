// ── Party kit (prepended to every party shot by party-signatures.js) ─────────
// Ports of the approved "Party Action Animations" mockup helpers onto
// oni.timeline. Mockup px were drawn for a ~300 px tall battler, so every size
// and distance below is multiplied by U = caster height / 300.
// Storage rules: no backticks and no dollar-brace anywhere in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && (!caster || t.id !== caster.id));

// boot(extra): the timeline with the caster as 'c', targets as t0..tn, plus extra tokens.
async function boot(extra) {
  const tokens = {};
  if (caster) tokens.c = cfg.foot ? { token: caster, foot: cfg.foot } : { token: caster };
  const TG = [];
  targets.forEach((t, i) => { const k = 't' + i; TG.push(k); tokens[k] = cfg.targetFoot ? { token: t, foot: cfg.targetFoot } : { token: t }; });
  Object.assign(tokens, extra || {});
  const tl = oni.timeline({ tokens, clips: A.clips || {}, images: A.images || {} });
  await tl.load();
  const T = []; const m = tl.mk(T);
  const TOK = tl.TOK;
  const U = ((TOK.c && TOK.c.h) || 300) / 300;
  return { tl, T, m, TOK, TG, U, E: tl.E };
}
const K = {};
K.ready = () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } };
K.dirOf = (TOK, k) => (TOK[k] && TOK[k].dir) || -1;
K.feet = (tl, k) => { const t = tl.TOK[k]; return tl.feet(t); };
K.mid = (tl, k) => { const t = tl.TOK[k]; const f = tl.feet(t); return { x: f.x, y: f.y - t.h * 0.5 }; };
K.head = (tl, k) => { const t = tl.TOK[k]; const f = tl.feet(t); return { x: f.x, y: f.y - t.h * 0.92 }; };
// BD places a summon at caster_front: caster centre +/- max(1.15 cell, meshW/2 + 0.65 cell) toward stage centre.
K.summonSpot = (tl, k) => { const t = tl.TOK[k]; const f = tl.feet(t); const g = tl.GRID; const sx = (tl.REST.cx < f.x) ? -1 : 1; return { x: f.x + sx * Math.max(1.15 * g, t.w / 2 + 0.65 * g), y: f.y }; };
// CSS-filter tint for white GG mask clips (the mockup recipe: sepia gives ~38deg, then rotate).
K.tintF = (hue, sat, br) => 'sepia(1) saturate(' + (sat || 5) + ') hue-rotate(' + Math.round(hue - 38) + 'deg) brightness(' + (br || 1.1) + ')';
K.ease = (E, name) => (name && E[name]) || E.ioQ;
// A token path: keys = [[t, dx, dy, ease?], ...]; held between keys, nothing before/after.
K.path = (m, E, k, keys) => {
  const t0 = keys[0][0], t1 = keys[keys.length - 1][0];
  m.hold(t0, t1 + 1, (tl, S) => {
    const t = tl + t0; const q = S.tok[k]; if (!q) return;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      if (t <= b[0]) { const u = (b[0] === a[0]) ? 1 : K.ease(E, b[3])(Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])))); q.dx += a[1] + (b[1] - a[1]) * u; q.dy += a[2] + (b[2] - a[2]) * u; return; }
    }
  });
};
// Step out toward the enemy and back. dist in mockup px.
K.step = (m, E, U, dir, k, out, hold, back, dist) => K.path(m, E, k, [[out, 0, 0], [out + 380, dir * dist * U, 0, 'ioQ'], [back, dir * dist * U, 0], [back + 460, 0, 0, 'ioQ']]);
// RO hexagram cast circle under k's feet. Eases in (scale .55 to 1 + fade, 380 ms),
// loops while channelling, fades out (420 ms) when released. Ground layer (z 2).
K.circle = (tl, m, U, k, at, hold, hue, o) => {
  o = o || {}; const f0 = tl.feet(tl.TOK[k]); const f = { x: f0.x + (o.dx || 0), y: f0.y }; const s = (o.scale || 1) * Math.max(0.8, tl.TOK[k].w / (170 * U)) * U;
  const dur = hold + 420; const w = 112 * 1.9 * 0.85 * 2.0 * s;
  const shift = 'hue-rotate(' + Math.round(hue - 268) + 'deg) brightness(1.35)';
  const alpha = (u) => { const t = u * dur; return t < 380 ? t / 380 : t > hold ? Math.max(0, 1 - (t - hold) / 420) : 1; };
  const live = (t) => ({ x: f.x, y: f.y + 4 * U, w: w * (t < 380 ? 0.55 + 0.45 * tl.E.outQ(t / 380) : t > hold ? 1 + 0.08 * (t - hold) / 420 : 1) });
  m.clip('mc', at, { x: f.x, y: f.y, w, z: 2, add: true, loop: true, hold: dur, filter: shift, alpha, live });
  if (o.ring) {
    const rw = (A.clips[o.ring] ? A.clips[o.ring].w : 592) * 1.9 * 0.85 * 0.95 * s;
    m.clip(o.ring, at, { x: f.x, y: f.y, w: rw, z: 2, add: true, loop: true, hold: dur, filter: 'hue-rotate(' + Math.round(hue - 265) + 'deg) brightness(1.1)', alpha, live: (t) => ({ x: f.x, y: f.y + 4 * U, w: rw * (t < 380 ? 0.55 + 0.45 * tl.E.outQ(t / 380) : 1) }) });
  }
  // the caster's glow while channelling
  m.tint(at, hold, k, 'hsl(' + hue + ',90%,70%)', (u) => 0.35 * Math.sin(Math.PI * u));
};
// Wisp (port of battle-director/particles/wisps.js draw) on a travel path:
// lift lift px off from, then home along an arc to to. Trail = the path sampled into the past.
K.wisp = (m, at, from, to, o) => {
  o = o || {}; const U = o.U || 1; const rgb = o.rgb || '110,180,255'; const rad = (o.rad || 7) * U;
  const liftMs = o.liftMs || 380, travelMs = o.travelMs || 900, lift = (o.lift || 46) * U, arcH = (o.arcH || 120) * U;
  const ph = o.phase != null ? o.phase : Math.random() * 6.28, sw = (o.sway || 16) * U;
  const pos = (e) => {
    const up = { x: from.x + Math.sin(ph) * 18 * U, y: from.y - lift };
    if (e < liftMs) { const k = 1 - (1 - e / liftMs) * (1 - e / liftMs); return { x: from.x + (up.x - from.x) * k, y: from.y + (up.y - from.y) * k }; }
    const k = Math.min(1, (e - liftMs) / travelMs), q = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    return { x: up.x + (to.x - up.x) * q + Math.sin(k * 9 + ph) * sw * (1 - k), y: up.y + (to.y - up.y) * q - Math.sin(k * Math.PI) * arcH };
  };
  const end = liftMs + travelMs;
  m.hold(at, at + end, (e, S) => {
    S.world.push({ z: 60, draw: (g) => {
      const a = Math.min(1, e / 180); const p = pos(e);
      g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
      const n = 20; let prev = null;
      for (let i = n; i >= 0; i--) { const q = pos(Math.max(0, e - i * 16)); if (prev) { const f = 1 - i / n; g.strokeStyle = 'rgba(' + rgb + ',' + (0.42 * f * a).toFixed(3) + ')'; g.lineWidth = rad * 2.4 * f; g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(q.x, q.y); g.stroke(); } prev = q; }
      const hr = rad * 7; let gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, hr);
      gr.addColorStop(0, 'rgba(' + rgb + ',' + (0.5 * a).toFixed(3) + ')'); gr.addColorStop(0.35, 'rgba(' + rgb + ',' + (0.16 * a).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, hr, 0, 6.283); g.fill();
      const tw = 0.6 + 0.4 * Math.sin(e * 0.013 + ph), L = rad * 7.5 * tw;
      g.save(); g.translate(p.x, p.y); g.rotate(ph + e * 0.002);
      for (let q2 = 0; q2 < 4; q2++) { const len = q2 < 2 ? L : L * 0.5; g.save(); g.rotate(q2 * Math.PI / 2 + (q2 >= 2 ? Math.PI / 4 : 0)); const lg = g.createLinearGradient(-len, 0, len, 0); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,' + ((q2 < 2 ? 0.85 : 0.45) * a * tw).toFixed(3) + ')'); lg.addColorStop(1, 'rgba(255,255,255,0)'); g.strokeStyle = lg; g.lineWidth = 1.4 * U; g.beginPath(); g.moveTo(-len, 0); g.lineTo(len, 0); g.stroke(); g.restore(); }
      g.restore();
      gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 1.9); gr.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')'); gr.addColorStop(0.5, 'rgba(255,255,255,' + (0.7 * a).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, rad * 1.9, 0, 6.283); g.fill();
      g.restore();
    } });
  });
  return at + end;
};
// Glass shards (or embers) flung from pt; deterministic per seed.
K.shards = (tl, m, at, pt, color, n, spread, U, seed) => {
  const r = tl.rng(seed || 7); const P2 = [];
  for (let i = 0; i < n; i++) P2.push({ a: r() * 6.283, d: spread * U * (0.5 + r() * 0.6), r0: r() * 6.28, rs: (r() - 0.5) * 16, ms: 700 + r() * 300 });
  m.hold(at, at + 1000, (e, S) => S.world.push({ z: 62, draw: (g) => {
    for (const s of P2) { const u = Math.min(1, e / s.ms); if (u >= 1) continue; const k = 1 - (1 - u) * (1 - u);
      g.save(); g.translate(pt.x + Math.cos(s.a) * s.d * k, pt.y + Math.sin(s.a) * s.d * k + 90 * U * u * u); g.rotate(s.r0 + s.rs * u); g.scale(1 - 0.5 * u, 1 - 0.5 * u);
      g.globalAlpha = 1 - u; g.globalCompositeOperation = 'lighter'; const gr = g.createLinearGradient(-8 * U, -11 * U, 8 * U, 11 * U); gr.addColorStop(0, '#fff'); gr.addColorStop(1, color); g.fillStyle = gr;
      g.beginPath(); g.moveTo(0, -11 * U); g.lineTo(8 * U, -2 * U); g.lineTo(3 * U, 11 * U); g.lineTo(-8 * U, 4 * U); g.closePath(); g.fill(); g.restore(); }
  } }));
};
// A soft glowing orb travelling an arc (from, to) over ms.
K.orb = (m, at, from, to, ms, h, color, size, U) => {
  m.hold(at, at + ms, (e, S) => { const k = e / ms, q = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; const x = from.x + (to.x - from.x) * q, y = from.y + (to.y - from.y) * q - Math.sin(k * Math.PI) * h * U;
    S.world.push({ z: 61, draw: (g) => { const r = size * U; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill(); g.restore(); } }); });
};
// GG twinkle sparks around pt (mask clip, tinted).
K.twinkles = (m, at, pt, color, n, spread, U, seed) => {
  const r = Math.random; for (let i = 0; i < n; i++) m.clip('twinkle', at + i * 70, { x: pt.x + (r() - 0.5) * spread * 2 * U, y: pt.y + (r() - 0.5) * spread * 2 * U, w: 64 * 1.6 * 0.85 * U, z: 63, add: true, filter: color });
};

// ── Phantasm skins: draw(g, x, feetY, alpha, scale, t) at a feet point. ──
//   mirage  = Illusionist default: a violet double of the CASTER (red/cyan split, flicker).
//   foxfire = Keren: her Fox fire summon art (A.images.foxfire), a pink spirit flame.
K.skin = (tl, name, U) => {
  if (name === 'foxfire') {
    const img = tl.IMG.foxfire; const size = 120 * U;
    return { h: size + 40 * U, draw(g, x, y, a, s, t) { if (!img || a <= 0) return; const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1; const h = size * (s || 1), w = h * iw / ih; const fl = 1 + 0.06 * Math.sin(t / 60);
      g.save(); g.translate(x, y - 40 * U); g.scale(1 / fl, fl); g.globalAlpha = a; g.shadowColor = '#ff6fb4'; g.shadowBlur = 18 * U; g.drawImage(img, -w / 2, -h, w, h); g.globalCompositeOperation = 'lighter'; g.globalAlpha = a * 0.35; g.drawImage(img, -w / 2, -h, w, h); g.restore(); } };
  }
  const art = tl.art('c'); const T0 = tl.TOK.c;
  return { h: T0 ? T0.h : 300 * U, draw(g, x, y, a, s, t) { if (!art || !T0 || a <= 0) return; const w = T0.w * (s || 1), h = T0.h * (s || 1); const j = (Math.floor(t / 70) % 12 === 0) ? 9 * U : 4 * U;
    const one = (f, al, ox, add) => { g.save(); g.translate(x + ox, y); g.scale(T0.flip, 1); g.globalAlpha = al; g.filter = f; if (add) g.globalCompositeOperation = 'lighter'; g.drawImage(art, -w / 2, -h * T0.foot, w, h); g.restore(); };
    one('grayscale(1) sepia(1) saturate(4) hue-rotate(225deg) brightness(1.35) drop-shadow(0 0 8px #b98cff)', a * (0.72 + 0.08 * Math.sin(t / 70)), 0, false);
    one('grayscale(1) sepia(1) saturate(8) hue-rotate(-50deg)', a * 0.32, -j, true);
    one('grayscale(1) sepia(1) saturate(8) hue-rotate(140deg)', a * 0.32, j, true); } };
};
// Draw a phantasm along posFn(e) -> { x, y (feet), a, s } between t0 and t1, with afterimages when moving.
K.phantasm = (m, skin, t0, t1, posFn, trail) => {
  m.hold(t0, t1, (e, S) => S.world.push({ z: 30, draw: (g) => {
    if (trail) for (let i = 4; i >= 1; i--) { const q = posFn(Math.max(0, e - i * 60)); const p0 = posFn(e); if (Math.hypot(q.x - p0.x, q.y - p0.y) < 4) continue; g.save(); g.filter = 'blur(2px)'; skin.draw(g, q.x, q.y, (q.a || 1) * 0.3 * (1 - i / 5), q.s, e); g.restore(); }
    const p = posFn(e); skin.draw(g, p.x, p.y, p.a == null ? 1 : p.a, p.s, e);
  } }));
};
// Ring under a point on the ground (z 2), expanding; used as an arrival / selection mark.
K.groundRing = (m, at, ms, pt, r0, r1, color, U, dashed) => {
  m.hold(at, at + ms, (e, S) => S.world.push({ z: 2, draw: (g) => { const u = e / ms; const r = (r0 + (r1 - r0) * (dashed ? 1 : u)) * U; g.save(); g.globalCompositeOperation = 'lighter'; g.strokeStyle = color; g.lineWidth = 4 * U; g.globalAlpha = dashed ? 0.9 : 1 - u; if (dashed) { g.setLineDash([10 * U, 8 * U]); g.lineDashOffset = -e / 20; } g.beginPath(); g.ellipse(pt.x, pt.y, r, r * 0.37, 0, 0, 6.283); g.stroke(); g.restore(); } }));
};
