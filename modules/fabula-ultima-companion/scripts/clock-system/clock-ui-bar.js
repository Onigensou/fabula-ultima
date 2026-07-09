// ============================================================================
// Clock System — the bundled UI.
//
// This file is a CONSUMER of the clock API, not part of it. It subscribes to
// `fu-clock-*` hooks and reads the store; nothing in the engine imports it, and
// disabling it (Settings → "Show the clock bar") costs the engine nothing. A
// downstream system that wants its own clock rendering turns this off and
// listens to the same four hooks.
//
// ── The colour rule ─────────────────────────────────────────────────────────
// Straight from the axis model, one rule for every shape:
//
//     notch i <  value  →  the HIGH pole's owner colour
//     notch i >= value  →  the LOW  pole's owner colour
//     (an unclaimed pole renders as neutral track)
//
//   progress  players fill left→right, remainder empty
//   threat    the GM's crimson creeps rightward
//   teardown  a solid neutral obstacle, eaten from the right by the players
//   struggle  a two-colour tug-of-war meeting wherever `value` sits
//
// ── Animation ───────────────────────────────────────────────────────────────
// Sections land ONE AT A TIME with a tick, because "two sections" is the unit
// the rules speak in and the player should feel both. The renderer keeps its
// own `shown` value and walks it toward the clock's real value, so a change
// arriving mid-animation retargets rather than stacking.
// ============================================================================

import {
  CLOCK_MODULE_ID, CLOCK_TAG, CLOCK_HOOK, CLOCK_STATE, VISIBILITY,
} from "./clock-const.js";
import * as store from "./clock-store.js";
import { notchOwnerAt } from "./clock-model.js";
import { injectClockStyles, applyClockTune, playClockSfx, CLOCK_TUNE } from "./clock-ui-styles.js";
import { playResolution, wireResolutionChat, RESOLVE_HOLD_MS } from "./clock-ui-resolve.js";

const LAYER_ID = "oni-clock-layer";
const SETTING_SHOW_BAR = "clockShowBar";

/** id → { root, notches, poles, count, shown, stepping } */
const _els = new Map();
let _layer = null;
let _wired = false;

// ── Visibility ──────────────────────────────────────────────────────────────

function _barEnabled() {
  try { return game.settings.get(CLOCK_MODULE_ID, SETTING_SHOW_BAR); }
  catch { return true; }
}

/** A GM-only clock is hidden from players' bars. (Not a security boundary — see clock-socket.js.) */
function _visibleToMe(clock) {
  return clock.visibility !== VISIBILITY.GM || game.user.isGM;
}

/**
 * Render a clock at all?
 *
 * Active clocks always. A RESOLVED clock only while we already have its element
 * on screen — that is the flourish playing out. A client that reloads after a
 * clock resolved should not be greeted by a stale victory banner.
 */
function _shouldRender(clock) {
  if (!_visibleToMe(clock)) return false;
  if (clock.state === CLOCK_STATE.ACTIVE) return true;
  return clock.state === CLOCK_STATE.RESOLVED && _els.has(clock.id);
}

// ── DOM ─────────────────────────────────────────────────────────────────────

function _ensureLayer() {
  if (_layer?.isConnected) return _layer;
  injectClockStyles();
  _layer = document.getElementById(LAYER_ID) ?? document.createElement("div");
  _layer.id = LAYER_ID;
  applyClockTune(_layer, CLOCK_TUNE);
  if (!_layer.isConnected) document.body.appendChild(_layer);
  return _layer;
}

function _buildElement(clock) {
  const root = document.createElement("div");
  root.className = "oni-clock";
  root.dataset.clockId = clock.id;

  const head = document.createElement("div");
  head.className = "oni-clock-head";

  if (clock.icon) {
    const icon = document.createElement("div");
    icon.className = "oni-clock-icon";
    // background-image, never <img> — the global stylesheet borders every image.
    icon.style.backgroundImage = `url("${clock.icon}")`;
    head.appendChild(icon);
  }

  const name = document.createElement("div");
  name.className = "oni-clock-name";
  name.textContent = clock.name;
  head.appendChild(name);

  if (clock.visibility === VISIBILITY.GM) {
    const gm = document.createElement("div");
    gm.className = "oni-clock-gmonly";
    gm.textContent = "GM";
    head.appendChild(gm);
  }

  const count = document.createElement("div");
  count.className = "oni-clock-count";
  head.appendChild(count);
  root.appendChild(head);

  const track = document.createElement("div");
  track.className = "oni-clock-track";
  const notches = [];
  for (let i = 0; i < clock.sections; i++) {
    const n = document.createElement("div");
    n.className = "oni-clock-notch";
    track.appendChild(n);
    notches.push(n);
  }
  root.appendChild(track);

  const poles = document.createElement("div");
  poles.className = "oni-clock-poles";
  const low = document.createElement("div");
  low.className = "oni-clock-pole-low";
  const high = document.createElement("div");
  high.className = "oni-clock-pole-high";
  poles.append(low, high);
  root.appendChild(poles);

  const flash = document.createElement("div");
  flash.className = "oni-clock-flash";
  root.appendChild(flash);

  const entry = { root, notches, count, low, high, flash, shown: clock.value, stepping: false };
  _paintPoles(entry, clock);
  _paint(entry, clock, clock.value);

  _ensureLayer().appendChild(root);
  requestAnimationFrame(() => root.classList.add("visible"));
  return entry;
}

