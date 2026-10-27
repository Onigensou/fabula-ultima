// ============================================================================
// Anim Studio — `oni.timeline`: the mockup engine, in the game.
//
// ⭐️ Fafnir's shots were designed in an interactive canvas-2D mockup (the
// "Fafnir Action Shots" artifact) as a list of timed TRACKS — { t0, t1, fn(tl, S) }
// — that each write into one shared per-frame STATE (camera, shake, dim,
// white, per-token pose/offset, and lists of draw callbacks in board space and
// in screen space). A renderer then paints that state every frame.
//
// This module is that engine, ported so a shot authored against the mockup
// runs in Foundry with the SAME track code and the SAME numbers:
//
//   - the board is the real scene: the real camera is driven from S.cam (+ the
//     mockup's unclamped `panY` slide and the screen shake), through the same
//     resolveIntent the rest of the cinematics use, with the camera authority
//     suspended for the run;
//   - every token on the board is hidden for the run and painted by us from its
//     own rendered texture (so poses, hurt loops, black cut-outs, tints, lifts
//     and per-token shakes all work exactly as in the mockup), with the painted
//     or baked ground shadow under it;
//   - all effect drawing happens on ONE transparent canvas-2D overlay laid over
//     the PIXI view as a position:fixed DOM element (the browser composites it;
//     no per-frame GPU upload, no re-projection). Damage numbers and impact FX
//     are DOM too and sit far above it (z 99985+), so the resolve side still
//     reads through the shot;
//   - webm clips are the staged independent copies (animation-stage.js), drawn
//     straight onto the overlay with drawImage, so the mockup's tint / additive
//     / perspective-strip tricks port verbatim.
//
// Only canvas-2D code lives here. Nothing in this file touches PIXI beyond
// reading the stage transform and the token meshes.
// ============================================================================

import { takeVideo, releaseVideo } from "../action-animation/animation-stage.js";

const TAG = "[ONI][Timeline]";
const MODULE_ID = "fabula-ultima-companion";

// ── small maths (identical to the mockup) ────────────────────────────────────
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const seg = (t, a, b) => clamp01((t - a) / (b - a));
export const lerp = (a, b, k) => a + (b - a) * k;
export const E = {
  lin: (k) => k,
  ioC: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  inQ: (k) => k * k,
  outQ: (k) => 1 - (1 - k) * (1 - k),
  ioQ: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  inC: (k) => k * k * k,
  outC: (k) => 1 - Math.pow(1 - k, 3),
  sine: (k) => 0.5 - 0.5 * Math.cos(Math.PI * k),
};
export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The game's shadow bake style (sprite-shadow-renderer.js STYLE, as the mockup
// carried it) — used for tokens that have the spriteShadow flag and no painted
// shadow of their own.
const SH_BASE = { alpha: 0.45, heightFrac: 0.25, groundFrac: 0.4, groundMassFrac: 0.2, widthFactor: 1, minBodyFrac: 0.25, aspect: 0.56, maxHeightFrac: 0.3, centerLift: 0.4, squash: 0.5, blur: 0.02, opaque: 128 };

// Shared scratch canvases (module singletons; re-sized on demand).
const SCRATCH = document.createElement("canvas"), SCTX = SCRATCH.getContext("2d");
const KCAN = document.createElement("canvas"), KCTX = KCAN.getContext("2d");
const SKYCAN = document.createElement("canvas"), SKYCTX = SKYCAN.getContext("2d");
const RCAN = document.createElement("canvas"), RCTX = RCAN.getContext("2d");
let FGCAN = null;

// Recolour a video/image frame: multiply a colour over its own alpha, keeping luminance.
function tintFrame(V, color) {
  const w = V.videoWidth || V.naturalWidth || V.width || 2, h = V.videoHeight || V.naturalHeight || V.height || 2;
  if (SCRATCH.width !== w || SCRATCH.height !== h) { SCRATCH.width = w; SCRATCH.height = h; }
  SCTX.clearRect(0, 0, w, h);
  SCTX.globalCompositeOperation = "source-over"; SCTX.drawImage(V, 0, 0, w, h);
  SCTX.globalCompositeOperation = "color"; SCTX.fillStyle = color; SCTX.fillRect(0, 0, w, h);
  SCTX.globalCompositeOperation = "destination-in"; SCTX.drawImage(V, 0, 0, w, h);
  SCTX.globalCompositeOperation = "source-over";
  return SCRATCH;
}

