// ============================================================================
// Clock System — the bundled UI.
//
// This file is a CONSUMER of the clock API, not part of it. It subscribes to
// `fu-clock-*` hooks and reads the store; nothing in the engine imports it, and
// disabling it (Settings → "Show the clock bar") costs the engine nothing. A
// downstream system that wants its own clock rendering turns this off and
// listens to the same four hooks.
//
// ── Anatomy ─────────────────────────────────────────────────────────────────
//   [ Ambushed! ]                 ← floating name tab, overhangs the panel
//   ┌───────────────────────┐  ⚙  ← brass gear, right of the panel
//   │ ████████░░░░░░░  50%  │
//   └───────────────────────┘
//
// One continuous fill bar, not discrete notches: the player reads "how close",
// and a percentage is unambiguous where counting notches at a glance is not.
// The section count still governs everything underneath — the bar is a view of
// `value / sections`, rounded UP so any progress at all shows.
//
// ── Choreography ────────────────────────────────────────────────────────────
// Spawn is three beats: the gear fades in, the panel slides in from the right,
// then the bar fills to its starting value. Exit is one beat: everything slides
// and fades together. A resolved clock glows, holds five seconds, then exits.
// When a clock leaves, the ones below FLIP upward to close the gap — the stack
// always reforms toward the top.
// ============================================================================

import {
  CLOCK_MODULE_ID, CLOCK_TAG, CLOCK_HOOK, CLOCK_STATE, VISIBILITY,
} from "./clock-const.js";
import * as store from "./clock-store.js";
import { clockTone, clockPercent } from "./clock-model.js";
import { injectClockStyles, applyClockTune, playClockSfx, CLOCK_TUNE } from "./clock-ui-styles.js";
import { playResolution, wireResolutionChat } from "./clock-ui-resolve.js";
import { bindPanelClicks, clickHint } from "./clock-interaction.js";

// Imported for its side effect (it installs the floating GM button on `ready`).
//
// NOT listed in module.json's `esmodules`, deliberately. Foundry's SERVER reads
// that list when the world launches and hands the client a fixed set of module
// scripts; a browser reload re-runs the same set. So a newly-added entry never
// boots until the world is relaunched — which is exactly why this button kept
// vanishing. Reaching it through an import from a file that IS in the manifest
// makes it load on every boot, with no relaunch and no manifest edit.
import "./clock-gm-button.js";

const LAYER_ID = "oni-clock-layer";
const SETTING_SHOW_BAR = "clockShowBar";

/** id → { root, panel, gear, fill, pct, name, shown, exiting } */
const _els = new Map();
let _layer = null;
let _wired = false;

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * on screen — that is the finality beat playing out. A client that reloads after
 * a clock resolved should not be greeted by a stale victory glow.
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

/** Sparks thrown off the clash band. Scattered by per-spark delay + vector. */
const SPARKS = [
  { dx: -14, dy: -13, dur: 720, delay: 0 },
  { dx: 12, dy: -16, dur: 640, delay: 130 },
  { dx: -9, dy: 12, dur: 800, delay: 260 },
  { dx: 15, dy: 10, dur: 700, delay: 390 },
  { dx: -16, dy: -3, dur: 760, delay: 520 },
  { dx: 10, dy: 3, dur: 680, delay: 640 },
];

function _buildElement(clock) {
  const tone = clockTone(clock);

  const root = document.createElement("div");
  root.className = "oni-clock spawning";
  root.dataset.clockId = clock.id;
  root.dataset.tone = tone;

  const panel = document.createElement("div");
  panel.className = "oni-clock-panel";
  panel.title = clickHint(clock);

  const shine = document.createElement("div");
  shine.className = "oni-clock-shine";
  panel.appendChild(shine);

  const name = document.createElement("div");
  name.className = "oni-clock-name";
  name.textContent = clock.name;
  panel.appendChild(name);

  const bar = document.createElement("div");
  bar.className = "oni-clock-bar";
  const fill = document.createElement("div");
  fill.className = "oni-clock-fill";
  const pct = document.createElement("div");
  pct.className = "oni-clock-pct";
  bar.append(fill, pct);

  // A contest clock gets the clash band + its sparks. Other tones never do:
  // there is nothing for the beam to push against.
  if (tone === "contest") {
    const clash = document.createElement("div");
    clash.className = "oni-clock-clash";
    bar.appendChild(clash);
    for (const s of SPARKS) {
      const spark = document.createElement("div");
      spark.className = "oni-clock-spark";
      spark.style.setProperty("--sp-dx", `${s.dx}px`);
      spark.style.setProperty("--sp-dy", `${s.dy}px`);
      spark.style.setProperty("--sp-dur", `${s.dur}ms`);
      spark.style.setProperty("--sp-delay", `${s.delay}ms`);
      bar.appendChild(spark);
    }
  }
  panel.appendChild(bar);

  const gear = document.createElement("div");
  gear.className = "oni-clock-gear";
  gear.innerHTML = `<i class="fas fa-gear"></i>`;

  root.append(panel, gear);
  _ensureLayer().appendChild(root);

  bindPanelClicks(panel, clock.id);

  // Start empty, whatever the real value: beat 3 fills it.
  const entry = { root, panel, gear, fill, pct, name, shown: 0, exiting: false };
  _paint(entry, clock, 0);
  return entry;
}

