// ============================================================================
// Area Name Panel — render + wiring
// ----------------------------------------------------------------------------
// A wooden plaque that slides in from the top-left when a scene is ACTIVATED,
// reads "◈ <Area Name>", holds, and leaves the way it came. The JRPG
// establishing-shot beat.
//
// Purely client-side: every client reacts to the scene document update on its
// own, so there is no socket, no GM host election and nothing to de-duplicate.
//
// TRIGGER — activation, not scene switch. The only event that means "the GM
// activated this scene" is updateScene with changes.active === true. Viewing a
// scene, navigating back to one, or reloading on an already-active scene all
// fire canvasReady WITHOUT that flag and are deliberately silent.
//
// SEQUENCING — scripts/screen-transition/screen-transition.js blacks the whole
// screen out at z 99999 while the new scene draws. Playing on the raw
// updateScene animates the panel behind solid black, so we wait for
// oni:screenRevealed (which fires on both the animated and the
// disableTransition snap path) and add a settle beat. A GM who activates the
// scene they are already looking at gets no redraw at all, so a settle timer
// covers that case, and a watchdog guarantees an arm can never be orphaned.
//
// HIDDEN TABS — a player alt-tabbed away has document.hidden true, paints
// nothing and throttles its timers. Such a client HOLDS the panel and plays it
// when it comes back (see playOrDefer), rather than burning the beat on a
// screen nobody is watching.
//
// Gate + tuning constants: ./area-panel-core.js
// ============================================================================

import {
  MODULE_ID, TUNING, GLYPH,
  readAreaConfig, shouldShowForScene, cleanName,
  mergeTuning, diffFromDefaults,
} from "./area-panel-core.js";

// ── live tuning ───────────────────────────────────────────────────────────
// The shipped TUNING with the world's saved overrides on top. Everything that
// can be expressed as a CSS variable is, so the tuner is an instant repaint
// rather than a stylesheet rebuild; the timings are read at play time.
export const TUNING_SETTING = "areaPanelTuning";

let live = { ...TUNING };

/** Re-read the saved overrides and repaint. Safe before settings exist. */
export function refreshTuning() {
  let stored = null;
  try { stored = game?.settings?.get?.(MODULE_ID, TUNING_SETTING) ?? null; } catch (_e) { /* not registered yet */ }
  live = mergeTuning(stored);
  applyVars();
  return live;
}

/** Paint a set of overrides WITHOUT saving them — what the tuner drags on. */
export function applyTuningPreview(overrides) {
  live = mergeTuning(overrides);
  applyVars();
  return live;
}

export function liveTuning() { return { ...live }; }

const ROOT_ID  = "fu-area-panel";
const STYLE_ID = "fu-area-panel-style";
const LAST_AREA_STORE_KEY = "fu-area-panel:last-area";

const TAG = "[AreaPanel]";
const DEBUG = false;
const log = (...a) => DEBUG && console.log(TAG, ...a);

// ── last-announced area (repeat suppression) ──────────────────────────────
// Held in sessionStorage so an F5 mid-session does not make the next scene of
// the same castle re-announce it. Session-scoped on purpose: a fresh sitting
// should get its establishing shot. Storage can throw (private mode, blocked
// site data), so every access is guarded and falls back to the in-memory copy.
let _lastArea = null;

function getLastArea() {
  try {
    const stored = window.sessionStorage?.getItem(LAST_AREA_STORE_KEY);
    if (typeof stored === "string") return stored;
  } catch (_e) { /* fall through to the memory copy */ }
  return _lastArea;
}

function setLastArea(name) {
  _lastArea = name ?? null;
  try {
    if (name) window.sessionStorage?.setItem(LAST_AREA_STORE_KEY, name);
    else window.sessionStorage?.removeItem(LAST_AREA_STORE_KEY);
  } catch (_e) { /* the memory copy still holds it */ }
}

