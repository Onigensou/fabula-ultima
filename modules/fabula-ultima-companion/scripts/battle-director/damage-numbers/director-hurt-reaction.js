// Director-native token "hurt reaction" — pseudo-animated damage feedback.
//
// When a token takes damage we want it to FLINCH (JRPG style), but animating the
// real PIXI token per-frame is expensive and fights Foundry's token-refresh
// pipeline. So we PSEUDO-ANIMATE: snapshot the token's image into a DOM overlay
// positioned exactly over the token, run a short CSS "got hit" animation on that
// clone, and (for the duration only) hide the real token's sprite so the clone
// stands in seamlessly. The real token never moves — zero canvas redraws.
//
// Same architecture as the damage-number / impact-fx subsystems: per-client
// screen projection + socketlib broadcast + surface-registry tracking.
//
// Tiers (intensity):
//   "normal" — white flash + small shake + squash (~300ms)
//   "strong" — bigger shake + squash + a double white flash + a RED silhouette
//              tint (~480ms). Used for WEAK / crit hits so they visibly hurt more.
//
// The RED tint is a CSS mask of the token image filled red, so it tints the
// SPRITE SILHOUETTE (not a rectangle) on any alpha PNG. Mask doesn't apply to
// <video> tokens, so animated tokens get the flash + shake without the red tint.
//
// Not a manifest entry: imported by director-boot.js / the test tools and
// initialised on the ready hook — loads on a normal hard-reload, no relaunch.
//
// Phase 0 scope: the engine + audition. The live damage path does NOT call this
// yet — the next phase wires it into director-vfx's loss VFX.

import { log, warn } from "../logger.js";
import { registerAnimation } from "../director-surfaces.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_HURT_PLAY";
const STYLE_ID = "fud-hurt-reaction-style";

const DUR = { normal: 300, strong: 480 };

let _socket = null;
// tokenUuid -> { el, timer, origAlpha } for multi-hit debounce (one clone per
// token; a new hit restarts it and keeps the mesh hidden across the restart).
const _active = new Map();

// ── boot: socket registration ───────────────────────────────────────────
export function initHurtReaction() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("hurt-reaction: socketlib unavailable — reactions stay local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playHurtReactionLocal);
    log("hurt-reaction: socket registered");
  } catch (e) {
    warn("hurt-reaction: init failed", e);
  }
}

// ── public emit (GM-side): render locally + broadcast ──────────────────────
export function emitHurtReaction(payload = {}) {
  try { playHurtReactionLocal(payload); }
  catch (e) { warn("emitHurtReaction: local render threw", e); }
  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("emitHurtReaction: broadcast failed", e); }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.fud-hurt {
  position: fixed; z-index: 99980; pointer-events: none;
  transform: translate(-50%, -50%);
}
.fud-hurt-rot { transform-origin: center; }
.fud-hurt-shake { position: relative; }
.fud-hurt-img { display: block; width: 100%; height: 100%; object-fit: contain; }
.fud-hurt-tint {
  position: absolute; inset: 0; background: #ff2b2b; opacity: 0;
  -webkit-mask-size: contain; mask-size: contain;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
}

.fud-hurt--normal .fud-hurt-shake { animation: fud-hurt-shake-n 300ms ease-out both; }
.fud-hurt--normal .fud-hurt-img   { animation: fud-hurt-flash-n 300ms ease-out both; }
.fud-hurt--strong .fud-hurt-shake { animation: fud-hurt-shake-s 480ms ease-out both; }
.fud-hurt--strong .fud-hurt-img   { animation: fud-hurt-flash-s 480ms ease-out both; }
.fud-hurt--strong .fud-hurt-tint  { animation: fud-hurt-tint 480ms ease-out both; }

