// Director-native floating damage numbers — DOM screen-space subsystem.
//
// REPLACES Sequencer's `.scrollingText()` for damage/heal/cost/miss feedback.
// FULLY SELF-CONTAINED: owns its own socketlib channel, its own DOM render
// surface, its own CSS + animation, its own projection. Does NOT touch the
// legacy pipeline and does NOT depend on Sequencer.
//
// RENDER SURFACE: a `position: fixed` DOM overlay (NOT PIXI/canvas) — the same
// proven pattern the namecard / cut-in / round-banner use. CSS gives us the
// kinetic Persona-style typography (skew, slab tags, pop-in, gold crit banner)
// that PIXI text can't do cleanly. The one thing canvas-anchoring gave us for
// free — tracking the token — we recover by projecting the token's world center
// to screen coords at SPAWN time (snapshot positioning; no per-frame tracking).
//
// SYNC: the GM computes authoritative damage (skill-effects applyDamageToTarget)
// and calls `emitDamageNumber(payload)` with a tiny SEMANTIC payload. That
// renders locally AND broadcasts to every other client via socketlib, each of
// which renders it from its OWN camera transform — so a number lands correctly
// on every screen regardless of pan/zoom. ~80 bytes per hit, no effect spec.
//
// Not a manifest entry: imported by director-boot.js (an existing esmodule) and
// initialised from its ready hook, so it loads on a normal hard-reload with no
// Setup-relaunch.
//
// Phase 0 scope: the rendering engine + audition tool. The skill-effects call
// sites still fire the old Sequencer VFX — Phase 1 repoints them here.

import { log, warn } from "../logger.js";
import { registerAnimation } from "../director-surfaces.js";
import { resolveDamageNumberStyle } from "./damage-number-style.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_DMGNUM_PLAY";
const STYLE_ID = "fud-damage-number-style";

// Multi-hit on the SAME token staggers by this much so numbers cascade
// (Persona-style) instead of stacking on one point.
const STAGGER_MS = 120;
// Total on-screen life — must match the longest CSS animation below.
const LIFETIME_MS = 1150;

let _socket = null;

// ── boot: socket registration ───────────────────────────────────────────
// Idempotent. Call once on every client after socketlib is up (boot `ready`).
export function initDamageNumbers() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("damage-numbers: socketlib unavailable — numbers stay local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, renderDamageNumberLocal);
    log("damage-numbers: socket registered");
  } catch (e) {
    warn("damage-numbers: init failed", e);
  }
}

// ── public emit (GM-side) ─────────────────────────────────────────────────
// Render locally + broadcast to all OTHER clients. Mirrors the cut-in's
// "local call + executeForOthers" split (executeForEveryone's local echo is
// unreliable). Fire-and-forget; never throws into the caller's damage write.
export function emitDamageNumber(payload = {}) {
  try { renderDamageNumberLocal(payload); }
  catch (e) { warn("emitDamageNumber: local render threw", e); }
  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("emitDamageNumber: broadcast failed", e); }
}

