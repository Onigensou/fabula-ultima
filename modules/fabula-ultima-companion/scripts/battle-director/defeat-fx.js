// ============================================================================
// Defeat FX — renders a monster's defeat style (defeat-styles.js) on every
// client, then hands back to defeat-reactor.js, which removes the token.
//
// Same shape as the entrance (boss-entrance-fx.js / director-init.js): the GM
// broadcasts, every client draws on ITS OWN canvas, the GM awaits its own
// playback before the removal. Drawn as a screen-fixed 2D canvas (glows,
// particles) plus a DOM afterimage, both re-projected from the token every
// frame so a camera move cannot strand them. The token itself is only faded
// and tinted locally — nothing is written; the GM's delete follows.
//
// Only reached for a monster with a non-"standard" style; "standard" never
// gets here and keeps defeat-reactor's own Sequencer chain untouched.
// ============================================================================

import { warn } from "./logger.js";
import { playSfx } from "./director-sfx.js";
import { shouldRender, hasOtherViewers } from "./presentation-clock.js";
import { DEFEAT_STYLES, DEFEAT_MODULE_ID } from "./defeat-styles.js";
import { shadowSpriteFor, STYLE as SHADOW_STYLE } from "../sprite-shadow/sprite-shadow-renderer.js";
import { CameraApi } from "./director-camera.js";
import { suspendCamera, resumeCamera } from "./camera-authority.js";

const ACTION_PLAY = "FU_DEFEAT_FX_PLAY";
const ACTION_RESTORE = "FU_DEFEAT_FX_RESTORE";
// Above the board, under the HP bars (99985) and damage numbers (99990).
const Z = 99984;
// A defeat sits inside the action's resolution: it may never hold the battle
// longer than its own length plus this.
const FAILSAFE_MS = 1500;

let _socket = null;

// Register on EVERY client (call once at ready).
export function initDefeatFx() {
  if (_socket) return;
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("defeat-fx: socketlib unavailable — defeat styles stay GM-local");
      return;
    }
    _socket = socketlib.registerModule(DEFEAT_MODULE_ID);
    _socket.register(ACTION_PLAY, playDefeatLocal);
    _socket.register(ACTION_RESTORE, restoreDefeatLocal);
  } catch (e) {
    warn("defeat-fx: init failed", e);
  }
}

/**
 * GM: play `style` for the token on every client. Resolves when the creature
 * can be removed. Never throws.
 */
export async function playDefeatFx({ tokenUuid, style, causeTokenUuid = null } = {}) {
  const cfg = DEFEAT_STYLES[style];
  if (!cfg || !tokenUuid) return;
  try { _socket?.executeForOthers?.(ACTION_PLAY, { tokenUuid, style, causeTokenUuid }); }
  catch (e) { warn("defeat-fx: broadcast failed", e); }
  if (shouldRender()) await playDefeatLocal({ tokenUuid, style, causeTokenUuid });
  // A hidden GM draws nothing, but the broadcast has left: hold the removal
  // for the style's length so the token is not deleted under everyone else.
  else if (hasOtherViewers()) await new Promise((r) => setTimeout(r, cfg.totalMs));
}

// Playbacks told to stop (a defeat begun on the hit that did not stand). The
// renderer checks it every frame; a new playback of the token clears it.
const _aborted = new Set();

/**
 * GM: undo a defeat begun on the killing blow that did not stand — the creature
 * was not removed after all (healed back above 0, or the battle went away first).
 * Stops any running playback and shows the token again, on every client.
 */
export function restoreDefeatFx(tokenUuid) {
  if (!tokenUuid) return;
  try { _socket?.executeForOthers?.(ACTION_RESTORE, { tokenUuid }); }
  catch (e) { warn("defeat-fx: restore broadcast failed", e); }
  restoreDefeatLocal({ tokenUuid });
}

function restoreDefeatLocal({ tokenUuid } = {}) {
  _aborted.add(tokenUuid);
  let token = null;
  try { token = fromUuidSync(tokenUuid)?.object ?? null; } catch { token = null; }
  if (!token || token.destroyed) return;
  try { token.alpha = token.document?.alpha ?? 1; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = 1; } catch { /* gone */ }
  try {
    const sh = shadowSpriteFor(token.id);
    if (sh && !sh.destroyed) { if (sh.fudBase) sh.fudBase.alpha = SHADOW_STYLE.alpha; sh.alpha = SHADOW_STYLE.alpha; }
  } catch { /* no shadow */ }
  try { token.renderFlags?.set?.({ refreshState: true }); } catch { /* older core */ }
}

/**
 * Play a defeat style on THIS client. Resolves when it has finished (or was
 * skipped). `causeTokenUuid` — whoever landed the killing blow — only steers
 * the styles that care which way the hit came from ("launched").
 */
