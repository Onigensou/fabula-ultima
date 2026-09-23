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
  MODULE_ID, TUNING,
  readAreaConfig, shouldShowForScene, formatLabel,
} from "./area-panel-core.js";

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
    /* Anchored to the LEFT EDGE of the screen, not floated near it: the plaque
       hangs off-frame by OVERSHOOT_PX so only its right corners are ever seen
       and it reads as sliding out of the screen edge. Vertically it still
       clears Foundry's own chrome. */
    #${ROOT_ID} {
      position: fixed;
      top: var(--fu-ap-top, 14px);
      left: ${-TUNING.OVERSHOOT_PX}px;
      z-index: ${TUNING.Z_INDEX};
      pointer-events: none;
      visibility: hidden;
      opacity: 0;
      will-change: transform, opacity;
    }

    #${ROOT_ID} .fu-ap-plaque {
      display: inline-flex;
      align-items: center;
      max-width: min(62vw, 760px);
      padding: ${TUNING.PAD_Y_PX}px ${TUNING.PAD_X_PX}px ${TUNING.PAD_Y_PX}px ${TUNING.PAD_X_PX + TUNING.OVERSHOOT_PX}px;
      border: 3px solid var(--camp-wood-3, #6f4526);
      border-radius: ${TUNING.RADIUS_PX}px;
      background: linear-gradient(180deg,
        var(--camp-parchment-1, #f6ebd3) 0%,
        var(--camp-parchment-2, #efdfc3) 100%);
      box-shadow:
        0 0 0 1px rgba(0,0,0,.4),
        0 8px 22px rgba(0,0,0,.42),
        inset 0 1px 0 rgba(255,255,255,.65);
      overflow: hidden;
    }

    #${ROOT_ID} .fu-ap-label {
      color: var(--camp-wood-3, #6f4526);
      font-family: "Signika", "Noto Sans", serif;
      font-size: ${TUNING.FONT_PX}px;
      font-weight: 700;
      letter-spacing: .06em;
      line-height: 1.1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 0 1px 0 rgba(255,255,255,.55);
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

  // One body, no spine: the glyph is part of the printed line ("◈ Area"), which
  // is what the mockup draws and what the spec asked for in the first place.
  const label = document.createElement("span");
  label.className = "fu-ap-label";

  plaque.append(label);
  root.appendChild(plaque);
  document.body.appendChild(root);
  return root;
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
  const pad = TUNING.EDGE_PAD_PX;

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

  root.style.setProperty("--fu-ap-top", `${Math.round(topEdge)}px`);
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

/** Play the full in/hold/out cycle. Restarts cleanly if one is already up. */
function play(label) {
  if (!label) return false;

  const root = ensureRoot();
  cancelAnim();

  root.querySelector(".fu-ap-label").textContent = label; // never innerHTML
  anchor(root);
  root.style.visibility = "visible";

  const a = root.animate([HIDDEN_FRAME, SHOWN_FRAME], {
    duration: TUNING.IN_MS,
    easing: TUNING.EASE_IN,
    fill: "forwards",
  });
  anim.current = a;

  a.finished.then(() => {
    if (anim.current !== a) return; // superseded by a newer activation
    anim.holdTimer = setTimeout(() => hide(true), TUNING.HOLD_MS);
  }).catch(() => { /* cancelled — a newer panel took over */ });

  log("play", label);
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
    duration: TUNING.OUT_MS,
    easing: TUNING.EASE_OUT,
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
  pending = { token: ++armSeq, sceneId: scene.id, label: verdict.label };
  timers.push(setTimeout(() => maybePlay("settle"), TUNING.SETTLE_MS));
  timers.push(setTimeout(() => maybePlay("watchdog"), TUNING.WATCHDOG_MS));
  log("armed", verdict.label, scene?.name);
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

Hooks.once("ready", () => {
  ensureStyle();
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.areaPanel = {
    /** Play a panel right now with an arbitrary label — the tuning loop. */
    preview(name = "Area Name") { return play(formatLabel(name)); },
    /** Play the panel a given scene would produce, ignoring repeat suppression. */
    previewScene(scene = canvas?.scene) {
      const cfg = readAreaConfig(scene);
      return cfg.name ? play(formatLabel(cfg.name)) : false;
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
  };
  log("ready");
});