// ── CSS (injected once, lazily) ────────────────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  // Fonts: prefer self-hosted/locally-installed Anton (numerals) + Bebas Neue
  // (tags); fall back to the heavy condensed faces that ship with the OS
  // (Haettenschweiler / Impact) so the Persona look holds even before the web
  // fonts are dropped in. Add `@font-face` rules here when the .woff2 files land.
  const css = `
.fud-dn {
  position: fixed; z-index: 99990; pointer-events: none;
  transform: translate(-50%, -50%);
  /* Numerals: a clean, heavy, NON-condensed sans so the value reads at a glance
     (the condensed Anton/Impact face was hard to parse). Tags stay condensed —
     they're words, not numbers, and the blocky look suits them. */
  --dn-num-font: 'Arial Black', 'Segoe UI', system-ui, Arial, sans-serif;
  --dn-tag-font: 'Bebas Neue', 'Oswald', 'Haettenschweiler', 'Impact', sans-serif;
}
.fud-dn-riser {
  animation: fud-dn-rise ${LIFETIME_MS}ms cubic-bezier(.18,.7,.3,1) forwards,
             fud-dn-fade ${LIFETIME_MS}ms ease-in forwards;
}
.fud-dn-inner {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  animation: fud-dn-pop 240ms cubic-bezier(.2,1.55,.4,1) both;
}
/* Crit "slab flash": a quick gold burst behind the numeral — the Persona pop. */
.fud-dn--crit .fud-dn-inner::before {
  content: ""; position: absolute; inset: -10px -22px; z-index: -1;
  background: radial-gradient(ellipse at center, rgba(255,220,90,.6), rgba(255,150,40,0) 70%);
  animation: fud-dn-flash 420ms ease-out forwards;
}
/* Pierce sub-tag — small "PIERCE" marker under the number when a hit pushed
   through immunity/affinity. */
.fud-dn-pierce {
  font-family: var(--dn-tag-font);
  font-weight: 700; font-style: italic; letter-spacing: 1px;
  font-size: 12px; color: #ffd9a8; transform: skewX(-9deg);
  text-shadow: 0 1px 0 rgba(0,0,0,.6);
}
.fud-dn-crit-banner {
  font-family: var(--dn-tag-font);
  font-weight: 900; font-style: italic; letter-spacing: 1px;
  font-size: 22px; color: #ffdf5e; transform: skewX(-9deg);
  -webkit-text-stroke: 2px #5a3500;
  text-shadow: 0 2px 0 #000, 0 0 14px rgba(255,210,60,.6);
}
.fud-dn-tag {
  font-family: var(--dn-tag-font);
  font-weight: 700; font-style: italic; letter-spacing: 1.5px;
  font-size: 16px; line-height: 1.1; color: #fff;
  padding: 1px 9px 2px; transform: skewX(-9deg);
  text-shadow: 0 2px 0 rgba(0,0,0,.5);
  box-shadow: 0 2px 0 rgba(0,0,0,.35);
}
.fud-dn-tag--weak   { background: #e8331f; }
.fud-dn-tag--resist { background: #3a5b80; }
.fud-dn-tag--immune { background: #2a3140; }
.fud-dn-tag--status-immune { background: #5b2e8f; }
.fud-dn-tag--absorb { background: #0d6c8c; }
.fud-dn-tag--miss   { background: #444a55; }
.fud-dn-num {
  display: inline-flex; align-items: center; gap: .18em;
  font-family: var(--dn-num-font);
  font-weight: 900; font-style: italic; line-height: 1;
  color: var(--dn-color, #fff); font-size: var(--dn-size, 34px);
  transform: skewX(-8deg);
  -webkit-text-stroke: 2.5px #1a1a1a;
  text-shadow: 0 3px 0 rgba(0,0,0,.55), 0 0 10px rgba(0,0,0,.3);
}
.fud-dn-num i { font-size: .72em; -webkit-text-stroke: 0; }
.fud-dn--crit .fud-dn-num {
  color: #ffe14a !important;
  -webkit-text-stroke: 3px #5a3500;
  text-shadow: 0 3px 0 #000, 0 0 18px rgba(255,210,60,.7);
}
.fud-dn--shake .fud-dn-num { animation: fud-dn-shake 320ms ease-in-out; }

@keyframes fud-dn-rise {
  0%   { transform: translateY(10px); }
  16%  { transform: translateY(0); }
  100% { transform: translateY(-54px); }
}
@keyframes fud-dn-fade { 0%, 68% { opacity: 1; } 100% { opacity: 0; } }
@keyframes fud-dn-pop {
  0%   { transform: scale(.25); }
  62%  { transform: scale(1.16); }
  100% { transform: scale(1); }
}
@keyframes fud-dn-shake {
  0%, 100% { margin-left: 0; }
  20% { margin-left: -5px; } 40% { margin-left: 5px; }
  60% { margin-left: -3px; } 80% { margin-left: 3px; }
}
@keyframes fud-dn-flash {
  0%   { transform: scale(.4); opacity: .9; }
  100% { transform: scale(1.6); opacity: 0; }
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// ── projection: token world center → client (screen) coords ───────────────
// Mirrors reaction-indicator.worldToClient: apply the canvas world transform,
// then offset by the board canvas' bounding rect. Correct under any pan/zoom.
function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// Token UUID ("Scene.X.Token.Y") → placeable on the active canvas, or null.
function canvasTokenFromUuid(tokenUuid) {
  const tokenId = String(tokenUuid ?? "").split(".Token.").pop();
  return tokenId ? (canvas?.tokens?.get?.(tokenId) ?? null) : null;
}

// Anchor a little above the token center so the number floats off the head.
function tokenAnchor(token) {
  const c = token.center ?? {
    x: (token.x ?? 0) + (token.w ?? 100) / 2,
    y: (token.y ?? 0) + (token.h ?? 100) / 2,
  };
  return { x: c.x, y: c.y - (token.h ?? 100) * 0.22 };
}

// ── per-token stagger scheduler ────────────────────────────────────────────
// tokenUuid -> timestamp the next float on that token may appear (ms, perf clock).
const _nextSlot = new Map();

// ── render (runs on EVERY client) ──────────────────────────────────────────
// Builds one float, projects it onto THIS client's screen, animates, self-removes.
// Silently no-ops if the token isn't on the active canvas — flavor, never critical.
export function renderDamageNumberLocal(payload = {}) {
  try {
    // Drop on a hidden/non-active tab — see FUCompanion.api.vfxSuppressed. rAF
    // is paused there, so accumulated floats would all burst on refocus.
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return;
    ensureStyle();
    const tokenUuid = payload?.tokenUuid;
    if (!tokenUuid) { return; }
    if (typeof PIXI === "undefined" || !canvas?.ready) { return; }
    // Token presence is re-checked at spawn time (after any stagger delay).
    if (!canvasTokenFromUuid(tokenUuid)) {
      log("damage-numbers: token not on canvas, skipping");
      return;
    }

    const spec = resolveDamageNumberStyle(payload);

    // Stagger same-token floats so a multi-hit cascades instead of stacking.
    const now = performance.now();
    const slot = Math.max(now, _nextSlot.get(tokenUuid) ?? 0);
    const delay = slot - now;
    _nextSlot.set(tokenUuid, slot + STAGGER_MS);
    // Small horizontal jitter so even simultaneous-ish floats don't perfectly overlap.
    const jitterX = Math.round((Math.random() - 0.5) * 26);

    const spawn = () => {
      const token = canvasTokenFromUuid(tokenUuid);
      if (!token || token.destroyed) return;
      const a = tokenAnchor(token);
      const pt = worldToClient(a.x, a.y);

      const root = document.createElement("div");
      root.className = `fud-dn fud-dn--${spec.variant}` +
        (spec.crit ? " fud-dn--crit" : "") +
        (spec.shake ? " fud-dn--shake" : "");
      root.style.left = `${pt.x + jitterX}px`;
      root.style.top = `${pt.y}px`;

      const riser = document.createElement("div");
      riser.className = "fud-dn-riser";
      const inner = document.createElement("div");
      inner.className = "fud-dn-inner";

      if (spec.critBanner) {
        const banner = document.createElement("div");
        banner.className = "fud-dn-crit-banner";
        banner.textContent = "CRITICAL!";
        inner.appendChild(banner);
      }
      if (spec.tag) {
        const tag = document.createElement("div");
        tag.className = `fud-dn-tag fud-dn-tag--${spec.tagVariant}`;
        tag.textContent = spec.tag;
        inner.appendChild(tag);
      }
      // Numeral slot — also hosts the big plain word (MISS) and the optional
      // leading FA icon (shield). Icon + text live in one skewed flex row.
      const bodyText = spec.number != null ? spec.number : spec.bigWord;
      if (bodyText != null) {
        const num = document.createElement("div");
        num.className = "fud-dn-num";
        num.style.setProperty("--dn-color", spec.color);
        num.style.setProperty("--dn-size", `${spec.fontPx}px`);
        if (spec.iconClass) {
          const icon = document.createElement("i");
          icon.className = spec.iconClass;
          num.appendChild(icon);
        }
        const txt = document.createElement("span");
        txt.textContent = bodyText;
        num.appendChild(txt);
        inner.appendChild(num);
      }
      // Pierce marker — a hit that pushed through immunity/affinity.
      if (spec.pierce && spec.number != null) {
        const pierce = document.createElement("div");
        pierce.className = "fud-dn-pierce";
        pierce.textContent = "PIERCE";
        inner.appendChild(pierce);
      }

      riser.appendChild(inner);
      root.appendChild(riser);
      document.body.appendChild(root);

      // Track in the surface registry (auto-unregisters after lifetime).
      const sid = registerAnimation({ kind: "damage-number", durationMs: LIFETIME_MS, meta: { variant: spec.variant } });

      const cleanup = () => {
        try { root.remove(); } catch {}
      };
      // Remove on the riser's animationend (the long one), with a timeout safety net.
      let done = false;
      const finish = () => { if (done) return; done = true; cleanup(); };
      riser.addEventListener("animationend", (ev) => {
        // Only the rise/fade animations on the riser should end it (not the
        // inner pop). Both rise + fade are on the riser and run the full life.
        if (ev.target === riser) finish();
      });
      setTimeout(finish, LIFETIME_MS + 120);
    };

    if (delay > 0) setTimeout(spawn, delay);
    else spawn();
  } catch (e) {
    warn("renderDamageNumberLocal threw", e);
  }
}