export function playDefeatLocal({ tokenUuid, style, causeTokenUuid = null } = {}) {
  return new Promise((resolve) => {
    const cfg = DEFEAT_STYLES[style];
    let token = null;
    try { token = fromUuidSync(tokenUuid)?.object ?? null; } catch { token = null; }
    if (!cfg || !token || token.destroyed || !shouldRender() || typeof PIXI === "undefined") {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const failsafe = setTimeout(finish, cfg.totalMs + FAILSAFE_MS);
    let cause = null;
    try { cause = causeTokenUuid ? (fromUuidSync(causeTokenUuid)?.object ?? null) : null; } catch { cause = null; }
    _aborted.delete(tokenUuid);
    const stopped = () => _aborted.has(tokenUuid);
    (cfg.launch ? runLaunched(token, cfg, cause, stopped) : runDefeat(token, cfg, stopped))
      .catch((e) => warn(`defeat-fx: "${style}" threw`, e))
      .finally(() => {
        // Undone mid-way: the renderer's last frame may have hidden the token
        // again after the restore, so show it once more now that it has let go.
        if (stopped()) restoreDefeatLocal({ tokenUuid });
        clearTimeout(failsafe); finish();
      });
  });
}

/* ── Renderer ────────────────────────────────────────────────────────────── */

// `sfx` is one cue at the start, or a list of { atMs, url, volume }.
function cueList(sfx) {
  return (Array.isArray(sfx) ? sfx : sfx ? [{ atMs: 0, ...sfx }] : [])
    .slice().sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

function playCuesUpTo(cues, t) {
  while (cues.length && t >= (cues[0].atMs ?? 0)) {
    const c = cues.shift();
    playSfx(c.url, c.volume ?? 0.6);
  }
}

async function runDefeat(token, cfg, stopped = () => false) {
  const cues = cueList(cfg.sfx);

  let rect = screenRect(token);
  const rectNow = () => {
    if (!token.destroyed) { try { rect = screenRect(token); } catch { /* keep the last one */ } }
    return rect;
  };
  const motes = cfg.motes ? makeMotes(cfg.motes) : null;
  const embers = cfg.embers ? makeEmbers(cfg.embers) : null;
  const leak = cfg.leak ? makeLeak(cfg.leak) : null;
  const fluff = cfg.fluff ? makeFluff(cfg.fluff) : null;
  const baseTint = Number(token.mesh?.tint ?? 0xffffff);
  const flip = Math.sign(token.mesh?.scale?.x ?? 1) || 1;
  // DOM copies of the art: the body (shudder / swell) and a crown piece cut
  // out of it. The real mesh is redrawn by Foundry on every refresh; these are ours.
  const copy = cfg.copy ? makeCopy(token) : null;
  const crown = cfg.crown ? makeCopy(token, cfg.crown.clip) : null;

  if (cfg.afterimage) spawnAfterimage(token, rect, cfg.afterimage);
  if (cfg.shake) shakeBoard(cfg.shake);

  const fx = makeFxCanvas();
  try {
    await new Promise((done) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (stopped()) { done(); return; }   // undone: draw nothing more
        const t = now - t0;
        const r = rectNow();
        applyBody(token, cfg.body, t, baseTint);
        playCuesUpTo(cues, t);
        if (copy) placeBody(copy, r, cfg.copy, t, flip);
        if (crown) placeCrown(crown, r, cfg.crown, t, flip);
        fx.ctx.clearRect(0, 0, fx.c.width, fx.c.height);
        if (leak) drawLeak(fx.ctx, r, cfg.leak, leak, t);
        if (cfg.screenFlash) drawScreenFlash(fx.ctx, fx.c, cfg.screenFlash, t);
        if (fluff) drawFluff(fx.ctx, r, cfg.fluff, fluff, t);
        if (cfg.glow) drawBodyGlow(fx.ctx, r, cfg.glow, t);
        if (motes) drawMotes(fx.ctx, r, cfg.motes, motes, t);
        if (cfg.flash) drawFlash(fx.ctx, r, cfg.flash, t);
        if (cfg.ring) drawRing(fx.ctx, r, cfg.ring, t);
        if (embers) drawEmbers(fx.ctx, r, cfg.embers, embers, t);
        if (t >= cfg.totalMs || stopped()) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    fx.done();
    try { copy?.remove(); } catch { /* gone */ }
    try { crown?.remove(); } catch { /* gone */ }
  }
  // Leave the body out until the GM's delete lands — a token refresh in
  // between would otherwise pop it back in for a frame.
  if (!stopped()) applyBody(token, cfg.body, Infinity, baseTint);
}

// Fade (and optionally cool) the token. Re-applied every frame: a token
// refresh mid-defeat resets alpha from the document.
function applyBody(token, body, t, baseTint) {
  if (!body || token.destroyed) return;
  const k = clamp01((t - (body.delayMs ?? 0)) / Math.max(1, body.fadeMs ?? 1));
  const a = 1 - k;
  try { token.alpha = a; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = a; } catch { /* gone */ }
  // The ground shadow keeps its own alpha copy (re-applied every frame for a
  // hovering body), so fading the mesh does not reach it: fade it with the body.
  try {
    const sh = shadowSpriteFor(token.id);
    if (sh && !sh.destroyed) { if (sh.fudBase) sh.fudBase.alpha = SHADOW_STYLE.alpha * a; sh.alpha = SHADOW_STYLE.alpha * a; }
  } catch { /* no shadow */ }
  if (body.tintTo != null && token.mesh) {
    try { token.mesh.tint = lerpColor(baseTint, body.tintTo, k); } catch { /* gone */ }
  }
}

// Token → screen-space rect { x, y (centre), h }. Prefers the drawn mesh (a
// battle sprite is usually larger than its grid footprint).
function screenRect(token) {
  const b = token.mesh?.getBounds?.();
  if (b && b.height > 0) return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  const wt = canvas.stage.worldTransform;
  const c = wt.apply(new PIXI.Point(token.center.x, token.center.y));
  const s = canvas.stage.scale.x || 1;
  return { x: c.x, y: c.y, w: (token.w ?? 100) * s, h: (token.h ?? 100) * s };
}

function makeFxCanvas(z = Z) {
  const c = document.createElement("canvas");
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  Object.assign(c.style, { position: "fixed", inset: "0", zIndex: String(z), pointerEvents: "none" });
  document.body.appendChild(c);
  const ctx = c.getContext("2d");
  ctx.globalCompositeOperation = "lighter";
  return { c, ctx, done: () => { try { c.remove(); } catch { /* gone */ } } };
}

function drawGlow(ctx, x, y, r, rgb, alpha) {
  if (!(r > 0) || !(alpha > 0)) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/* ── dissolve ── */

function makeMotes(m) {
  const out = [];
  for (let i = 0; i < m.count; i++) {
    out.push({
      at: rand(0, m.spawnOverMs),
      life: rand(m.lifeMs[0], m.lifeMs[1]),
      dx: rand(-0.32, 0.32),        // across the body
      dy: rand(-0.38, 0.4),         // from the feet to the shoulders
      rise: rand(m.rise[0], m.rise[1]),
      size: rand(m.size[0], m.size[1]),
      phase: rand(0, Math.PI * 2),
      rgb: m.rgb[i % m.rgb.length],
    });
  }
  return out;
}

function drawMotes(ctx, r, m, motes, t) {
  for (const p of motes) {
    const k = (t - p.at) / p.life;
    if (k < 0 || k > 1) continue;
    const e = 1 - Math.pow(1 - k, 2);                       // easeOutQuad — lift off, then drift
    const x = r.x + p.dx * r.h + Math.sin(p.phase + k * 4) * m.sway * r.h;
    const y = r.y + p.dy * r.h - p.rise * r.h * e;
    const a = Math.min(1, k * 6) * (1 - k);                 // pop in, fade out
    drawGlow(ctx, x, y, p.size * r.h, p.rgb, 0.9 * a);
  }
}

function drawBodyGlow(ctx, r, g, t) {
  const k = clamp01(t / g.ms);
  drawGlow(ctx, r.x, r.y, r.h * 0.6, g.rgb, g.alpha * Math.sin(Math.PI * Math.min(1, k * 1.4)) * (1 - k));
}

/* ── burst ── */

function drawFlash(ctx, r, f, t) {
  const k = (t - (f.atMs ?? 0)) / f.ms;
  if (k < 0) return;
  if (k > 1) return;
  drawGlow(ctx, r.x, r.y, r.h * f.size * (0.55 + 0.6 * k), f.rgb, 1 - k);
}

function drawRing(ctx, r, g, t) {
  const k = (t - (g.atMs ?? 0)) / g.ms;
  if (k < 0) return;
  if (k > 1) return;
  const e = 1 - Math.pow(1 - k, 3);
  ctx.strokeStyle = `rgba(${g.rgb},${0.85 * (1 - k)})`;
  ctx.lineWidth = Math.max(1, r.h * g.width * (1 - k));
  ctx.beginPath();
  ctx.arc(r.x, r.y, r.h * (0.2 + g.reach * e), 0, Math.PI * 2);
  ctx.stroke();
}

function makeEmbers(m) {
  const out = [];
  for (let i = 0; i < m.count; i++) {
    out.push({
      ang: (i / m.count) * Math.PI * 2 + rand(-0.2, 0.2),
      reach: rand(m.reach[0], m.reach[1]),
      size: rand(m.size[0], m.size[1]),
      rgb: m.rgb[i % m.rgb.length],
    });
  }
  return out;
}

function drawEmbers(ctx, r, m, embers, t) {
  const k = (t - (m.atMs ?? 0)) / m.ms;
  if (k < 0) return;
  if (k > 1) return;
  const e = 1 - Math.pow(1 - k, 3);
  for (const p of embers) {
    const x = r.x + Math.cos(p.ang) * p.reach * r.h * e;
    const y = r.y + Math.sin(p.ang) * p.reach * r.h * e - m.lift * r.h * k * k;
    drawGlow(ctx, x, y, p.size * r.h, p.rgb, 1 - k);
  }
}

/* ── overfed ── */

// Motes leaking out of a swelling body.
function makeLeak(m) {
  const out = [];
  for (let i = 0; i < m.count; i++) {
    out.push({ at: rand(m.fromMs, m.toMs), ang: rand(0, Math.PI * 2), rgb: m.rgb[i % m.rgb.length] });
  }
  return out;
}

function drawLeak(ctx, r, m, leak, t) {
  for (const p of leak) {
    const k = (t - p.at) / m.lifeMs;
    if (k < 0 || k > 1) continue;
    const d = r.h * (m.from + (m.to - m.from) * k);
    drawGlow(ctx, r.x + Math.cos(p.ang) * d, r.y + Math.sin(p.ang) * d, m.size * r.h, p.rgb, 1 - k);
  }
}

function drawScreenFlash(ctx, c, f, t) {
  const k = (t - f.atMs) / f.ms;
  if (k < 0 || k > 1) return;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(${f.rgb},${f.alpha * (1 - k)})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "lighter";
}

function makeFluff(f) {
  const out = [];
  for (let i = 0; i < f.count; i++) {
    out.push({ ang: (i / f.count) * Math.PI * 2 + rand(0, 0.3), reach: rand(f.reach[0], f.reach[1]), size: rand(f.size[0], f.size[1]) });
  }
  return out;
}

// Soft dark fluff, painted normally (a glow would brighten instead of darken).
function drawFluff(ctx, r, f, fluff, t) {
  const k = (t - f.atMs) / f.ms;
  if (k < 0 || k > 1) return;
  const e = 1 - Math.pow(1 - k, 3);
  ctx.globalCompositeOperation = "source-over";
  for (const p of fluff) {
    const x = r.x + Math.cos(p.ang) * p.reach * r.h * e;
    const y = r.y + Math.sin(p.ang) * p.reach * r.h * e * 0.7;
    const rad = p.size * r.h * (0.6 + 0.6 * e);
    const a = f.alpha * 0.62 * (1 - k);
    if (!(rad > 0) || !(a > 0)) continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(38,28,48,${a})`);
    g.addColorStop(0.55, `rgba(46,34,58,${a * 0.6})`);
    g.addColorStop(1, "rgba(46,34,58,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = "lighter";
}

// A DOM copy of the token's art; `clip` cuts a piece out of it (the crown).
function makeCopy(token, clip = null) {
  const src = String(token.document?.texture?.src ?? "");
  const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(src);
  const el = document.createElement(isVideo ? "video" : "img");
  if (isVideo) { el.muted = true; el.autoplay = true; el.loop = true; el.playsInline = true; }
  el.src = src;
  if (isVideo) el.play?.()?.catch?.(() => {});
  Object.assign(el.style, {
    position: "fixed", left: "0", top: "0", zIndex: String(Z - 1), pointerEvents: "none",
    border: "none", outline: "none", boxShadow: "none", background: "none", objectFit: "contain",
    ...(clip ? { clipPath: clip } : {}),
  });
  document.body.appendChild(el);
  return el;
}

function boxAt(el, r, cx, cy) {
  el.style.width = `${Math.round(r.w)}px`;
  el.style.height = `${Math.round(r.h)}px`;
  el.style.left = `${Math.round(cx - r.w / 2)}px`;
  el.style.top = `${Math.round(cy - r.h / 2)}px`;
}

// The body copy: shudders through hue shifts, then swells and brightens, and
// is gone at `popMs`.
function placeBody(el, r, c, t, flip) {
  if (t >= c.popMs) { el.style.display = "none"; return; }
  const sh = clamp01(t / c.shudderMs);
  const sw = clamp01((t - c.shudderMs) / (c.popMs - c.shudderMs));
  const jx = Math.sin(t * c.jitterHz) * r.h * (c.jitter[0] + c.jitter[1] * sh + c.jitter[2] * sw);
  const hue = Math.sin(t / 45) * c.hueDeg * (0.4 + sh);
  const sc = 1 + c.swell * sw * sw * sw;
  const wob = 1 + c.wobble * Math.sin(t / 30) * sw;
  boxAt(el, r, r.x + jx, r.y);
  el.style.transformOrigin = "50% 70%";
  el.style.transform = `scale(${(flip * sc * wob).toFixed(3)}, ${sc.toFixed(3)})`;
  el.style.filter = `hue-rotate(${hue.toFixed(0)}deg) saturate(${(1 + sh).toFixed(2)}) brightness(${(1 + c.bright * sw).toFixed(2)})`;
}

// The crown: hidden until the pop, then flung up and off to one side, falls to
// the ground, bounces once, settles tilted and fades.
function placeCrown(el, r, c, t, flip) {
  if (t < c.atMs) { el.style.display = "none"; return; }
  el.style.display = "";
  const offX = c.center[0] * r.h * flip, offY = c.center[1] * r.h;
  const x0 = r.x + offX, y0 = r.y + offY - c.lift * r.h;
  const ground = r.y + c.ground * r.h;
  const side = -flip * c.side * r.h;
  const top = y0 - c.up * r.h;
  const f = clamp01((t - c.atMs) / c.flyMs);
  let x = x0 + side * f;
  let y = f <= 0.5
    ? y0 - c.up * r.h * Math.sin(Math.PI * f)
    : top + (ground - top) * Math.pow((f - 0.5) * 2, 3);
  let rot = c.spinDeg * (1 - Math.pow(1 - f, 3));
  const b = clamp01((t - c.atMs - c.flyMs) / c.bounceMs);
  if (f >= 1) {
    x = x0 + side - flip * c.roll * r.h * b;
    y = ground - c.bounce * r.h * Math.sin(Math.PI * b);
    rot = c.spinDeg + c.restTiltDeg * clamp01((t - c.atMs - c.flyMs) / (c.bounceMs * 1.4));
  }
  const a = 1 - clamp01((t - c.atMs - c.fadeAfterMs) / c.fadeMs);
  // Box centre that puts the crown art's centre at (x, y); rotate about the crown.
  boxAt(el, r, x - offX, y - offY);
  el.style.transformOrigin = `${(50 + (offX / r.w) * 100).toFixed(1)}% ${(50 + (offY / r.h) * 100).toFixed(1)}%`;
  el.style.transform = `rotate(${(rot * flip).toFixed(1)}deg) scale(${flip}, 1)`;
  el.style.opacity = String(a);
}

// The sprite's own art, blown outward and faded — read as the body breaking
// apart. One-time projection: it lives ~0.6 s.
function spawnAfterimage(token, r, a) {
  try {
    const src = String(token.document?.texture?.src ?? "");
    if (!src) return;
    const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(src);
    const el = document.createElement(isVideo ? "video" : "img");
    if (isVideo) { el.muted = true; el.autoplay = true; el.loop = true; el.playsInline = true; }
    el.src = src;
    if (isVideo) el.play?.()?.catch?.(() => {});
    const flip = Math.sign(token.mesh?.scale?.x ?? 1) || 1;
    Object.assign(el.style, {
      position: "fixed", left: `${Math.round(r.x)}px`, top: `${Math.round(r.y)}px`,
      height: `${Math.round(r.h)}px`, width: "auto", zIndex: String(Z), pointerEvents: "none",
      border: "none", outline: "none", boxShadow: "none", background: "none",
      opacity: String(a.alpha), transform: `translate(-50%, -50%) scale(${flip}, 1)`,
    });
    document.body.appendChild(el);
    const anim = el.animate(
      [
        { transform: `translate(-50%, -50%) scale(${flip}, 1)`, opacity: a.alpha },
        { transform: `translate(-50%, -50%) scale(${flip * a.growTo}, ${a.growTo})`, opacity: 0 },
      ],
      { duration: a.ms, easing: "cubic-bezier(0.33, 1, 0.68, 1)", fill: "forwards" },
    );
    anim.onfinish = () => { try { el.remove(); } catch { /* gone */ } };
    setTimeout(() => { try { el.remove(); } catch { /* gone */ } }, a.ms + 400);
  } catch (e) { warn("defeat-fx: afterimage failed", e); }
}

function shakeBoard(s) {
  try {
    const board = canvas.app?.view ?? document.getElementById("board");
    if (!board?.animate) return;
    const frames = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const d = s.px * (1 - i / n);
      frames.push({ transform: i === n ? "translate(0,0)" : `translate(${rand(-d, d).toFixed(1)}px, ${rand(-d, d).toFixed(1)}px)` });
    }
    board.animate(frames, { duration: s.ms, easing: "linear" });
  } catch (e) { warn("defeat-fx: shake failed", e); }
}

/* ── launched ── */

// A Smash Bros. KO. Unlike the other styles everything here is anchored in
// WORLD space and projected every frame, because the camera moves twice (the
// punch-in, the pull-back) and the exit point only exists in terms of the view
// the camera returns to. Three layers: `under` (dim, speed lines, smoke trail)
// below the flying body copy, the fx canvas (impact, streak, beam) above it.
async function runLaunched(token, cfg, cause, stopped = () => false) {
  const H = cfg.hitstop, L = cfg.launch, B = cfg.blast;
  const cues = cueList(cfg.sfx);
  const st = canvas.stage;
  const toScreen = (p) => st.worldTransform.apply(new PIXI.Point(p.x, p.y));
  const scaleNow = () => st.scale?.x || 1;
  const flip = Math.sign(token.mesh?.scale?.x ?? 1) || 1;
  const baseTint = Number(token.mesh?.tint ?? 0xffffff);

  // The body in world units, measured once — the token is hidden from here on.
  const r0 = screenRect(token);
  const c0 = st.worldTransform.applyInverse(new PIXI.Point(r0.x, r0.y));
  const body = { x: c0.x, y: c0.y, w: r0.w / scaleNow(), h: r0.h / scaleNow() };

  // He flies AWAY from whoever hit him; with no attacker (a damage tick), away
  // from the middle of the field.
  const from = cause && !cause.destroyed ? cause.center : null;
  let side = from ? Math.sign(body.x - from.x) : 0;
  if (!side) {
    const d = canvas.dimensions?.rect;
    side = (d ? Math.sign(body.x - (d.x + d.width / 2)) : 0) || -1;
  }
  const ang = (L.angleDeg * Math.PI) / 180;
  const dir = { x: side * Math.cos(ang), y: -Math.sin(ang) };
  const hit = { x: body.x - side * body.w * 0.3, y: body.y - body.h * 0.05 };

  // The view the camera comes back to, and where on its edge he leaves —
  // the VISIBLE edge: an open sidebar covers the right of the canvas.
  const saved = { x: st.pivot.x, y: st.pivot.y, scale: scaleNow() };
  const vp = CameraApi.viewportOf();
  const vh = vp.h;
  const ins = vp.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const pos = st.position;
  const exitDist = rayExit(body, dir, {
    x0: saved.x + (ins.left - pos.x) / saved.scale, x1: saved.x + (vp.w - ins.right - pos.x) / saved.scale,
    y0: saved.y + (ins.top - pos.y) / saved.scale, y1: saved.y + (vp.h - ins.bottom - pos.y) / saved.scale,
  });
  const exit = { x: body.x + dir.x * exitDist, y: body.y + dir.y * exitDist };
  const speed = exitDist / Math.max(1, L.edgeMs);              // world px per ms
  const flyEnd = Math.min(L.edgeMs * 1.6, (exitDist + L.overshoot * body.h) / Math.max(1e-6, speed));
  const flightAt = (u) => ({ x: body.x + dir.x * speed * u, y: body.y + dir.y * speed * u });
  const tBlast = H.ms + L.edgeMs;

  let camHeld = false;
  try { suspendCamera(); camHeld = true; } catch { /* no authority */ }
  try {
    CameraApi.panTo({ x: (body.x + hit.x) / 2, y: body.y, scale: saved.scale * H.zoom }, { duration: H.zoomInMs })
      ?.catch?.(() => {});
  } catch (e) { warn("defeat-fx: launch zoom failed", e); }

  const copy = makeCopy(token);
  const under = makeFxCanvas(Z - 2);
  const fx = makeFxCanvas();
  const lines = Array.from({ length: H.lines }, () => ({}));
  const beamParts = makeBeam(B);
  const diag = Math.hypot(vp.w, vp.h);
  let blastShaken = false, released = false, lineRoll = -Infinity;

  try {
    await new Promise((done) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (stopped()) { done(); return; }   // undone: draw nothing more
        const t = now - t0;
        const sc = scaleNow();
        const hS = body.h * sc;
        applyBody(token, cfg.body, t, baseTint);
        playCuesUpTo(cues, t);
        under.ctx.clearRect(0, 0, under.c.width, under.c.height);
        fx.ctx.clearRect(0, 0, fx.c.width, fx.c.height);

        if (t < H.ms) {
          // ── the freeze ──
          const k = t / H.ms;
          const amp = body.h * (H.shake[0] + (H.shake[1] - H.shake[0]) * k);
          const p = { x: body.x + Math.sin(t * H.shakeHz) * amp, y: body.y + Math.cos(t * H.shakeHz * 1.7) * amp * 0.35 };
          const strobe = t < H.strobeUntilMs && Math.floor(t / H.strobeMs) % 2 === 0;
          placeLaunchCopy(copy, toScreen(p), body, sc, 0, flip, strobe ? "brightness(2.6) saturate(0.2)" : "");
          const env = Math.min(1, t / 90) * (1 - clamp01((t - (H.ms - 160)) / 160));
          const c = toScreen(body);
          drawHitDim(under.ctx, under.c, c, hS, H.dim * env);
          if (t - lineRoll > 60) { lineRoll = t; rollSpeedLines(lines); }   // flicker, like drawn speed lines
          drawSpeedLines(under.ctx, under.c, c, hS, lines, (H.lineAlpha ?? 0.4) * env);
          drawImpact(fx.ctx, toScreen(hit), hS, cfg.impact, t);
        } else {
          // ── the launch ──
          if (!released) {
            released = true;
            CameraApi.panTo(saved, { duration: L.zoomOutMs })?.catch?.(() => {});
            if (L.kick) shakeBoard(L.kick);
          }
          const u = t - H.ms;
          // The freeze's dim lifts fast and EVENLY: its clear pool belongs to
          // where he stood, and left behind it reads as a spotlight on nothing.
          const dimOut = 1 - clamp01(u / 120);
          if (dimOut > 0) {
            under.ctx.globalCompositeOperation = "source-over";
            under.ctx.fillStyle = `rgba(14,8,26,${H.dim * 0.75 * dimOut})`;
            under.ctx.fillRect(0, 0, under.c.width, under.c.height);
          }
          drawImpact(fx.ctx, toScreen(hit), hS, cfg.impact, t);
          // the jet trail: from where he was `trailMs` ago to where he is,
          // drawn under him; it keeps shrinking after he has left
          const tailU = Math.max(0, u - L.trailMs), headU = Math.min(u, flyEnd);
          if (headU > tailU) {
            const pts = [];
            for (let i = 0; i <= 12; i++) pts.push(toScreen(flightAt(tailU + (headU - tailU) * (i / 12))));
            drawJetTrail(under.ctx, pts, hS, L.trailAlpha);
          }
          // air rings across his path, one at the release and more on the way
          for (const at of L.rings) {
            const u0 = at * L.edgeMs;
            drawAirRing(under.ctx, toScreen(flightAt(u0)), dir, hS, (u - u0) / L.ringMs);
          }
          if (u <= flyEnd) {
            placeLaunchCopy(copy, toScreen(flightAt(u)), body, sc, L.spinDeg * (u / L.edgeMs), flip, "");
          } else copy.style.display = "none";
          // The field dims behind the beam so it reads overexposed on any map,
          // a bright one included — starting just before he reaches the edge.
          const kd = (t - (tBlast - (B.dimLeadMs ?? 0))) / (B.ms + (B.dimLeadMs ?? 0));
          if (B.dim && kd >= 0 && kd < 1) {
            under.ctx.globalCompositeOperation = "source-over";
            under.ctx.fillStyle = `rgba(14,8,26,${B.dim * Math.min(1, kd * 6) * (1 - kd * kd)})`;
            under.ctx.fillRect(0, 0, under.c.width, under.c.height);
          }
          if (t >= tBlast) {
            if (!blastShaken) { blastShaken = true; shakeBoard(B.shake); }
            const kb = (t - tBlast) / B.ms;
            const E = toScreen(exit);
            drawBeam(fx.ctx, E, Math.atan2(-dir.y, -dir.x), B, beamParts, vh, diag, kb, t - tBlast);
            if (kb < 1) drawGlow(fx.ctx, E.x, E.y, vh * 0.16, "255,255,255", 0.9 * (1 - kb * kb));
            // the bang: a white flash over everything as the beam lands
            const kf = (t - tBlast) / (B.flash?.ms ?? 1);
            if (B.flash && kf < 1) {
              fx.ctx.globalCompositeOperation = "lighter";
              fx.ctx.fillStyle = `rgba(255,255,255,${B.flash.alpha * (1 - kf)})`;
              fx.ctx.fillRect(0, 0, fx.c.width, fx.c.height);
              drawGlow(fx.ctx, E.x, E.y, vh * B.flash.size * (0.6 + 0.4 * kf), "255,255,255", 1 - kf);
            }
          }
        }
        if (t >= cfg.totalMs || stopped()) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    fx.done();
    under.done();
    try { copy.remove(); } catch { /* gone */ }
    if (!released) { try { CameraApi.panTo(saved, { duration: L.zoomOutMs })?.catch?.(() => {}); } catch { /* no camera */ } }
    if (camHeld) { try { resumeCamera(); } catch { /* gone */ } }
  }
  if (!stopped()) applyBody(token, cfg.body, Infinity, baseTint);
}

// Distance along `d` from `p` to the edge of the view rect (0 when outside it).
function rayExit(p, d, v) {
  let t = Infinity;
  if (d.x > 0) t = Math.min(t, (v.x1 - p.x) / d.x); else if (d.x < 0) t = Math.min(t, (v.x0 - p.x) / d.x);
  if (d.y > 0) t = Math.min(t, (v.y1 - p.y) / d.y); else if (d.y < 0) t = Math.min(t, (v.y0 - p.y) / d.y);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

function placeLaunchCopy(el, c, body, sc, rotDeg, flip, filter) {
  el.style.display = "";
  boxAt(el, { w: body.w * sc, h: body.h * sc }, c.x, c.y);
  el.style.transformOrigin = "50% 50%";
  el.style.transform = `rotate(${(rotDeg * -flip).toFixed(1)}deg) scale(${flip}, 1)`;
  el.style.filter = filter;
}

// The field darkens around him; a clear pool keeps him lit. Full strength is
// reached a few body-heights out — measured from HIM, not the screen size, so
// the zoomed-in view actually shows it.
function drawHitDim(ctx, cv, c, hS, alpha) {
  if (!(alpha > 0)) return;
  const r0 = hS * 0.6, r1 = r0 + hS * 2.6;
  const g = ctx.createRadialGradient(c.x, c.y, r0, c.x, c.y, r1);
  g.addColorStop(0, "rgba(14,8,26,0)");
  g.addColorStop(0.35, `rgba(14,8,26,${alpha * 0.8})`);
  g.addColorStop(1, `rgba(14,8,26,${alpha})`);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cv.width, cv.height);
}

function rollSpeedLines(lines) {
  for (const l of lines) { l.ang = rand(0, Math.PI * 2); l.in = rand(1.1, 2.2); l.w = rand(0.8, 3.2); }
}

// Thin wedges converging on him from past the screen edge. Painted, not
// added: additive white vanishes on bright ground, plain white over the dim
// reads on any map.
function drawSpeedLines(ctx, cv, c, hS, lines, alpha) {
  if (!(alpha > 0)) return;
  const far = Math.hypot(cv.width, cv.height);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  for (const l of lines) {
    const ca = Math.cos(l.ang), sa = Math.sin(l.ang);
    const r1 = hS * l.in;
    ctx.beginPath();
    ctx.moveTo(c.x + ca * r1, c.y + sa * r1);
    ctx.lineTo(c.x + ca * far - sa * l.w * 3, c.y + sa * far + ca * l.w * 3);
    ctx.lineTo(c.x + ca * far + sa * l.w * 3, c.y + sa * far - ca * l.w * 3);
    ctx.closePath();
    ctx.fill();
  }
}

// The finishing blow: a spiked star and a shock ring at the point of contact.
function drawImpact(ctx, p, hS, f, t) {
  const k = t / f.ms;
  if (k < 0 || k > 1) return;
  const e = 1 - Math.pow(1 - k, 3);
  ctx.globalCompositeOperation = "lighter";
  drawGlow(ctx, p.x, p.y, hS * f.size * (0.5 + 0.5 * e), f.rgb, 1 - k);
  const R = hS * f.size * 0.75 * (0.35 + 0.65 * e);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(0.3 + k * 0.4);
  ctx.fillStyle = `rgba(${f.rgb},${1 - k * k})`;
  ctx.beginPath();
  for (let i = 0; i < 20; i++) {
    const rr = i % 2 ? R * 0.22 : R * (i % 4 ? 0.7 : 1);
    const a = (i / 20) * Math.PI * 2;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = `rgba(${f.ring},${0.9 * (1 - k)})`;
  ctx.lineWidth = Math.max(1, hS * 0.06 * (1 - k));
  ctx.beginPath();
  ctx.arc(p.x, p.y, hS * f.size * (0.25 + 0.75 * e), 0, Math.PI * 2);
  ctx.stroke();
}

// The KO beam's parts, made once per defeat.
//   streaks — the beam body. `o` is the offset across the band (-0.5..0.5).
//             The core streaks are white; the rest alternate between the two
//             fringes and each fringe walks the whole element list, so both
//             sides carry every colour.
//   spikes  — the spray at the base: long, thin, soft white light streaks
//             fired inward in a narrow fan, rooted BEHIND the edge so only the
//             shafts show (Smash's blast opens with it; short fat spikes with
//             their bases on screen read as cut-paper triangles).
//   rays    — long hairline rays fanning wide across the screen.
function makeBeam(B, rnd = Math.random) {
  const r = (a, b) => a + rnd() * (b - a);
  const streaks = [];
  const nCore = Math.round(B.streaks * 0.3);
  for (let i = 0; i < B.streaks; i++) {
    const core = i < nCore, j = i - nCore, side = j % 2 ? 1 : -1;
    const o = core ? r(-B.core / 2, B.core / 2) : side * r(B.core / 2, 0.5);
    const len = r(B.streakLen[0], B.streakLen[1]);
    streaks.push({
      o, len, w: r(B.streakW[0], B.streakW[1]),
      st: r(-len, 1), slide: r(B.slide[0], B.slide[1]), ph: r(0, Math.PI * 2),
      rgb: core ? "255,255,255" : B.rgb[Math.floor(j / 2) % B.rgb.length],
    });
  }
  const spikes = Array.from({ length: B.spray.count }, (_, i) => ({
    o: r(-0.75, 0.75), ang: r(-1, 1) * B.spray.spreadDeg * Math.PI / 180,
    len: r(B.spray.len[0], B.spray.len[1]), w: r(B.spray.width[0], B.spray.width[1]),
    rgb: i % 4 ? "255,255,255" : "228,206,255",
  }));
  const rays = Array.from({ length: B.rays.count }, () => ({
    ang: r(-1, 1) * B.rays.spreadDeg * Math.PI / 180, len: r(0.6, 1.2), w: r(1, 2.6), at: r(0, 0.08),
  }));
  return { streaks, spikes, rays };
}

// A white bar that fades out across its height AND along its length. Canvas
// gradients are one-dimensional, so it is baked once into a small texture
// (cross gradient, then masked by the along-length one) and stretched.
let _bloom = null;
function bloomTexture() {
  if (_bloom) return _bloom;
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const x = c.getContext("2d");
  const cross = x.createLinearGradient(0, 0, 0, 64);
  cross.addColorStop(0, "rgba(255,255,255,0)");
  cross.addColorStop(0.3, "rgba(255,255,255,0.55)");
  cross.addColorStop(0.5, "rgba(255,255,255,1)");
  cross.addColorStop(0.7, "rgba(255,255,255,0.55)");
  cross.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = cross;
  x.fillRect(0, 0, 256, 64);
  const along = x.createLinearGradient(0, 0, 256, 0);
  along.addColorStop(0, "rgba(0,0,0,1)");
  along.addColorStop(0.5, "rgba(0,0,0,0.75)");
  along.addColorStop(1, "rgba(0,0,0,0)");
  x.globalCompositeOperation = "destination-in";
  x.fillStyle = along;
  x.fillRect(0, 0, 256, 64);
  return (_bloom = c);
}

// The KO beam, drawn in its own frame: origin on the exit point, +x pointing
// back into the screen along his flight line, y across the band. It starts
// `back` BEHIND the exit point, so its square-cut end is always off screen
// whatever angle he left at — the beam pours in from beyond the edge.
function drawBeam(ctx, E, inward, B, parts, vh, diag, k, tMs) {
  if (k < 0 || k > 1) return;
  const { streaks, spikes, rays } = parts;
  // reaches full length within ~3 frames: a growing head shows the hard-cut
  // ends of every streak at once (Smash's beam is full length on its first frame)
  const grow = 1 - Math.pow(1 - Math.min(1, k * 25), 3);
  const fade = 1 - k * k * k;                                // holds, then burns out fast
  const punch = 1 + 0.3 * (1 - Math.min(1, k * 8));          // opens wide on the bang, then settles
  const Lb = B.length * diag * grow;
  const band = B.band * vh * punch * (0.75 + 0.25 * grow) * (1 - 0.6 * k * k);   // thins as it burns out
  if (!(Lb > 1) || !(fade > 0)) return;
  const back = B.band * vh * 1.2;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(E.x, E.y);
  ctx.rotate(inward);
  // a coloured haze where he went out
  if (B.haze) {
    const hr = vh * B.haze.size * (0.7 + 0.3 * grow);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, hr);
    g.addColorStop(0, `rgba(${B.haze.rgb},${B.haze.alpha * fade})`);
    g.addColorStop(1, `rgba(${B.haze.rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-hr, -hr, hr * 2, hr * 2);
  }
  // hairline rays fanning wide across the screen
  for (const r of rays) {
    const kr = (k - r.at) / (1 - r.at);
    if (kr <= 0) continue;
    const len = r.len * diag * Math.min(1, kr * 6);
    const a = B.rays.alpha * (1 - kr) ;
    const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
    const g = ctx.createLinearGradient(0, 0, ca * len, sa * len);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = r.w;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(ca * len, sa * len); ctx.stroke();
  }
  // the white bloom: a soft wide pass, then a narrow solid one down the middle
  const hb = band * B.core * 1.6;
  ctx.globalAlpha = 0.9 * fade;
  ctx.drawImage(bloomTexture(), -back, -hb / 2, Lb + back, hb);
  ctx.globalAlpha = fade;
  ctx.drawImage(bloomTexture(), -back, -hb * 0.22, Lb + back, hb * 0.44);
  ctx.globalAlpha = 1;
  // the streaks, sliding inward and flickering; one that runs off the far end
  // comes back in at the base, so the beam stays dense while it thins
  for (const s of streaks) {
    const p = ((s.st + s.slide * k + s.len) % (1 + s.len)) - s.len;
    const x0 = Math.max(-back, p * Lb);
    const x1 = Math.min(Lb, (p + s.len) * Lb);
    if (x1 - x0 < 2) continue;
    const w = Math.max(1, s.w * vh * (1 - 0.4 * k));
    const a = fade * (0.7 + 0.3 * Math.sin(tMs / 23 + s.ph));
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, `rgba(${s.rgb},0)`);
    g.addColorStop(0.12, `rgba(${s.rgb},${a})`);
    g.addColorStop(0.7, `rgba(${s.rgb},${0.75 * a})`);
    g.addColorStop(1, `rgba(${s.rgb},0)`);
    ctx.fillStyle = g;
    // a faint wide pass under the sharp one, so a streak glows instead of
    // reading as a painted ribbon
    ctx.globalAlpha = 0.28;
    ctx.fillRect(x0, s.o * band - w * 1.75, x1 - x0, w * 3.5);
    ctx.globalAlpha = 1;
    ctx.fillRect(x0, s.o * band - w / 2, x1 - x0, w);
  }
  // the spray: soft white light streaks fired inward from behind the edge,
  // out fast, then gone. A faint wide pass under a sharp one, both fading to
  // nothing at the tip, so each reads as light rather than a flat shape.
  const ks = k / B.spray.life;
  if (ks < 1) {
    const sg = 1 - Math.pow(1 - Math.min(1, ks * 4), 3), sf = 1 - ks * ks;
    const x0 = -back * 0.6;
    for (const s of spikes) {
      const L = s.len * vh * sg, y0 = s.o * band;
      const ca = Math.cos(s.ang), sa = Math.sin(s.ang);
      const tx = x0 + ca * L, ty = y0 + sa * L;
      for (const [wm, am] of [[3.2, 0.22], [1, 0.9]]) {
        const w = s.w * vh * wm;
        const g = ctx.createLinearGradient(x0, y0, tx, ty);
        g.addColorStop(0, `rgba(${s.rgb},${am * sf})`);
        g.addColorStop(0.45, `rgba(${s.rgb},${am * 0.8 * sf})`);
        g.addColorStop(1, `rgba(${s.rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x0 - sa * w, y0 + ca * w); ctx.lineTo(tx, ty); ctx.lineTo(x0 + sa * w, y0 - ca * w);
        ctx.closePath(); ctx.fill();
      }
    }
  }
  // a shock ring travelling down the beam, widening as it goes
  const kr = k / B.ring.life;
  if (kr < 1) {
    const e = 1 - Math.pow(1 - kr, 2);
    const rx = band * 0.75 * (1 + 0.6 * e), cx = Lb * (0.06 + B.ring.travel * e);
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * (1 - kr)})`;
    ctx.lineWidth = Math.max(1, vh * 0.012 * (1 - kr));
    ctx.beginPath();
    ctx.ellipse(cx, 0, rx * 0.22, rx, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// The launch jet: a white, feathered trail from where he was a moment ago to
// where he is, widest at his back. `pts` are screen points, oldest first.
function drawJetTrail(ctx, pts, hS, alpha, rnd = Math.random) {
  const n = pts.length;
  if (n < 2 || !(alpha > 0)) return;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const w = hS * 0.42 * Math.pow(i / (n - 1), 0.8) * (0.65 + 0.35 * rnd());   // feathered edge
    L.push({ x: pts[i].x + nx * w, y: pts[i].y + ny * w });
    R.push({ x: pts[i].x - nx * w, y: pts[i].y - ny * w });
  }
  const tail = pts[0], head = pts[n - 1];
  const g = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(1, `rgba(255,255,255,${alpha})`);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(L[0].x, L[0].y);
  for (const p of L) ctx.lineTo(p.x, p.y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i].x, R[i].y);
  ctx.closePath();
  ctx.fill();
}

// An air ring around the flight line — an ellipse standing across his path,
// widening and fading. `dir` is the flight direction in screen space.
function drawAirRing(ctx, c, dir, hS, k) {
  if (k < 0 || k > 1) return;
  const e = 1 - Math.pow(1 - k, 2);
  const rad = hS * (0.45 + 0.9 * e);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(Math.atan2(dir.y, dir.x));
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`;
  ctx.lineWidth = Math.max(1, hS * 0.05 * (1 - k));
  ctx.beginPath();
  ctx.ellipse(0, 0, rad * 0.24, rad, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
/* ── small helpers ── */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : (Number.isFinite(v) ? v : 1); }
function rand(a, b) { return a + Math.random() * (b - a); }
function lerpColor(a, b, k) {
  const ch = (c, s) => (c >> s) & 0xff;
  const mix = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * k);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}