function _paintPoles(entry, clock) {
  const { low, high } = entry;
  low.textContent = clock.poles.low?.label ?? "";
  high.textContent = clock.poles.high?.label ?? "";
  low.className = `oni-clock-pole-low ${clock.poles.low?.side ?? ""}`;
  high.className = `oni-clock-pole-high ${clock.poles.high?.side ?? ""}`;
}

function _paint(entry, clock, value) {
  entry.notches.forEach((n, i) => {
    n.className = `oni-clock-notch ${notchOwnerAt(clock, i, value)}`;
  });
  entry.count.textContent = `${value} / ${clock.sections}`;
}

/** Flash the one section that just flipped. */
function _pop(entry, index) {
  const n = entry.notches[index];
  if (!n) return;
  n.classList.add("pop");
  setTimeout(() => n.classList.remove("pop"), 200);
}

// ── Animation ───────────────────────────────────────────────────────────────

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Walk `entry.shown` toward the clock's real value, one section per tick. Only
 * one stepper runs per clock; a change that arrives mid-walk simply moves the
 * target, so rapid advances never queue up or double-animate.
 */
async function _step(entry, clock) {
  if (entry.stepping) return;
  entry.stepping = true;
  try {
    while (entry.shown !== clock.value) {
      const dir = clock.value > entry.shown ? 1 : -1;
      const next = entry.shown + dir;

      // Growing → the notch we just claimed is at index `shown`.
      // Shrinking → the notch we just gave up is at index `next`.
      const touched = dir > 0 ? entry.shown : next;

      entry.shown = next;
      _paint(entry, clock, next);
      _pop(entry, touched);
      playClockSfx(dir > 0 ? "TICK_FILL" : "TICK_ERASE");

      if (entry.shown !== clock.value) await _sleep(CLOCK_TUNE.tickStaggerMs);
    }
  } finally {
    entry.stepping = false;
  }
}

// ── Sync ────────────────────────────────────────────────────────────────────

function _remove(id, { immediate = false } = {}) {
  const entry = _els.get(id);
  if (!entry) return;
  _els.delete(id);
  if (immediate) { entry.root.remove(); _reflow(); return; }
  entry.root.classList.add("leaving");
  setTimeout(() => { entry.root.remove(); _reflow(); }, 240);
}

function _reflow() {
  if (!_layer) return;
  _layer.classList.toggle("compact", _els.size > CLOCK_TUNE.compactAt);
}

/** Reconcile the whole layer against the registry. Cheap; called on any change. */
export function syncClockBar() {
  if (!_barEnabled()) { _els.forEach((_, id) => _remove(id, { immediate: true })); return; }
  _ensureLayer();

  const live = new Map();
  for (const clock of store.list()) {
    if (_shouldRender(clock)) live.set(clock.id, clock);
  }

  for (const id of [..._els.keys()]) if (!live.has(id)) _remove(id);

  for (const [id, clock] of live) {
    let entry = _els.get(id);
    if (!entry) {
      entry = _buildElement(clock);
      _els.set(id, entry);
    } else if (entry.notches.length !== clock.sections) {
      // Section count changed — cheaper and safer to rebuild than to splice.
      _remove(id, { immediate: true });
      entry = _buildElement(clock);
      _els.set(id, entry);
    } else {
      _paintPoles(entry, clock);
    }
    _step(entry, clock).catch((e) => console.warn(CLOCK_TAG, "bar animation threw", e));
  }

  _reflow();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export function registerClockBarSetting() {
  try {
    game.settings.register(CLOCK_MODULE_ID, SETTING_SHOW_BAR, {
      name: "Show the clock bar",
      hint: "Display the bundled on-screen clock gauge. Turn this off to render clocks yourself via the fu-clock-* hooks.",
      scope: "client", config: true, default: true, type: Boolean,
      onChange: () => syncClockBar(),
    });
  } catch { /* already registered */ }
}

export function wireClockBar() {
  if (_wired) return;
  _wired = true;

  Hooks.on(CLOCK_HOOK.CREATED, () => syncClockBar());
  Hooks.on(CLOCK_HOOK.CHANGED, () => syncClockBar());
  Hooks.on(CLOCK_HOOK.DISCARDED, ({ clock }) => _remove(clock.id));

  Hooks.on(CLOCK_HOOK.RESOLVED, async ({ clock, resolution }) => {
    // Let the final section land before the flourish fires.
    syncClockBar();
    const entry = _els.get(clock.id);
    if (!entry) return;
    while (entry.stepping) await _sleep(40);
    playResolution(entry, clock, resolution);
    setTimeout(() => _remove(clock.id), RESOLVE_HOLD_MS);
  });

  // The chat card is not the bar: it stays wired even for a GM who turned the
  // on-screen gauge off. (It self-gates to the active GM.)
  wireResolutionChat();

  syncClockBar();
  console.debug(CLOCK_TAG, "bar wired");
}

Hooks.once("init", () => registerClockBarSetting());
Hooks.once("ready", () => {
  try { wireClockBar(); }
  catch (e) { console.warn(CLOCK_TAG, "bar bootstrap failed", e); }
});
