// ── Love kit (prepended after the party _kit + _zpkit by legacy-love-signatures.js) ──
// Shared pieces of Love's eight moves, ported from the approved "Legacy boss" mockup
// (part-b3.js Love defs, part-common.js kit, Serenade from part-r9 + part-r10).
// Mockup units: a 1682 x 788 stage with Love ~169 px tall (Love_Standard.png, 1x1 token,
// texture scale 1.54). Body sizes and speeds scale by LV.U = Love's drawn height / 169.4.
// The mockup has Love on the LEFT and the party on the RIGHT; every x offset and every
// rotation is mirrored by LV.DIR (+1 = the party is to his right).
// Mockup sfx volumes were x0.75 of the given number; LV.S applies that.
// Storage rules: no backticks and no dollar-brace anywhere in this file.
const LV = {};
LV.PI = Math.PI;
LV.rnd = Math.random;
LV.r = (a, b) => a + (b - a) * Math.random();
LV.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// sfx cue at absolute ms; the engine dedupes on at|url, so a second identical cue moves 1 ms
LV.sfx = []; LV._seen = new Set();
LV.S = (at, key, v) => { const url = (A.sfx || {})[key] || key; if (!url) return; let t = Math.round(at); while (LV._seen.has(t + '|' + url)) t += 1; LV._seen.add(t + '|' + url); LV.sfx.push({ at: t, url, v: Math.min(1, (v == null ? 0.55 : v) * 0.75) }); };
// a raw-volume cue (the shipped Overdrive is 0.9, not x0.75)
LV.Sraw = (at, key, v) => { const url = (A.sfx || {})[key] || key; if (!url) return; LV.sfx.push({ at: Math.round(at), url, v }); };

const LIVE_OK = (t) => t && t.mesh && t.visible !== false && !(t.document && t.document.hidden);
LV.disp = (t) => Number(t && t.document ? t.document.disposition : 0);
// his side (same disposition, visible) and the other side
LV.sides = () => {
  const mine = LV.disp(caster); const allies = [], foes = [];
  for (const t of (canvas.tokens && canvas.tokens.placeables) || []) { if (!t || t.id === caster.id || !LIVE_OK(t)) continue; (LV.disp(t) === mine ? allies : foes).push(t); }
  return { allies, foes };
};
// after boot(): direction to the party, unit, helpers on drawn feet
LV.init = (tl, TOK, foes) => {
  LV.tl = tl; LV.TOK = TOK; LV.E = tl.E;
  LV.U = ((TOK.c && TOK.c.h) || 169.4) / 169.4;
  let dir = 0;
  const list = (foes && foes.length) ? foes : targets;
  if (list.length) { let sx = 0; for (const t of list) sx += t.center.x; dir = (sx / list.length) >= caster.center.x ? 1 : -1; }
  else dir = (tl.REST.cx >= caster.center.x) ? 1 : -1;
  LV.DIR = dir;
};
LV.F = (k) => LV.tl.feet(LV.TOK[k]);
LV.body = (k, lift) => { const T = LV.TOK[k], f = LV.F(k); return { x: f.x, y: f.y - (lift || 0) - T.h * 0.5 }; };
LV.head = (k) => { const T = LV.TOK[k], f = LV.F(k); return { x: f.x, y: f.y - T.h * 0.92 }; };
LV.hand = (k) => { const T = LV.TOK[k], f = LV.F(k); return { x: f.x + LV.DIR * T.w * 0.3, y: f.y - T.h * 0.62 }; };

// Keyed property curve on token k: keys [[t, value, ease]]; ease names from tl.E (lin, outQ, inQ, outC, sine, ioQ).
// rot in degrees (mirrored by DIR), sx / sy multiply, dx (mirrored by DIR when mirror), dy / air add (world px).
LV.keys = (m, k, prop, keys, mirror) => {
  const E = LV.E; const t0 = keys[0][0], t1 = keys[keys.length - 1][0];
  m.hold(t0, t1 + 1, (e, S) => {
    const t = e + t0; const q = S.tok[k]; if (!q) return; let v = keys[keys.length - 1][1];
    for (let i = 1; i < keys.length; i++) { const a = keys[i - 1], b = keys[i]; if (t <= b[0]) { const u = b[0] === a[0] ? 1 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))); v = a[1] + (b[1] - a[1]) * ((E[b[2] || 'lin'] || E.lin)(u)); break; } }
    if (prop === 'rot') q.rot += v * LV.PI / 180 * LV.DIR;
    else if (prop === 'sx' || prop === 'sy') q[prop] *= v;
    else q[prop] += v * (mirror ? LV.DIR : 1);
  });
};
// the mockup's hop(a, h, n): up 170 ms outCubic, down 150 ms in, n times (air, mockup px)
LV.hopKeys = (at, h, n) => { const k = [[at, 0]]; let t = at; for (let i = 0; i < n; i++) { k.push([t + 170, h * LV.U, 'outC']); k.push([t + 320, 0, 'inQ']); t += 320; } return k; };

// One draw list per z (world) or for the screen; particles live in it from t0 for life ms.
// p.draw(g, e (ms since t0), u (0..1)) draws in world (or screen) coordinates.
LV.layer = (m, z, screen) => {
  const L = [];
  m.hold(0, 1e9, (t, S) => {
    if (!L.length) return;
    const item = { z, draw: (g) => { for (const p of L) { const e = t - p.t0; if (e < 0 || e >= p.life) continue; g.save(); try { p.draw(g, e, e / p.life); } catch (err) {} g.restore(); } } };
    (screen ? S.screen : S.world).push(item);
  });
  return L;
};

// ── pre-rendered shapes (glow drawn additive, body source-over, as the mockup's SHAPE) ──
LV._shape = new Map();
LV.shape = (name, r, rgb) => {
  const key = name + '|' + r + '|' + rgb; if (LV._shape.has(key)) return LV._shape.get(key);
  const R0 = r * LV.U; const gr = (name === 'heart' ? 2.2 : 2) * R0; const pad = 4;
  const half = Math.ceil(Math.max(gr, R0 * 2.4) + pad);
  const mkC = () => { const c = document.createElement('canvas'); c.width = half * 2; c.height = half * 2; const x = c.getContext('2d'); x.translate(half, half); return [c, x]; };
  const [gc, gx] = mkC(); const ga = name === 'heart' ? 0.7 : 0.6;
  const grad = gx.createRadialGradient(0, 0, 0, 0, 0, gr); grad.addColorStop(0, 'rgba(' + rgb + ',' + ga + ')'); grad.addColorStop(1, 'rgba(' + rgb + ',0)'); gx.fillStyle = grad; gx.beginPath(); gx.arc(0, 0, gr, 0, 6.2832); gx.fill();
  const [bc, bx] = mkC(); bx.fillStyle = 'rgb(' + rgb + ')';
  if (name === 'heart') { bx.beginPath(); bx.moveTo(0, R0 * 0.9); bx.bezierCurveTo(-R0 * 1.5, -R0 * 0.2, -R0 * 0.6, -R0 * 1.3, 0, -R0 * 0.45); bx.bezierCurveTo(R0 * 0.6, -R0 * 1.3, R0 * 1.5, -R0 * 0.2, 0, R0 * 0.9); bx.fill(); }
  else { bx.beginPath(); bx.ellipse(0, 0, R0 * 0.75, R0 * 0.55, -0.4, 0, 6.2832); bx.fill(); bx.fillRect(R0 * 0.5, -R0 * 2.2, 2.4 * LV.U, R0 * 2.2); bx.fillRect(R0 * 0.5, -R0 * 2.2, R0 * 0.9, 3 * LV.U); }
  const out = { glow: gc, body: bc, half }; LV._shape.set(key, out); return out;
};
LV.drawShape = (g, sh, x, y, ang, a) => {
  g.translate(x, y); if (ang) g.rotate(ang);
  g.globalAlpha = a; g.globalCompositeOperation = 'lighter'; g.drawImage(sh.glow, -sh.half, -sh.half);
  g.globalCompositeOperation = 'source-over'; g.drawImage(sh.body, -sh.half, -sh.half);
};
LV.HEART = '255,110,170'; LV.NOTE = '255,214,120';
LV.NOTE_RGB = ['255,214,120', '255,140,190', '150,220,255'];
LV.CONCERT = ['255,60,170', '60,200,255', '255,190,60', '120,255,120', '190,110,255', '255,90,80'];

