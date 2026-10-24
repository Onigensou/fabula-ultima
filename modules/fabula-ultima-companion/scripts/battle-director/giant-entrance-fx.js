// ============================================================================
// Giant entrance FX — the "giant" gather style (gather-styles.js) on THIS
// client: King Gorger (Wild)'s fake-out cinematic. Ported from the approved
// mockup claude.ai/artifact/S6HVbfQxWZiKBTATsT83rz (Entrance C · Giant).
//
//   1. A colossal shadow creeps over the battlefield and swallows it to black.
//   2. A letterboxed cutaway: a building-sized black silhouette under a purple
//      storm, seen through a real pinhole 3D camera that starts level with his
//      crown, lowers down his front on one curved rail, and pulls back along
//      the ground past the party (black, mirrored silhouettes). Lightning is
//      the only thing that shows his outline. A last strike eases the screen
//      to a soft white (no flicker) that holds.
//   3. Hard cut to the battle: every storm cue stops dead, and there he is,
//      one tile big, with a small ring of light rays behind him.
//
// Called through gather-entrance-fx.playGatherLocal (callers own the
// broadcast). Everything is local DOM/canvas; nothing is written to the
// document. Shots 1–2 sit above the whole UI; shot 3 sits on the board under
// the HP bars, like the other gather styles.
// ============================================================================

import { playSfx, preloadSfx } from "./director-sfx.js";
import { shadowSpriteFor, STYLE as SHADOW_STYLE } from "../sprite-shadow/sprite-shadow-renderer.js";

const Z_CINE = 100050;   // shots 1–2: over everything
const Z_RAYS = 99982;    // shot 3: rays, under the copy of him (99983) and the HP bars (99985)
const DESIGN_H = 788;    // the mockup's screen height: pixel sizes below are tuned to it

/* ── the 3D scene (metres) ───────────────────────────────────────────────── */

const K3 = { h: 26, w: 26, z: 24 };   // him: 26 m tall, standing 24 m from the party's line
// The camera rail in (y, z): control points of a uniform cubic B-spline —
// curvature-continuous, so the drop down his front bends into the run along
// the ground with no corner, and z never increases (it never drifts back).
const RAIL_P = [[23, 16], [23, 16], [23, 16], [11, 16], [2.5, 15.2], [1.1, 10], [1.1, 3], [1.1, -4], [1.1, -4], [1.1, -4]];
const RAIL = buildRail();
// Party slots, left to right; the party is filled in from the battle screen's
// bottom-most member (left) up. [x, z]
const PARTY_SLOTS = [[-1.7, 10], [1.6, 11], [-3.2, 10.6], [3.0, 11.4]];
const PARTY_H = 1.7;

