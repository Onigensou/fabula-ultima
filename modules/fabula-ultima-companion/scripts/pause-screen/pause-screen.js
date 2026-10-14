// ============================================================================
// Pause Screen — PS1/PS2-style dressing over Foundry's native pause
// ----------------------------------------------------------------------------
// The GM still pauses with Space; game.paused stays the real state (it blocks
// player token movement and is synced by core). This file only replaces what
// that pause LOOKS like: the spinning "Game Paused" logo is hidden, the map
// dims and drains a little colour, a parchment "PAUSE" panel slides in, and
// the music drops while the group is on a break.
//
// SAME SCREEN FOR EVERYONE — the GM sees exactly what the players see, so the
// table pauses together like one console. This is a deliberate exception to
// the "presentation never takes the GM screen" rule, and it keeps that rule's
// spirit: the whole screen is pointer-events:none and listens to no keys, so
// the GM keeps moving tokens and placing things underneath it, as core pause
// allows. On the GM client the panel also fades out of the way while the GM
// drags on the map or points at the spot the panel covers.
//
// LAYERING — the screen sits right after the #board canvas at z-index 0: it
// paints over the map (same z, later in the page) and under the sidebar,
// controls and every Foundry window, which all carry a higher z-index, so a
// sheet the GM opens during a break draws on top. In V12 #board comes AFTER
// #interface, so placing it before #interface left it hidden under the map.
//
// TRANSITIONS — a pause during a battle shatter or a scene-change fade waits
// until the screen is clear, then draws.
//
// MUSIC — each playing PlaylistSound is faded to MUSIC_DUCK of its own volume
// and faded back on resume. Nothing is written to settings or documents.
//
// Purely client-side: every client reacts to the core pauseGame hook.
// ============================================================================

import { readAreaConfig, cleanName, GLYPH } from "../area-panel/area-panel-core.js";

const TAG = "[PauseScreen]";
const ROOT_ID = "oni-pause-screen";
const STYLE_ID = "oni-pause-screen-style";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";

export const TUNING = {
  SFX_PAUSE: `${FORGE}/Sound/ffxiv_sps05001_mp3/FFXIV_Open_Window.mp3`,
  SFX_RESUME: `${FORGE}/Sound/ffxiv_sps05001_mp3/FFXIV_Close_Window.mp3`,
  SFX_VOLUME: 0.6,
  MUSIC_DUCK: 0.4,        // fraction of each track's own volume while paused
  MUSIC_FADE_MS: 900,
  ENTER_MS: 650,          // slow + smooth, see the animation pacing rule
  EXIT_MS: 450,
  GM_FADE_OPACITY: 0.15,  // panel opacity while the GM works under it
  GM_FADE_HOLD_MS: 700,   // how long it stays faded after the GM lets go
  WAIT_POLL_MS: 150,
  WAIT_MAX_MS: 12000,     // never hold the pause screen back longer than this
};

const CSS = `
  /* Core's pause logo — replaced by this screen. */
  #pause { display: none !important; }

  #board { transition: filter ${TUNING.ENTER_MS}ms ease; }
  body.oni-paused #board { filter: saturate(0.55) brightness(0.8); }

  #${ROOT_ID} {
    position: fixed; inset: 0; z-index: 0;
    pointer-events: none !important;
    display: flex; align-items: center; justify-content: center;
    background: rgba(18, 8, 1, 0.42);
    opacity: 0;
    transition: opacity ${TUNING.ENTER_MS}ms ease;
    font-family: "Signika", sans-serif;
    user-select: none;
  }
  #${ROOT_ID} * { pointer-events: none !important; }
  #${ROOT_ID}.is-shown { opacity: 1; }
  #${ROOT_ID}.is-leaving { transition-duration: ${TUNING.EXIT_MS}ms; }

  /* Parchment panel — the Save/Load confirm skin. */
  #${ROOT_ID} .ops-panel {
    position: relative;
    min-width: 360px;
    padding: 30px 64px 24px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
    border: 2px solid #c9a44a;
    border-radius: 10px;
    box-shadow:
      0 0 0 2px #7a4e20, 0 0 0 4px #b8865a,
      0 0 40px rgba(0, 0, 0, 0.55),
      inset 0 1px 0 rgba(255, 245, 200, 0.70);
    color: #3a1e06;
    opacity: 0;
    transform: translateX(-48px);
    transition:
      opacity ${TUNING.ENTER_MS}ms ease,
      transform ${TUNING.ENTER_MS}ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  #${ROOT_ID} .ops-panel::before {
    content: ""; position: absolute; inset: 0; z-index: 0; border-radius: 10px;
    background: repeating-linear-gradient(0deg, transparent, transparent 23px,
      rgba(140, 90, 30, 0.04) 23px, rgba(140, 90, 30, 0.04) 24px);
  }
  #${ROOT_ID} .ops-panel > * { position: relative; z-index: 1; }
  #${ROOT_ID}.is-shown .ops-panel { opacity: 1; transform: translateX(0); }
  #${ROOT_ID}.is-leaving .ops-panel {
    opacity: 0; transform: translateX(48px);
    transition-duration: ${TUNING.EXIT_MS}ms;
  }
  #${ROOT_ID}.is-gm-working .ops-panel {
    opacity: ${TUNING.GM_FADE_OPACITY};
    transition: opacity 250ms ease, transform 0ms;
  }

  #${ROOT_ID} .ops-title {
    font-size: 46px; font-weight: 400; letter-spacing: 0.22em;
    margin-right: -0.22em; /* letter-spacing pads the right edge */
    line-height: 1;
    animation: ops-breathe 3.2s ease-in-out infinite;
  }
  @keyframes ops-breathe {
    0%, 100% { text-shadow: 0 1px 0 rgba(255, 220, 130, 0.55), 0 0 6px rgba(201, 164, 74, 0.10); }
    50%      { text-shadow: 0 1px 0 rgba(255, 220, 130, 0.55), 0 0 18px rgba(201, 164, 74, 0.55); }
  }
  #${ROOT_ID} .ops-rule {
    width: 100%; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(140, 90, 30, 0.45), transparent);
  }
  #${ROOT_ID} .ops-loc { font-size: 15px; color: #7a5428; }
  #${ROOT_ID} .ops-loc:empty, #${ROOT_ID} .ops-loc:empty + * { display: none; }
`;

