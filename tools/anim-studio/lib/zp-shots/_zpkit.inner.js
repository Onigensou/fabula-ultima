// ── Zero Power kit (prepended after the party _kit by zp-signatures.js) ──────
// Shared pieces of the four party Zero Powers (2026-11-06 overhaul, mockup v17):
// the shipped full-body cut-in, hit cues, the cast focus fade, the game's flinch
// for painted copies, screen anchors for numbers, and small particle helpers.
// Storage rules: no backticks and no dollar-brace anywhere in this file.
const ZP = {};

// Fire something ONCE when the timeline reaches 'at' (tracks run per frame while
// t0 <= t < t1, so a 1 ms window can be skipped; this one stays open).
ZP.once = (m, at, fn) => { let done = false; m.hold(at, 1e9, () => { if (done) return; done = true; try { fn(); } catch (e) { console.warn('[ZP] once threw', e); } }); };
// A Chain tick: reveals the next strike (number, HP bar, counter) on the acting GM.
// info: { numbersOnly, screenAt: { [tokenUuid]: { fx, fy } } } or a function returning it.
ZP.hit = (m, at, info) => ZP.once(m, at, () => oni.hit(typeof info === 'function' ? info() : (info || {})));

// The shipped Zero Power cut-in (createCutinDOM/runCutinDOM): a full-body image
// 92% of the view tall on the bottom edge; left -120% -> 0 (CSS ease-out, 650 ms),
// hold 850 ms, -> 120% (CSS ease-in, 650 ms). Drawn in screen space above the board.
// Needs A.images[key]; Overdrive is a cfg sfx cue at the same time.
ZP.cssOut = (t) => ZP.bez(0, 0, 0.58, 1, t);
ZP.cssIn = (t) => ZP.bez(0.42, 0, 1, 1, t);
ZP.bez = (x1, y1, x2, y2, x) => { let t = x; for (let i = 0; i < 8; i++) { const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx; const fx = ((ax * t + bx) * t + cx) * t - x; const d = (3 * ax * t + 2 * bx) * t + cx; if (Math.abs(d) < 1e-6) break; t -= fx / d; } const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by; return ((ay * t + by) * t + cy) * t; };
ZP.cutin = (tl, m, at, key, o) => {
  o = o || {}; const inMs = o.slideIn || 650, hold = o.hold || 850, outMs = o.slideOut || 650; const end = inMs + hold + outMs;
  m.hold(at, at + end, (e, S) => { const img = tl.IMG[key]; if (!img) return; (o.over ? S.over : S.screen).push({ draw: (g) => {
    const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1; const h = g.H * 0.92, w = h * iw / ih;
    const x = e < inMs ? -1.2 * g.W * (1 - ZP.cssOut(e / inMs)) : e < inMs + hold ? 0 : 1.2 * g.W * ZP.cssIn((e - inMs - hold) / outMs);
    g.save(); g.globalAlpha = 1; g.drawImage(img, x, g.H - h, w, h); g.restore(); } }); });
  return at + end;
};

// Everyone on the board who is not the caster or a target, as extra timeline tokens
// ('b0', 'b1', ...), so the cast focus can fade them. Summon tokens already on the
// field are bystanders too (the user's dedupe rule: the parade never shows a real
// Crysta next to the drawn one). keep: extra tokens to leave alone.
ZP.bystanders = (keep) => {
  const out = {}; const skip = new Set(); if (caster) skip.add(caster.id); for (const t of targets) skip.add(t.id); for (const t of (keep || [])) if (t) skip.add(t.id);
  let n = 0; for (const t of (canvas.tokens && canvas.tokens.placeables) || []) { if (skip.has(t.id) || !t.visible || !t.mesh || (t.document && t.document.hidden)) continue; out['b' + (n++)] = { token: t }; }
  return out;
};
// Fade the bystanders out from 'at' over ms, keep them out until 'back', fade back over backMs.
ZP.focus = (m, TOK, at, ms, back, backMs) => {
  const keys = Object.keys(TOK).filter((k) => k.charAt(0) === 'b' && /^b[0-9]+$/.test(k));
  for (const k of keys) m.hold(at, back + backMs, (e, S) => { const q = S.tok[k]; if (!q) return; const t = e + at; let a; if (t < at + ms) a = 1 - (t - at) / ms; else if (t < back) a = 0; else a = Math.min(1, (t - back) / backMs); if (a < 1) { if (a <= 0.001) q.hidden = true; else q.alpha *= a; } });
  return keys;
};