// ── procedural drawings (verbatim ports; `g` carries W/H for screen space) ───
function boltPath(g, x0, y0, x1, y1, r, amp, color, width, a) {
  const n = 12, pts = [[x0, y0]];
  for (let i = 1; i < n; i++) { const k = i / n; pts.push([lerp(x0, x1, k) + (r() - 0.5) * amp, lerp(y0, y1, k) + (r() - 0.5) * amp * 0.3]); }
  pts.push([x1, y1]);
  g.save(); g.globalCompositeOperation = "lighter"; g.lineJoin = "round"; g.lineCap = "round";
  for (const [w, c, k] of [[width * 3.2, color, 0.35 * a], [width, "#ffffff", a]]) { g.strokeStyle = c; g.globalAlpha = k; g.lineWidth = w; g.beginPath(); pts.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); }
  g.restore();
}
function screenCracks(g, ox, oy, grow, alpha) {
  const W = g.W, H = g.H; const r = rng(41); const sc = H / 788; g.save(); g.lineCap = "round"; g.lineJoin = "round";
  const rays = [];
  for (let i = 0; i < 7; i++) {
    const a0 = i / 7 * Math.PI * 2 + (r() - 0.5) * 0.5; let x = W * ox, y = H * oy, an = a0; const pts = [[x, y]];
    for (let s = 0; s < 16; s++) { const L = (0.045 + r() * 0.05) * W; an += (r() - 0.5) * 0.7; x += Math.cos(an) * L; y += Math.sin(an) * L; pts.push([x, y]); if (x < -10 || x > W + 10 || y < -10 || y > H + 10) break; }
    rays.push(pts);
    const bi = 2 + Math.floor(r() * Math.min(4, pts.length - 3));
    if (pts[bi]) { let bx = pts[bi][0], by = pts[bi][1], ba = a0 + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.5); const bp = [[bx, by]]; for (let s = 0; s < 5; s++) { const L = (0.03 + r() * 0.03) * W; ba += (r() - 0.5) * 0.6; bx += Math.cos(ba) * L; by += Math.sin(ba) * L; bp.push([bx, by]); } bp.branch = true; rays.push(bp); }
  }
  for (const pts of rays) {
    const n = Math.max(2, Math.round(2 + (pts.length - 2) * (pts.branch ? Math.max(0, grow * 1.6 - 0.6) : grow))); if (pts.branch && grow < 0.4) continue;
    for (let pass = 0; pass < 2; pass++) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]); g.strokeStyle = pass === 0 ? "rgba(10,4,20," + (0.55 * alpha) + ")" : "rgba(255,255,255," + (0.9 * alpha) + ")"; g.lineWidth = (pass === 0 ? (pts.branch ? 3.2 : 4.6) : (pts.branch ? 1.2 : 2.2)) * sc; g.stroke(); }
  }
  g.restore();
}
function glowCircle(g, x, y, r, color, a) {
  if (!(r > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, color); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = a; g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); g.restore();
}
function speedlines(g, W, H, t, a, holeR, color) {
  const r = rng(Math.floor(t / 70) + 11); g.save(); g.globalAlpha = a; g.strokeStyle = color; g.lineCap = "round"; const R = Math.hypot(W, H) * 0.6;
  for (let i = 0; i < 132; i++) { const an = r() * Math.PI * 2, h0 = H * (holeR + r() * 0.10), w = H * 0.016 * (0.4 + r() * 0.8); g.lineWidth = w; g.beginPath(); g.moveTo(W / 2 + Math.cos(an) * h0, H / 2 + Math.sin(an) * h0); g.lineTo(W / 2 + Math.cos(an) * R, H / 2 + Math.sin(an) * R); g.stroke(); }
  g.restore();
}
function dragonEye(g, x, y, w, open, a, look) {
  const h = w * 0.5 * open; if (h < 1) return; g.save(); g.globalAlpha = a;
  g.beginPath(); g.moveTo(x - w / 2, y); g.quadraticCurveTo(x, y - h * 1.6, x + w / 2, y); g.quadraticCurveTo(x, y + h * 1.6, x - w / 2, y); g.closePath();
  g.fillStyle = "#120618"; g.fill(); g.save(); g.clip();
  const ix = x + (look || 0) * w * 0.08; const gr = g.createRadialGradient(ix, y, 0, ix, y, h * 1.1); gr.addColorStop(0, "#f1dcff"); gr.addColorStop(0.35, "#b58cff"); gr.addColorStop(0.8, "#5a2a9e"); gr.addColorStop(1, "#1b0a2e"); g.fillStyle = gr; g.beginPath(); g.arc(ix, y, h * 1.1, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#05020a"; g.beginPath(); g.ellipse(ix, y, h * 0.16, h * 1.05, 0, 0, Math.PI * 2); g.fill();
  g.restore(); g.lineWidth = w * 0.03; g.strokeStyle = "#e8d6ff"; g.globalCompositeOperation = "lighter"; g.globalAlpha = a * 0.8; g.beginPath(); g.moveTo(x - w / 2, y); g.quadraticCurveTo(x, y - h * 1.6, x + w / 2, y); g.quadraticCurveTo(x, y + h * 1.6, x - w / 2, y); g.stroke(); g.restore();
}
function zoomLines(g, cx, cy, t, a, color) {
  const r = rng(Math.floor(t / 60) + 5); const R = Math.hypot(g.W, g.H); g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = a; g.fillStyle = color;
  for (let i = 0; i < 60; i++) { const an = r() * Math.PI * 2, r0 = g.H * (0.26 + r() * 0.2), w = 0.0015 + r() * 0.004; g.beginPath(); g.moveTo(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0); g.lineTo(cx + Math.cos(an - w) * R, cy + Math.sin(an - w) * R); g.lineTo(cx + Math.cos(an + w) * R, cy + Math.sin(an + w) * R); g.closePath(); g.fill(); }
  g.restore();
}
function fireball(g, x, y, r, t, a) {
  const fl = 1 + Math.sin(t / 37) * 0.05 + Math.sin(t / 61) * 0.04; r *= fl; g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = a;
  for (const [k, c] of [[1, "rgba(255,90,20,.55)"], [0.72, "rgba(255,150,40,.8)"], [0.45, "rgba(255,230,160,1)"]]) { const gr = g.createRadialGradient(x, y, 0, x, y, r * k); gr.addColorStop(0, c); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
  g.restore();
}
function drawKeystone(g, img, cx, cy, w, h, topScale, botScale, strips, fore) {
  const n = strips || 40; const q = fore || 1; const W = g.W || g.canvas.width, H = g.H || g.canvas.height;
  if (KCAN.width !== W || KCAN.height !== H) { KCAN.width = W; KCAN.height = H; }
  KCTX.clearRect(0, 0, W, H); const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; const sh = ih / n;
  for (let i = 0; i < n; i++) { const k0 = i / n, k1 = (i + 1) / n; const s0 = lerp(topScale, botScale, k0), s1 = lerp(topScale, botScale, k1); const y0 = cy - h / 2 + h * Math.pow(k0, q), y1 = cy - h / 2 + h * Math.pow(k1, q); const ws = w * (s0 + s1) / 2; KCTX.drawImage(img, 0, i * sh, iw, sh, cx - ws / 2, y0, ws, y1 - y0 + 1.5); }
  g.drawImage(KCAN, 0, 0);
}
function drawCover(g, img, W, H, scale, ox, oy, alpha) {
  if (!img) return; const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; const s = Math.max(W / iw, H / ih) * scale; const dw = iw * s, dh = ih * s;
  g.save(); g.globalAlpha = alpha; g.drawImage(img, W / 2 - dw / 2 + ox, H / 2 - dh / 2 + oy, dw, dh); g.restore();
}
function drawSkyPan(g, img, W, H, scale, oy, fadeH, smear, blurPx) {
  if (SKYCAN.width !== W || SKYCAN.height !== H) { SKYCAN.width = W; SKYCAN.height = H; }
  const c = SKYCTX; c.setTransform(1, 0, 0, 1, 0, 0); c.filter = "none"; c.clearRect(0, 0, W, H); c.W = W; c.H = H;
  c.save(); if (blurPx) c.filter = "blur(" + blurPx.toFixed(1) + "px)"; drawCover(c, img, W, H, scale, 0, oy, 1); c.restore();
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; const s = Math.max(W / iw, H / ih) * scale; const seam = H / 2 + ih * s / 2 + oy;
  const m = c.createLinearGradient(0, seam - fadeH, 0, seam); m.addColorStop(0, "rgba(0,0,0,0)"); m.addColorStop(1, "rgba(0,0,0,1)");
  c.save(); c.globalCompositeOperation = "destination-out"; c.fillStyle = m; c.fillRect(0, seam - fadeH - 2, W, fadeH + 4); c.fillRect(0, seam, W, H); c.restore();
  if (smear > 0) { const n = 5; for (let i = 0; i < n; i++) { const o = (i / (n - 1) - 0.5) * 2 * smear; g.save(); g.globalAlpha = 1 / n + 0.08; g.drawImage(SKYCAN, 0, o); g.restore(); } }
  else g.drawImage(SKYCAN, 0, 0);
}
function vlines(g, tl, a, col) {
  if (a <= 0) return; const W = g.W, H = g.H; const r = rng(Math.floor(tl / 40) + 5); g.save(); g.globalCompositeOperation = "lighter"; g.lineCap = "round";
  for (let i = 0; i < 110; i++) { const x = r() * W, len = H * (0.18 + r() * 0.7), y = r() * H * 1.5 - len; g.lineWidth = H * (0.003 + r() * 0.009); g.strokeStyle = r() < 0.7 ? "#ffffff" : col; g.globalAlpha = a * (0.35 + r() * 0.65); g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + len); g.stroke(); }
  g.globalCompositeOperation = "source-over"; g.globalAlpha = a * 0.55; const v = g.createLinearGradient(0, 0, W, 0); v.addColorStop(0, "rgba(0,0,0,.9)"); v.addColorStop(0.25, "rgba(0,0,0,0)"); v.addColorStop(0.75, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.9)"); g.fillStyle = v; g.fillRect(0, 0, W, H); g.restore();
}

// ── the valley (mountainscape + foreground rocks) ────────────────────────────
function tri(v) { v = v - Math.floor(v); return 1 - Math.abs(v * 2 - 1); }
function ridgeY(x, freq, seed) { return tri(x * freq * 0.5 + seed * 0.13) * 0.5 + tri(x * freq * 1.3 + seed * 0.31) * 0.28 + Math.abs(Math.sin(x * freq * 4.7 + seed)) * 0.14 + tri(x * freq * 9 + seed * 0.7) * 0.08; }
export const VALLEY_HY = 0.62;
function valleyXf(V, g, px, py) {
  const W = g.W, H = g.H; const C = { x: W / 2, y: H * VALLEY_HY + H * 0.05 }; const dx = (px - C.x) * V.z, dy = (py - C.y) * V.z; const c = Math.cos(V.rot), s = Math.sin(V.rot);
  return { x: V.ax * W + dx * c - dy * s, y: V.ay * H + dx * s + dy * c };
}
const FG_BASE = [
  [[-0.6, 1], [-0.6, -0.2], [-0.55, -0.22], [-0.52, -0.1], [-0.49, -0.13], [-0.46, -0.02], [-0.44, -0.04], [-0.41, 0.06], [-0.39, 0.05], [-0.36, 0.14], [-0.34, 0.13], [-0.31, 0.22], [-0.29, 0.21], [-0.26, 0.3], [-0.23, 0.34], [-0.2, 0.42], [-0.17, 0.47], [-0.13, 0.55], [-0.09, 0.6], [-0.05, 0.7], [0, 0.8], [0.03, 1]],
  [[0.6, 1], [0.6, -0.12], [0.55, -0.1], [0.52, 0], [0.49, -0.02], [0.46, 0.08], [0.43, 0.06], [0.4, 0.15], [0.37, 0.2], [0.34, 0.18], [0.31, 0.27], [0.28, 0.33], [0.25, 0.38], [0.21, 0.46], [0.17, 0.52], [0.13, 0.6], [0.09, 0.68], [0.05, 1]],
  [[-0.33, 1], [-0.32, 0.52], [-0.34, 0.46], [-0.31, 0.4], [-0.33, 0.33], [-0.29, 0.27], [-0.31, 0.21], [-0.27, 0.15], [-0.24, 0.13], [-0.21, 0.19], [-0.23, 0.27], [-0.2, 0.35], [-0.22, 0.41], [-0.19, 0.47], [-0.21, 0.53], [-0.18, 1]],
  [[0.14, 1], [0.16, 0.56], [0.17, 0.46], [0.2, 0.36], [0.23, 0.41], [0.25, 0.52], [0.28, 0.6], [0.31, 1]],
  [[-0.7, 0.5], [-0.55, 0.44], [-0.42, 0.47], [-0.3, 0.4], [-0.2, 0.45], [-0.1, 0.41], [0, 0.44], [0.1, 0.4], [0.2, 0.45], [0.3, 0.41], [0.45, 0.44], [0.7, 0.4], [0.7, 1], [-0.7, 1]],
  [[-0.48, 0.5], [-0.44, 0.42], [-0.36, 0.44], [-0.34, 0.52]], [[0.3, 0.52], [0.34, 0.44], [0.44, 0.46], [0.48, 0.54]], [[-0.1, 0.52], [-0.06, 0.46], [0.02, 0.48], [0.04, 0.55]]];
let FG_DET = null;
function fgDetail(W, H) {
  if (FG_DET && FG_DET.key === W + "x" + H) return FG_DET; const r = rng(97);
  const rough = (pts) => { const out = []; const n = pts.length; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; const ax = a[0] * W, ay = a[1] * H, bx = b[0] * W, by = b[1] * H; const len = Math.hypot(bx - ax, by - ay) || 1; const segs = Math.max(1, Math.round(len / (H * 0.035))); const nx = -(by - ay) / len, ny = (bx - ax) / len; out.push([ax, ay]); for (let s = 1; s < segs; s++) { const t = s / segs; let px = ax + (bx - ax) * t, py = ay + (by - ay) * t; const amp = H * 0.014 * (r() - 0.5) * 2; px += nx * amp; py += ny * amp; out.push([px, py]); if (r() < 0.3) out.push([px + H * 0.025 * (r() - 0.5) * 2, py]); } } return out; };
  const polys = FG_BASE.map(rough);
  const inside = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const xi = P[i][0], yi = P[i][1], xj = P[j][0], yj = P[j][1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; };
  const parts = []; const sp = H * 0.011; const bx = 0, by = H * 0.08; let dmax = 0;
  for (let y = -H * 0.25; y < H * 0.62; y += sp) for (let x = -W * 0.95; x < W * 0.95; x += sp) { const px = x + (r() - 0.5) * sp, py = y + (r() - 0.5) * sp; let hit = false; for (const P of polys) { if (inside(px, py, P)) { hit = true; break; } } if (!hit) continue; const d = Math.hypot(px - bx, py - by) * (1 + 0.1 * (r() - 0.5)); dmax = Math.max(dmax, d); parts.push({ x: px, y: py, d, s: 0.6 + r() * 1.2, ph: r() * 6.28, w: (r() - 0.5) }); }
  const pits = []; for (let i = 0; i < 1600; i++) { const an = r() * Math.PI * 2, d = H * 0.1 + r() * dmax; pits.push({ x: bx + Math.cos(an) * d, y: by + Math.sin(an) * d, d, rad: H * (0.003 + r() * 0.005) }); }
  FG_DET = { key: W + "x" + H, polys, parts, pits, dmax, bx, by }; return FG_DET;
}
function foregroundRocks(g, P, col) {
  const W = g.W, H = g.H; const ero = P.ero || 0; if (ero >= 1 || P.fgHide) return; const tl = P.tl || 0; const D = fgDetail(W, H);
  const tracePoly = (c, pts) => { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); };
  const frameXf = (c) => { c.translate(W / 2, H / 2); c.rotate(P.rot); c.scale(P.sf, P.sf); const sh = P.fgShake || 0; if (sh > 0) c.translate(Math.sin(tl * 0.37) * H * 0.014 * sh, Math.cos(tl * 0.53) * H * 0.011 * sh); };
  if (ero <= 0) {
    g.save(); frameXf(g); const blurPx = (P.fgBlur || 0) * (H / 788); if (blurPx > 0) g.filter = "blur(" + blurPx.toFixed(1) + "px)";
    g.fillStyle = "#030108"; for (const pts of D.polys) { tracePoly(g, pts); g.fill(); }
    const lit = Math.min(1, (P.k || 0) * 3); if (lit > 0 && !P.onWhite) { g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = 0.35 * lit; g.strokeStyle = col; g.lineWidth = H * 0.004; for (const pts of D.polys) { tracePoly(g, pts); g.stroke(); } g.restore(); }
    g.filter = "none"; g.restore(); return;
  }
  if (!FGCAN || FGCAN.width !== W || FGCAN.height !== H) { FGCAN = document.createElement("canvas"); FGCAN.width = W; FGCAN.height = H; }
  const c = FGCAN.getContext("2d"); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H); c.save(); frameXf(c);
  c.fillStyle = "#030108"; for (const pts of D.polys) { tracePoly(c, pts); c.fill(); }
  const R0 = H * 0.08, R1 = D.dmax * 1.02; const Rf = R0 + (R1 - R0) * ero;
  c.globalCompositeOperation = "destination-out";
  const fg = c.createRadialGradient(D.bx, D.by, 0, D.bx, D.by, Rf); fg.addColorStop(0, "rgba(0,0,0,1)"); fg.addColorStop(0.8, "rgba(0,0,0,1)"); fg.addColorStop(0.82, "rgba(0,0,0,0)"); c.fillStyle = fg; c.fillRect(D.bx - Rf, D.by - Rf, Rf * 2, Rf * 2);
  const rr = rng(131); c.fillStyle = "#000"; for (let i = 0; i < 1400; i++) { const q = rr(); const an = rr() * Math.PI * 2, rad = Rf * (0.78 + 0.42 * q * q), br = H * (0.002 + 0.007 * rr()); const x = D.bx + Math.cos(an) * rad, y = D.by + Math.sin(an) * rad; c.beginPath(); c.arc(x, y, br, 0, Math.PI * 2); c.fill(); }
  for (const p of D.pits) { const open = seg(Rf, p.d * 0.7, p.d * 0.98); if (open <= 0) continue; c.beginPath(); c.arc(p.x, p.y, p.rad * open, 0, Math.PI * 2); c.fill(); }
  c.globalCompositeOperation = "source-over";
  for (const p of D.parts) { const ur = (p.d - R0) / (R1 - R0); const tau = (ero - ur) / 0.42; if (tau <= 0 || tau >= 1) continue; const dx = p.x - D.bx, dy = p.y - D.by; const dd = Math.hypot(dx, dy) || 1; const e = E.outQ(tau);
    const x = p.x + dx / dd * H * 0.08 * e + Math.sin(tau * 6 + p.ph) * H * 0.012 * tau + p.w * H * 0.05 * tau, y = p.y + dy / dd * H * 0.03 * e - H * 0.2 * tau * (1 + p.w * 0.4);
    c.globalAlpha = 1 - E.inQ(tau); const s = H * 0.004 * p.s * (1 - 0.5 * tau); c.fillStyle = "#0a0612"; c.fillRect(x - s / 2, y - s / 2, s, s); }
  c.restore();
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); if (g.__base) g.setTransform.apply(g, g.__base); g.drawImage(FGCAN, 0, 0); g.restore();
}
function mountainscape(g, el, P) {
  const W = g.W, H = g.H; const hy = H * VALLEY_HY, cx = W / 2; const bolt = el === "bolt"; const col = bolt ? "#c9a5ff" : "#ffb070", core = bolt ? "#f1e7ff" : "#fff1d6";
  const C = { x: cx, y: hy + H * 0.05 }; const z = P.z, k = P.k, tl = P.tl || 0;
  g.save(); g.translate(P.ax * W, P.ay * H); g.rotate(P.rot); g.scale(z, z); g.translate(-C.x, -C.y);
  const sg = g.createLinearGradient(0, hy - H * 1.3, 0, hy); if (bolt) { sg.addColorStop(0, "#05020c"); sg.addColorStop(0.6, "#170a2c"); sg.addColorStop(1, "#3a1a5e"); } else { sg.addColorStop(0, "#0a0303"); sg.addColorStop(0.6, "#2a0c08"); sg.addColorStop(1, "#5c2410"); }
  g.fillStyle = sg; g.fillRect(-W * 2, -H * 3, W * 5, H * 3 + hy + 2);
  const R = H * (0.06 + 1.05 * E.outQ(k));
  if (k > 0) { const dg = g.createRadialGradient(C.x, hy, 0, C.x, hy, R); dg.addColorStop(0, core); dg.addColorStop(0.35, col); dg.addColorStop(1, "rgba(0,0,0,0)"); g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = 0.9 * (1 - 0.45 * k); g.fillStyle = dg; g.fillRect(C.x - R, hy - R, R * 2, R * 2); g.restore(); }
  const layers = bolt ? [["#1b1030", 0.17, 1.3, 0.86], ["#100823", 0.24, 2.1, 0.93], ["#06020c", 0.32, 3.4, 1]] : [["#2b100a", 0.17, 1.3, 0.86], ["#190806", 0.24, 2.1, 0.93], ["#070202", 0.32, 3.4, 1]];
  const ridgePath = (amp, freq, li) => { g.beginPath(); g.moveTo(-W * 2, H * 3); for (let i = 0; i <= 200; i++) { const x = -W * 2 + i * (W * 5 / 200); const y = hy + H * 0.02 * li - H * amp * ridgeY(x / W, freq, li * 7 + 1); g.lineTo(x, y); } g.lineTo(W * 3, H * 3); g.closePath(); };
  layers.forEach(([c, amp, freq], li) => { g.fillStyle = c; ridgePath(amp, freq, li); g.fill();
    if (k > 0) { g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = 0.55 * (1 - k * 0.6); const rg = g.createRadialGradient(C.x, hy, 0, C.x, hy, R * 0.9); rg.addColorStop(0, col); rg.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = rg; ridgePath(amp, freq, li); g.clip(); g.fillRect(C.x - R, hy - R, R * 2, R * 2); g.restore(); } });
  const gg = g.createLinearGradient(0, hy, 0, H * 1.6); gg.addColorStop(0, bolt ? "#120a1f" : "#1a0806"); gg.addColorStop(1, "#020104"); g.fillStyle = gg; g.fillRect(-W * 2, hy + H * 0.03, W * 5, H * 3);
  g.save(); g.globalAlpha = 0.32; g.strokeStyle = bolt ? "#34225a" : "#4a2214"; g.lineWidth = H * 0.0035; const rt = rng(11); for (let i = 0; i < 40; i++) { const x0 = -W * 2 + rt() * W * 5, y0 = hy + H * 0.03 + rt() * H * 1.2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + (rt() - 0.5) * W * 0.9, y0 + (rt() - 0.2) * H * 0.35); g.stroke(); } g.restore();
  if (k > 0) { g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = 0.5 * (1 - k * 0.5); const lg = g.createRadialGradient(C.x, C.y, 0, C.x, C.y, R * 0.8); lg.addColorStop(0, col); lg.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = lg; g.save(); g.translate(C.x, C.y); g.scale(1, 0.35); g.translate(-C.x, -C.y); g.fillRect(C.x - R, C.y - R, R * 2, R * 2); g.restore(); g.restore();
    if (k > 0.3) { const sa = 0.3 * seg(k, 0.3, 0.7) * (1 - 0.5 * k); const rs = rng(29); g.save(); g.globalCompositeOperation = "lighter"; g.strokeStyle = col; g.lineWidth = H * 0.0025; g.translate(C.x, C.y); g.scale(1, 0.32); for (let i = 0; i < 44; i++) { const an = rs() * Math.PI * 2, r0 = R * (0.9 + rs() * 0.4), r1 = r0 + R * (0.6 + rs() * 1.4); g.globalAlpha = sa * (0.4 + 0.6 * rs()); g.beginPath(); g.moveTo(Math.cos(an) * r0, Math.sin(an) * r0); g.lineTo(Math.cos(an) * r1, Math.sin(an) * r1); g.stroke(); } g.restore(); } }
  if (P.beam > 0) { const b = E.outC(P.beam); const tip = lerp(C.y - H * 2.6, C.y, b); const cw = W * (0.012 + 0.045 * k);
    g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = 0.85 * (1 - 0.55 * k);
    const cg = g.createLinearGradient(C.x - cw, 0, C.x + cw, 0); cg.addColorStop(0, "rgba(255,255,255,0)"); cg.addColorStop(0.5, col); cg.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = cg; g.fillRect(C.x - cw, -H * 3, cw * 2, tip + H * 3);
    const kw = W * 0.004 + cw * 0.12; g.fillStyle = core; g.fillRect(C.x - kw, -H * 3, kw * 2, tip + H * 3);
    for (let i = 0; i < 3; i++) { const u = ((tl / 260) + i / 3) % 1; const y = lerp(tip - H * 0.5, tip, u); if (y < -H * 2) continue; g.globalAlpha = 0.7 * (1 - u) * (1 - 0.6 * k); g.strokeStyle = core; g.lineWidth = H * 0.004; g.beginPath(); g.ellipse(C.x, y, cw * 3 * (1 - u * 0.4) + W * 0.01, (cw * 3 * (1 - u * 0.4) + W * 0.01) * 0.3, 0, 0, Math.PI * 2); g.stroke(); }
    g.restore(); }
  if (P.ember > 0) { const p = 1 + 0.3 * Math.sin(tl / 55); g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = P.ember; const eg = g.createRadialGradient(C.x, C.y, 0, C.x, C.y, H * 0.03 * p); eg.addColorStop(0, core); eg.addColorStop(0.3, col); eg.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = eg; g.fillRect(C.x - H * 0.04, C.y - H * 0.04, H * 0.08, H * 0.08); g.fillStyle = core; g.beginPath(); g.ellipse(C.x, C.y, H * 0.006 * p, H * 0.003 * p, 0, 0, Math.PI * 2); g.fill(); g.restore(); }
  if (P.disc > 0) { const d = E.outC(P.disc); const rx = W * (0.015 + 0.6 * d), ry = rx * 0.22; g.save(); g.globalCompositeOperation = "lighter";
    const fg = g.createRadialGradient(C.x, C.y, 0, C.x, C.y, rx); fg.addColorStop(0, "#ffffff"); fg.addColorStop(0.5, core); fg.addColorStop(1, "rgba(0,0,0,0)"); g.globalAlpha = 0.95 * (1 - 0.55 * d); g.fillStyle = fg; g.save(); g.translate(C.x, C.y); g.scale(1, 0.22); g.translate(-C.x, -C.y); g.fillRect(C.x - rx, C.y - rx, rx * 2, rx * 2); g.restore();
    g.globalAlpha = (1 - P.disc) * 0.95; g.strokeStyle = core; g.lineWidth = H * (0.018 * (1 - P.disc) + 0.003); g.beginPath(); g.ellipse(C.x, C.y, rx * 1.12, ry * 1.12, 0, 0, Math.PI * 2); g.stroke();
    const th = H * 0.09 * Math.sin(Math.min(1, P.disc * 1.4) * Math.PI); const rt2 = rng(71); for (let i = 0; i < 18; i++) { const an = i / 18 * Math.PI * 2 + rt2() * 0.2; const bx = C.x + Math.cos(an) * rx * 0.92, by = C.y + Math.sin(an) * ry * 0.92; const h = th * (0.5 + rt2() * 0.8); const tg = g.createLinearGradient(0, by, 0, by - h); tg.addColorStop(0, core); tg.addColorStop(1, "rgba(255,255,255,0)"); g.globalAlpha = 0.85 * (1 - P.disc * 0.7); g.fillStyle = tg; g.beginPath(); g.moveTo(bx - rx * 0.035, by); g.quadraticCurveTo(bx - rx * 0.012, by - h * 0.5, bx, by - h); g.quadraticCurveTo(bx + rx * 0.012, by - h * 0.5, bx + rx * 0.035, by); g.closePath(); g.fill(); }
    g.restore(); }
  if (k > 0) { const Rd = W * (0.04 + 0.21 * E.outQ(k)); const hg = Rd * (0.9 - 0.25 * k); g.save();
    const dome = () => { g.beginPath(); g.moveTo(C.x - Rd, C.y); g.bezierCurveTo(C.x - Rd * 1.08, C.y - hg * 0.8, C.x - Rd * 0.55, C.y - hg * 1.02, C.x, C.y - hg); g.bezierCurveTo(C.x + Rd * 0.55, C.y - hg * 1.02, C.x + Rd * 1.08, C.y - hg * 0.8, C.x + Rd, C.y); g.ellipse(C.x, C.y, Rd, Rd * 0.22, 0, 0, Math.PI); g.closePath(); };
    const vg = g.createLinearGradient(0, C.y - hg, 0, C.y + Rd * 0.22); vg.addColorStop(0, "#ffffff"); vg.addColorStop(0.3, core); vg.addColorStop(0.8, col); vg.addColorStop(1, bolt ? "#5a2a9a" : "#a83a10"); g.fillStyle = vg; dome(); g.fill();
    g.save(); dome(); g.clip(); const rb = rng(17); g.globalCompositeOperation = "lighter"; for (let i = 0; i < 16; i++) { const bx = C.x + (rb() - 0.5) * Rd * 1.6, by = C.y - hg * (0.15 + rb() * 0.75) + Math.sin(tl / 140 + i) * hg * 0.03; const br = Rd * (0.08 + rb() * 0.16); const bg = g.createRadialGradient(bx, by, 0, bx, by, br); bg.addColorStop(0, "rgba(255,255,255,.9)"); bg.addColorStop(1, "rgba(255,255,255,0)"); g.globalAlpha = 0.7; g.fillStyle = bg; g.fillRect(bx - br, by - br, br * 2, br * 2); } g.restore();
    g.globalAlpha = 0.6; g.strokeStyle = col; g.lineWidth = H * 0.004; dome(); g.stroke();
    g.globalCompositeOperation = "lighter"; const rf = rng(23); for (let i = 0; i < 40; i++) { const an = rf() * Math.PI * 2; const bx = C.x + Math.cos(an) * Rd * (0.95 + rf() * 0.2), by = C.y + Math.sin(an) * Rd * 0.22 * (0.95 + rf() * 0.2); const h = Rd * (0.06 + rf() * 0.14) * (1 + 0.3 * Math.sin(tl / 90 + i)); const tg = g.createLinearGradient(0, by, 0, by - h); tg.addColorStop(0, i % 3 ? col : core); tg.addColorStop(1, "rgba(255,255,255,0)"); g.globalAlpha = 0.8; g.fillStyle = tg; g.beginPath(); g.moveTo(bx - Rd * 0.025, by); g.quadraticCurveTo(bx - Rd * 0.01, by - h * 0.5, bx, by - h); g.quadraticCurveTo(bx + Rd * 0.01, by - h * 0.5, bx + Rd * 0.025, by); g.closePath(); g.fill(); }
    g.restore();
    const kk0 = seg(k, 0.08, 0.8); const r = rng(53); g.save(); for (let i = 0; i < 55; i++) { const an = -Math.PI / 2 + (r() - 0.5) * 1.6, sp = 0.25 + r() * 0.75, lag = r(); const kk = Math.max(0, kk0 - lag * 0.3); if (kk <= 0) continue; const d = H * 1.5 * sp * E.outQ(kk); const x = C.x + Math.cos(an) * d * 1.4, y = C.y - hg * 0.2 + Math.sin(an) * d + kk * kk * H * 1.4 * sp; g.fillStyle = "rgba(8,3,14," + (0.95 * (1 - k * 0.4)) + ")"; const s = H * (0.005 + r() * 0.022); g.save(); g.translate(x, y); g.rotate(kk * 6 * (r() - 0.5)); g.beginPath(); g.moveTo(-s * 0.6, -s * 0.2); g.lineTo(-s * 0.1, -s * 0.7); g.lineTo(s * 0.7, -s * 0.3); g.lineTo(s * 0.5, s * 0.5); g.lineTo(-s * 0.3, s * 0.6); g.closePath(); g.fill(); g.restore(); } g.restore(); }
  if (P.wash > 0) { const wr = W * (0.1 + 2.2 * E.inQ(P.wash) * 1.2); const wg = g.createRadialGradient(C.x, C.y - H * 0.05, 0, C.x, C.y - H * 0.05, wr); wg.addColorStop(0, "rgba(255,255,255,1)"); wg.addColorStop(0.6, "rgba(255,255,255,1)"); wg.addColorStop(1, "rgba(255,255,255,0)"); g.save(); g.globalAlpha = Math.min(1, P.wash * 1.6); g.fillStyle = wg; g.fillRect(C.x - wr, C.y - wr, wr * 2, wr * 2); g.restore(); }
  g.restore();
  foregroundRocks(g, P, col);
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, Math.max(W, H) * 0.65); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0," + (0.6 * (1 - (P.wash || 0))) + ")"); g.fillStyle = v; g.fillRect(0, 0, W, H);
}