/** Play the giant entrance for `token`. Resolves when it is over. */
export async function runGiant(token, cfg) {
  const W = window.innerWidth, H = window.innerHeight, S = H / DESIGN_H;
  const r0 = screenRect(token);
  const kgSrc = textureSource(token);
  const kgFlip = Math.sign(token.mesh?.scale?.x ?? 1) || 1;
  const kgBlack = tint(kgSrc, "0,0,0", kgFlip);
  const party = partyFor(token);
  const partySide = party.length ? Math.sign(party.reduce((s, p) => s + p.rect.x, 0) / party.length - r0.x) || 1 : 1;
  const scene = makeScene(cfg);
  const sfx = [...(cfg.sfx ?? [])];
  const ringing = [];
  // Warm the cues first (most are not in the battle preload), but never hold
  // the entrance for them for long.
  await Promise.race([
    preloadSfx([...sfx.map((s) => s.url), cfg.cutSfx?.url]),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
  const layers = makeLayers(W, H);
  const board = document.getElementById("board");
  let copy = null, cutDone = false;

  try {
    await new Promise((done) => {
      const t0 = performance.now();
      const tick = (now) => {
        const t = now - t0;
        hideToken(token);
        holdShadow(token, t >= cfg.cutMs ? 1 : 0);
        while (sfx.length && t >= sfx[0].atMs) { const s = sfx.shift(); ringing.push(playSfx(s.url, s.volume ?? 0.6)); }

        if (t < cfg.headMs) {
          drawShadowShot(layers, t, cfg, { W, H, S, r: rectNow(token, r0), kgBlack, side: partySide, board });
        } else if (t < cfg.cutMs) {
          if (board) board.style.transform = "";
          layers.shade.style.display = "none";
          layers.cine.style.display = "block";
          drawCutaway(layers, t, cfg, scene, { W, H, S, kgBlack, party });
        } else {
          if (!cutDone) {
            cutDone = true;
            // the storm stops dead on the cut
            for (const h of ringing) { try { h?.stop?.(); } catch { /* gone */ } }
            if (cfg.cutSfx) playSfx(cfg.cutSfx.url, cfg.cutSfx.volume ?? 0.6);
            layers.cine.style.display = "none";
            layers.shade.style.display = "none";
            copy = makeCopy(token);
          }
          const r = rectNow(token, r0);
          placeCopy(copy, r, kgFlip);
          drawRays(layers, t - cfg.cutMs, cfg, scene, r, S);
        }
        if (t >= cfg.totalMs) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    for (const h of ringing) { try { h?.stop?.(); } catch { /* gone */ } }
    if (board) board.style.transform = "";
    layers.remove();
    showToken(token);
    await new Promise((r) => requestAnimationFrame(r));
    try { copy?.remove(); } catch { /* gone */ }
  }
}

/* ── shot 1: the shadow ──────────────────────────────────────────────────── */

function drawShadowShot(L, t, cfg, { W, H, S, r, kgBlack, side, board }) {
  const c = L.shadeCtx;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, W, H);
  const k = seg(t, 0, cfg.shadowMs);
  // the ground rumbles, building as it comes
  if (board) {
    const a = 3 * S * k;
    board.style.transform = t < cfg.shadowMs ? `translate(${(Math.sin(t * 0.7) * a).toFixed(1)}px, ${(Math.cos(t * 1.1) * a * 0.6).toFixed(1)}px)` : "";
  }
  // his silhouette, blurred and laid flat on the ground: it creeps in from off
  // screen on his side, already huge, slowly and steadily, growing as it comes
  if (kgBlack) {
    const sz = r.h * lerp(16, 30, k);
    const x = lerp(r.x - side * 0.88 * W, r.x + side * 0.19 * W, smooth(k));
    c.save();
    c.filter = `blur(${(lerp(30, 56, k) * S).toFixed(0)}px)`;
    c.globalAlpha = 0.82 * Math.min(1, k * 2.5);
    c.translate(x, r.y + r.h * 0.47); c.scale(1, 0.5);
    c.drawImage(kgBlack, -sz / 2, -sz * 0.85, sz, sz);
    c.restore();
  }
  c.fillStyle = `rgba(3,1,6,${eIn(seg(t, 1200, cfg.shadowMs))})`;
  c.fillRect(0, 0, W, H);
}

/* ── shot 2: the cutaway ─────────────────────────────────────────────────── */

function makeScene(cfg) {
  const strikes = cfg.strikes.map((s, i) => {
    const r = rng(90 + i), pts = [[s.x, s.top]];
    for (let y = s.top; y > s.bottom;) { y -= 3 + r() * 4; pts.push([pts[pts.length - 1][0] + (r() - 0.5) * 5, Math.max(y, s.bottom)]); }
    const from = pts[Math.floor(pts.length * (0.3 + r() * 0.3))], br = [from];
    for (let j = 0; j < 4; j++) br.push([br[j][0] + (r() < 0.5 ? -1 : 1) * (1.5 + r() * 2), br[j][1] - 3 - r() * 3]);
    // the last strike (the white-out) rises once and stays: no flicker on the brightest flash
    return { ...s, steady: i === cfg.strikes.length - 1, lines: [pts, br] };
  });
  return {
    strikes,
    clouds: motes(71, 16, (r) => ({ x: r(), y: r() * 0.55, rx: 160 + r() * 260, ry: 50 + r() * 70, drift: 8 + r() * 14 })),
    rays: motes(73, 14, (r, i) => ({ ang: (i / 14) * Math.PI * 2 + (r() - 0.5) * 0.2, w: i % 2 ? 0.1 + r() * 0.06 : 0.2 + r() * 0.08 })),
    trees: motes(74, 34, (r) => ({ x: (r() - 0.5) * 60, z: 16 + r() * 26, h: 1.1 + r() * 1.3 })).filter((tr) => !(Math.abs(tr.x) < 5 && tr.z < 22)),
    birds: motes(75, 7, (r) => ({ x: -34 + r() * 6, y: 15 + r() * 4, z: K3.z - 6 + r() * 3, sp: 5 + r() * 2, ph: r() * 6 })),
    mists: [[6, -15, 2.4, 12], [15, 13, 2, 10]],   // [height, x offset, thickness, half-length]
  };
}

// one flash: up in 40 ms, a dip, a second flicker, then a 380 ms tail
function flashEnv(u) {
  return u < 0 ? 0 : u < 40 ? u / 40 : u < 90 ? 1 - 0.7 * (u - 40) / 50 : u < 130 ? 0.3 + 0.7 * (u - 90) / 40 : Math.max(0, 1 - (u - 130) / 380);
}
const strikeEnv = (s, u) => s.steady ? (u < 0 ? 0 : Math.min(1, u / 40)) : flashEnv(u);

function cam3(t, cfg) {
  const u = eInOut(seg(t, cfg.headMs, cfg.restMs)), v = 1 - u;
  const [y, z] = railAt(u);
  // all smooth functions of the same u: the aim slides from his crown to his
  // middle, the lens widens, the slight offset toward his crown centres out
  const aimY = 10.6 + 13.4 * Math.pow(v, 1.6);
  return { x: 2.4 * v * v * v, y, z, f: 680 + 620 * v * v, pitch: Math.atan2(aimY - y, K3.z - z) };
}

function drawCutaway(L, t, cfg, sc, env) {
  const { W, H, S } = env;
  const fl = Math.max(0, ...sc.strikes.map((s) => s.strength * strikeEnv(s, t - s.atMs)));
  const cam = cam3(t, cfg);
  const proj = (x, y, z) => {
    const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z, cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const yy = dy * cp - dz * sp, zz = dy * sp + dz * cp;
    if (zz < 0.4) return null;
    const f = cam.f * S;
    return { x: W / 2 + f * dx / zz, y: H / 2 - f * yy / zz, s: f / zz };
  };
  drawSky(L.skyCtx, t, fl, cam, proj, sc, env);
  drawKing(L, cam, proj, fl, env);
  drawFront(L.frontCtx, t, fl, proj, sc, cfg, env);
  // the strikes jolt the camera
  const j = Math.max(0, ...sc.strikes.map((s) => s.strength * (t >= s.atMs ? 1 - seg(t, s.atMs, s.atMs + 260) : 0)));
  L.cine.style.transform = j > 0 ? `translate(${(Math.sin(t * 1.3) * 5 * S * j).toFixed(1)}px, ${(Math.cos(t * 1.7) * 4 * S * j).toFixed(1)}px)` : "";
}

function drawSky(c, t, fl, cam, proj, sc, { W, H, S }) {
  c.globalCompositeOperation = "source-over";
  const f = cam.f * S;
  const hy = H / 2 + f * Math.tan(cam.pitch);   // the horizon line
  const g = c.createLinearGradient(0, hy - 1500 * S, 0, hy);
  g.addColorStop(0, "#0b0418"); g.addColorStop(0.65, "#26103f"); g.addColorStop(1, "#4d2675");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // the flash lights the whole sky; the clouds stay dark in front of it
  if (fl > 0) { c.fillStyle = `rgba(206,176,255,${0.85 * fl})`; c.fillRect(0, 0, W, H); }
  // clouds sit at infinity: they turn with the camera but never parallax
  for (const k of sc.clouds) {
    const el = 0.14 + (1 - k.y / 0.55) * 0.8;
    const x = ((k.x * W + k.drift * S * t / 1000) % (W + 600 * S)) - 300 * S;
    cloud(c, x, H / 2 - f * 0.6 * Math.tan(el - cam.pitch), k.rx * S, k.ry * S, fl);
  }
  c.globalCompositeOperation = "lighter"; c.lineJoin = "round";
  for (const s of sc.strikes) {
    const a = s.strength * strikeEnv(s, t - s.atMs);
    if (!(a > 0.05)) continue;
    for (const line of s.lines) bolt(c, line.map(([x, y]) => proj(x, y, s.z)).filter(Boolean).map((p) => [p.x, p.y]), a, S);
  }
  c.globalCompositeOperation = "source-over";
  // storm light far behind him, so his outline reads even between strikes
  const bl = proj(0, 20, 90);
  if (bl) {
    const rr = 46 * bl.s, g2 = c.createRadialGradient(bl.x, bl.y, 0, bl.x, bl.y, rr);
    g2.addColorStop(0, "rgba(160,118,224,.75)"); g2.addColorStop(1, "rgba(160,118,224,0)");
    c.fillStyle = g2; c.fillRect(bl.x - rr, bl.y - rr, rr * 2, rr * 2);
  }
  // far hills, then the ground below the horizon
  c.fillStyle = "#0c0616"; c.beginPath(); c.moveTo(0, H);
  for (let i = 0; i <= 24; i++) {
    const p = proj(-260 + i * (520 / 24), 6 + 7 * Math.abs(Math.sin(i * 1.7)), 260);
    if (p) c.lineTo(p.x, p.y);
  }
  c.lineTo(W, H); c.closePath(); c.fill();
  if (hy < H) {
    const gg = c.createLinearGradient(0, hy, 0, hy + 500 * S);
    gg.addColorStop(0, "#10081c"); gg.addColorStop(1, "#040208");
    c.fillStyle = gg; c.fillRect(0, hy, W, H - hy);
  }
  // his contact shadow, so the round base sits on the ground
  const cs = proj(0, 0, K3.z);
  if (cs) {
    const rx = 17 * cs.s, g3 = c.createRadialGradient(cs.x, cs.y, 0, cs.x, cs.y, rx);
    g3.addColorStop(0, "rgba(3,1,6,.95)"); g3.addColorStop(0.7, "rgba(3,1,6,.7)"); g3.addColorStop(1, "rgba(3,1,6,0)");
    c.save(); c.translate(cs.x, cs.y); c.scale(1, 0.16); c.translate(-cs.x, -cs.y);
    c.fillStyle = g3; c.fillRect(cs.x - rx, cs.y - rx, rx * 2, rx * 2); c.restore();
  }
  c.fillStyle = "#07030d";
  for (const tr of sc.trees) if (tr.z > K3.z) pine(c, proj(tr.x, 0, tr.z), proj(tr.x, tr.h, tr.z));
}

// him: drawn row by row, each source row placed by the projection, so his base
// is wide and near and his crown narrows away (true keystone)
function drawKing(L, cam, proj, fl, { W, H, S, kgBlack }) {
  const c = L.kingCtx;
  c.globalCompositeOperation = "source-over"; c.clearRect(0, 0, W, H);
  if (!kgBlack) return;
  c.imageSmoothingEnabled = false;
  const n = kgBlack.height;
  for (let r = 0; r < n; r++) {
    const a = proj(0, K3.h * (1 - r / n), K3.z), b = proj(0, K3.h * (1 - (r + 1) / n), K3.z);
    if (!a || !b || b.y < 0 || a.y > H) continue;
    const w = K3.w * (a.s + b.s) / 2;
    c.drawImage(kgBlack, 0, r, kgBlack.width, 1, (a.x + b.x) / 2 - w / 2, a.y, w, b.y - a.y + 0.8);
  }
  // the far end of him is hazier: his top fades toward the sky colour
  const tp = proj(0, K3.h, K3.z), bp = proj(0, 0, K3.z);
  if (tp && bp) {
    c.globalCompositeOperation = "source-atop";
    const hz = c.createLinearGradient(0, bp.y, 0, tp.y);
    hz.addColorStop(0, "rgba(60,32,96,0)"); hz.addColorStop(0.55, "rgba(60,32,96,0)"); hz.addColorStop(1, "rgba(60,32,96,.28)");
    c.fillStyle = hz; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = "source-over";
  }
  // a lavender rim, bright only while the lightning is lit
  L.king.style.filter = `drop-shadow(0 0 ${((4 + 12 * fl) * S).toFixed(1)}px rgba(225,200,255,${(0.5 + 0.5 * fl).toFixed(2)}))`;
}

// in front of him: mist banks, the trees in front, birds, the party, the frame, the white-out
function drawFront(c, t, fl, proj, sc, cfg, { W, H, S, party }) {
  c.globalCompositeOperation = "source-over"; c.clearRect(0, 0, W, H);
  for (const [y, dx, th, len] of sc.mists) {
    const p = proj(dx + Math.sin(t / 1700 + y) * 3, y, K3.z - 2.5); if (!p) continue;
    const rx = len * p.s, ry = th * p.s, g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, rx);
    g.addColorStop(0, `rgba(150,118,196,${0.22 + 0.15 * fl})`); g.addColorStop(1, "rgba(150,118,196,0)");
    c.save(); c.translate(p.x, p.y); c.scale(1, ry / rx); c.translate(-p.x, -p.y);
    c.fillStyle = g; c.fillRect(p.x - rx, p.y - rx, rx * 2, rx * 2); c.restore();
  }
  c.fillStyle = "#07030d";
  for (const tr of sc.trees) if (tr.z <= K3.z) pine(c, proj(tr.x, 0, tr.z), proj(tr.x, tr.h, tr.z));
  // ground mist round his feet
  const gp = proj(0, 0.6, K3.z - 4);
  if (gp && gp.y < H) {
    const top = gp.y - 2 * gp.s, g = c.createLinearGradient(0, top, 0, gp.y + 40 * S);
    g.addColorStop(0, "rgba(70,40,110,0)"); g.addColorStop(1, "rgba(70,40,110,.6)");
    c.fillStyle = g; c.fillRect(0, top, W, H - top);
  }
  // birds: tiny, crossing the sky beside him
  c.strokeStyle = "#07030d"; c.lineCap = "round";
  for (const b of sc.birds) {
    const p = proj(b.x + b.sp * (t - cfg.headMs) / 1000, b.y, b.z); if (!p) continue;
    const span = 0.45 * p.s, flap = Math.sin(t / 70 + b.ph) * span * 0.5;
    c.lineWidth = Math.max(1.5, span * 0.18);
    c.beginPath(); c.moveTo(p.x - span, p.y - flap); c.quadraticCurveTo(p.x - span * 0.4, p.y - flap * 0.2, p.x, p.y + span * 0.15);
    c.quadraticCurveTo(p.x + span * 0.4, p.y - flap * 0.2, p.x + span, p.y - flap); c.stroke();
  }
  // the party, looking up at him: black silhouettes, mirrored, rim-lit by the storm
  for (const m of party) {
    const p = proj(m.x, 0, m.z), q = proj(m.x, PARTY_H, m.z); if (!p || !q || q.y > H) continue;
    const hh = p.y - q.y, ww = hh * m.aspect;
    c.save(); c.translate(q.x, 0);
    c.filter = `blur(${(4 * S + p.s / 60).toFixed(1)}px)`; c.globalAlpha = 0.4 + 0.5 * fl;
    c.drawImage(m.lav, -ww * 0.53, q.y - hh * 0.03, ww * 1.06, hh * 1.06);
    c.filter = `blur(${(p.s / 80).toFixed(1)}px)`;   // close to the lens = out of focus
    c.globalAlpha = 1;
    c.drawImage(m.black, -ww / 2, q.y, ww, hh);
    c.restore();
  }
  // the vignette, the letterbox bars, the fade in from black
  const v = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.max(W, H) * 0.62);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.7)");
  c.fillStyle = v; c.fillRect(0, 0, W, H);
  c.fillStyle = "#000"; c.fillRect(0, 0, W, H * 0.1); c.fillRect(0, H * 0.9, W, H * 0.1);
  const fade = 1 - seg(t, cfg.headMs, cfg.headMs + 450);
  if (fade > 0) { c.fillStyle = `rgba(0,0,0,${fade})`; c.fillRect(0, 0, W, H); }
  // the white-out: a soft off-white eased in over a third of a second (never a
  // hard pop), then held until the cut
  const wk = seg(t, cfg.whiteMs + 60, cfg.whiteMs + 420), wo = wk * wk * (3 - 2 * wk);
  if (wo > 0) { c.fillStyle = `rgba(240,234,248,${wo})`; c.fillRect(0, 0, W, H); }
}

function cloud(c, x, y, rx, ry, fl) {
  const g = c.createRadialGradient(x, y, 0, x, y, rx);
  g.addColorStop(0, `rgba(8,3,16,${0.55 + 0.25 * fl})`); g.addColorStop(1, "rgba(8,3,16,0)");
  c.save(); c.translate(x, y); c.scale(1, ry / rx); c.translate(-x, -y);
  c.fillStyle = g; c.fillRect(x - rx, y - rx, rx * 2, rx * 2); c.restore();
}
function bolt(c, pts, a, S) {
  if (pts.length < 2) return;
  for (const [w, rgb, k] of [[14, "170,110,255", 0.35], [3, "255,255,255", 1]]) {
    c.strokeStyle = `rgba(${rgb},${a * k})`; c.lineWidth = w * S;
    c.beginPath(); pts.forEach(([x, y], j) => j ? c.lineTo(x, y) : c.moveTo(x, y)); c.stroke();
  }
}
function pine(c, p, q) {   // p = base, q = tip, both projected
  if (!p || !q) return;
  const w = (p.y - q.y) * 0.42;
  c.beginPath(); c.moveTo(q.x, q.y); c.lineTo(p.x + w / 2, p.y); c.lineTo(p.x - w / 2, p.y); c.closePath(); c.fill();
}

/* ── shot 3: actual size ─────────────────────────────────────────────────── */

function drawRays(L, u, cfg, sc, r, S) {
  const c = L.raysCtx, W = L.rays.width, H = L.rays.height;
  c.clearRect(0, 0, W, H);
  const a = Math.min(1, u / 120) * (1 - seg(u, cfg.raysMs - 700, cfg.raysMs));
  if (!(a > 0)) return;
  // never wider than twice his size
  const size = Math.max(r.w, r.h), R = size * 2 * (0.55 + 0.45 * eOut(seg(u, 0, 300))), rot = u / 1000 * 1.5;
  c.globalCompositeOperation = "lighter";
  for (const ray of sc.rays) {
    const g = c.createRadialGradient(r.x, r.y, 0, r.x, r.y, R);
    g.addColorStop(0, `rgba(255,244,205,${0.75 * a})`); g.addColorStop(0.45, `rgba(255,226,150,${0.4 * a})`); g.addColorStop(1, "rgba(255,226,150,0)");
    c.fillStyle = g; c.beginPath(); c.moveTo(r.x, r.y);
    c.arc(r.x, r.y, R, ray.ang + rot - ray.w / 2, ray.ang + rot + ray.w / 2); c.closePath(); c.fill();
  }
  const cg = c.createRadialGradient(r.x, r.y, 0, r.x, r.y, size * 0.85);
  cg.addColorStop(0, `rgba(255,250,225,${0.55 * a})`); cg.addColorStop(1, "rgba(255,250,225,0)");
  c.fillStyle = cg; c.fillRect(r.x - size, r.y - size, size * 2, size * 2);
  c.globalCompositeOperation = "source-over";
}

/* ── layers, tokens, sprites ─────────────────────────────────────────────── */

function makeLayers(W, H) {
  const canvasEl = (z) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", width: `${W}px`, height: `${H}px`, pointerEvents: "none", zIndex: String(z) });
    return c;
  };
  const shade = canvasEl(Z_CINE);
  const cine = document.createElement("div");
  Object.assign(cine.style, { position: "fixed", inset: "0", zIndex: String(Z_CINE + 1), pointerEvents: "none", background: "#000", display: "none", overflow: "hidden" });
  const sky = canvasEl(0), king = canvasEl(0), front = canvasEl(0);
  for (const el of [sky, king, front]) { el.style.position = "absolute"; el.style.zIndex = ""; cine.appendChild(el); }
  const rays = canvasEl(Z_RAYS);
  document.body.append(shade, cine, rays);
  return {
    shade, cine, king, rays,
    shadeCtx: shade.getContext("2d"), skyCtx: sky.getContext("2d"), kingCtx: king.getContext("2d"),
    frontCtx: front.getContext("2d"), raysCtx: rays.getContext("2d"),
    remove() { for (const el of [shade, cine, rays]) { try { el.remove(); } catch { /* gone */ } } },
  };
}