function _paint(entry, clock, value) {
  const pct = clockPercent(clock, value);
  entry.fill.style.width = `${pct}%`;
  entry.pct.textContent = `${pct}%`;
  // The clash band and its sparks ride this, so they track the meeting point.
  entry.root.style.setProperty("--ck-v", `${pct}%`);

  // Two sections or fewer from a pole: the panel pulses in the colour of
  // whichever side is about to win. Only meaningful where both can win.
  const contest = entry.root.dataset.tone === "contest";
  const nearHigh = contest && value >= clock.sections - 2;
  const nearLow = contest && value <= 2;
  entry.root.classList.toggle("near-high", nearHigh && !nearLow);
  entry.root.classList.toggle("near-low", nearLow && !nearHigh);
}

// ── Choreography ────────────────────────────────────────────────────────────

/** Beat 1: gear fades in. Beat 2: panel slides in. Beat 3: bar fills. */
async function _spawnIn(entry, clock) {
  const { root } = entry;
  await _sleep(20);                       // let the initial styles settle
  root.classList.add("gear-in");
  playClockSfx("CREATE");

  await _sleep(CLOCK_TUNE.gearInMs);
  if (!root.isConnected) return;
  root.classList.add("panel-in");

  await _sleep(CLOCK_TUNE.panelInMs);
  if (!root.isConnected) return;

  entry.shown = clock.value;
  _paint(entry, clock, clock.value);      // still `.spawning`: the slow fill

  await _sleep(CLOCK_TUNE.barFillMs);
  root.classList.remove("spawning");
}

/**
 * Move the bar to the clock's current value. One sound per change, not per
 * section — the bar is continuous now, so a three-section swing is one motion.
 */
function _advanceTo(entry, clock) {
  if (entry.shown === clock.value) return;
  const rising = clock.value > entry.shown;
  entry.shown = clock.value;
  _paint(entry, clock, clock.value);
  playClockSfx(rising ? "ADVANCE" : "REGRESS");
}

// ── Reflow (FLIP) ───────────────────────────────────────────────────────────
//
// The stack always reforms toward the top. When a clock is removed, the ones
// below it would jump up instantly; instead we record every element's position
// BEFORE the layout changes, then translate each back to where it was and let
// CSS transition it to zero. Elements on their way out are skipped — they are
// mid-exit and must not be dragged upward.

function _captureRects() {
  const rects = new Map();
  for (const [id, entry] of _els) {
    if (entry.exiting) continue;
    rects.set(id, entry.root.getBoundingClientRect().top);
  }
  return rects;
}

function _playReflow(before) {
  for (const [id, top] of before) {
    const entry = _els.get(id);
    if (!entry?.root.isConnected || entry.exiting) continue;

    const delta = top - entry.root.getBoundingClientRect().top;
    if (!delta) continue;

    entry.root.style.transition = "none";
    entry.root.style.transform = `translateY(${delta}px)`;
    void entry.root.offsetWidth;                  // force the start frame
    entry.root.style.transition = "";
    entry.root.style.transform = "";
  }
}

// ── Removal ─────────────────────────────────────────────────────────────────

function _remove(id, { immediate = false } = {}) {
  const entry = _els.get(id);
  if (!entry || entry.exiting) return;

  if (immediate) {
    _els.delete(id);
    const before = _captureRects();
    entry.root.remove();
    _playReflow(before);
    return;
  }

  entry.exiting = true;
  entry.root.classList.add("leaving");

  setTimeout(() => {
    _els.delete(id);
    const before = _captureRects();       // positions of the SURVIVORS
    entry.root.remove();
    _playReflow(before);
  }, CLOCK_TUNE.outMs);
}

// ── Sync ────────────────────────────────────────────────────────────────────

/** Reconcile the whole layer against the registry. Cheap; called on any change. */
export function syncClockBar() {
  if (!_barEnabled()) {
    for (const id of [..._els.keys()]) _remove(id, { immediate: true });
    return;
  }
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
      _spawnIn(entry, clock).catch((e) => console.warn(CLOCK_TAG, "spawn-in threw", e));
      continue;                            // beat 3 paints the starting value
    }
    if (entry.exiting) continue;

    entry.name.textContent = clock.name;
    entry.root.dataset.tone = clockTone(clock);
    if (!entry.root.classList.contains("spawning")) _advanceTo(entry, clock);
  }
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
    syncClockBar();                        // let the final fill land
    const entry = _els.get(clock.id);
    if (!entry) return;

    playResolution(entry, clock, resolution);
    await _sleep(CLOCK_TUNE.holdMs);       // glow, then hold
    _remove(clock.id);
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
