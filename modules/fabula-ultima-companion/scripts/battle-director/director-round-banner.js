// Director-native start-of-round banner.
//
// Screen-fixed DOM cinematic shown at the start of each round: a centered dark
// band fades in, gold accent lines sweep open from the center, and "ROUND N"
// rises in — holds — then fades out. Self-contained: own socketlib channel,
// own render surface, own SFX. No legacy dependency (the legacy "round
// announcer" was end-of-round chat cards coupled to Lancer Initiative + the
// chat log, which the director doesn't use).
//
// SFX: Critical_1.wav, loaded via Web Audio (fetch the FULL file →
// decodeAudioData → play). Foundry's HTML5 AudioHelper uses Range requests,
// and some Forge .wav assets fail to decode on a 206 partial response
// (ERR_CONTENT_DECODING_FAILED); a plain full fetch (200) sidesteps that.
//
// Flow:
//   boot        → initDirectorRoundBanner() registers the socket handler.
//   ROUND_START → playRoundBanner({round}) renders locally + broadcasts.

import { log, warn } from "./logger.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_ROUND_PLAY";
const ACTION_HIDE = "FU_DIRECTOR_ROUND_HIDE";
const STYLE_ID = "fu-dir-round-style";
const LAYER_ID = "fu-dir-round-layer";
const ROUND_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav";
const ACCENT = "#ffd866";

let _socket = null;

// ── boot: socket registration (idempotent; call once after socketlib up) ──
export function initDirectorRoundBanner() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("director-round-banner: socketlib unavailable — banner will be local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playRoundBannerLocal);
    _socket.register(ACTION_HIDE, () => exitRoundBannerLocal({ animate: true }));
    log("director-round-banner: socket registered");
  } catch (e) {
    warn("director-round-banner: init failed", e);
  }
}

// ── Web Audio SFX (full-file fetch → decode → play; cached per session) ───
const _audio = { ctx: null, cache: {} };
async function playRoundSfx(url = ROUND_SFX_URL, vol = 0.6) {
  try {
    _audio.ctx = _audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audio.ctx.state === "suspended") { try { await _audio.ctx.resume(); } catch {} }
    let buf = _audio.cache[url];
    if (!buf) {
      const resp = await fetch(url, { cache: "reload" }); // full 200, no Range
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      buf = await _audio.ctx.decodeAudioData((await resp.arrayBuffer()).slice(0));
      _audio.cache[url] = buf;
    }
    const src = _audio.ctx.createBufferSource();
    const gain = _audio.ctx.createGain();
    gain.gain.value = vol;
    src.buffer = buf;
    src.connect(gain).connect(_audio.ctx.destination);
    src.start(0);
  } catch (e) {
    warn("director-round-banner: sfx failed", e);
  }
}

// ── DOM surface (created lazily, reused) ──────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${LAYER_ID} { position: fixed; inset: 0; z-index: 100000; pointer-events: none; overflow: hidden; display: none; }
#${LAYER_ID}.active { display: block; }
#${LAYER_ID} .fu-rb-band {
  position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1.6vh; padding: 3.2vh 0;
}
#${LAYER_ID} .fu-rb-bg {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(8,8,12,.78) 16%, rgba(8,8,12,.78) 84%, transparent 100%);
}
#${LAYER_ID} .fu-rb-line {
  position: relative; height: 2px; width: 48vw; transform-origin: center;
  background: linear-gradient(90deg, transparent, ${ACCENT} 12%, ${ACCENT} 88%, transparent);
  box-shadow: 0 0 8px ${ACCENT};
}
#${LAYER_ID} .fu-rb-text {
  position: relative; color: #fff; white-space: nowrap; letter-spacing: .1em;
  font: 900 6.2vh "Pixel Operator", system-ui, sans-serif;
  text-shadow: 0 2px 12px rgba(0,0,0,.7);
}
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
  const band = document.createElement("div"); band.className = "fu-rb-band";
  const bg = document.createElement("div"); bg.className = "fu-rb-bg";
  const lt = document.createElement("div"); lt.className = "fu-rb-line";
  const tx = document.createElement("div"); tx.className = "fu-rb-text";
  const lb = document.createElement("div"); lb.className = "fu-rb-line";
  band.append(bg, lt, tx, lb);
  layer.append(band);
  document.body.appendChild(layer);
  layer.__fu = { band, bg, lt, lb, tx };
  return layer;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── exit: fade out + clear the docked banner ──────────────────────────────
