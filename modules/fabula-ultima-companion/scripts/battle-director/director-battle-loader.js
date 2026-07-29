// Director-native battle-init "eye-catcher" loader.
//
// Covers the otherwise-black, featureless pause that the player sees while the
// PREP pipeline activates the battle scene and preloads assets across clients
// (runDirectorInit steps 3–8, behind the raised curtain). Instead of dead air
// on a black screen, we render a JRPG-style "PREPARING BATTLE…" flourish:
// anime speed-lines drifting across the black, a spinning gold emblem, and an
// indeterminate loading bar.
//
// Design notes / why it's built this way:
//   - Lives ABOVE the curtain (z 26 vs the curtain's 25) and BELOW Foundry UI
//     (panels sit at ≥30), exactly like the curtain's own z rationale. The
//     curtain stays the opaque black backdrop; this layer only adds motion.
//   - ALL motion (ring spin, bar slide, speed-line scroll, dot pulse) is driven
//     by `transform` / `opacity` only, so it runs on the GPU compositor. This
//     matters: the eye-catcher is on screen precisely WHILE the main thread is
//     busy doing scene-activate + asset decode, and compositor animations keep
//     moving smoothly even when the main thread is blocked. (A background-
//     position or width tween would stutter under that load.)
//   - Own socketlib channel so EVERY client shows it — players hit the same
//     canvas-rebuild + preload dead air when they follow to the battle scene.
//   - A `maxHold` failsafe (just past the preload watchdog) guarantees the
//     overlay can never strand the screen if a hide message is lost.
//   - Pure CSS — no new assets required.
//
// Flow:
//   boot  → initDirectorBattleLoader() registers the socket handlers.
//   PREP  → showBattleLoader() right after raiseCurtain() (renders + broadcasts).
//   PREP  → await hideBattleLoader() just before dropCurtain() (enforces a min
//           on-screen floor so a fully-cached load doesn't flash for a frame,
//           fades out, then hands off into the curtain's own fade).

import { log, warn } from "./logger.js";
import { registerSurface, unregisterSurface } from "./director-surfaces.js";
import { pWait, shouldRender, interval, hasOtherViewers } from "./presentation-clock.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_SHOW = "FU_DIRECTOR_LOADER_SHOW";
const ACTION_HIDE = "FU_DIRECTOR_LOADER_HIDE";
const STYLE_ID = "fu-dir-loader-style";
const LAYER_ID = "fu-dir-loader-layer";
const ACCENT = "#ffd866";
// Failsafe auto-hide: a touch past the preload watchdog (20s in director-init)
// so the overlay is never stranded if a hide broadcast is lost.
const MAX_HOLD_MS = 23000;
// Reveal / dismiss fade durations (the dismiss hands off into dropCurtain's
// 600ms fade, so keep it short).
const FADE_IN_MS = 220;
const FADE_OUT_MS = 250;
// Minimum time the overlay stays on screen once shown — so a fully-cached
// battle (preload returns in ~100ms) still reads as an intentional beat
// rather than a single-frame flash.
const DEFAULT_MIN_SHOW_MS = 800;
// Center emblem glyph (FontAwesome ships with Foundry; if absent the spinning
// rings alone still read fine).
const EMBLEM_GLYPH = "fa-solid fa-khanda";

// Presentation dwell — zero while hidden. The only use is the loader's
// minimum-show floor, which exists purely so the curtain isn't a visual flash;
// there is nothing to not-flash on a hidden client.
const sleep = pWait;

let _socket = null;
let _surfaceId = null;
let _shownAt = 0;
let _maxHoldTimer = null;

// ── boot: socket registration (idempotent; call once after socketlib up) ──
export function initDirectorBattleLoader() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("director-battle-loader: socketlib unavailable — loader will be local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_SHOW, showLoaderLocal);
    _socket.register(ACTION_HIDE, hideLoaderLocal);
    log("director-battle-loader: socket registered");
  } catch (e) {
    warn("director-battle-loader: init failed", e);
  }
}

// ── DOM surface (created lazily, reused) ──────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
/* z 26 = above the preload curtain (25), below Foundry UI panels (≥30). */
#${LAYER_ID} {
  position: fixed; inset: 0; z-index: 26; pointer-events: all; overflow: hidden;
  display: none; opacity: 0; transition: opacity ${FADE_IN_MS}ms ease-out;
  /* Subtle vignette deepens the curtain black toward the edges. */
  background: radial-gradient(ellipse at 50% 46%, rgba(20,16,10,0) 0%, rgba(0,0,0,.55) 78%);
}
#${LAYER_ID}.active { display: block; }

/* ── Anime speed-lines ─────────────────────────────────────────────────────
   A rotated, oversized frame holds VERTICAL repeating gradients; the rotation
   makes them read diagonal, and translating by exactly one gradient period is
   seamless. Two layers (fast faint white + slower sparse gold) add depth. */