// ── style ─────────────────────────────────────────────────────────────────
// Warm wood + parchment, matching the camp system's theme tokens
// (scripts/camp-system/camp-styles.js). Literal fallbacks are the house idiom:
// the tokens are injected by another file and load order is not guaranteed.

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Anchored to the LEFT EDGE of the screen, not floated near it: --fu-ap-x
       is negative, so the plaque hangs off-frame and only its right corners are
       ever seen. Vertically it clears Foundry's own chrome (--fu-ap-auto-top,
       measured at show time) plus whatever offset the tuner adds.

       Every var here is written by applyVars() from the live tuning, so a drag
       in the tuner is a repaint and never a stylesheet rebuild. */
    #${ROOT_ID} {
      position: fixed;
      top: calc(var(--fu-ap-auto-top, 14px) + var(--fu-ap-y, 0px));
      left: var(--fu-ap-x, -28px);
      z-index: ${TUNING.Z_INDEX};
      pointer-events: none;
      visibility: hidden;
      opacity: 0;
      will-change: transform, opacity;
    }

    #${ROOT_ID} .fu-ap-plaque {
      display: inline-flex;
      align-items: center;
      box-sizing: border-box;
      max-width: min(62vw, 760px);
      min-width: var(--fu-ap-min-w, 0px);
      min-height: var(--fu-ap-min-h, 0px);
      padding: var(--fu-ap-pad-y, 15px) var(--fu-ap-pad-x, 32px)
               var(--fu-ap-pad-y, 15px) var(--fu-ap-pad-left, 60px);
      border: var(--fu-ap-outline, 3px) solid var(--camp-wood-3, #6f4526);
      border-radius: var(--fu-ap-radius, 12px);
      background: linear-gradient(180deg,
        var(--camp-parchment-1, #f6ebd3) 0%,
        var(--camp-parchment-2, #efdfc3) 100%);
      box-shadow:
        0 0 0 1px rgba(0,0,0,.4),
        0 8px 22px rgba(0,0,0,.42),
        inset 0 1px 0 rgba(255,255,255,.65);
      overflow: hidden;
      transform: scale(var(--fu-ap-scale, 1));
      transform-origin: left center;
    }

    #${ROOT_ID} .fu-ap-label {
      display: inline-flex;
      align-items: baseline;
      gap: var(--fu-ap-glyph-gap, 12px);
      min-width: 0;
      color: var(--camp-wood-3, #6f4526);
      font-family: "Signika", "Noto Sans", serif;
      font-weight: 700;
      letter-spacing: .06em;
      line-height: 1.1;
      text-shadow: 0 1px 0 rgba(255,255,255,.55);
    }

    /* The diamond is its own element purely so it can be scaled against the
       name. It is printed ONCE, here — never also inside the name (an early
       build did both and read "◈ ◈ Eisendrache Kingdom"). */
    #${ROOT_ID} .fu-ap-glyph {
      flex: 0 0 auto;
      font-size: calc(var(--fu-ap-font, 30px) * var(--fu-ap-glyph-scale, 1));
      line-height: 1;
    }
    #${ROOT_ID} .fu-ap-glyph[data-hidden="1"] { display: none; }

    #${ROOT_ID} .fu-ap-text {
      font-size: var(--fu-ap-font, 30px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.head.appendChild(style);
}

// ── DOM ───────────────────────────────────────────────────────────────────

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;

  ensureStyle();
  root = document.createElement("div");
  root.id = ROOT_ID;

  const plaque = document.createElement("div");
  plaque.className = "fu-ap-plaque";

  // One body, no spine. The glyph and the name are separate elements only so
  // the tuner can scale one against the other; the printed line is still the
  // single "◈ Area" the mockup draws.
  const label = document.createElement("span");
  label.className = "fu-ap-label";

  const glyph = document.createElement("span");
  glyph.className = "fu-ap-glyph";
  glyph.textContent = GLYPH;

  const text = document.createElement("span");
  text.className = "fu-ap-text";

  label.append(glyph, text);
  plaque.append(label);
  root.appendChild(plaque);
  document.body.appendChild(root);
  applyVars(root);
  return root;
}

/**
 * Push the live tuning into the element's CSS variables.
 *
 * The left padding carries the overhang: with the plaque hanging off the edge
 * by -POS_X_PX, plain PAD_X would leave the text crowded against the screen
 * edge (or, at a positive X offset, lopsided). Only a NEGATIVE x adds anything.
 */
function applyVars(node) {
  const root = node ?? document.getElementById(ROOT_ID);
  if (!root) return;
  const overhang = Math.max(0, -live.POS_X_PX);
  const set = (name, value) => root.style.setProperty(name, value);

  set("--fu-ap-x", `${live.POS_X_PX}px`);
  set("--fu-ap-y", `${live.POS_Y_PX}px`);
  set("--fu-ap-font", `${live.FONT_PX}px`);
  set("--fu-ap-glyph-scale", String(live.GLYPH_SCALE));
  set("--fu-ap-glyph-gap", `${live.GLYPH_GAP_PX}px`);
  set("--fu-ap-scale", String(live.PANEL_SCALE));
  set("--fu-ap-min-w", `${live.MIN_W_PX}px`);
  set("--fu-ap-min-h", `${live.MIN_H_PX}px`);
  set("--fu-ap-pad-x", `${live.PAD_X_PX}px`);
  set("--fu-ap-pad-y", `${live.PAD_Y_PX}px`);
  set("--fu-ap-pad-left", `${live.PAD_X_PX + overhang}px`);
  set("--fu-ap-outline", `${live.OUTLINE_PX}px`);
  set("--fu-ap-radius", `${live.RADIUS_PX}px`);

  // A zero scale would leave an invisible element that still measures, so the
  // diamond is removed from the flow outright — including its gap.
  const glyph = root.querySelector(".fu-ap-glyph");
  if (glyph) glyph.dataset.hidden = live.GLYPH_SCALE <= 0 ? "1" : "0";
}

/**
 * Set how far down the plaque hangs.
 *
 * Horizontally there is nothing to decide any more — it is welded to the left
 * edge of the screen. Vertically it still has to clear Foundry's own chrome:
 * #ui-top carries the scene nav (GM only, and collapsible) and module HUDs park
 * in this corner too, the Main Controller badge above all. Those are found by id
 * convention the way gacha-ui does it, since the list changes as systems are
 * added.
 */
function anchor(root) {
  const pad = live.EDGE_PAD_PX;

  const rect = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return getComputedStyle(n).visibility === "hidden" ? null : r;
  };

  let topEdge = Math.max(pad, (rect("#ui-top")?.bottom ?? 0) + pad);

  const cornerH = window.innerHeight * 0.4;
  const cornerW = window.innerWidth * 0.5;
  for (const n of document.querySelectorAll('[id^="oni-"], [id^="fu-"]')) {
    if (n.id === ROOT_ID || n.closest(`#${ROOT_ID}`)) continue;
    const r = n.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.top >= cornerH || r.left >= cornerW) continue;
    if (r.bottom + pad > topEdge && r.bottom < cornerH) topEdge = r.bottom + pad;
  }

  root.style.setProperty("--fu-ap-auto-top", `${Math.round(topEdge)}px`);
}