// The party on this scene, as mirrored black (and lavender, for the rim)
// copies of their art, ordered so the battle screen's bottom-most member is on
// the left.
function partyFor(kg) {
  const friendly = CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  const toks = (canvas?.tokens?.placeables ?? [])
    .filter((t) => t !== kg && !t.destroyed && t.document?.disposition === friendly && !t.document?.hidden && t.visible !== false)
    .map((t) => ({ t, rect: safeRect(t) }))
    .filter((p) => p.rect)
    .sort((a, b) => b.rect.y - a.rect.y)
    .slice(0, PARTY_SLOTS.length);
  return toks.map(({ t, rect }, i) => {
    const src = textureSource(t);
    const flip = -(Math.sign(t.mesh?.scale?.x ?? 1) || 1);   // mirrored from how the battle shows them
    const black = tint(src, "0,0,0", flip), lav = tint(src, "200,170,245", flip);
    if (!black || !lav) return null;
    const [x, z] = PARTY_SLOTS[i];
    return { rect, x, z, black, lav, aspect: black.width / black.height };
  }).filter(Boolean).sort((a, b) => a.x - b.x);
}

function textureSource(token) {
  const src = token?.texture?.baseTexture?.resource?.source ?? token?.mesh?.texture?.baseTexture?.resource?.source;
  if (src && (src.naturalWidth || src.videoWidth || src.width)) return src;
  return null;
}