// Used both on round change (before the next banner enters) and at battle end.
// Function declaration → hoisted, so playRoundBannerLocal can call it above.
async function exitRoundBannerLocal({ animate = true } = {}) {
  try {
    const layer = document.getElementById(LAYER_ID);
    if (!layer || !layer.__fu || !layer.classList.contains("active")) return;
    const { band, bg, lt, lb, tx } = layer.__fu;
    if (animate) {
      // Single-keyframe → fades from each element's CURRENT opacity to 0
      // (the docked banner sits at reduced bg opacity, full text/lines).
      await Promise.all([
        bg.animate([{ opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished,
        lt.animate([{ opacity: 0 }], { duration: 300, fill: "forwards" }).finished,
        lb.animate([{ opacity: 0 }], { duration: 300, fill: "forwards" }).finished,
        tx.animate([{ opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished,
      ]);
    }
    for (const el of [band, bg, lt, lb, tx]) el.getAnimations?.().forEach((a) => a.cancel());
    layer.classList.remove("active");
  } catch (e) {
    warn("exitRoundBannerLocal threw", e);
  }
}

// ── local render (runs on every client via socket) ───────────────────────
// Enter center → hold → DOCK to middle-top and persist as a round indicator.
async function playRoundBannerLocal(payload = {}) {
  try {
    const {
      round = 0, holdMs = 800, sfx = true, sfxVol = 0.6,
      dockTopPct = 9, dockScale = 0.4, dockBgOpacity = 0.3,
    } = payload;
    const layer = ensureLayer();
    const { band, bg, lt, lb, tx } = layer.__fu;

    // If a prior round's banner is still docked at the top, fade it out first
    // so the new one enters from center cleanly (no jump back from the top).
    if (layer.classList.contains("active")) await exitRoundBannerLocal({ animate: true });

    for (const el of [band, bg, lt, lb, tx]) el.getAnimations?.().forEach((a) => a.cancel());

    tx.textContent = `ROUND ${round}`;
    layer.classList.add("active");
    if (sfx) playRoundSfx(ROUND_SFX_URL, sfxVol);

    // Reset to centered start state.
    band.style.top = "50%";
    band.style.transform = "translateY(-50%) scale(1)";
    bg.style.opacity = "0";
    tx.style.opacity = "0";
    lt.style.transform = "scaleX(0)";
    lb.style.transform = "scaleX(0)";

    // Enter: band fades in, accent lines sweep open, text rises in.
    bg.animate([{ opacity: 0, transform: "scaleY(.55)" }, { opacity: 1, transform: "scaleY(1)" }],
      { duration: 240, easing: "ease-out", fill: "forwards" });
    await Promise.all([
      lt.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: 400, easing: "cubic-bezier(.16,.84,.36,1)", fill: "forwards" }).finished,
      lb.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: 400, easing: "cubic-bezier(.16,.84,.36,1)", fill: "forwards" }).finished,
    ]);
    await tx.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 300, easing: "ease-out", fill: "forwards" }).finished;

    await sleep(holdMs);

    // Dock: shrink + glide to middle-top, then STAY (persistent indicator).
    band.animate(
      [
        { top: "50%", transform: "translateY(-50%) scale(1)" },
        { top: `${dockTopPct}%`, transform: `translateY(-50%) scale(${dockScale})` },
      ],
      { duration: 520, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }
    );
    bg.animate([{ opacity: 1 }, { opacity: dockBgOpacity }],
      { duration: 520, easing: "ease-in-out", fill: "forwards" });
    // Note: NO layer.classList.remove — the banner persists until the next
    // round (exited above) or battle end (hideRoundBanner).
  } catch (e) {
    warn("playRoundBannerLocal threw", e);
  }
}

// ── public: fire from ROUND_START ─────────────────────────────────────────
// Render on THIS (GM) client + broadcast to all OTHERS. Fire-and-forget so the
// FSM is not blocked by the ~2.5s cinematic.
export function playRoundBanner({ round = 0 } = {}) {
  try {
    const payload = { round };
    playRoundBannerLocal(payload);
    try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
    catch (e) { warn("director-round-banner: broadcast failed", e); }
  } catch (e) {
    warn("playRoundBanner threw", e);
  }
}

// ── public: clear the docked banner at battle end ─────────────────────────
// Fade out + remove on THIS client and broadcast the same to all others, so
// the persistent round indicator never lingers after the director stops.
export function hideRoundBanner() {
  try {
    exitRoundBannerLocal({ animate: true });
    try { _socket?.executeForOthers?.(ACTION_HIDE); }
    catch (e) { warn("director-round-banner: hide broadcast failed", e); }
  } catch (e) {
    warn("hideRoundBanner threw", e);
  }
}
