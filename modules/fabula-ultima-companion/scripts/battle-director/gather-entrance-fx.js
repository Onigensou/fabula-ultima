// ============================================================================
// Gather entrance FX — renders a gather style (gather-styles.js) on THIS
// client: energy pulled in to the token's spot, then the creature pops out.
//
// Callers own the broadcast, exactly as with playDescentLocal: the director's
// battle-start entrance and its live-join path already run on every client.
//
// Drawn as a screen-fixed 2D canvas (ripples, motes, orb, fluff, ring) plus a
// DOM copy of the token's art for the squash-and-stretch pop, all re-projected
// from the token every frame so a camera move cannot strand them. The real
// token is held invisible (locally) for the whole effect and revealed at the
// end, under the copy — nothing is written to the document here.
// ============================================================================

import { warn } from "./logger.js";
import { playSfx } from "./director-sfx.js";
import { GATHER_STYLES, ELEMENT_RGB } from "./gather-styles.js";
import { runGiant } from "./giant-entrance-fx.js";
import { shadowSpriteFor, STYLE as SHADOW_STYLE } from "../sprite-shadow/sprite-shadow-renderer.js";

// Above the board, under the HP bars (99985) and damage numbers (99990).
const Z = 99984;
// An entrance gates the battle: it may never hold it longer than its own
// length plus this.
const FAILSAFE_MS = 1500;
// A client that receives the broadcast before its canvas has drawn the new
// token waits this long for it.
const TOKEN_WAIT_MS = 1500;
// The ground shadow (sprite-shadow) fades in over this long once he pops.
const SHADOW_IN_MS = 300;

/** Play `style` for the token on this client. Resolves when it is over (or skipped). */
export function playGatherLocal({ sceneId, tokenId, style } = {}) {
  return new Promise((resolve) => {
    const cfg = GATHER_STYLES[style];
    if (!cfg || typeof PIXI === "undefined" || !canvas?.ready) { resolve(); return; }
    if (sceneId && canvas.scene?.id !== sceneId) { resolve(); return; }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const failsafe = setTimeout(finish, cfg.totalMs + TOKEN_WAIT_MS + FAILSAFE_MS);
    waitForToken(tokenId)
      .then((token) => (!token ? null : cfg.renderer === "giant" ? runGiant(token, cfg) : runGather(token, cfg)))
      .catch((e) => warn(`gather-entrance: "${style}" threw`, e))
      .finally(() => { clearTimeout(failsafe); finish(); });
  });
}