// fly(): the mockup's projectile path: lerp + arc lift, eased, drawn pointing along travel
LV.flyPos = (from, to, arc, ease, e, ms) => { const u = ease(Math.min(1, Math.max(0, e / ms))); return { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u - arc * Math.sin(LV.PI * u) }; };
LV.fly = (L, at, from, to, ms, arc, ease, drawFn) => {
  L.push({ t0: at, life: ms, draw: (g, e) => { const p = LV.flyPos(from, to, arc, ease, e, ms), q = LV.flyPos(from, to, arc, ease, Math.max(0, e - 16), ms); const ang = (Math.hypot(p.x - q.x, p.y - q.y) > 0.01) ? Math.atan2(p.y - q.y, p.x - q.x) : 0; drawFn(g, p.x, p.y, ang, e); } });
};
// toss(): shapes thrown up and away (mockup px/ms, gravity), fading over the last quarter
LV.toss = (L, at, pt, n, shapeFn, o) => {
  o = o || {}; const up = o.up == null ? 0.35 : o.up, spread = o.spread == null ? 0.25 : o.spread, life = o.life || 900, gv = o.g == null ? 0.0009 : o.g; const U = LV.U;
  for (let i = 0; i < n; i++) { const x0 = pt.x + LV.r(-10, 10) * U, vx = LV.r(-spread, spread), vy = -LV.r(up * 0.6, up), lf = life * LV.r(0.8, 1.2), sh = shapeFn(i);
    L.push({ t0: at, life: lf, draw: (g, e, u) => { const a = u > 0.75 ? 1 - (u - 0.75) / 0.25 : 1; LV.drawShape(g, sh, x0 + vx * e * U, pt.y + (vy * e + 0.5 * gv * e * e) * U, 0, a); } }); }
};
// noteStream(): a note every 'every' ms from Love's hand between t0 and t1 (mockup: life 1400, rises, wobbles)
LV.noteStream = (L, t0, t1, every, from) => {
  const U = LV.U;
  for (let at = t0; at < t1; at += every) { const vx = LV.r(-0.05, 0.12) * LV.DIR, vy = -LV.r(0.06, 0.12), sh = LV.shape('note', 8, LV.pick(LV.NOTE_RGB));
    L.push({ t0: at, life: 1400, draw: (g, e, u) => { LV.drawShape(g, sh, from.x + vx * e * U + Math.sin(e / 200) * 8 * U, from.y + vy * e * U, 0, Math.sin(u * LV.PI)); } }); }
};
// twinkles(): four-point sparkles round pt (life 500-900)
LV.twinkles = (L, at, pt, n, r, rgb) => {
  const U = LV.U, glow = LV.tl.draw.glowCircle;
  for (let i = 0; i < n; i++) { const x = pt.x + LV.r(-r, r) * U, y = pt.y + LV.r(-r, r) * 0.8 * U, s = LV.r(5, 11) * U;
    L.push({ t0: at, life: LV.r(500, 900), draw: (g, e, u) => { const k = Math.sin(u * LV.PI) * s; glow(g, x, y, k * 2.5, 'rgba(' + rgb + ',0.7)', 1); g.globalCompositeOperation = 'lighter'; g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(x, y - k * 1.6); g.lineTo(x + k * 0.3, y); g.lineTo(x, y + k * 1.6); g.lineTo(x - k * 0.3, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - k * 1.6, y); g.lineTo(x, y + k * 0.3); g.lineTo(x + k * 1.6, y); g.lineTo(x, y - k * 0.3); g.closePath(); g.fill(); } }); }
};
// dustBurst(): soft dust puffs kicked up from the feet (drag 0.97 per 16 ms)
LV.dust = (L, at, pt, n, s) => {
  const U = LV.U * (s || 1); const K = 16 / Math.log(1 / 0.97);
  for (let i = 0; i < n; i++) { const an = LV.r(LV.PI, LV.PI * 2), sp = LV.r(0.08, 0.25), sv = LV.r(0.02, 0.1), x0 = pt.x + LV.r(-10, 10) * U, rr = LV.r(8, 18) * U;
    L.push({ t0: at, life: LV.r(500, 900), draw: (g, e, u) => { const d = K * (1 - Math.pow(0.97, e / 16)); g.globalCompositeOperation = 'source-over'; g.fillStyle = 'rgba(190,170,140,' + (0.45 * (1 - u)).toFixed(3) + ')'; g.beginPath(); g.arc(x0 + Math.cos(an) * sp * d * U, pt.y + Math.sin(an) * sv * d * U, rr * (1 + u), 0, 6.2832); g.fill(); } }); }
};
// coinsTo(): n coins from one point to another (stagger 70 ms, arc 70-130, sine), spinning
LV.coinsTo = (L, at, from, to, n, ms) => {
  const U = LV.U, ease = LV.E.sine, R0 = 7 * U;
  for (let i = 0; i < n; i++) { const f = { x: from.x + LV.r(-12, 12) * U, y: from.y }, arc = LV.r(70, 130) * U;
    LV.fly(L, at + i * 70, f, to, ms, arc, ease, (g, x, y, ang, e) => { const kk = Math.abs(Math.cos(e / 70)); g.translate(x, y); g.rotate(ang); g.globalCompositeOperation = 'source-over'; g.fillStyle = '#e8b32a'; g.beginPath(); g.ellipse(0, 0, R0 * Math.max(0.15, kk), R0, 0, 0, 6.2832); g.fill(); g.fillStyle = '#fff3b0'; g.fillRect(-1 * U, -R0 * 0.6, 2 * U, R0 * 0.5); }); }
  return at + ms;
};
// the shipped Zero Power cut-in with pixel-art scaling (mockup cutin(src, { pixel: true }))
LV.cutin = (tl, m, at, key) => {
  const inMs = 650, hold = 850, outMs = 650, end = inMs + hold + outMs;
  m.hold(at, at + end, (e, S) => { const img = tl.IMG[key]; if (!img) return; S.screen.push({ draw: (g) => {
    const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1; const h = g.H * 0.92, w = h * iw / ih;
    const x = e < inMs ? -1.2 * g.W * (1 - ZP.cssOut(e / inMs)) : e < inMs + hold ? 0 : 1.2 * g.W * ZP.cssIn((e - inMs - hold) / outMs);
    g.save(); g.globalAlpha = 1; g.imageSmoothingEnabled = false; g.drawImage(img, x, g.H - h, w, h); g.restore(); } }); });
  return at + end;
};
// fire the gate once at 'at'
LV.gate = (m, at) => ZP.once(m, at, () => oni.fireDone());