// ── animation ─────────────────────────────────────────────────────────────

const anim = { current: null, holdTimer: null };

function cancelAnim() {
  if (anim.holdTimer) { clearTimeout(anim.holdTimer); anim.holdTimer = null; }
  if (anim.current) { try { anim.current.cancel(); } catch (_e) { /* already done */ } anim.current = null; }
}

// It starts and ends entirely off the left edge — -100% of its OWN width, so a
// long area name leaves from just as far out as a short one.
const HIDDEN_FRAME = { opacity: 0, transform: "translateX(-100%)" };
const SHOWN_FRAME  = { opacity: 1, transform: "translateX(0)" };

/**
 * Play the full in/hold/out cycle. Restarts cleanly if one is already up.
 *
 * `name` is the bare area name — the diamond is the plaque's own element.
 * `stay` keeps it on screen instead of setting the dwell timer, which is how
 * the tuner holds it still while you drag sliders at it.
 */
function play(name, { stay = false } = {}) {
  if (!name) return false;

  const root = ensureRoot();
  cancelAnim();

  root.querySelector(".fu-ap-text").textContent = name; // never innerHTML
  applyVars(root);
  anchor(root);
  root.style.visibility = "visible";

  const a = root.animate([HIDDEN_FRAME, SHOWN_FRAME], {
    duration: live.IN_MS,
    easing: live.EASE_IN,
    fill: "forwards",
  });
  anim.current = a;

  a.finished.then(() => {
    if (anim.current !== a || stay) return; // superseded, or held by the tuner
    anim.holdTimer = setTimeout(() => hide(true), live.HOLD_MS);
  }).catch(() => { /* cancelled — a newer panel took over */ });

  log("play", name, stay ? "(held)" : "");
  return true;
}