// ── State ───────────────────────────────────────────────────────────────────

let root = null;
let shown = false;
let waitToken = 0;      // bumps on every pause/resume so a stale wait gives up
let leaveTimer = null;
let gmFadeTimer = null;
const ducked = new Map(); // PlaylistSound id → volume we faded it to

const log = (...a) => console.debug(TAG, ...a);

// ── DOM ─────────────────────────────────────────────────────────────────────

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function locationText() {
  const scene = canvas?.scene ?? game.scenes?.viewed;
  if (!scene) return "";
  const name = cleanName(readAreaConfig(scene).name || scene.navName || "");
  return name ? `${GLYPH} ${name}` : "";
}

function ensureRoot() {
  if (root?.isConnected) return root;
  root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="ops-panel">
      <div class="ops-title">PAUSE</div>
      <div class="ops-loc"></div>
      <div class="ops-rule"></div>
    </div>`;
  // Above the map, below the sidebar / controls / windows (see LAYERING).
  const board = document.getElementById("board");
  if (board) board.after(root); else document.body.appendChild(root);
  return root;
}

function refreshLocation() {
  const el = root?.querySelector(".ops-loc");
  if (el) el.textContent = locationText();
}

// ── Transitions ─────────────────────────────────────────────────────────────

function transitionBusy() {
  if (document.body.classList.contains("fuc-shatter-active")) return true;
  const cover = document.getElementById("fu-screen-transition");
  return !!cover && parseFloat(cover.style.opacity || "0") > 0.01;
}

async function waitForClearScreen(token) {
  const start = Date.now();
  while (transitionBusy() && Date.now() - start < TUNING.WAIT_MAX_MS) {
    await new Promise((r) => setTimeout(r, TUNING.WAIT_POLL_MS));
    if (token !== waitToken) return false;
  }
  return token === waitToken;
}

// ── Sound ───────────────────────────────────────────────────────────────────

function sfx(src) {
  try { foundry.audio.AudioHelper.play({ src, volume: TUNING.SFX_VOLUME, loop: false }, false); }
  catch { /* sound is decoration */ }
}

function playingSounds() {
  const out = [];
  for (const playlist of game.playlists ?? []) {
    for (const ps of playlist.sounds) if (ps.playing && ps.sound) out.push(ps);
  }
  return out;
}

function duckMusic() {
  for (const ps of playingSounds()) {
    const target = ps.volume * TUNING.MUSIC_DUCK;
    try { ps.sound.fade(target, { duration: TUNING.MUSIC_FADE_MS }); ducked.set(ps.id, target); }
    catch (e) { log("duck failed", ps.name, e); }
  }
}

function restoreMusic() {
  for (const ps of playingSounds()) {
    if (!ducked.has(ps.id)) continue;
    try { ps.sound.fade(ps.volume, { duration: TUNING.MUSIC_FADE_MS }); }
    catch (e) { log("restore failed", ps.name, e); }
  }
  ducked.clear();
}

// A track started (or a volume changed) mid-break plays at full volume; bring
// it down once its sound has loaded, which can take a few seconds.
function reduckSoon(ps) {
  if (!shown) return;
  let tries = 0;
  const tick = () => {
    if (!shown || !ps.playing) return;
    if (ps.sound?.playing) {
      const target = ps.volume * TUNING.MUSIC_DUCK;
      try { ps.sound.fade(target, { duration: TUNING.MUSIC_FADE_MS }); ducked.set(ps.id, target); }
      catch { /* decoration */ }
      return;
    }
    if (++tries < 40) setTimeout(tick, 250);
  };
  setTimeout(tick, 400);
}

// ── GM: get out of the way while working ────────────────────────────────────

function gmFade(on) {
  if (!root) return;
  clearTimeout(gmFadeTimer);
  if (on) root.classList.add("is-gm-working");
  else gmFadeTimer = setTimeout(() => root?.classList.remove("is-gm-working"), TUNING.GM_FADE_HOLD_MS);
}

let pointerDown = false;
let overPanel = false;

function onPointerDown(ev) {
  if (!shown || !ev.target?.closest?.("#board")) return;
  pointerDown = true;
  gmFade(true);
}

function onPointerUp() {
  if (!pointerDown) return;
  pointerDown = false;
  if (!overPanel) gmFade(false);
}

let moveQueued = false;
function onPointerMove(ev) {
  if (!shown || moveQueued) return;
  moveQueued = true;
  const { clientX: x, clientY: y } = ev;
  requestAnimationFrame(() => {
    moveQueued = false;
    const panel = root?.querySelector(".ops-panel");
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    if (inside === overPanel) return;
    overPanel = inside;
    if (inside) gmFade(true);
    else if (!pointerDown) gmFade(false);
  });
}

function bindGmListeners(on) {
  if (!game.user?.isGM) return;
  const fn = on ? "addEventListener" : "removeEventListener";
  document[fn]("pointerdown", onPointerDown, true);
  document[fn]("pointerup", onPointerUp, true);
  document[fn]("pointermove", onPointerMove, { capture: true, passive: true });
  if (!on) { pointerDown = false; overPanel = false; clearTimeout(gmFadeTimer); root?.classList.remove("is-gm-working"); }
}

// ── Show / hide ─────────────────────────────────────────────────────────────

async function show({ sound = true } = {}) {
  const token = ++waitToken;
  if (!(await waitForClearScreen(token))) return;
  if (shown) return;
  shown = true;
  clearTimeout(leaveTimer);
  ensureStyle();
  ensureRoot();
  refreshLocation();
  root.classList.remove("is-leaving");
  void root.offsetHeight; // commit the hidden state so the slide-in plays
  root.classList.add("is-shown");
  document.body.classList.add("oni-paused");
  bindGmListeners(true);
  if (sound) sfx(TUNING.SFX_PAUSE);
  duckMusic();
  log("shown");
}

function hide({ sound = true } = {}) {
  ++waitToken;
  if (!shown) return;
  shown = false;
  bindGmListeners(false);
  document.body.classList.remove("oni-paused");
  root?.classList.add("is-leaving");
  root?.classList.remove("is-shown");
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => root?.classList.remove("is-leaving"), TUNING.EXIT_MS + 50);
  if (sound) sfx(TUNING.SFX_RESUME);
  restoreMusic();
  log("hidden");
}

// ── Wiring ──────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  ensureStyle();
  ensureRoot();
  // Joined (or reloaded) mid-break: show the screen without the chime.
  if (game.paused) show({ sound: false });
});

Hooks.on("pauseGame", (paused) => {
  if (paused) show();
  else hide();
});

Hooks.on("canvasReady", () => { if (shown) refreshLocation(); });

// Starting a track updates its PLAYLIST (changes.sounds), not the sound, so
// updatePlaylistSound alone misses it. A volume edit on a sound fires the latter.
Hooks.on("updatePlaylist", (playlist, changes) => {
  if (!shown) return;
  for (const change of changes.sounds ?? []) {
    if (!change.playing) continue;
    const ps = playlist.sounds.get(change._id);
    if (ps) reduckSoon(ps);
  }
});

Hooks.on("updatePlaylistSound", (ps, changes) => {
  if (!shown) return;
  if (("playing" in changes && changes.playing) || "volume" in changes) reduckSoon(ps);
});

// Console handle: preview the screen without pausing, for tuning.
globalThis.oni = globalThis.oni || {};
globalThis.oni.PauseScreen = {
  TUNING,
  isShown: () => shown,
  preview(ms = 4000) { show(); setTimeout(() => { if (!game.paused) hide(); }, ms); },
};