// ── shadow bake (the mockup's port of sprite-shadow-renderer's bake) ─────────
function bakeShadow(img, override) {
  const SH = Object.assign({}, SH_BASE, override || {}); const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, W, H).data; const T = SH.opaque;
  let bx0 = W, bx1 = -1, by0 = H, by1 = -1; for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) { if (d[(y * W + i) * 4 + 3] < T) continue; if (i < bx0) bx0 = i; if (i > bx1) bx1 = i; if (y < by0) by0 = y; if (y > by1) by1 = y; } if (bx1 < 0) return null;
  const colH = new Uint16Array(W), colG = new Uint16Array(W); const groundTop = by1 - Math.max(1, Math.round((by1 - by0 + 1) * SH.groundFrac)) + 1;
  for (let y = by0; y <= by1; y++) { const ing = y >= groundTop; for (let i = bx0; i <= bx1; i++) { if (d[(y * W + i) * 4 + 3] < T) continue; colH[i]++; if (ing) colG[i]++; } }
  let maxH = 0, maxG = 0; for (let i = bx0; i <= bx1; i++) { if (colH[i] > maxH) maxH = colH[i]; if (colG[i] > maxG) maxG = colG[i]; } const hMin = maxH * SH.heightFrac, gMin = maxG * SH.groundMassFrac; let sx0 = W, sx1 = -1; for (let i = bx0; i <= bx1; i++) { if (colH[i] < hMin || colG[i] < gMin) continue; if (i < sx0) sx0 = i; if (i > sx1) sx1 = i; } if (sx1 < 0) { sx0 = bx0; sx1 = bx1; }
  const footY = by1 + 1, bodyH = by1 - by0 + 1; const w = Math.max((bx1 - bx0 + 1) * SH.minBodyFrac, (sx1 - sx0 + 1) * SH.widthFactor); const hh = Math.min(w * SH.aspect, bodyH * SH.maxHeightFrac); const cx = (sx0 + sx1 + 1) / 2, cy = footY - hh * SH.centerLift; const bandH = footY - groundTop; const blur = Math.max(1, w * SH.blur); const pad = Math.ceil(blur * 3) + 2;
  const x0 = Math.floor(Math.min(cx - w / 2, 0) - pad), x1 = Math.ceil(Math.max(cx + w / 2, W) + pad), y0 = Math.floor(Math.min(cy - hh / 2, cy - bandH * SH.squash / 2) - pad), y1 = Math.ceil(Math.max(cy + hh / 2, cy + bandH * SH.squash / 2) + pad);
  const b = document.createElement("canvas"); b.width = x1 - x0; b.height = y1 - y0; const g = b.getContext("2d"); g.fillStyle = "#000"; g.beginPath(); g.ellipse(cx - x0, cy - y0, w / 2, hh / 2, 0, 0, Math.PI * 2); g.fill();
  const band = document.createElement("canvas"); band.width = W; band.height = bandH; const bg = band.getContext("2d"); bg.drawImage(img, 0, groundTop, W, bandH, 0, 0, W, bandH); bg.globalCompositeOperation = "source-in"; bg.fillStyle = "#000"; bg.fillRect(0, 0, W, bandH);
  g.drawImage(band, 0 - x0, cy - (bandH * SH.squash) / 2 - y0, W, bandH * SH.squash);
  const out = document.createElement("canvas"); out.width = b.width; out.height = b.height; const og = out.getContext("2d"); og.filter = "blur(" + blur + "px)"; og.drawImage(b, 0, 0);
  return { cv: out, ox: x0, oy: y0, footY, texW: W, texH: H, alpha: SH.alpha };
}