// The game's FULL_FLINCH (battler-pose.js): [time, scaleX, scaleY, shiftX px] and brightness.
ZP.FLINCH = {
  normal: { ms: 300, move: [[0, 1, 1, 0], [0.12, 1.12, 0.88, 0], [0.30, 0.97, 1.03, -7], [0.50, 1, 1, 6], [0.70, 1, 1, -4], [0.85, 1, 1, 3], [1, 1, 1, 0]], bright: [[0, 3.6], [0.35, 1], [1, 1]] },
  strong: { ms: 480, move: [[0, 1, 1, 0], [0.10, 1.22, 0.80, 0], [0.26, 0.90, 1.10, -13], [0.44, 1, 1, 11], [0.62, 1, 1, -7], [0.80, 1, 1, 5], [1, 1, 1, 0]], bright: [[0, 4], [0.20, 1], [0.40, 3.2], [0.60, 1], [1, 1]] },
};
ZP.stop = (stops, t, col) => { for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const a = stops[i - 1], b = stops[i]; const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]); const k = 1 - (1 - u) * (1 - u); return a[col] + (b[col] - a[col]) * k; } return stops[stops.length - 1][col]; };
// Flinch sample at ms since the hit: { sx, sy, dx, b (brightness) } or null when over.
ZP.flinchAt = (ms, tier) => { const F = ZP.FLINCH[tier || 'normal']; if (ms < 0 || ms >= F.ms) return null; const u = ms / F.ms; return { sx: ZP.stop(F.move, u, 1), sy: ZP.stop(F.move, u, 2), dx: ZP.stop(F.move, u, 3), b: ZP.stop(F.bright, u, 1) }; };
// The hurt reaction on a PAINTED timeline token k at 'at': its hurt art (sprite_hurt,
// the engine's hurt loop) for hurtMs with the flinch on top, else the flinch alone.
// Use with oni.hit({ numbersOnly: true }) so the game's own DOM flinch stays off.
ZP.flinchTok = (m, at, k, tier, hurtMs) => {
  const F = ZP.FLINCH[tier || 'normal']; const hold = Math.max(F.ms, hurtMs == null ? 700 : hurtMs);
  m.hold(at, at + hold, (e, S) => { const q = S.tok[k]; if (!q) return; q.hurt = true; const f = ZP.flinchAt(e, tier); if (!f) return; q.sx *= f.sx; q.sy *= f.sy; q.dx += f.dx; if (f.b > 1.05) { const a = Math.min(1, (f.b - 1) / 3); if (a > q.tintA) { q.tint = '#ffffff'; q.tintA = a; } } });
};
// Screen anchor for a damage number at screen px (x, y) of the overlay: board-view fractions.
ZP.frac = (g, x, y) => ({ fx: x / g.W, fy: y / g.H });

// Splitting for a drawn pseudo multi-hit preview (bench only; in battle the numbers come from BD).
ZP.split = (total, n) => { const out = []; let prev = 0; for (let i = 1; i <= n; i++) { const c = Math.round(total * i / n); out.push(c - prev); prev = c; } return out; };

// A soft additive glow (canvas 2D).
ZP.glow = (g, x, y, r, rgb, a) => { if (!(r > 0) || !(a > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
// A deterministic particle field for a track: n particles from seed, each p(i, r) => spec,
// drawn by draw(g, p, e). Lets a whole ember/dust swarm live in one track (no per-frame spawns).
ZP.swarm = (tl, n, seed, make) => { const r = tl.rng(seed || 3); const out = []; for (let i = 0; i < n; i++) out.push(make(i, r)); return out; };
// A glow-sprite with a black backing turned into real alpha (alpha = brightness), cached.
ZP._ga = new Map();
ZP.glowAlpha = (img) => { if (!img) return null; if (ZP._ga.has(img)) return ZP._ga.get(img); const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height; if (!w || !h) return null; const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
  try { const id = x.getImageData(0, 0, w, h), d = id.data; for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]); if (mx > 0) { d[i] = d[i] * 255 / mx; d[i + 1] = d[i + 1] * 255 / mx; d[i + 2] = d[i + 2] * 255 / mx; } d[i + 3] = mx; } x.putImageData(id, 0, 0); } catch (e) { return img; }
  ZP._ga.set(img, cv); return cv; };
// Tip and joint of a Disgaea weapon part, read from its alpha (top-most / bottom-most opaque rows).
ZP._li = new Map();
ZP.limbInfo = (img) => { if (ZP._li.has(img)) return ZP._li.get(img); const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height; const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.drawImage(img, 0, 0); let d; try { d = x.getImageData(0, 0, w, h).data; } catch (e) { const r0 = { tip: { x: w / 2, y: 0 }, joint: { x: w / 2, y: h } }; ZP._li.set(img, r0); return r0; }
  const row = (y) => { let a = -1, b = -1; for (let i = 0; i < w; i++) if (d[(y * w + i) * 4 + 3] > 90) { if (a < 0) a = i; b = i; } return a < 0 ? null : (a + b) / 2; };
  let tip = null, joint = null; for (let y = 0; y < h && !tip; y++) { const c = row(y); if (c != null) tip = { x: c, y }; } for (let y = h - 1; y >= 0 && !joint; y--) { const c = row(y); if (c != null) joint = { x: c, y }; }
  const r = { tip: tip || { x: w / 2, y: 0 }, joint: joint || { x: w / 2, y: h } }; ZP._li.set(img, r); return r; };
