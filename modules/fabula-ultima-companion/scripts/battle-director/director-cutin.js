// Director-native critical-hit cut-in.
//
// FULLY SELF-CONTAINED — does NOT touch the legacy cut-in system
// (scripts/cutin-receiver.js / cutin-broadcast.js stay byte-for-byte
// original). This module owns its own socketlib channel, its own render
// surface, its own geometry + timing, and its own asset preloading.
//
// RENDER SURFACE: a screen-fixed DOM overlay (NOT PIXI/canvas). The legacy
// cut-in rendered onto `canvas.stage`, which is transformed by camera
// pan/zoom — so a "screen" coordinate is actually a scene-world coordinate
// and the portrait lands off-screen whenever the battlefield is zoomed. A
// `position: fixed` DOM layer is immune to the camera transform and uses
// vw/vh units, so it's correct on every screen size and zoom level. This is
// the same proven pattern the namecard uses.
//
// Why director-native at all: the director runs a director-owned
// DirectorCombat with no Foundry Combat document, so the legacy receiver's
// `combatStart` preload never fires; and per project direction the director
// must not depend on / mutate legacy battle subsystems.
//
// Flow:
//   boot  → initDirectorCutin() registers the socket handlers.
//   PREP  → preloadDirectorCutins({tokens}) warms every client's browser
//           image cache for combatants that have `cut_in_critical` art.
//   crit  → playCritCutin(ar) resolves the attacker's portrait and tells
//           every client to render the cinematic.
//
// Players are staged on the RIGHT, so portraits enter from the right edge.
// Scope: criticals only (per design decision).

import { log, warn } from "./logger.js";
import { registerAnimation } from "./director-surfaces.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_CUTIN_PLAY";
const ACTION_PRELOAD = "FU_DIRECTOR_CUTIN_PRELOAD";
const STYLE_ID = "fu-dir-cutin-style";
const LAYER_ID = "fu-dir-cutin-layer";
const CRIT_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg";

let _socket = null;

// ── boot: socket registration ───────────────────────────────────────────
// Idempotent. Call once after socketlib is available (boot `ready`).
export function initDirectorCutin() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("director-cutin: socketlib unavailable — cut-ins disabled");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playDirectorCutinLocal);
    _socket.register(ACTION_PRELOAD, preloadLocal);
    log("director-cutin: socket registered");
  } catch (e) {
    warn("director-cutin: init failed", e);
  }
}

// ── DOM surface (created lazily, reused) ──────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${LAYER_ID} {
  position: fixed; inset: 0; z-index: 100000;
  pointer-events: none; overflow: hidden; display: none;
}
#${LAYER_ID}.active { display: block; }
#${LAYER_ID} .fu-dc-dim   { position: absolute; inset: 0; background: #000; opacity: 0; }
#${LAYER_ID} .fu-dc-flash { position: absolute; inset: 0; background: #fff; opacity: 0; }
#${LAYER_ID} .fu-dc-portrait {
  position: absolute; bottom: 0; height: 92vh; width: auto; opacity: 0.999;
  will-change: transform; transform: translateX(120vw);
  border: none; outline: none; background: transparent;
}
#${LAYER_ID} .fu-dc-portrait.side-right { right: 6vw; }
#${LAYER_ID} .fu-dc-portrait.side-left  { left: 6vw; }
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
  const dim = document.createElement("div");
  dim.className = "fu-dc-dim";
  const flash = document.createElement("div");
  flash.className = "fu-dc-flash";
  const portrait = document.createElement("img");
  portrait.className = "fu-dc-portrait";
  portrait.draggable = false;
  layer.append(dim, flash, portrait);
  document.body.appendChild(layer);
  layer.__fu = { dim, flash, portrait };
  return layer;
}