// A one-colour copy of a sprite (optionally mirrored), made once per entrance.
function tint(src, rgb, flip = 1) {
  if (!src) return null;
  const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
  if (!(w > 0 && h > 0)) return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  try {
    if (flip < 0) { x.translate(w, 0); x.scale(-1, 1); }
    x.drawImage(src, 0, 0, w, h);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = "source-in";
    x.fillStyle = `rgb(${rgb})`; x.fillRect(0, 0, w, h);
  } catch { return null; }
  return c;
}

function holdShadow(token, k) {
  const sh = shadowSpriteFor(token.id);
  if (!sh || sh.destroyed) return;
  const a = SHADOW_STYLE.alpha * k;
  if (sh.fudBase) sh.fudBase.alpha = a;
  sh.alpha = a;
}
function hideToken(token) {
  if (token.destroyed) return;
  try { token.alpha = 0; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = 0; } catch { /* gone */ }
}
function showToken(token) {
  if (token.destroyed) return;
  try { token.alpha = 1; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = 1; } catch { /* gone */ }
  try { token.renderFlags?.set?.({ refreshState: true }); } catch { /* gone */ }
}

// Token → screen-space rect { x, y (centre), w, h }. The token is hidden
// (alpha 0) here, which leaves its bounds intact.
function screenRect(token) {
  const b = token.mesh?.getBounds?.();
  if (b && b.height > 0) return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  const s = canvas.stage.scale.x || 1;
  const c = canvas.stage.worldTransform.apply(new PIXI.Point(token.center.x, token.center.y));
  return { x: c.x, y: c.y, w: (token.w ?? 100) * s, h: (token.h ?? 100) * s };
}
function safeRect(token) { try { return screenRect(token); } catch { return null; } }
function rectNow(token, fallback) { return (!token.destroyed && safeRect(token)) || fallback; }