// Bottom-most opaque row of an image as a fraction of its height (where the
// feet really are). null when the pixels cannot be read (tainted canvas).
function footOf(img) {
  try {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height; if (!W || !H) return null;
    const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, W, H).data;
    for (let y = H - 1; y >= 0; y--) { for (let i = 0; i < W; i++) if (d[(y * W + i) * 4 + 3] > 128) return (y + 1) / H; }
    return null;
  } catch { return null; }
}

// ── the engine ───────────────────────────────────────────────────────────────
//
// createTimeline(spec, env) → tl. One per shot run.
//   spec.tokens  { key: { token, art?, shadow?, foot?, hurt?, nativeDir?, shadowStyle? } }
//                token = the Foundry Token object; art/shadow/hurt = URLs
//                (defaults: the token's own texture; baked shadow when the actor
//                has the spriteShadow flag; hurt from the actor's sprite_hurt).
//   spec.images  { key: url }                    drawn via tl.IMG[key]
//   spec.clips   { key: { url, w, h, dur, ax, ay, add?, mask?, impact? } }
//   spec.poses   { tokKey: { pose: { url, foot, scale? } } }  scale defaults to art px / pose px
//   spec.bystanders  true (default) → every other visible token is drawn too, as itself
//   env = { canvas, PIXI, loadTexture, oni, scene? }
export function createTimeline(spec = {}, env = {}) {
  const { canvas, loadTexture, oni } = env;
  const app = canvas?.app ?? null;
  const ticker = app?.ticker ?? null;
  const scene = env.scene ?? canvas?.scene ?? null;
  const cam = globalThis.FUCompanion?.api?.camera ?? null;

  // ── geometry (the mockup's constants, from the live scene) ──
  const dims = canvas?.dimensions ?? {};
  const sr = dims.sceneRect ?? { x: 0, y: 0, width: dims.width ?? 0, height: dims.height ?? 0 };
  const SCENE = { x: sr.x, y: sr.y, w: sr.width, h: sr.height };
  let STAGE = null;
  try { STAGE = cam?.stageOf?.(scene) ?? null; } catch { STAGE = null; }
  if (!STAGE) STAGE = { x: SCENE.x, y: SCENE.y, w: SCENE.w, h: SCENE.h };
  const REST = { cx: STAGE.x + STAGE.w / 2, cy: STAGE.y + STAGE.h / 2 };
  const GRID = canvas?.grid?.size ?? 100;

  const TOK = {};            // key -> { token, x, y, w, h, flip, dir, foot, name, hidden }
  const IMG = {};            // key -> HTMLImageElement | HTMLVideoElement
  const ART = {};            // tok key -> image source
  const SHADOW = {};         // tok key -> baked shadow
  const PAINTED = {};        // tok key -> painted shadow image
  const HURT = {};           // tok key -> looping <video> copy
  const POSE = {};           // tok key -> pose -> { img, foot, w, h }
  const LIB = spec.clips || {};
  const TINT = new Map();

  const feet = (t) => ({ x: t.x, y: t.y - t.h / 2 + t.h * t.foot });
  // Her jaw: 44% of her width ahead of centre in her facing direction, 12% of
  // her height below centre (the mockup's JAW, facing-aware).
  const JAW = (key) => { const t = TOK[key]; return { x: t.x + t.dir * t.w * 0.44, y: t.y + t.h * 0.12 }; };

  function tinted(key, color) {
    const ck = key + "|" + color; if (TINT.has(ck)) return TINT.get(ck);
    const src = IMG[key] || ART[key]; if (!src) return null;
    const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(src, 0, 0); x.globalCompositeOperation = "source-in"; x.fillStyle = color; x.fillRect(0, 0, w, h);
    TINT.set(ck, c); return c;
  }

  async function imageOf(url) {
    if (!url) return null;
    try { const tex = await loadTexture(url); const s = tex?.baseTexture?.resource?.source ?? null; return s || null; }
    catch (e) { console.warn(TAG, "image load failed", url, e); return null; }
  }

  const fx = globalThis.FUCompanion?.api;
  const actorProps = (token) => token?.actor?.system?.props ?? {};

  // ── load: tokens, art, shadows, poses, images ──
  let loaded = false;
  async function load() {
    if (loaded) return; loaded = true;
    const named = new Map(); for (const [k, s] of Object.entries(spec.tokens || {})) if (s?.token) named.set(s.token.id, k);
    const all = [];
    for (const [k, s] of Object.entries(spec.tokens || {})) if (s?.token) all.push([k, s]);
    if (spec.bystanders !== false) {
      let n = 0;
      for (const t of canvas?.tokens?.placeables ?? []) {
        if (named.has(t.id)) continue;
        if (!t.visible || !t.mesh || t.document?.hidden) continue;
        all.push(["x" + (n++), { token: t }]);
      }
    }
    for (const [k, s] of all) {
      const t = s.token, mesh = t.mesh;
      const art = await imageOf(s.art) || mesh?.texture?.baseTexture?.resource?.source || null;
      const nativeDir = s.nativeDir ?? -1;
      const sign = Math.sign(mesh?.scale?.x || 1) || 1;
      ART[k] = art;
      const foot = s.foot ?? (art ? footOf(art) : null) ?? 0.97;
      TOK[k] = { token: t, x: t.center.x, y: t.center.y, w: mesh?.width ?? t.w, h: mesh?.height ?? t.h, flip: sign, dir: sign * nativeDir, foot, name: t.name, hidden: !!s.hidden };
      if (s.shadow) { PAINTED[k] = await imageOf(s.shadow); }
      else if (art && (t.document?.flags?.[MODULE_ID]?.spriteShadow || t.actor?.flags?.[MODULE_ID]?.spriteShadow)) {
        try { SHADOW[k] = bakeShadow(art, s.shadowStyle); } catch { SHADOW[k] = null; }
      }
      const hurtUrl = s.hurt ?? actorProps(t).sprite_hurt;
      if (hurtUrl) { try { const c = await takeVideo(hurtUrl); if (c) { c.video.loop = true; HURT[k] = c; } } catch {} }
      for (const [p, pd] of Object.entries((spec.poses || {})[k] || {})) {
        const img = await imageOf(pd.url); if (!img) continue;
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        const artW = art?.naturalWidth || art?.width || iw;
        const scale = pd.scale ?? (TOK[k].w / artW);
        (POSE[k] ||= {})[p] = { img, foot: pd.foot ?? foot, w: iw * scale, h: ih * scale };
      }
    }
    for (const [k, url] of Object.entries(spec.images || {})) IMG[k] = await imageOf(url);
  }

  // ── per-frame state ──
  function makeState() {
    const tok = {}; for (const k in TOK) tok[k] = { dx: 0, dy: 0, sx: 1, sy: 1, alpha: 1, hidden: !!TOK[k].hidden, black: 0, tint: null, tintA: 0, glow: 0, rot: 0, noShadow: false, hurt: false, pose: null };
    return { cam: { cx: REST.cx, cy: REST.cy, zoom: 1 }, dim: 0, flash: { a: 0, c: "#fff" }, white: 0, black: 0, shake: 0, letterbox: 0, topdark: 0, tok, world: [], screen: [], over: [], texts: [], beat: "", whiteUnder: 0, hideBoard: false, panY: 0, _skyOy: 0 };
  }

  // ── realtime clip (a staged copy; plays from its track start, no seeking) ──
  class Clip {
    constructor(def) { this.def = def; this.copy = null; this.started = false; this.cache = null; this.cctx = null; this.done = false; }
    async take() { if (this.copy || this.done) return; try { this.copy = await takeVideo(this.def.url); } catch (e) { console.warn(TAG, "clip take failed", this.def.url, e); } }
    frame(loop) {
      const c = this.copy; if (!c) return false; const v = c.video;
      if (!this.started) { this.started = true; try { v.loop = !!loop; v.currentTime = 0; v.play?.().catch(() => {}); } catch {} }
      if (v.readyState >= 2 && !v.seeking) {
        if (loop) { if (!this.cache) { this.cache = document.createElement("canvas"); this.cache.width = v.videoWidth || 2; this.cache.height = v.videoHeight || 2; this.cctx = this.cache.getContext("2d"); } this.cctx.clearRect(0, 0, this.cache.width, this.cache.height); this.cctx.drawImage(v, 0, 0); }
        return v;
      }
      return this.cache || false;
    }
    stop() { if (this.done) return; this.done = true; try { this.copy?.video?.pause?.(); } catch {} if (this.copy) { try { releaseVideo(this.copy); } catch {} this.copy = null; } }
  }

  // ── the mockup's track helpers ──
  function mk(T) {
    const m = {
      tw(t0, dur, fn) { T.push({ t0, t1: t0 + dur, fn: (tl, S) => fn(clamp01(tl / dur), S, tl) }); },
      hold(t0, t1, fn) { T.push({ t0, t1, fn }); },
      // o: x,y scene px (or screen:{x,y} viewport fractions) | w scene px (or wh = fraction of viewport height) | rot | flip | loop | hold | z | alpha(fn) | over (above whiteout) | tint | add | blur | pivot | persp | sx/sy | live(tl,S,g)
      clip(key, t0, o) {
        const def = LIB[key]; if (!def) { console.warn(TAG, "unknown clip", key); return null; }
        const c = new Clip(def); const dur = o.hold != null ? o.hold : def.dur;
        T.push({ t0, t1: t0 + dur, clip: c, loop: !!o.loop, fn: (tl, S) => {
          const src = c.frame(!!o.loop); if (!src) return;
          const a = o.alpha ? o.alpha(clamp01(tl / dur)) : 1; if (a <= 0) return;
          const draw = (g) => {
            const V = src; let dw, dh, x, y, rot = o.rot || 0;
            let persp = o.persp || null, sx = o.sx, sy = o.sy;
            if (o.screen) { dh = g.H * o.wh; x = o.screen.x * g.W; y = o.screen.y * g.H; if (o.live) { const p = o.live(tl, S, g); if (!p) return; x = p.x; y = p.y; dh = g.H * p.wh; rot = p.rot || 0; if (p.persp) persp = p.persp; if (p.sx != null) sx = p.sx; if (p.sy != null) sy = p.sy; } dw = dh * def.w / def.h; }
            else { dw = o.w; x = o.x; y = o.y; if (o.live) { const p = o.live(tl, S, g); if (!p) return; x = p.x; y = p.y; dw = p.w; rot = p.rot || 0; } dh = dw * def.h / def.w; }
            g.save(); g.translate(x, y); if (rot) g.rotate(rot); if (o.flip) g.scale(-1, 1); if (sy || sx) g.scale(sx || 1, sy || 1); g.globalAlpha = a;
            if (def.add || o.add) g.globalCompositeOperation = "lighter"; else if (o.blur) g.filter = "blur(" + (o.blur * (g.H / 788)).toFixed(1) + "px)";
            const pax = o.pivot ? o.pivot.x : def.ax, pay = o.pivot ? o.pivot.y : def.ay; const F = o.tint ? tintFrame(V, o.tint) : V;
            if (persp) { const n = 48, fh = (F.videoHeight || F.height), sh = fh / n, fw = (F.videoWidth || F.width); for (let i = 0; i < n; i++) { const k0 = i / n, k1 = (i + 1) / n; const s = (k0 + k1) / 2; const depth = lerp(persp.near, persp.far, s); const ws = dw * persp.near / depth; const y0 = -pay * dh + dh * k0, y1 = -pay * dh + dh * k1; g.drawImage(F, 0, i * sh, fw, sh, -ws / 2, y0, ws, y1 - y0 + 1.5); } }
            else g.drawImage(F, -pax * dw, -pay * dh, dw, dh);
            g.restore();
          };
          if (o.screen) (o.over ? S.over : S.screen).push({ draw }); else S.world.push({ z: o.z == null ? 10 : o.z, draw });
        } });
        return c;
      },
      dmg() { /* real numbers come from the resolve side */ },
      shakeTok(at, k, ms, amp) { T.push({ t0: at, t1: at + ms, fn: (tl, S) => { const q = 1 - tl / ms; if (!S.tok[k]) return; S.tok[k].dx += Math.sin(tl * 0.9) * amp * q; S.tok[k].dy += Math.cos(tl * 1.3) * amp * 0.4 * q; } }); },
      shake(at, ms, amp) { T.push({ t0: at, t1: at + ms, fn: (tl, S) => { S.shake = Math.max(S.shake, amp * (1 - tl / ms)); } }); },
      flash(at, inMs, outMs, color, alpha) { T.push({ t0: at, t1: at + inMs + outMs, fn: (tl, S) => { const a = tl < inMs ? alpha * tl / inMs : alpha * (1 - (tl - inMs) / outMs); if (a > S.flash.a) S.flash = { a, c: color }; } }); },
      dim(at, ms, to, from) { T.push({ t0: at, t1: 1e9, fn: (tl, S) => { S.dim = Math.max(S.dim, lerp(from || 0, to, E.sine(seg(tl, 0, ms)))); } }); },
      undim(at, ms, from) { T.push({ t0: at, t1: 1e9, fn: (tl, S) => { S.dim = Math.min(S.dim, lerp(from, 0, E.sine(seg(tl, 0, ms)))); } }); },
      beat(at, label) { T.push({ t0: at, t1: 1e9, fn: (tl, S) => { S.beat = label; } }); },
      tint(at, ms, k, color, curve) { T.push({ t0: at, t1: at + ms, fn: (tl, S) => { const a = curve ? curve(tl / ms) : 1 - tl / ms; const q = S.tok[k]; if (q && a > q.tintA) { q.tint = color; q.tintA = a; } } }); },
      // the shared "she returns from the top edge" descent (three beats + rebound)
      descend(at, k) { const F = TOK[k]; const from = -F.h; const b = [0.46, 0.78, 1]; T.push({ t0: at, t1: at + 1700, fn: (tl, S) => { S.tok[k].hidden = false; let y = from; const sq = [[0, 420, 0, b[0]], [420, 210, b[0], b[0] - 0.035], [630, 420, b[0] - 0.035, b[1]], [1050, 210, b[1], b[1] - 0.035], [1260, 420, b[1] - 0.035, 1]]; let done = true; for (const [s, d, a0, b0] of sq) { if (tl < s + d) { y = lerp(from, F.y, lerp(a0, b0, E.outQ((tl - s) / d))); done = false; break; } } if (done) y = F.y; S.tok[k].dy = y - F.y; } }); },
      // the shared blow-out: white frame, black cut-out creatures, 260 in / 900 hold / 900 out
      blowout(at) { T.push({ t0: at, t1: at + 2060, fn: (tl, S) => { const a = tl < 260 ? tl / 260 : tl < 1160 ? 1 : 1 - (tl - 1160) / 900; for (const k in S.tok) S.tok[k].black = Math.max(S.tok[k].black, a); S.whiteUnder = Math.max(S.whiteUnder, a); } }); },
      dust(at, x, y, w, kind) { const col = "#b9a9cc"; if (kind === "takeoff") { this.clip("smoke14", at, { x: x - w * 0.25, y, w, z: 12, tint: col, alpha: (u) => 0.85 * (1 - u * u) }); this.clip("smoke14", at + 60, { x: x + w * 0.25, y, w: w * 0.8, z: 12, tint: col, flip: true, alpha: (u) => 0.8 * (1 - u * u) }); } else { this.clip("dust05", at, { x: x - w * 0.3, y, w, z: 12, tint: col, alpha: (u) => 0.9 * (1 - u * u) }); this.clip("dust05", at + 40, { x: x + w * 0.3, y, w: w * 0.9, z: 12, tint: col, flip: true, alpha: (u) => 0.9 * (1 - u * u) }); this.clip("smoke12", at + 120, { x, y: y - w * 0.1, w: w * 0.9, z: 11, tint: col, alpha: (u) => 0.6 * (1 - u) }); } },
      // seeded sky bolts in WORLD space from above the stage down to a point
      skybolts(at, ms, x, y, count, color) { T.push({ t0: at, t1: at + ms, fn: (tl, S) => { const r = rng(Math.floor(tl / 55) + Math.round(x)); const a = tl < 80 ? tl / 80 : 1 - seg(tl, ms * 0.45, ms); S.world.push({ z: 48, draw: (g) => { for (let n = 0; n < count; n++) { const sx = x + (r() - 0.5) * 420, sy = STAGE.y - 320 - r() * 200; boltPath(g, sx, sy, x + (r() - 0.5) * 30, y, r, 120, color, 6, a * (0.6 + r() * 0.4)); } } }); } }); },
      cam(at, ms, to, ease) { let from = null; T.push({ t0: at, t1: 1e9, fn: (tl, S) => { if (!from || tl < 17) from = { ...S.cam }; const k = (ease || E.sine)(seg(tl, 0, ms)); S.cam = { cx: lerp(from.cx, to.cx, k), cy: lerp(from.cy, to.cy, k), zoom: lerp(from.zoom, to.zoom, k) }; } }); },
    };
    return m;
  }

  // ── the overlay ──
  let overlay = null, octx = null, dpr = 1;
  function makeOverlay() {
    const view = app?.view; const el = document.createElement("canvas");
    el.className = "oni-timeline-overlay";
    el.style.cssText = "position:fixed; pointer-events:none; z-index:65;";
    const place = () => {
      const r = view?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      dpr = Math.min(2, window.devicePixelRatio || 1);
      el.style.left = r.left + "px"; el.style.top = r.top + "px"; el.style.width = r.width + "px"; el.style.height = r.height + "px";
      const bw = Math.round(r.width * dpr), bh = Math.round(r.height * dpr);
      if (el.width !== bw || el.height !== bh) { el.width = bw; el.height = bh; }
    };
    place(); window.addEventListener("resize", place); document.body.appendChild(el);
    overlay = el; octx = el.getContext("2d");
    return () => { window.removeEventListener("resize", place); try { el.remove(); } catch {} overlay = null; octx = null; };
  }
  const view = () => { const W = app?.renderer?.screen?.width ?? window.innerWidth, H = app?.renderer?.screen?.height ?? window.innerHeight; return { W, H }; };

  // ── camera write (S.cam + panY + shake) ──
  function applyCamera(S, t) {
    const { W, H } = view();
    let v;
    try { v = cam?.resolveIntent ? cam.resolveIntent({ point: { x: S.cam.cx, y: S.cam.cy }, zoom: S.cam.zoom }, scene) : null; } catch { v = null; }
    if (!v) { const st = canvas.stage; v = { x: S.cam.cx, y: S.cam.cy, scale: st.scale.x }; }
    const shx = S.shake ? Math.sin(t * 0.9) * S.shake : 0, shy = S.shake ? Math.cos(t * 1.3) * S.shake * 0.6 : 0;
    const px = v.x - shx / v.scale, py = v.y - shy / v.scale - (S.panY || 0) * H / v.scale;
    const st = canvas.stage;
    st.pivot.set(px, py); st.scale.set(v.scale, v.scale);
    try { canvas.updateBlur?.(); } catch {}
    try { canvas.hud?.align?.(); } catch {}
    try { canvas.scene._viewPosition = { x: v.x, y: v.y, scale: v.scale }; } catch {}
    return { W, H, shx, shy };
  }

  // ── draw one token as the mockup does ──
  function drawTok(g, k, m) {
    const T = TOK[k]; const art = ART[k]; if (!art || m.hidden || m.alpha <= 0) return;
    const f = feet(T); const fx0 = T.x + m.dx, fy = f.y + m.dy;
    g.save(); g.translate(fx0, fy); if (m.rot) g.rotate(m.rot); g.scale(T.flip * m.sx, m.sy); g.globalAlpha = m.alpha;
    const HV = m.hurt && HURT[k] ? HURT[k].video : null;
    if (HV && HV.readyState >= 2) { const hh = T.h, hw = hh * (HV.videoWidth || 1) / (HV.videoHeight || 1); g.drawImage(HV, -hw / 2, -T.h * T.foot, hw, hh); }
    else { const P = m.pose && POSE[k] && POSE[k][m.pose]; if (P && P.img) g.drawImage(P.img, -P.w / 2, -P.h * P.foot, P.w, P.h); else g.drawImage(art, -T.w / 2, -T.h * T.foot, T.w, T.h); }
    if (m.tintA > 0 && m.tint) { const c = tinted(k, m.tint); if (c) { g.globalAlpha = m.alpha * m.tintA * 0.85; g.drawImage(c, -T.w / 2, -T.h * T.foot, T.w, T.h); } }
    if (m.black > 0) { const c = tinted(k, "#000"); if (c) { g.globalAlpha = m.alpha * m.black; g.drawImage(c, -T.w / 2, -T.h * T.foot, T.w, T.h); } }
    g.restore();
    if (m.glow > 0) { g.save(); g.translate(T.x + m.dx, fy - T.h * T.foot * m.sy + T.h * 0.5 * m.sy); glowCircle(g, 0, -T.h * 0.05, T.w * 0.42, "#8a5cff", 0.55 * m.glow); glowCircle(g, T.w * 0.1, -T.h * 0.25, T.w * 0.22, "#c9a5ff", 0.5 * m.glow); g.restore(); }
  }

  // ── render a frame of state S ──
  function render(S, t) {
    if (!octx || !overlay) return;
    const g = octx; const { W, H, shx, shy } = applyCamera(S, t);
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, overlay.width, overlay.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = [dpr, 0, 0, dpr, 0, 0]; g.__base = base;
    // The stage matrix from the camera we JUST wrote (PIXI's worldTransform is
    // only refreshed by its own render pass, so reading it here is a frame late).
    const st = canvas.stage; const sc = st.scale.x;
    const wt = { a: sc, b: 0, c: 0, d: sc, tx: st.position.x - st.pivot.x * sc, ty: st.position.y - st.pivot.y * sc };
    _wt = wt;
    const order = Object.keys(TOK).sort((a, b) => feet(TOK[a]).y - feet(TOK[b]).y);
    const boardXf = () => { g.setTransform(dpr * wt.a, dpr * wt.b, dpr * wt.c, dpr * wt.d, dpr * wt.tx, dpr * wt.ty); };
    if (S.hideBoard) { g.fillStyle = "#000"; g.fillRect(0, 0, W, H); }
    else {
      g.save(); boardXf();
      if (S.dim > 0) { g.fillStyle = "rgba(4,2,10," + S.dim + ")"; g.fillRect(SCENE.x - SCENE.w, SCENE.y - SCENE.h, SCENE.w * 3, SCENE.h * 3); }
      if (S.topdark > 0) { const gr = g.createLinearGradient(0, SCENE.y, 0, SCENE.y + SCENE.h * 0.7); gr.addColorStop(0, "rgba(8,3,20," + S.topdark + ")"); gr.addColorStop(1, "rgba(8,3,20,0)"); g.fillStyle = gr; g.fillRect(SCENE.x - SCENE.w, SCENE.y - SCENE.h, SCENE.w * 3, SCENE.h * 1.7); }
      const low = S.world.filter((l) => l.z < 5).sort((a, b) => a.z - b.z); for (const l of low) l.draw(g);
      for (const k of order) {
        const m = S.tok[k], T = TOK[k]; if (m.hidden || m.alpha <= 0 || m.noShadow) continue;
        const lift = Math.max(0, -m.dy); const lk = Math.min(1, lift / T.h); const ls = 1 - 0.35 * lk, la = 1 - 0.45 * lk; const f = feet(T);
        if (PAINTED[k]) { g.save(); g.translate(T.x + m.dx, f.y); g.scale(T.flip * m.sx * ls, ls); g.globalAlpha = m.alpha * la; g.drawImage(PAINTED[k], -T.w / 2, -T.h * T.foot, T.w, T.h); g.restore(); continue; }
        const sh = SHADOW[k]; if (!sh) continue; const s = T.w / sh.texW;
        g.save(); g.translate(T.x + m.dx, f.y); g.scale(T.flip * m.sx * ls, ls); g.globalAlpha = sh.alpha * m.alpha * la; g.drawImage(sh.cv, (sh.ox - sh.texW / 2) * s, (sh.oy - sh.footY) * s, sh.cv.width * s, sh.cv.height * s); g.restore();
      }
      for (const k of order) drawTok(g, k, S.tok[k]);
      const high = S.world.filter((l) => l.z >= 5).sort((a, b) => a.z - b.z); for (const l of high) l.draw(g);
      g.restore();
    }
    g.setTransform(dpr, 0, 0, dpr, dpr * shx, dpr * shy); g.W = W; g.H = H;
    if (S.whiteUnder > 0) {
      g.save(); g.globalAlpha = S.whiteUnder; g.fillStyle = "#fff"; g.fillRect(-20, -20, W + 40, H + 40); g.restore();
      g.save(); boardXf(); for (const k of order) { const m = S.tok[k], T = TOK[k]; if (m.hidden || m.alpha <= 0) continue; const c = tinted(k, "#000"); if (!c) continue; const f = feet(T); g.save(); g.translate(T.x + m.dx, f.y + m.dy); g.scale(T.flip * m.sx, m.sy); g.globalAlpha = S.whiteUnder; g.drawImage(c, -T.w / 2, -T.h * T.foot, T.w, T.h); g.restore(); } g.restore();
    }
    if (S.black > 0) { g.fillStyle = "#000"; g.globalAlpha = S.black; g.fillRect(-20, -20, W + 40, H + 40); g.globalAlpha = 1; }
    for (const l of S.screen) l.draw(g);
    if (S.letterbox > 0) { g.fillStyle = "#000"; g.fillRect(-20, -20, W + 40, H * S.letterbox + 20); g.fillRect(-20, H * (1 - S.letterbox), W + 40, H * S.letterbox + 20); }
    if (S.flash.a > 0) { g.fillStyle = S.flash.c; g.globalAlpha = S.flash.a; g.fillRect(-20, -20, W + 40, H + 40); g.globalAlpha = 1; }
    if (S.white > 0) { g.fillStyle = "#f0eaf8"; g.globalAlpha = S.white; g.fillRect(-20, -20, W + 40, H + 40); g.globalAlpha = 1; }
    for (const l of S.over) l.draw(g);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  // World→screen for helpers that need it (shockRing, cracks): screen px of a world point, from THIS frame's matrix.
  let _wt = null;
  function toScreen(x, y) { const m = _wt; if (!m) { const p = canvas.stage.worldTransform.apply({ x, y }); return { x: p.x, y: p.y }; } return { x: m.a * x + m.tx, y: m.d * y + m.ty }; }
  // roar shockwave: the finished overlay frame is copied, blurred, and shown back through a travelling ring mask
  function shockRing(g, x, y, tl, ms) {
    const cv = overlay; if (!cv) return; const W = cv.width, H = cv.height; if (RCAN.width !== W || RCAN.height !== H) { RCAN.width = W; RCAN.height = H; }
    const s = toScreen(x, y); const sx = s.x * dpr, sy = s.y * dpr; const R = Math.hypot(W, H) * 0.6; const ring = R * E.outQ(seg(tl, 0, 650)); const band = R * 0.22; const tail = 1 - seg(tl, ms - 350, ms);
    RCTX.globalCompositeOperation = "source-over"; RCTX.filter = "blur(" + (14 * (H / 788)).toFixed(1) + "px)"; RCTX.drawImage(cv, 0, 0); RCTX.filter = "none";
    RCTX.globalCompositeOperation = "destination-in"; const gr = RCTX.createRadialGradient(sx, sy, 0, sx, sy, R * 1.2); const a0 = Math.max(0, (ring - band) / (R * 1.2)), a1 = Math.min(1, ring / (R * 1.2)), a2 = Math.min(1, (ring + band * 0.6) / (R * 1.2)); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(a0, "rgba(0,0,0,0)"); gr.addColorStop(a1, "rgba(0,0,0," + (0.95 * tail) + ")"); gr.addColorStop(a2, "rgba(0,0,0," + (0.55 * tail) + ")"); gr.addColorStop(1, "rgba(0,0,0," + (0.9 * tail) + ")"); RCTX.fillStyle = gr; RCTX.fillRect(0, 0, W, H);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(RCAN, 0, 0); g.restore();
  }
  // a conjured spear silhouette (Disgaea head + shaft from IMG.spearHead / IMG.spearShaft)
  function needle(g, tx, ty, an, len, a, t) {
    t = t || 0; const head = tinted("spearHead", "#1a0a30"), shaft = tinted("spearShaft", "#2a1448"); if (!head || !shaft) return;
    const sc = Math.max(1, Math.round(len / 320)); const hw = 64 * sc, hh = 176 * sc, sw = 32 * sc, sh = 144 * sc; const total = hh + sh * 0.8;
    g.save(); g.translate(tx, ty); g.rotate(an - Math.PI / 2); g.globalAlpha = a; g.imageSmoothingEnabled = false;
    const draw = () => { g.drawImage(shaft, -sw / 2, hh * 0.82, sw, sh); g.drawImage(head, -hw / 2, 0, hw, hh); };
    g.save(); g.globalCompositeOperation = "lighter"; g.shadowColor = "#c87cff"; g.shadowBlur = (26 + 12 * Math.sin(t / 90)) * sc; g.globalAlpha = a * (0.8 + 0.2 * Math.sin(t / 90)); draw(); draw(); g.restore();
    draw();
    g.save(); g.globalCompositeOperation = "lighter"; const r = rng(Math.floor(t / 120) + Math.round(tx)); for (let i = 0; i < 10; i++) { const yy = r() * total, xx = (r() - 0.5) * hw * 1.8, s = 1 + r() * 3; g.fillStyle = r() < 0.5 ? "#d6a8ff" : "#a85cff"; g.globalAlpha = a * (0.5 + r() * 0.5); g.fillRect(xx, yy, s * sc, s * sc); }
    g.globalAlpha = a; const tg = g.createRadialGradient(0, 0, 0, 0, 0, hw * 0.6); tg.addColorStop(0, "rgba(220,170,255,.95)"); tg.addColorStop(0.4, "rgba(170,100,255,.6)"); tg.addColorStop(1, "rgba(170,100,255,0)"); g.fillStyle = tg; g.fillRect(-hw * 0.6, -hw * 0.6, hw * 1.2, hw * 1.2); g.restore();
    g.restore();
  }

  // ── run ──
  //   tracks: the track list; total: ms; sfx: [{ at, url, v }]; onEnd: fn
  //   Resolves when the shot is over and everything is torn down. The caller
  //   (the inner script) awaits this so oni.dispose() cannot cut the tail.
  async function run(tracks, { total = 0, sfx = [], onBeat = null } = {}) {
    await load();
    // pre-take every clip copy so frame 0 pays nothing
    await Promise.all(tracks.filter((tr) => tr.clip).map((tr) => tr.clip.take()));
    const restores = [];
    for (const t of canvas?.tokens?.placeables ?? []) { if (!t?.mesh) continue; try { restores.push(oni.hideToken(t)); } catch {} }
    for (const k in HURT) { try { const v = HURT[k].video; v.loop = true; v.currentTime = 0; v.play?.().catch(() => {}); } catch {} }
    try { oni.camera.capture(); } catch {}
    const removeOverlay = makeOverlay();
    const fired = new Set();
    let t0 = performance.now();
    let S = makeState(); let keep = null;
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        try { ticker?.remove(tick); } catch {}
        for (const tr of tracks) if (tr.clip) tr.clip.stop();
        for (const k in HURT) { try { HURT[k].video.pause(); releaseVideo(HURT[k]); } catch {} }
        removeOverlay();
        for (const r of restores) { try { r(); } catch {} }
        resolve();
      };
      const tick = () => {
        try {
          const t = performance.now() - t0;
          keep = S && S._mouth; S = makeState(); S._mouth = keep; S.playing = true; S.rate = 1;
          for (const tr of tracks) { if (t >= tr.t0 && t < tr.t1) tr.fn(t - tr.t0, S); else if (tr.clip && t >= tr.t1) tr.clip.stop(); }
          for (const c of sfx) { const id = c.at + "|" + (c.url || c.key); if (t >= c.at && t < c.at + 400 && !fired.has(id)) { fired.add(id); try { oni.sfx(c.url || c.key, { volume: c.v ?? 1 }); } catch {} } }
          if (onBeat && S.beat) onBeat(S.beat);
          render(S, t);
          if (t >= total) finish();
        } catch (e) { console.error(TAG, "frame threw", e); finish(); }
      };
      if (!ticker) { finish(); return; }
      ticker.add(tick);
    });
  }

  return {
    // maths + constants
    E, seg, lerp, clamp01, rng, VALLEY_HY,
    SCENE, STAGE, REST, GRID, TOK, IMG, LIB, POSE,
    feet, JAW, tinted, view, toScreen,
    load, mk, run, makeState,
    draw: { boltPath, screenCracks, glowCircle, speedlines, dragonEye, zoomLines, fireball, drawKeystone, drawCover, drawSkyPan, vlines, mountainscape, foregroundRocks, valleyXf, shockRing, needle, tintFrame },
  };
}