// ── helpers ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setImageSrc(img, url) {
  return new Promise((resolve) => {
    if (img.src === url && img.complete) return resolve();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

// Browser-cache warm: just create Image() objects. Subsequent <img>.src to
// the same URL is then instant.
async function preloadLocal({ urls = [] } = {}) {
  await Promise.all(
    urls.map(
      (u) =>
        new Promise((resolve) => {
          const im = new Image();
          im.onload = im.onerror = () => resolve();
          im.src = u;
        })
    )
  );
}

function playCritSfx(volume = 0.8) {
  try {
    const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    AH?.play?.({ src: CRIT_SFX_URL, volume, autoplay: true, loop: false }, false);
  } catch (e) {
    warn("director-cutin: sfx failed", e);
  }
}

// ── local render (runs on every client via socket) ───────────────────────
async function playDirectorCutinLocal(payload = {}) {
  try {
    // Drop on a hidden/non-active tab — see FUCompanion.api.vfxSuppressed.
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return;
    const {
      url,
      enterFrom = "right",
      // Mirror the portrait horizontally. Player art usually faces "forward"
      // (to the art's right); staged on the screen's right, they should face
      // the enemies on the LEFT, so right-entry cut-ins mirror by default.
      flip = false,
      // Soft left/right edge fade as a % of width per side (0 = hard edges).
      // Per-actor via the `cutinSoftEdge` flag; resolved in playCritCutin.
      edgeFade = 0,
      sfx = true,
      sfxVol = 0.8,
      dimAlpha = 0.6,
      flashPeak = 0.85,
      // Energetic profile: snappy enter, gentle leftward drift to stay alive,
      // accelerating exit. All distances are vw/vh so it's screen-size safe.
      slideInMs = 500,
      driftMs = 1500,
      driftVw = 3,
      slideOutMs = 450,
      enterEase = "cubic-bezier(.1,.9,.25,1)",
      exitEase = "cubic-bezier(.6,0,.9,.15)",
    } = payload;
    if (!url) return;

    const layer = ensureLayer();
    const { dim, flash, portrait } = layer.__fu;

    // Cancel any in-flight animations from a prior cut-in on these elements.
    for (const el of [dim, flash, portrait]) el.getAnimations?.().forEach((a) => a.cancel());

    // Optional soft edges — horizontal mask fading both vertical edges.
    if (edgeFade > 0) {
      const mask = `linear-gradient(to right, transparent 0%, #000 ${edgeFade}%, #000 ${100 - edgeFade}%, transparent 100%)`;
      portrait.style.webkitMaskImage = mask;
      portrait.style.maskImage = mask;
    } else {
      portrait.style.webkitMaskImage = "none";
      portrait.style.maskImage = "none";
    }

    const right = String(enterFrom).toLowerCase() !== "left";
    portrait.classList.toggle("side-right", right);
    portrait.classList.toggle("side-left", !right);
    const off = right ? "120vw" : "-120vw";      // off-screen on the ENTRY side
    const exitOff = right ? "-120vw" : "120vw";  // off-screen on the EXIT side (opposite)
    const driftX = (right ? -driftVw : driftVw); // drift toward the exit side

    // Transform combines the slide (translateX) with an optional mirror
    // (scaleX(-1)). CSS applies scaleX first then translateX, so translateX
    // stays a screen-space shift — the mirror only flips the image content.
    const mir = flip ? " scaleX(-1)" : "";
    const offT = `translateX(${off})${mir}`;          // entry start (off entry side)
    const restT = `translateX(0)${mir}`;              // resting position
    const driftT = `translateX(${driftX}vw)${mir}`;   // gentle drift toward exit
    const exitT = `translateX(${exitOff})${mir}`;     // sweep off the OPPOSITE edge

    await setImageSrc(portrait, url);

    // Reset to start state.
    dim.style.opacity = "0";
    flash.style.opacity = "0";
    portrait.style.opacity = "1";
    portrait.style.transform = offT;
    layer.classList.add("active");

    // Track this cinematic in the director's surface registry (auto-expires
    // after its full enter→drift→exit duration). Observability only.
    try { registerAnimation({ kind: "crit-cutin", durationMs: slideInMs + driftMs + slideOutMs, meta: { url } }); }
    catch (_e) {}

    if (sfx) playCritSfx(sfxVol);

    // Dim + flash fire alongside the energetic enter (not blocking it).
    dim.animate([{ opacity: 0 }, { opacity: dimAlpha }],
      { duration: 200, easing: "ease-out", fill: "forwards" });
    flash.animate([{ opacity: 0 }, { opacity: flashPeak }, { opacity: 0 }],
      { duration: 320, easing: "ease-out", fill: "forwards" });

    // 1) Energetic enter from the entry side to rest.
    await portrait.animate(
      [{ transform: offT }, { transform: restT }],
      { duration: slideInMs, easing: enterEase, fill: "forwards" }
    ).finished;

    // 2) Gentle leftward drift (keeps the moment alive instead of freezing).
    await portrait.animate(
      [{ transform: restT }, { transform: driftT }],
      { duration: driftMs, easing: "linear", fill: "forwards" }
    ).finished;

    // 3) Accelerating exit — sweep off the OPPOSITE edge + lift the dim.
    await Promise.all([
      dim.animate([{ opacity: dimAlpha }, { opacity: 0 }],
        { duration: 300, easing: "ease-in", fill: "forwards" }).finished,
      portrait.animate(
        [{ transform: driftT }, { transform: exitT }],
        { duration: slideOutMs, easing: exitEase, fill: "forwards" }
      ).finished,
    ]);

    layer.classList.remove("active");
  } catch (e) {
    warn("playDirectorCutinLocal threw", e);
  }
}

// ── resolve an Actor from a token/actor uuid ──────────────────────────────
function resolveActor(anyUuid) {
  try {
    if (!anyUuid) return null;
    const doc = fromUuidSync?.(anyUuid);
    if (!doc) return null;
    if (doc.documentName === "Token" || doc.isToken) return doc.actor ?? doc.document?.actor ?? null;
    if (doc.documentName === "Actor") return doc;
    return doc.actor ?? doc.document?.actor ?? null;
  } catch {
    return null;
  }
}

// Whether to mirror an actor's portrait for a given entrance side. Per-actor
// override lives in the `cutinFlip` flag (set true/false on the actor when
// its art already faces the right way). Default: mirror on right-entry so the
// portrait faces the enemies staged on the left.
function resolveFlip(actor, enterFrom) {
  const override = actor?.getFlag?.(MODULE_ID, "cutinFlip");
  if (typeof override === "boolean") return override;
  return String(enterFrom).toLowerCase() !== "left";
}

// ── public: PREP preload ──────────────────────────────────────────────────
// Warm every active client's image cache for combatants that have crit art.
// Fire-and-forget — the first crit is at least a turn away.
export async function preloadDirectorCutins({ tokens = [] } = {}) {
  try {
    const urls = [];
    const seen = new Set();
    for (const tok of tokens) {
      const u = tok?.actor?.system?.props?.cut_in_critical;
      if (u && !seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    }
    if (!urls.length) {
      log("director-cutin preload: no actors with crit art");
      return;
    }
    // Warm THIS client + every other client (no dependency on the active-user
    // filter, which can be empty for a solo GM).
    await preloadLocal({ urls });
    try { _socket?.executeForOthers?.(ACTION_PRELOAD, { urls }); }
    catch (e) { warn("director-cutin: preload broadcast failed", e); }
    log(`director-cutin preload: ${urls.length} portrait URL(s) across clients`);
  } catch (e) {
    warn("preloadDirectorCutins threw", e);
  }
}

// ── public: crit playback ─────────────────────────────────────────────────
// Fire-and-forget from RESOLVE. No-op unless the action was a (non-fumble)
// crit and the attacker has crit art. Broadcasts to all active clients;
// socketlib runs the handler locally for the GM sender too.
export function playCritCutin(ar) {
  try {
    if (!ar?.roll?.isCrit || ar?.roll?.isFumble) return;
    const actor = resolveActor(ar?.attacker?.tokenUuid ?? ar?.attackerActorRef);
    const url = actor?.system?.props?.cut_in_critical || null;
    if (!url) {
      log("director-cutin: attacker has no cut_in_critical art");
      return;
    }
    const enterFrom = "right";
    // Per-actor soft edges (cutinSoftEdge flag) → 6% fade per side, else hard.
    const edgeFade = actor?.getFlag?.(MODULE_ID, "cutinSoftEdge") === true ? 6 : 0;
    const payload = { url, enterFrom, flip: resolveFlip(actor, enterFrom), edgeFade };
    // Always render on THIS (GM) client + broadcast to all OTHERS. We don't
    // rely on game.users.active filtering (it can be empty for a solo GM, and
    // executeForUsers' local-echo is unreliable) — local call + executeForOthers
    // guarantees every client renders exactly once.
    playDirectorCutinLocal(payload);
    try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
    catch (e) { warn("director-cutin: broadcast failed", e); }
  } catch (e) {
    warn("playCritCutin threw", e);
  }
}