// A DOM copy of his art over the rays (the real token is redrawn by Foundry on
// every refresh; a copy is ours alone).
function makeCopy(token) {
  const src = String(token.document?.texture?.src ?? "");
  const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(src);
  const el = document.createElement(isVideo ? "video" : "img");
  if (isVideo) { el.muted = true; el.autoplay = true; el.loop = true; el.playsInline = true; }
  el.src = src;
  if (isVideo) el.play?.()?.catch?.(() => {});
  Object.assign(el.style, {
    position: "fixed", left: "0", top: "0", zIndex: String(Z_RAYS + 1), pointerEvents: "none",
    border: "none", outline: "none", boxShadow: "none", background: "none", objectFit: "contain",
  });
  document.body.appendChild(el);
  return el;
}
function placeCopy(el, r, flip) {
  if (!el) return;
  el.style.width = `${Math.round(r.w)}px`;
  el.style.height = `${Math.round(r.h)}px`;
  el.style.left = `${Math.round(r.x - r.w / 2)}px`;
  el.style.top = `${Math.round(r.y - r.h / 2)}px`;
  el.style.transform = `scaleX(${flip})`;
}

/* ── rail + small helpers ── */

function buildRail() {
  const pts = [];
  for (let i = 0; i + 3 < RAIL_P.length; i++) {
    for (let j = i ? 1 : 0; j <= 60; j++) {
      const k = j / 60;
      const b = [(1 - k) ** 3 / 6, (3 * k ** 3 - 6 * k * k + 4) / 6, (-3 * k ** 3 + 3 * k * k + 3 * k + 1) / 6, k ** 3 / 6];
      pts.push([0, 1].map((d) => b.reduce((sum, w, n) => sum + w * RAIL_P[i + n][d], 0)));
    }
  }
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len, total: len[len.length - 1] };
}
function railAt(u) {
  const d = u * RAIL.total;
  let i = 1;
  while (i < RAIL.len.length - 1 && RAIL.len[i] < d) i++;
  const k = (d - RAIL.len[i - 1]) / ((RAIL.len[i] - RAIL.len[i - 1]) || 1);
  return [lerp(RAIL.pts[i - 1][0], RAIL.pts[i][0], k), lerp(RAIL.pts[i - 1][1], RAIL.pts[i][1], k)];
}

// Seeded, so every client draws the same bolts, clouds and trees.
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function motes(seed, n, f) { const r = rng(seed); return Array.from({ length: n }, (_, i) => f(r, i)); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : (Number.isFinite(v) ? v : 1); }
function seg(t, a, b) { return clamp01((t - a) / (b - a)); }
function lerp(a, b, k) { return a + (b - a) * k; }
function eIn(k) { return k * k * k; }
function eOut(k) { return 1 - Math.pow(1 - k, 3); }
function eInOut(k) { return 0.5 - 0.5 * Math.cos(Math.PI * k); }
function smooth(k) { return k * k * (3 - 2 * k); }

// Exported for the bare-Node test.
export const _test = { RAIL, railAt, cam3 };