@keyframes fud-hurt-shake-n {
  0%   { transform: scale(1,1) translateX(0); }
  12%  { transform: scale(1.12,.88) translateX(0); }
  30%  { transform: scale(.97,1.03) translateX(-7px); }
  50%  { transform: translateX(6px) scale(1,1); }
  70%  { transform: translateX(-4px); }
  85%  { transform: translateX(3px); }
  100% { transform: translateX(0) scale(1,1); }
}
@keyframes fud-hurt-shake-s {
  0%   { transform: scale(1,1) translateX(0); }
  10%  { transform: scale(1.22,.8) translateX(0); }
  26%  { transform: scale(.9,1.1) translateX(-13px); }
  44%  { transform: translateX(11px) scale(1,1); }
  62%  { transform: translateX(-7px); }
  80%  { transform: translateX(5px); }
  100% { transform: translateX(0) scale(1,1); }
}
@keyframes fud-hurt-flash-n {
  0%  { filter: brightness(3.6); }
  35% { filter: brightness(1); }
  100%{ filter: brightness(1); }
}
@keyframes fud-hurt-flash-s {
  0%  { filter: brightness(4); }
  20% { filter: brightness(1); }
  40% { filter: brightness(3.2); }
  60% { filter: brightness(1); }
  100%{ filter: brightness(1); }
}
@keyframes fud-hurt-tint {
  0%  { opacity: .9; }
  55% { opacity: .45; }
  100%{ opacity: 0; }
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

// World point → client (screen) coords.
function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// ── render (runs on EVERY client) ──────────────────────────────────────────
//   tokenUuid : the token that took the hit
//   intensity : "normal" | "strong"
export function playHurtReactionLocal({ tokenUuid, intensity = "normal" } = {}) {
  try {
    if (typeof PIXI === "undefined" || !canvas?.ready) return;
    const token = canvasTokenFromUuid(tokenUuid);
    if (!token || token.destroyed) return;
    const src = token.document?.texture?.src;
    if (!src) return;
    ensureStyle();

    const strong = intensity === "strong";
    const dur = strong ? DUR.strong : DUR.normal;

    // If a reaction is already mid-flight on this token, drop its element + timer
    // but KEEP the mesh hidden (we carry origAlpha forward) so the restart is seamless.
    const prev = _active.get(tokenUuid);
    if (prev) { clearTimeout(prev.timer); try { prev.el.remove(); } catch {} }

    // Geometry — project the token center onto THIS client's screen; size to the
    // token's on-screen footprint; carry rotation + horizontal mirror.
    const c = token.center ?? {
      x: (token.x ?? 0) + (token.w ?? 100) / 2,
      y: (token.y ?? 0) + (token.h ?? 100) / 2,
    };
    const pt = worldToClient(c.x, c.y);
    const zoom = canvas.stage?.scale?.x ?? 1;
    const w = (token.w ?? 100) * zoom;
    const h = (token.h ?? 100) * zoom;
    const rot = Number(token.document?.rotation ?? 0) || 0;
    const mir = (Number(token.document?.texture?.scaleX ?? 1) < 0) ? -1 : 1;
    const isVideo = /\.(webm|mp4|m4v|ogv)$/i.test(String(src));

    const root = document.createElement("div");
    root.className = `fud-hurt fud-hurt--${strong ? "strong" : "normal"}`;
    root.style.left = `${pt.x}px`;
    root.style.top = `${pt.y}px`;

    const rotEl = document.createElement("div");
    rotEl.className = "fud-hurt-rot";
    rotEl.style.transform = `rotate(${rot}deg) scaleX(${mir})`;

    const shake = document.createElement("div");
    shake.className = "fud-hurt-shake";
    shake.style.width = `${w}px`;
    shake.style.height = `${h}px`;

    let media;
    if (isVideo) {
      media = document.createElement("video");
      media.src = src; media.muted = true; media.autoplay = true; media.loop = true; media.playsInline = true;
    } else {
      media = document.createElement("img");
      media.src = src;
    }
    media.className = "fud-hurt-img";
    media.draggable = false;
    shake.appendChild(media);

    // Red silhouette tint for strong hits (image tokens only — mask needs an image).
    if (strong && !isVideo) {
      const tint = document.createElement("div");
      tint.className = "fud-hurt-tint";
      const url = `url("${encodeURI(src)}")`;
      tint.style.webkitMaskImage = url;
      tint.style.maskImage = url;
      shake.appendChild(tint);
    }

    rotEl.appendChild(shake);
    root.appendChild(rotEl);
    document.body.appendChild(root);

    // Hide the real token sprite for the reaction (single toggle; restored at end).
    // Mesh = the token's image only — bars/border/nameplate are separate children
    // and stay visible. Carry the TRUE original alpha across a debounce restart.
    const mesh = token.mesh;
    const origAlpha = (prev && prev.origAlpha != null) ? prev.origAlpha : (mesh ? mesh.alpha : null);
    if (mesh && origAlpha != null) mesh.alpha = 0;

    registerAnimation({ kind: "hurt-reaction", durationMs: dur + 120, meta: { intensity } });

    const cleanup = () => {
      try { root.remove(); } catch {}
      // Re-fetch the token in case it re-rendered mid-animation (fresh mesh ref).
      const t = canvasTokenFromUuid(tokenUuid);
      if (t?.mesh && origAlpha != null) t.mesh.alpha = origAlpha;
      _active.delete(tokenUuid);
    };
    const timer = setTimeout(cleanup, dur + 80);
    _active.set(tokenUuid, { el: root, timer, origAlpha });
    if (isVideo) { try { media.play?.()?.catch?.(() => {}); } catch {} }
  } catch (e) {
    warn("playHurtReactionLocal threw", e);
  }
}