#${LAYER_ID} .fu-dl-speed {
  position: absolute; left: -30%; top: -30%; width: 160%; height: 160%;
  transform: rotate(18deg); opacity: .45; pointer-events: none;
}
#${LAYER_ID} .fu-dl-speed::before,
#${LAYER_ID} .fu-dl-speed::after {
  content: ""; position: absolute; inset: -20%; will-change: transform;
}
#${LAYER_ID} .fu-dl-speed::before {
  background: repeating-linear-gradient(90deg, transparent 0 44px, rgba(255,255,255,.05) 44px 46px);
  animation: fu-dl-scroll-a 1.5s linear infinite;
}
#${LAYER_ID} .fu-dl-speed::after {
  background: repeating-linear-gradient(90deg, transparent 0 118px, rgba(255,216,102,.05) 118px 121px);
  animation: fu-dl-scroll-b 2.6s linear infinite;
}
@keyframes fu-dl-scroll-a { from { transform: translateX(0); } to { transform: translateX(-46px); } }
@keyframes fu-dl-scroll-b { from { transform: translateX(0); } to { transform: translateX(-121px); } }

/* ── Center emblem (two counter-spinning gold rings + pulsing glyph) ──────── */
#${LAYER_ID} .fu-dl-crest {
  position: absolute; left: 50%; top: 43%; transform: translate(-50%, -50%);
  width: 17vh; height: 17vh; pointer-events: none;
}
#${LAYER_ID} .fu-dl-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 2px solid rgba(255,216,102,.16);
  border-top-color: ${ACCENT}; border-right-color: ${ACCENT};
  filter: drop-shadow(0 0 6px rgba(255,216,102,.5));
  animation: fu-dl-spin 2.2s linear infinite; will-change: transform;
}
#${LAYER_ID} .fu-dl-ring.inner {
  inset: 17%; border-top-color: transparent; border-right-color: transparent;
  border-bottom-color: ${ACCENT}; border-left-color: ${ACCENT};
  animation: fu-dl-spin 1.6s linear infinite reverse;
}
#${LAYER_ID} .fu-dl-glyph {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: ${ACCENT}; font-size: 6vh; line-height: 1;
  filter: drop-shadow(0 0 8px rgba(255,216,102,.7));
  animation: fu-dl-pulse 1.4s ease-in-out infinite; will-change: transform, opacity;
}
@keyframes fu-dl-spin { to { transform: rotate(360deg); } }
@keyframes fu-dl-pulse { 0%,100% { opacity: .72; transform: scale(.93); } 50% { opacity: 1; transform: scale(1.07); } }

/* ── Title text + marching dots (opacity-only pulse = compositor-safe) ────── */
#${LAYER_ID} .fu-dl-text {
  position: absolute; left: 50%; top: 62%; transform: translateX(-50%);
  display: flex; align-items: baseline; white-space: nowrap;
  font: 700 2.7vh "Pixel Operator", system-ui, sans-serif; letter-spacing: .22em;
  color: #f3e9c8; text-shadow: 0 0 9px rgba(0,0,0,.85), 0 0 18px rgba(255,216,102,.18);
}
#${LAYER_ID} .fu-dl-dots { display: inline-flex; margin-left: .12em; }
#${LAYER_ID} .fu-dl-dots i {
  font-style: normal; opacity: .15; animation: fu-dl-dot 1.2s ease-in-out infinite;
}
#${LAYER_ID} .fu-dl-dots i:nth-child(2) { animation-delay: .18s; }
#${LAYER_ID} .fu-dl-dots i:nth-child(3) { animation-delay: .36s; }
@keyframes fu-dl-dot { 0%,70%,100% { opacity: .15; } 35% { opacity: 1; } }

/* ── Indeterminate bar (transform sweep = compositor-safe) ────────────────── */
#${LAYER_ID} .fu-dl-bar {
  position: absolute; left: 50%; top: 69.5%; transform: translateX(-50%);
  width: min(38vw, 420px); height: 3px; border-radius: 3px; overflow: hidden;
  background: rgba(255,255,255,.07);
  box-shadow: 0 0 10px rgba(0,0,0,.5);
}
#${LAYER_ID} .fu-dl-bar::before {
  content: ""; position: absolute; top: 0; left: 0; height: 100%; width: 38%;
  background: linear-gradient(90deg, transparent, ${ACCENT} 55%, transparent);
  filter: drop-shadow(0 0 4px rgba(255,216,102,.6));
  animation: fu-dl-slide 1.25s cubic-bezier(.45,.05,.55,.95) infinite;
  will-change: transform;
}
@keyframes fu-dl-slide { from { transform: translateX(-130%); } to { transform: translateX(330%); } }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function ensureLayer() {
  ensureStyle();
  let layer = document.getElementById(LAYER_ID);
  if (layer && layer.__fu) return layer;
  layer = document.createElement("div");
  layer.id = LAYER_ID;

  const speed = document.createElement("div");
  speed.className = "fu-dl-speed";

  const crest = document.createElement("div");
  crest.className = "fu-dl-crest";
  const ringO = document.createElement("div"); ringO.className = "fu-dl-ring";
  const ringI = document.createElement("div"); ringI.className = "fu-dl-ring inner";
  const glyph = document.createElement("div");
  glyph.className = "fu-dl-glyph";
  glyph.innerHTML = `<i class="${EMBLEM_GLYPH}"></i>`;
  crest.append(ringO, ringI, glyph);

  const text = document.createElement("div");
  text.className = "fu-dl-text";
  const label = document.createElement("span");
  label.textContent = "PREPARING BATTLE";
  const dots = document.createElement("span");
  dots.className = "fu-dl-dots";
  dots.innerHTML = "<i>.</i><i>.</i><i>.</i>";
  text.append(label, dots);

  const bar = document.createElement("div");
  bar.className = "fu-dl-bar";

  layer.append(speed, crest, text, bar);
  document.body.appendChild(layer);
  layer.__fu = { speed, crest, text, bar };
  return layer;
}

