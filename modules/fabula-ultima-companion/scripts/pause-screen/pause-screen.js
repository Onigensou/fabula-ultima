// ============================================================================
// Pause Screen — PS1/PS2-style dressing over Foundry's native pause
// ----------------------------------------------------------------------------
// The GM still pauses with Space; game.paused stays the real state (it blocks
// player token movement and is synced by core). This file only replaces what
// that pause LOOKS like: the spinning "Game Paused" logo is hidden, the map
// dims and drains a little colour, and the music drops while the group is on
// a break.
//
// THE BEAT (the user's storyboard, 2026-10-15) —
//   1. a thin red line draws in from the left edge across the screen
//   2. at full width it thickens
//   3. "Pause" slides in from the left, grey and see-through
//   4. it lands centred on the line, white with a black outline, and slowly
//      blinks for as long as the break lasts
// Times are in TUNING; each step is a CSS animation started by .is-shown.
//
// SAME SCREEN FOR EVERYONE — the GM sees exactly what the players see, so the
// table pauses together like one console. This is a deliberate exception to
// the "presentation never takes the GM screen" rule, and it keeps that rule's
// spirit: the whole screen is pointer-events:none and listens to no keys, so
// the GM keeps moving tokens and placing things underneath it, as core pause
// allows. On the GM client the line and word also fade out of the way while
// the GM drags on the map or points at the word.
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
  LINE_AT_MS: 150,        // red line starts drawing
  LINE_DRAW_MS: 900,      // ... and reaches the right edge
  LINE_THICKEN_MS: 300,   // then thickens
  WORD_AT_MS: 1050,       // "Pause" starts sliding in
  WORD_IN_MS: 750,
  BLINK_AT_MS: 2300,      // first blink
  BLINK_MS: 2800,         // one slow blink, bright → dim → bright
  BLINK_LOW: 0.3,         // opacity at the bottom of a blink
  EXIT_MS: 450,
  GM_FADE_OPACITY: 0.15,  // line + word opacity while the GM works under them
  GM_FADE_HOLD_MS: 700,   // how long they stay faded after the GM lets go
  WAIT_POLL_MS: 150,
  WAIT_MAX_MS: 12000,     // never hold the pause screen back longer than this
};

const T = TUNING;
const OUTLINE = [
  "3px 0 0 #000", "-3px 0 0 #000", "0 3px 0 #000", "0 -3px 0 #000",
  "2px 2px 0 #000", "-2px 2px 0 #000", "2px -2px 0 #000", "-2px -2px 0 #000",
  "6px 7px 10px rgba(0, 0, 0, 0.65)",
].join(", ");

const CSS = `
  /* Core's pause logo — replaced by this screen. */
  #pause { display: none !important; }

  #board { transition: filter ${T.DIM_MS}ms ease; }
  body.oni-paused #board { filter: saturate(0.55) brightness(0.8); }

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
    transition: opacity ${T.EXIT_MS}ms ease;
  }

  /* The band across the middle: the line, with the word sitting on it. */
  #${ROOT_ID} .ops-stage {
    position: absolute; left: 0; right: 0; top: 46%;
    transform: translateY(-50%);
    transition: opacity 250ms ease;
  }
  #${ROOT_ID}.is-gm-working .ops-stage { opacity: ${T.GM_FADE_OPACITY}; }

  #${ROOT_ID} .ops-line {
    position: absolute; left: 0; right: 0; top: 84%;
    height: 6px; margin-top: -3px;
    transform: scaleX(0); transform-origin: left center;
  }
  #${ROOT_ID} .ops-line-bar {
    width: 100%; height: 100%;
    background: linear-gradient(180deg, #ff3b3b 0%, #c8101a 55%, #8a0a10 100%);
    box-shadow: 0 0 10px rgba(255, 40, 40, 0.55), 0 2px 6px rgba(0, 0, 0, 0.6);
    transform: scaleY(0.34);
  }
  #${ROOT_ID}.is-shown .ops-line {
    animation: ops-line-draw ${T.LINE_DRAW_MS}ms cubic-bezier(0.65, 0, 0.35, 1) ${T.LINE_AT_MS}ms both;
  }
  #${ROOT_ID}.is-shown .ops-line-bar {
    animation: ops-line-thicken ${T.LINE_THICKEN_MS}ms ease-out ${T.LINE_AT_MS + T.LINE_DRAW_MS - 100}ms both;
  }
  @keyframes ops-line-draw { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes ops-line-thicken { from { transform: scaleY(0.34); } to { transform: scaleY(1); } }

  #${ROOT_ID} .ops-word {
    position: relative;
    text-align: center;
    font-family: "Arial Black", "Arial", "Signika", sans-serif;
    font-weight: 900; font-style: italic;
    font-size: clamp(64px, 6.2vw, 128px);
    line-height: 1;
    letter-spacing: 0.01em;
    color: #fff;
    text-shadow: ${OUTLINE};
    opacity: 0;
  }
  #${ROOT_ID}.is-shown .ops-word {
    animation:
      ops-word-in ${T.WORD_IN_MS}ms cubic-bezier(0.22, 1, 0.36, 1) ${T.WORD_AT_MS}ms both,
      ops-word-blink ${T.BLINK_MS}ms ease-in-out ${T.BLINK_AT_MS}ms infinite;
  }
  @keyframes ops-word-in {
    from { opacity: 0;    transform: translateX(-140px); color: #8e8e8e; }
    45%  { opacity: 0.55; color: #a8a8a8; }
    to   { opacity: 1;    transform: translateX(0);      color: #fff; }
  }
  @keyframes ops-word-blink {
    0%, 100% { opacity: 1; }
    50%      { opacity: ${T.BLINK_LOW}; }
  }
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

function ensureRoot() {
  if (root?.isConnected) return root;
  root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="ops-stage">
      <div class="ops-line"><div class="ops-line-bar"></div></div>
      <div class="ops-word">Pause</div>
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
  document.body.classList.remove("oni-paused");
  // Fade out with the line and word still drawn, then reset.
  root?.classList.add("is-leaving");
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => root?.classList.remove("is-shown", "is-leaving"), TUNING.EXIT_MS + 50);
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