/** Retire the panel: animated by default, instant when `animated` is false. */
function hide(animated = true) {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  cancelAnim();

  if (!animated) {
    root.style.visibility = "hidden";
    root.style.opacity = "0";
    return;
  }

  const a = root.animate([SHOWN_FRAME, HIDDEN_FRAME], {
    duration: live.OUT_MS,
    easing: live.EASE_OUT,
    fill: "forwards",
  });
  anim.current = a;
  a.finished.then(() => {
    if (anim.current !== a) return;
    root.style.visibility = "hidden";
    anim.current = null;
  }).catch(() => { /* cancelled */ });
}

// ── arming / trigger ──────────────────────────────────────────────────────

// pending = { token, sceneId, label } — one activation in flight at a time.
let pending = null;
let armSeq = 0;
let sawTearDown = false;
const timers = [];

function disarm() {
  pending = null;
  sawTearDown = false;
  while (timers.length) clearTimeout(timers.pop());
}

/**
 * A scene was activated. Decide whether this client announces it, then wait
 * for the right moment to play.
 */
function arm(scene) {
  const verdict = shouldShowForScene(scene, { lastAreaName: getLastArea() });
  if (!verdict.show) {
    log("gate declined", verdict.reason, scene?.name);
    return;
  }

  // Remember it up front, so a second map of the same area stays silent even
  // if this client never got to draw the first one.
  setLastArea(verdict.name);

  disarm();
  pending = { token: ++armSeq, sceneId: scene.id, label: verdict.display };
  timers.push(setTimeout(() => maybePlay("settle"), TUNING.SETTLE_MS));
  timers.push(setTimeout(() => maybePlay("watchdog"), TUNING.WATCHDOG_MS));
  log("armed", verdict.display, scene?.name);
}

function maybePlay(source) {
  if (!pending) return;

  // Not (yet) looking at the scene that was activated. On the watchdog that is
  // terminal — the client is somewhere else and the beat has passed.
  if (canvas?.scene?.id !== pending.sceneId || !canvas?.ready) {
    if (source === "watchdog") { log("watchdog: canvas never arrived", pending.sceneId); disarm(); }
    return;
  }

  // A redraw is in flight — the curtain is down. Wait for the reveal.
  if (source === "settle" && sawTearDown) return;

  const { label, sceneId } = pending;
  disarm();

  if (source === "reveal") setTimeout(() => playOrDefer(sceneId, label), TUNING.DELAY_AFTER_REVEAL_MS);
  else playOrDefer(sceneId, label);
}

// ── deferral for a backgrounded client ────────────────────────────────────
// A hidden tab throttles its timers and paints nothing, so playing into one
// spends the beat on a screen nobody is looking at — and because the area is
// already remembered, it would never be announced again. Hold it instead and
// play when they come back. Caught live: a player client whose window was
// behind the GM's silently swallowed the panel.
let deferred = null; // { sceneId, label, at }

function playOrDefer(sceneId, label) {
  if (!document.hidden) return play(label);
  deferred = { sceneId, label, at: Date.now() };
  log("tab hidden — holding", label);
  return false;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !deferred) return;
  const held = deferred;
  deferred = null;

  // Stale, or the party has moved on to a scene this panel does not describe.
  if (Date.now() - held.at > TUNING.DEFER_MAX_MS) { log("held panel expired", held.label); return; }
  if (canvas?.scene?.id !== held.sceneId) { log("held panel no longer current", held.label); return; }

  setTimeout(() => play(held.label), TUNING.DEFER_SETTLE_MS);
});

