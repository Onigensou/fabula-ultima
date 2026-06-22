// Director-native impact VFX — DOM screen-space <video> overlay.
//
// REPLACES Sequencer's `.effect().file(webm)` bursts for combat feedback (the
// orange hit impact, the heal/MP auras, the absorb aura). Same architecture as
// the damage-number subsystem: a `position: fixed` DOM element projected onto
// each client's screen from the token's world center, broadcast over our own
// socketlib channel. No Sequencer dependency.
//
// RENDER: a <video> element playing the (alpha) webm. We composite with
// `mix-blend-mode: screen` — these are bright glow effects on a dark battlefield,
// and screen blend is robust whether the webm carries true alpha or a black
// matte (pure black contributes nothing under screen), sidestepping any
// browser-alpha uncertainty.
//
// SIZING: scaled to the token's ON-SCREEN footprint (token size × camera zoom)
// so the impact tracks zoom and reads consistently across token sizes — more
// robust than Sequencer's texture-relative `.scale(0.4)`.
//
// Not a manifest entry: imported by director-vfx.js / director-boot.js and
// initialised on the ready hook — loads on a normal hard-reload, no relaunch.

import { log, warn } from "../logger.js";
import { registerAnimation } from "../director-surfaces.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_IMPACTFX_PLAY";
const STYLE_ID = "fud-impact-fx-style";

// Impact size relative to the token's on-screen width (mirrors the old
// Sequencer impact reading a touch larger than the token).
const SIZE_FACTOR = 1.6;

let _socket = null;

// ── boot: socket registration ───────────────────────────────────────────
// Idempotent. Call once on every client after socketlib is up (boot `ready`).
export function initImpactFx() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("impact-fx: socketlib unavailable — impacts stay local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playImpactFxLocal);
    log("impact-fx: socket registered");
  } catch (e) {
    warn("impact-fx: init failed", e);
  }
}

// ── public emit (GM-side) ─────────────────────────────────────────────────
// Render locally + broadcast to all OTHER clients. Fire-and-forget.
export function emitImpactFx(payload = {}) {
  try { playImpactFxLocal(payload); }
  catch (e) { warn("emitImpactFx: local render threw", e); }
  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("emitImpactFx: broadcast failed", e); }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.fud-impact {
  position: fixed; z-index: 99985; pointer-events: none;
  transform: translate(-50%, -50%);
  mix-blend-mode: screen;
  will-change: opacity;
  /* Defensive: the game stylesheet borders media elements; never on our FX. */
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// Token UUID ("Scene.X.Token.Y") → placeable on the active canvas, or null.
function canvasTokenFromUuid(tokenUuid) {
  const tokenId = String(tokenUuid ?? "").split(".Token.").pop();
  return tokenId ? (canvas?.tokens?.get?.(tokenId) ?? null) : null;
}

// World point → client (screen) coords. Mirrors damage-numbers / reaction-indicator.
function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// ── render (runs on EVERY client) ──────────────────────────────────────────
//   tokenUuid  : the impacted token
//   file       : webm URL/path
//   scale      : extra multiplier on top of the token-relative size (default 1)
//   durationMs : hard cap on the burst (mirrors Sequencer's .duration())
export function playImpactFxLocal({ tokenUuid, file, scale = 1.0, durationMs = 1000 } = {}) {
  try {
    if (!file) return;
    if (typeof PIXI === "undefined" || !canvas?.ready) return;
    const token = canvasTokenFromUuid(tokenUuid);
    if (!token || token.destroyed) { log("impact-fx: token not on canvas, skipping"); return; }
    ensureStyle();

    const c = token.center ?? {
      x: (token.x ?? 0) + (token.w ?? 100) / 2,
      y: (token.y ?? 0) + (token.h ?? 100) / 2,
    };
    const pt = worldToClient(c.x, c.y);
    const zoom = canvas.stage?.scale?.x ?? 1;
    const sizePx = Math.max(40, (token.w ?? 100) * zoom * SIZE_FACTOR * scale);

    const vid = document.createElement("video");
    vid.className = "fud-impact";
    vid.src = file;
    vid.muted = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.loop = false;
    vid.style.left = `${pt.x}px`;
    vid.style.top = `${pt.y}px`;
    vid.style.width = `${sizePx}px`;
    vid.style.height = "auto";
    document.body.appendChild(vid);

    const sid = registerAnimation({ kind: "impact-fx", durationMs: durationMs + 200, meta: { file } });

    let done = false;
    const cleanup = () => { if (done) return; done = true; try { vid.remove(); } catch {} };
    vid.addEventListener("ended", cleanup);
    vid.addEventListener("error", cleanup);
    // Hard cap (mirrors Sequencer .duration) + safety net if the webm stalls.
    setTimeout(cleanup, durationMs);
    try { vid.play?.()?.catch?.(() => {}); } catch {}
  } catch (e) {
    warn("playImpactFxLocal threw", e);
  }
}
