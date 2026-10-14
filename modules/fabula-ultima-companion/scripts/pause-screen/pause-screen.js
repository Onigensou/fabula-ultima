// ============================================================================
// Pause Screen — PS1/PS2-style dressing over Foundry's native pause
// ----------------------------------------------------------------------------
// The GM still pauses with Space; game.paused stays the real state (it blocks
// player token movement and is synced by core). This file only replaces what
// that pause LOOKS like: the spinning "Game Paused" logo is hidden, the map
// dims and drains a little colour, and the music drops while the group is on
// a break.
//
// THE BEAT (the user's storyboard, 2026-10-15, then tuned) —
//   1. the map dims
//   2. "Pause" slides in from the left and fades up, landing centred
//   3. on resume it slides on out to the right the same way, and the dim
//      lifts just behind it
// The word is minimal: bold white italic, a thin black outline, a hard drop
// shadow and a faint glow. The outline is a stroked copy of the text under
// the white one, because text-stroke on a single layer eats into the fill.
// Times are in TUNING; each step is a CSS animation started by .is-shown.
//
// SAME SCREEN FOR EVERYONE — the GM sees exactly what the players see, so the
// table pauses together like one console. This is a deliberate exception to
// the "presentation never takes the GM screen" rule, and it keeps that rule's
// spirit: the whole screen is pointer-events:none and listens to no keys, so
// the GM keeps moving tokens and placing things underneath it, as core pause
// allows. On the GM client the word also fades out of the way while the GM
// drags on the map or points at it.
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
  // The beat — slow + smooth, see the animation pacing rule.
  DIM_MS: 650,            // map dims
  WORD_AT_MS: 150,        // "Pause" starts sliding in
  WORD_IN_MS: 400,
  WORD_SLIDE_PX: 140,     // how far it travels in, and on out
  WORD_OUT_MS: 400,       // slide out on resume (mirrors the slide in)
  UNDIM_AT_MS: 250,       // the dim starts lifting this far into the slide out
  UNDIM_MS: 400,
  GM_FADE_OPACITY: 0.15,  // word opacity while the GM works under it
  GM_FADE_HOLD_MS: 700,   // how long they stay faded after the GM lets go
  WAIT_POLL_MS: 150,
  WAIT_MAX_MS: 12000,     // never hold the pause screen back longer than this
};

const T = TUNING;
// In: decelerates into place. Out: the mirror, accelerating away.
const EASE_SLIDE = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_SLIDE_OUT = "cubic-bezier(0.64, 0, 0.78, 0)";

const CSS = `
  /* Core's pause logo — replaced by this screen. */
  #pause { display: none !important; }

  #board { transition: filter ${T.DIM_MS}ms ease; }
  body.oni-paused #board { filter: saturate(0.55) brightness(0.8); }
  body:not(.oni-paused) #board { transition-duration: ${T.UNDIM_MS}ms; }

  #${ROOT_ID} {
    position: fixed; inset: 0; z-index: 0;
    pointer-events: none !important;
    background: rgba(18, 8, 1, 0.42);
    opacity: 0;
    visibility: hidden;
    user-select: none;
  }
  #${ROOT_ID} * { pointer-events: none !important; }
  #${ROOT_ID}.is-shown {
    opacity: 1; visibility: visible;
    transition: opacity ${T.DIM_MS}ms ease;
  }
  #${ROOT_ID}.is-shown.is-leaving {
    opacity: 0;
    transition: opacity ${T.UNDIM_MS}ms ease ${T.UNDIM_AT_MS}ms;
  }

  #${ROOT_ID} .ops-stage {
    position: absolute; left: 0; right: 0; top: 46%;
    transform: translateY(-50%);
    display: flex; justify-content: center;
    transition: opacity 250ms ease;
  }
  #${ROOT_ID}.is-gm-working .ops-stage { opacity: ${T.GM_FADE_OPACITY}; }

  /* The word: a stroked black copy under the white one, in one grid cell. */
  #${ROOT_ID} .ops-word {
    display: grid;
    font-family: "Arial Black", "Arial", "Signika", sans-serif;
    font-weight: 900; font-style: italic;
    font-size: clamp(48px, 4.5vw, 92px);
    line-height: 1.1;
    letter-spacing: 0.02em;
    opacity: 0;
    /* faint glow, then a hard drop shadow down-right */
    filter:
      drop-shadow(0 0 0.12em rgba(255, 255, 255, 0.28))
      drop-shadow(0.05em 0.06em 0.015em rgba(0, 0, 0, 0.85));
  }
  #${ROOT_ID} .ops-word > span {
    grid-area: 1 / 1;
    justify-self: center;
    padding: 0 0.12em; /* room for the italic overhang */
    white-space: nowrap;
  }
  #${ROOT_ID} .ops-ink {
    color: #000;
    -webkit-text-stroke: 0.06em #000;
  }
  #${ROOT_ID} .ops-face { color: #fff; }

  #${ROOT_ID}.is-shown .ops-word {
    animation: ops-word-in ${T.WORD_IN_MS}ms ${EASE_SLIDE} ${T.WORD_AT_MS}ms both;
  }
  #${ROOT_ID}.is-shown.is-leaving .ops-word {
    animation: ops-word-out ${T.WORD_OUT_MS}ms ${EASE_SLIDE_OUT} both;
  }
  @keyframes ops-word-in {
    from { opacity: 0; transform: translateX(-${T.WORD_SLIDE_PX}px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes ops-word-out {
    from { opacity: 1; transform: translateX(0); }
    to   { opacity: 0; transform: translateX(${T.WORD_SLIDE_PX}px); }
  }
`;

// ── State ───────────────────────────────────────────────────────────────────

let root = null;
let shown = false;
let waitToken = 0;      // bumps on every pause/resume so a stale wait gives up
let leaveTimer = null;
let undimTimer = null;
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

function ensureRoot() {
  if (root?.isConnected) return root;
  root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="ops-stage">
      <div class="ops-word">
        <span class="ops-ink">Pause</span>
        <span class="ops-face">Pause</span>
      </div>
    </div>`;
  // Above the map, below the sidebar / controls / windows (see LAYERING).
  const board = document.getElementById("board");
  if (board) board.after(root); else document.body.appendChild(root);
  return root;
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
    const word = root?.querySelector(".ops-word");
    if (!word) return;
    const r = word.getBoundingClientRect();
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
  clearTimeout(undimTimer);
  ensureStyle();
  ensureRoot();
  root.classList.remove("is-shown", "is-leaving");
  void root.offsetHeight; // reset so the whole beat plays from the start
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
  // The word slides on out and the dim lifts behind it (the overlay by its
  // CSS delay, the map filter by this timer); then reset.
  root?.classList.add("is-leaving");
  clearTimeout(undimTimer);
  undimTimer = setTimeout(() => document.body.classList.remove("oni-paused"), TUNING.UNDIM_AT_MS);
  clearTimeout(leaveTimer);
  const outMs = Math.max(TUNING.WORD_OUT_MS, TUNING.UNDIM_AT_MS + TUNING.UNDIM_MS);
  leaveTimer = setTimeout(() => root?.classList.remove("is-shown", "is-leaving"), outMs + 50);
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