Hooks.on("updateScene", (scene, changes) => {
  if (changes?.active !== true) return; // activation only, never a scene switch
  try { arm(scene); } catch (e) { console.warn(TAG, "arm failed", e); }
});

Hooks.on("canvasTearDown", () => {
  if (pending) sawTearDown = true;
  hide(false); // never leave a plaque hanging over a scene it does not belong to
});

Hooks.on("oni:screenRevealed", () => {
  try { maybePlay("reveal"); } catch (e) { console.warn(TAG, "reveal play failed", e); }
});

// The tuned values live in a WORLD setting, so a tuning session reaches every
// client at once and survives a reload. `config: false` keeps it out of the
// settings menu — the tuner window owns it. The shipped defaults stay in
// TUNING; this only ever holds the deltas.
Hooks.once("init", () => {
  try {
    game.settings.register(MODULE_ID, TUNING_SETTING, {
      name: "Area Name Panel — tuning overrides",
      scope: "world",
      config: false,
      type: Object,
      default: {},
      onChange: () => { try { refreshTuning(); } catch (e) { console.warn(TAG, "tuning refresh failed", e); } },
    });
  } catch (e) { console.warn(TAG, "tuning setting registration failed", e); }
});

Hooks.once("ready", () => {
  ensureStyle();
  refreshTuning();
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.areaPanel = {
    /** Play a panel right now with an arbitrary label — the tuning loop. */
    preview(name = "Area Name", opts = {}) { return play(cleanName(name), opts); },
    /** Play the panel a given scene would produce, ignoring repeat suppression. */
    previewScene(scene = canvas?.scene) {
      const cfg = readAreaConfig(scene);
      return cfg.name ? play(cleanName(cfg.name)) : false;
    },
    hide: () => hide(true),
    readConfig: (scene = canvas?.scene) => readAreaConfig(scene),
    check: (scene = canvas?.scene) => shouldShowForScene(scene, { lastAreaName: getLastArea() }),
    lastArea: () => getLastArea(),
    resetLastArea: () => { setLastArea(null); return true; },
    state: () => ({
      pending: pending ? { ...pending } : null,
      deferred: deferred ? { ...deferred } : null,
      sawTearDown,
      hidden: document.hidden,
      lastArea: getLastArea(),
    }),
    TUNING,
    MODULE_ID,

    // ── tuning ────────────────────────────────────────────────────────────
    tuning: () => liveTuning(),
    /** Paint overrides without saving — what every slider drag calls. */
    applyPreview: (overrides) => applyTuningPreview(overrides),
    /** Re-read the saved setting and repaint (also runs on every client via onChange). */
    refresh: () => refreshTuning(),
    /**
     * Persist. GM only: it writes a world setting.
     *
     * Only the keys that actually DIFFER from the shipped defaults are stored.
     * Saving a value that merely equals today's default would pin the world to
     * it — a later change to that default in code would then silently not
     * reach this world, for a knob nobody meant to override.
     */
    async save(overrides) {
      if (!game.user?.isGM) { ui.notifications?.warn?.("Only a GM can save panel tuning."); return false; }
      await game.settings.set(MODULE_ID, TUNING_SETTING, diffFromDefaults(overrides));
      return true;
    },
    async reset() {
      if (!game.user?.isGM) { ui.notifications?.warn?.("Only a GM can reset panel tuning."); return false; }
      await game.settings.set(MODULE_ID, TUNING_SETTING, {});
      return true;
    },
    saved: () => {
      try { return foundry.utils.duplicate(game.settings.get(MODULE_ID, TUNING_SETTING) ?? {}); }
      catch (_e) { return {}; }
    },
    /** Open the tuning window (GM only). Defined by area-panel-tuner.js. */
    tuner: (...args) => globalThis.FUCompanion?.api?.areaPanelTuner?.open?.(...args),
  };
  log("ready");
});