function clearMaxHold() {
  if (_maxHoldTimer) { clearTimeout(_maxHoldTimer); _maxHoldTimer = null; }
}

// ── local render (runs on every client via socket) ───────────────────────
function showLoaderLocal() {
  try {
    const layer = ensureLayer();
    _shownAt = performance.now();
    layer.style.transition = `opacity ${FADE_IN_MS}ms ease-out`;
    layer.classList.add("active");
    // Commit display:block before flipping opacity so the fade actually runs.
    void layer.offsetHeight;
    layer.style.opacity = "1";
    if (!_surfaceId) _surfaceId = registerSurface({ kind: "battle-loader" });

    // Failsafe: never strand the screen if a hide message is lost.
    clearMaxHold();
    _maxHoldTimer = setTimeout(() => {
      warn(`director-battle-loader: auto-hidden after ${MAX_HOLD_MS}ms (no hide received)`);
      hideLoaderLocal().catch(() => {});
    }, MAX_HOLD_MS);
  } catch (e) {
    warn("showLoaderLocal threw", e);
  }
}

async function hideLoaderLocal() {
  clearMaxHold();
  const layer = document.getElementById(LAYER_ID);
  if (!layer || !layer.classList.contains("active")) return;
  try {
    layer.style.transition = `opacity ${FADE_OUT_MS}ms ease-in`;
    void layer.offsetHeight;
    layer.style.opacity = "0";
    // A hidden window paints nothing, so the CSS transition never runs and
    // `transitionend` never fires — leaving only the fallback timer, which
    // Chromium clamps to its >=1 s hidden-tab floor. That is a full second of
    // PREP stall per hide for a fade nobody can see. Drop straight to the end
    // state instead; the layer is dismissed either way.
    if (shouldRender()) {
      await new Promise((resolve) => {
        const done = () => resolve();
        const fallback = setTimeout(done, FADE_OUT_MS + 80);
        layer.addEventListener("transitionend", () => { clearTimeout(fallback); done(); }, { once: true });
      });
    }
    layer.classList.remove("active");
  } catch (e) {
    warn("hideLoaderLocal threw", e);
  } finally {
    if (_surfaceId) { unregisterSurface(_surfaceId); _surfaceId = null; }
  }
}

// ── public: fire from PREP ────────────────────────────────────────────────
// Render on THIS (GM) client + broadcast to all OTHERS. Fire-and-forget — the
// pipeline continues straight into the (awaited) preload step.
export function showBattleLoader({ broadcast = true } = {}) {
  showLoaderLocal();
  if (broadcast) {
    try { _socket?.executeForOthers?.(ACTION_SHOW); }
    catch (e) { warn("director-battle-loader: show broadcast failed", e); }
  }
}

// Enforce a minimum on-screen floor, then dismiss on every client. Awaited by
// the pipeline so the curtain only drops after the overlay has faded out (clean
// handoff — the overlay never covers the battlefield reveal).
export async function hideBattleLoader({ broadcast = true, minShowMs = DEFAULT_MIN_SHOW_MS } = {}) {
  const elapsed = _shownAt ? (performance.now() - _shownAt) : minShowMs;
  if (elapsed < minShowMs) {
    // ⚠ This floor sits IN FRONT OF the hide broadcast below, so it is NOT a
    // purely local dwell: collapsing it on a hidden GM would dismiss the loader
    // ~800ms early on every OTHER client too, flashing it. Only fast-forward it
    // when nobody else is watching. (The local fade further down IS local-only
    // and stays clock-aware.)
    const remaining = minShowMs - elapsed;
    await (hasOtherViewers() ? interval(remaining) : sleep(remaining));
  }
  if (broadcast) {
    try { _socket?.executeForOthers?.(ACTION_HIDE); }
    catch (e) { warn("director-battle-loader: hide broadcast failed", e); }
  }
  await hideLoaderLocal();
}