async function waitForToken(tokenId) {
  const t0 = performance.now();
  for (;;) {
    const t = canvas?.tokens?.get?.(tokenId);
    if (t && !t.destroyed && t.mesh) return t;
    if (performance.now() - t0 > TOKEN_WAIT_MS) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* ── Renderer ────────────────────────────────────────────────────────────── */

async function runGather(token, cfg) {
  const motes = makeMotes(cfg.motes);
  const fluff = makeFluff(cfg.fluff);
  const sfxLeft = [...(cfg.sfx ?? [])];
  const flip = Math.sign(token.mesh?.scale?.x ?? 1) || 1;
  const fx = makeFxCanvas();
  let copy = null;
  let rect = screenRect(token);
  const rectNow = () => {
    if (!token.destroyed) { try { rect = screenRect(token); } catch { /* keep the last one */ } }
    return rect;
  };

  try {
    await new Promise((done) => {
      const t0 = performance.now();
      const tick = (now) => {
        const t = now - t0;
        const r = rectNow();
        hideToken(token);
        holdShadow(token, clamp01((t - cfg.pop.atMs) / SHADOW_IN_MS));
        while (sfxLeft.length && t >= sfxLeft[0].atMs) {
          const s = sfxLeft.shift();
          playSfx(s.url, s.volume ?? 0.6);
        }
        const c = fx.ctx;
        c.clearRect(0, 0, fx.c.width, fx.c.height);
        drawRipples(c, r, cfg.ripples, t);
        drawMotes(c, r, cfg.motes, motes, t, cfg.orb.y);
        drawOrb(c, r, cfg.orb, t);
        drawFlash(c, r, cfg.flash, t);
        drawFluff(c, r, cfg.fluff, fluff, t);
        if (t >= cfg.pop.atMs) {
          if (!copy) copy = makeCopy(token);
          placeCopy(copy, r, cfg.pop, t, flip);
        }
        drawGlint(c, r, cfg.glint, t, flip);
        drawRing(c, r, cfg.ring, t);
        if (t >= cfg.totalMs) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    fx.done();
    // Reveal the real token under the copy, then drop the copy on the next frame
    // so there is no gap between them.
    showToken(token);
    await new Promise((r) => requestAnimationFrame(r));
    try { copy?.remove(); } catch { /* gone */ }
  }
}

// The sprite shadow keeps its own copy of the mesh's alpha (`fudBase`) and
// re-applies it every frame for a hovering body, so hiding the mesh does not
// reach it: drive that copy directly. showToken's refresh re-syncs it after.
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

// Token → screen-space rect { x, y (centre), w, h } of its drawn art.
function screenRect(token) {
  const b = token.mesh?.getBounds?.();
  if (b && b.height > 0) return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  const s = canvas.stage.scale.x || 1;
  const c = canvas.stage.worldTransform.apply(new PIXI.Point(token.center.x, token.center.y));
  return { x: c.x, y: c.y, w: (token.w ?? 100) * s, h: (token.h ?? 100) * s };
}

function makeFxCanvas() {
  const c = document.createElement("canvas");
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  Object.assign(c.style, { position: "fixed", inset: "0", zIndex: String(Z), pointerEvents: "none" });
  document.body.appendChild(c);
  const ctx = c.getContext("2d");
  ctx.globalCompositeOperation = "lighter";
  return { c, ctx, done: () => { try { c.remove(); } catch { /* gone */ } } };
}

function glow(ctx, x, y, r, rgb, alpha) {
  if (!(r > 0) || !(alpha > 0)) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// Soft dark fluff, painted normally (a glow would brighten instead of darken).
function smoke(ctx, x, y, r, alpha) {
  if (!(r > 0) || !(alpha > 0)) return;
  const a = alpha * 0.62;
  ctx.globalCompositeOperation = "source-over";
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(38,28,48,${a})`);
  g.addColorStop(0.55, `rgba(46,34,58,${a * 0.6})`);
  g.addColorStop(1, "rgba(46,34,58,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = "lighter";
}

function drawRipples(ctx, r, p, t) {
  if (!p || t >= p.untilMs) return;
  const groundY = r.y + r.h * 0.47;
  for (let k = 0; k < p.count; k++) {
    const q = (t - k * p.everyMs) / p.lifeMs;
    if (q < 0 || q > 1) continue;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.translate(r.x, groundY);
    ctx.scale(1, 0.28);
    ctx.strokeStyle = `rgba(${p.rgb},${p.alpha * (1 - q)})`;
    ctx.lineWidth = Math.max(1, r.h * p.width * (1 - q));
    ctx.beginPath(); ctx.arc(0, 0, r.h * (0.18 + p.reach * q), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.globalCompositeOperation = "lighter";
  }
}

function makeMotes(m) {
  const out = [];
  for (let i = 0; i < m.count; i++) {
    out.push({
      at: rand(0, m.spawnOverMs),
      life: rand(m.lifeMs[0], m.lifeMs[1]),
      ang: rand(0, Math.PI * 2),
      from: rand(m.from[0], m.from[1]),
      swirl: (Math.random() < 0.5 ? -1 : 1) * rand(m.swirl[0], m.swirl[1]),
      size: rand(m.size[0], m.size[1]),
      rgb: ELEMENT_RGB[i % ELEMENT_RGB.length],
    });
  }
  return out;
}

// Motes converge on the orb's centre (`orbY`, a share of h from the token centre).
function drawMotes(ctx, r, cfg, motes, t, orbY = 0) {
  const long = Math.max(window.innerWidth, window.innerHeight);
  const oy = r.y + r.h * orbY;
  for (const m of motes) {
    const k = (t - m.at) / m.life;
    if (k < 0 || k > 1) continue;
    const e = k * k * k;
    const rad = m.from * long * (1 - e);
    const an = m.ang + m.swirl * e;
    glow(ctx, r.x + Math.cos(an) * rad, oy + Math.sin(an) * rad * 0.8, m.size * r.h * (1 - 0.4 * e), m.rgb, 0.35 + 0.6 * e);
  }
}

function drawOrb(ctx, r, o, t) {
  const grow = easeOut(clamp01((t - o.growMs[0]) / (o.growMs[1] - o.growMs[0])));
  const shrink = clamp01((t - o.shrinkMs[0]) / (o.shrinkMs[1] - o.shrinkMs[0]));
  const rad = o.radius * r.h * grow * (1 - shrink);
  if (rad < 0.5) return;
  const cx = r.x, cy = r.y + o.y * r.h;
  const n = ELEMENT_RGB.length;
  for (let i = 0; i < n; i++) {
    const an = t / o.spinMs + i * (Math.PI * 2 / n);
    glow(ctx, cx + Math.cos(an) * rad * 0.55, cy + Math.sin(an) * rad * 0.55, rad * 0.8, ELEMENT_RGB[i], 0.75);
  }
  glow(ctx, cx, cy, rad * 0.7, "255,255,255", 0.8 + 0.2 * Math.sin(t / 40));
}

function drawFlash(ctx, r, f, t) {
  const k = (t - f.atMs) / f.ms;
  if (k < 0 || k > 1) return;
  glow(ctx, r.x, r.y, f.radius * r.h, f.rgb, 0.9 * (1 - k));
}

function makeFluff(f) {
  const out = [];
  for (let i = 0; i < f.count; i++) {
    out.push({ ang: (i / f.count) * Math.PI * 2 + rand(0, 0.4), reach: rand(f.reach[0], f.reach[1]), size: rand(f.size[0], f.size[1]) });
  }
  return out;
}

function drawFluff(ctx, r, f, fluff, t) {
  const k = (t - f.atMs) / f.ms;
  if (k < 0 || k > 1) return;
  const e = easeOut(k);
  for (const p of fluff) {
    smoke(ctx, r.x + Math.cos(p.ang) * p.reach * r.h * e, r.y + Math.sin(p.ang) * p.reach * r.h * e * 0.7 + r.h * 0.07,
      p.size * r.h * (0.6 + 0.6 * e), 0.85 * (1 - k));
  }
}

function drawGlint(ctx, r, g, t, flip) {
  const k = (t - g.atMs) / g.ms;
  if (k <= 0 || k >= 1) return;
  const x = r.x + g.at[0] * r.h * flip, y = r.y + g.at[1] * r.h;
  const size = g.size * r.h * Math.sin(Math.PI * k), a = Math.sin(Math.PI * k);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(k * 2);
  ctx.fillStyle = `rgba(255,244,200,${a})`;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 ? size * 0.18 : size;
    const an = i * Math.PI / 4;
    ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
  glow(ctx, x, y, size * 0.9, "255,230,150", a * 0.6);
}

function drawRing(ctx, r, g, t) {
  const k = (t - g.atMs) / g.ms;
  if (k <= 0 || k >= 1) return;
  const rad = r.h * (g.from + (g.to - g.from) * easeOut(k));
  const n = ELEMENT_RGB.length;
  ctx.lineWidth = Math.max(1, r.h * g.width * (1 - k));
  for (let i = 0; i < n; i++) {
    ctx.strokeStyle = `rgba(${ELEMENT_RGB[i]},${g.alpha * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(r.x, r.y, rad, (i / n) * Math.PI * 2, ((i + 1) / n) * Math.PI * 2);
    ctx.stroke();
  }
}

// A DOM copy of the token's art for the squash-and-stretch: the real mesh is
// redrawn by Foundry on every refresh, a copy is ours alone.
function makeCopy(token) {
  const src = String(token.document?.texture?.src ?? "");
  const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(src);
  const el = document.createElement(isVideo ? "video" : "img");
  if (isVideo) { el.muted = true; el.autoplay = true; el.loop = true; el.playsInline = true; }
  el.src = src;
  if (isVideo) el.play?.()?.catch?.(() => {});
  Object.assign(el.style, {
    position: "fixed", left: "0", top: "0", zIndex: String(Z - 1), pointerEvents: "none",
    border: "none", outline: "none", boxShadow: "none", background: "none", objectFit: "contain",
    transformOrigin: "50% 100%",
  });
  document.body.appendChild(el);
  return el;
}

function placeCopy(el, r, p, t, flip) {
  const k = clamp01((t - p.atMs) / p.ms);
  const b = easeBack(k);
  const sx = p.fromScale[0] + (1 - p.fromScale[0]) * b;
  const sy = p.fromScale[1] + (1 - p.fromScale[1]) * b;
  const hop = -p.hop * r.h * Math.sin(Math.PI * clamp01((t - p.atMs) / p.hopMs));
  el.style.width = `${Math.round(r.w)}px`;
  el.style.height = `${Math.round(r.h)}px`;
  el.style.left = `${Math.round(r.x - r.w / 2)}px`;
  el.style.top = `${Math.round(r.y - r.h / 2 + hop)}px`;
  el.style.transform = `scale(${(flip * sx).toFixed(3)}, ${sy.toFixed(3)})`;
}

/* ── small helpers ── */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : (Number.isFinite(v) ? v : 1); }
function rand(a, b) { return a + Math.random() * (b - a); }
function easeOut(k) { return 1 - Math.pow(1 - k, 3); }
function easeBack(k) { const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }
