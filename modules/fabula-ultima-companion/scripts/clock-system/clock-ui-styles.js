// ============================================================================
// Clock System — bundled UI styles (injected once) + live-tunable layout.
//
// Warm parchment plate, matched to the camp/shop/heal UIs so a clock reads as
// part of the same game. A floating name tab overhangs the panel's top-left; a
// continuous fill bar reads as a percentage; a brass gear sits at the right.
//
// ── Docking ─────────────────────────────────────────────────────────────────
// The layer hangs off `--fu-sidebar-anchor-right`, published every animation
// frame by scripts/custom-ui/sidebar-anchor.js from a ResizeObserver on
// #sidebar. So the stack tracks the chat sidebar live as it expands/collapses,
// rather than snapping after the fact (Foundry's `collapseSidebar` hook fires
// only once the width animation has already finished).
//
// ── Tone ────────────────────────────────────────────────────────────────────
// The glow says what KIND of clock this is, derived from the poles:
//   one pole, outcome=failure  → threat    (red)
//   one pole, outcome=success  → progress  (blue)
//   both poles claimed         → contest   (blue→red gradient, a tug-of-war)
//
// NOTE: the global stylesheet puts a 1px black border on every <img>. Nothing
// here uses <img>. See [[feedback_dom_img_transparent_border]].
// ============================================================================

const STYLE_ID = "oni-clock-styles";

// Mutated by the tuner and re-applied as CSS custom properties, so layout can
// be dialled in live. Edit these defaults to bake a final design.
export const CLOCK_TUNE = {
  layerTop: 12,        // px from viewport top
  layerGap: 10,        // px between stacked clocks
  panelWidth: 250,     // px — the parchment plate
  panelHeight: 42,     // px
  barHeight: 15,       // px — the continuous fill bar
  nameSize: 15,        // px — floating name tab
  pctSize: 12,         // px
  gearSize: 30,        // px

  // Animation (ms). Spawn is a three-beat sequence; exit is one beat.
  gearInMs: 220,       // 1. gear fades in
  panelInMs: 280,      // 2. panel slides in from the right + fades
  barFillMs: 620,      // 3. bar fills to its starting value
  advanceMs: 480,      // a live advance/regress
  holdMs: 5000,        // resolved clock glows, then holds, before exiting
  outMs: 300,          // slide + fade out, everything at once
  reflowMs: 320,       // remaining clocks slide up to close the gap
};

export function clockTuneVars(t = CLOCK_TUNE) {
  return {
    "--ck-top": `${t.layerTop}px`,
    "--ck-gap": `${t.layerGap}px`,
    "--ck-panel-w": `${t.panelWidth}px`,
    "--ck-panel-h": `${t.panelHeight}px`,
    "--ck-bar-h": `${t.barHeight}px`,
    "--ck-name-size": `${t.nameSize}px`,
    "--ck-pct-size": `${t.pctSize}px`,
    "--ck-gear-size": `${t.gearSize}px`,
    "--ck-gear-in": `${t.gearInMs}ms`,
    "--ck-panel-in": `${t.panelInMs}ms`,
    "--ck-bar-fill": `${t.barFillMs}ms`,
    "--ck-advance": `${t.advanceMs}ms`,
    "--ck-out": `${t.outMs}ms`,
    "--ck-reflow": `${t.reflowMs}ms`,
  };
}

/** Apply the current tune to a root element as inline custom properties. */
export function applyClockTune(root, t = CLOCK_TUNE) {
  if (!root) return;
  for (const [k, v] of Object.entries(clockTuneVars(t))) root.style.setProperty(k, v);
}

export function injectClockStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#oni-clock-layer {
  /* Parchment palette — shared with the camp / shop / healing UIs. */
  --ck-parch-1: #f7eed7;
  --ck-parch-2: #ece0c2;
  --ck-wood-1: #8d5f38;
  --ck-wood-2: #6f4526;
  --ck-wood-3: #4e2f19;
  --ck-ink: #4a2f18;
  --ck-gold: #f4e2a8;
  --ck-gear-ink: #1d1109;   /* dark brown, nearly black */

  --ck-blue: #3f9fd6;
  --ck-blue-hi: #9fe0ff;
  --ck-red: #cf4034;
  --ck-red-hi: #ff9a8f;
  --ck-clash: #f2cf7a;      /* warm amber where the beams meet — not white */
  --ck-spark: #f7dda0;

  position: fixed;
  top: var(--ck-top, 12px);
  /* Live sidebar anchor — tracks the chat panel frame-by-frame. */
  right: var(--fu-sidebar-anchor-right, 313px);
  z-index: 70;
  display: flex; flex-direction: column; align-items: flex-end;
  gap: var(--ck-gap, 10px);
  pointer-events: none;
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
}

/* ── One clock: [ panel ][ gear ] ──────────────────────────────────────── */
.oni-clock {
  pointer-events: auto;
  display: flex; align-items: center; gap: 7px;
  /* FLIP: the reflow sets a transform, then transitions it back to zero. */
  transition: transform var(--ck-reflow, 320ms) cubic-bezier(.22,.8,.3,1);
}

/* Near-black brown fill with a gold outline, so the gear reads against both the
 * bright parchment and a dark scene. An icon font is a glyph, not a shape, so
 * the outline is a stack of 1px drop-shadows rather than a stroke. */
.oni-clock-gear {
  order: 2;
  width: var(--ck-gear-size, 30px); height: var(--ck-gear-size, 30px);
  flex: 0 0 auto;
  display: grid; place-items: center;
  color: var(--ck-gear-ink);
  font-size: calc(var(--ck-gear-size, 30px) * 0.82);
  filter:
    drop-shadow( 1px  0   0 var(--ck-gold)) drop-shadow(-1px  0   0 var(--ck-gold))
    drop-shadow( 0    1px 0 var(--ck-gold)) drop-shadow( 0   -1px 0 var(--ck-gold))
    drop-shadow( 0    2px 2px rgba(0,0,0,.5));
  opacity: 0;
}

.oni-clock-panel {
  order: 1;
  position: relative;
  width: var(--ck-panel-w, 250px);
  min-height: var(--ck-panel-h, 42px);
  box-sizing: border-box;
  display: flex; align-items: flex-end;
  padding: 15px 10px 7px;
  background: linear-gradient(180deg, var(--ck-parch-1), var(--ck-parch-2));
  border: 2px solid var(--ck-wood-2);
  border-radius: 7px;
  box-shadow: 0 0 0 1px var(--ck-wood-3), 0 6px 18px rgba(0,0,0,.45),
              inset 0 0 18px rgba(160,118,73,.20);
  opacity: 0;
  transform: translateX(34px);
}

/* Floating name tab, overhanging the panel's top-left corner.
 *
 * The outline is built from text-shadow, NOT -webkit-text-stroke +
 * paint-order: stroke fill. Chromium only honours paint-order on HTML text
 * from v128; before that it PARSES the property (so CSS.supports() answers
 * "yes") but paints the stroke over the fill, which turns light-stroked dark
 * text into an illegible blob. The Foundry desktop app is Electron 29 /
 * Chromium 122, so it hit that path while a modern browser client did not —
 * same stylesheet, two different renderings. text-shadow always paints behind
 * the glyph, on every engine. Check Roller's card has the same bug for the
 * same reason. */
.oni-clock-name {
  position: absolute;
  top: -9px; left: 8px;
  font-size: var(--ck-name-size, 15px);
  font-weight: 700; letter-spacing: .3px;
  color: var(--ck-wood-3);
  text-shadow:
    -2px -2px 0 var(--ck-gold), 0 -2px 0 var(--ck-gold), 2px -2px 0 var(--ck-gold),
    -2px  0   0 var(--ck-gold),                          2px  0   0 var(--ck-gold),
    -2px  2px 0 var(--ck-gold), 0  2px 0 var(--ck-gold), 2px  2px 0 var(--ck-gold),
    0 2px 3px rgba(0,0,0,.45);
  white-space: nowrap; max-width: calc(var(--ck-panel-w, 250px) - 22px);
  overflow: hidden; text-overflow: ellipsis;
  pointer-events: none;
}

/* ── The continuous bar ────────────────────────────────────────────────── */
.oni-clock-bar {
  position: relative;
  flex: 1 1 auto;
  height: var(--ck-bar-h, 15px);
  border-radius: 3px;
  background: rgba(78, 47, 25, .30);
  border: 1px solid var(--ck-wood-2);
  overflow: hidden;
}

.oni-clock-fill {
  position: absolute; inset: 0 auto 0 0;
  width: 0%;
  border-radius: 2px 0 0 2px;
  transition: width var(--ck-advance, 480ms) cubic-bezier(.22,.8,.3,1);
}
.oni-clock.spawning .oni-clock-fill { transition-duration: var(--ck-bar-fill, 620ms); }

.oni-clock-pct {
  position: absolute; inset: 0; z-index: 1;
  display: grid; place-items: center;
  font-size: var(--ck-pct-size, 12px); font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--ck-parch-1);
  text-shadow: 0 1px 2px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.7);
  pointer-events: none;
}

/* ── Tone: what KIND of clock is this ──────────────────────────────────── */
.oni-clock[data-tone="progress"] .oni-clock-fill { background: linear-gradient(180deg, var(--ck-blue-hi), var(--ck-blue)); }
.oni-clock[data-tone="threat"]   .oni-clock-fill { background: linear-gradient(180deg, var(--ck-red-hi), var(--ck-red)); }

/* ── Contest: two beams clashing ───────────────────────────────────────────
 * The bar is NOT one gradient across its whole width — that read as a single
 * blended thing rather than two forces meeting. Instead:
 *   the track is solid GM red (the ground the players have not taken),
 *   the fill is solid player blue up to the current value,
 *   and only where they MEET is there a blend — the clash band.
 * Past the midpoint the bar is overwhelmingly one colour, which is the point.
 *
 * No percentage label: "62%" on a tug-of-war invites the question "62% of
 * what?". The clash position already says everything.
 */
.oni-clock[data-tone="contest"] .oni-clock-bar { background: linear-gradient(180deg, var(--ck-red-hi), var(--ck-red)); }
.oni-clock[data-tone="contest"] .oni-clock-fill { background: linear-gradient(180deg, var(--ck-blue-hi), var(--ck-blue)); }
.oni-clock[data-tone="contest"] .oni-clock-pct { display: none; }

/* The clash band, centred on the meeting point. Jitters and shudders as the two
 * beams shove each other. --ck-v is the fill percentage, set by the renderer. */
.oni-clock-clash {
  position: absolute; top: -2px; bottom: -2px;
  left: var(--ck-v, 50%);
  width: 26px; margin-left: -13px;
  pointer-events: none;
  /* Warm amber rather than near-white: the two beams grind against each other,
     they don't blow out the exposure. Softer core, narrower hot centre. */
  background:
    radial-gradient(closest-side, rgba(255,232,170,.62), rgba(255,232,170,0) 72%),
    linear-gradient(90deg, var(--ck-blue) 0%, var(--ck-clash) 46%, var(--ck-clash) 54%, var(--ck-red) 100%);
  filter: blur(.4px) saturate(1.15);
  animation: oni-clash-jitter 220ms steps(2, jump-none) infinite,
             oni-clash-pulse 900ms ease-in-out infinite;
  transition: left var(--ck-advance, 480ms) cubic-bezier(.22,.8,.3,1);
  z-index: 2;
}
.oni-clock.spawning .oni-clock-clash { transition-duration: var(--ck-bar-fill, 620ms); }

/* Small, fast, irregular: a struggle, not a wobble. */
@keyframes oni-clash-jitter {
  0%   { transform: translate(0, 0) scaleY(1); }
  20%  { transform: translate(-1.5px, .5px) scaleY(1.06); }
  40%  { transform: translate(1.5px, -.5px) scaleY(.96); }
  60%  { transform: translate(-1px, -.5px) scaleY(1.08); }
  80%  { transform: translate(1px, .5px) scaleY(.98); }
  100% { transform: translate(0, 0) scaleY(1); }
}
/* The slow shove: the whole band swells and recedes, pushed back and forth. */
@keyframes oni-clash-pulse {
  0%, 100% { width: 24px; margin-left: -12px; filter: blur(.4px) saturate(1.15) brightness(1); }
  50%      { width: 34px; margin-left: -17px; filter: blur(.6px) saturate(1.3) brightness(1.14); }
}

/* Sparks thrown off where the beams meet. Each is one span with its own delay,
 * so they scatter rather than pulsing in lockstep. */
.oni-clock-spark {
  position: absolute; top: 50%; left: var(--ck-v, 50%);
  width: 3px; height: 3px; border-radius: 50%;
  background: var(--ck-spark); box-shadow: 0 0 4px 1px rgba(255,233,160,.7);
  pointer-events: none; opacity: 0; z-index: 3;
  transition: left var(--ck-advance, 480ms) cubic-bezier(.22,.8,.3,1);
  animation: oni-spark var(--sp-dur, 700ms) ease-out var(--sp-delay, 0ms) infinite;
}
@keyframes oni-spark {
  0%   { opacity: 0;  transform: translate(-50%, -50%) scale(.4); }
  12%  { opacity: 1; }
  100% { opacity: 0;  transform: translate(calc(-50% + var(--sp-dx, 0px)), calc(-50% + var(--sp-dy, -10px))) scale(.15); }
}

/* ── Near a pole: the panel itself pulses and shimmers ──────────────────────
 * Applied when the clash is two sections or fewer from either end. The colour
 * is the side that is ABOUT TO WIN. */
.oni-clock.near-high .oni-clock-panel { animation: oni-near-blue 1.05s ease-in-out infinite; }
.oni-clock.near-low  .oni-clock-panel { animation: oni-near-red  1.05s ease-in-out infinite; }

@keyframes oni-near-blue {
  0%, 100% { box-shadow: 0 0 0 1px var(--ck-wood-3), 0 0 12px 1px rgba(63,159,214,.45), 0 6px 18px rgba(0,0,0,.45); }
  50%      { box-shadow: 0 0 0 1px var(--ck-wood-3), 0 0 26px 5px rgba(63,159,214,.85), 0 6px 18px rgba(0,0,0,.45); }
}
@keyframes oni-near-red {
  0%, 100% { box-shadow: 0 0 0 1px var(--ck-wood-3), 0 0 12px 1px rgba(207,64,52,.45), 0 6px 18px rgba(0,0,0,.45); }
  50%      { box-shadow: 0 0 0 1px var(--ck-wood-3), 0 0 26px 5px rgba(207,64,52,.85), 0 6px 18px rgba(0,0,0,.45); }
}

/* Shimmer sweep across the parchment.
 * It rides its own clipping layer rather than a panel ::after pseudo-element:
 * the panel cannot take overflow hidden, because the name tab deliberately
 * overhangs its top-left corner, and the sweep must not escape the plate. */
.oni-clock-shine {
  position: absolute; inset: 0; border-radius: 5px;
  overflow: hidden; pointer-events: none; z-index: 0;
}
.oni-clock.near-high .oni-clock-shine::after,
.oni-clock.near-low  .oni-clock-shine::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.55) 50%, transparent 65%);
  animation: oni-shimmer 1.6s linear infinite;
}
@keyframes oni-shimmer {
  0%   { transform: translateX(-100%); opacity: 0; }
  35%  { opacity: 1; }
  100% { transform: translateX(100%); opacity: 0; }
}

/* The panel is the button. */
.oni-clock-panel { cursor: pointer; }
.oni-clock-panel:hover { filter: brightness(1.04); }
.oni-clock.resolved .oni-clock-panel { cursor: default; }

.oni-clock[data-tone="progress"] .oni-clock-panel { box-shadow: 0 0 0 1px var(--ck-wood-3), 0 0 14px 1px rgba(63,159,214,.55), 0 6px 18px rgba(0,0,0,.45), inset 0 0 18px rgba(160,118,73,.20); }
.oni-clock[data-tone="threat"]   .oni-clock-panel { box-shadow: 0 0 0 1px var(--ck-wood-3), 0 0 14px 1px rgba(207,64,52,.55), 0 6px 18px rgba(0,0,0,.45), inset 0 0 18px rgba(160,118,73,.20); }
.oni-clock[data-tone="contest"]  .oni-clock-panel { box-shadow: 0 0 0 1px var(--ck-wood-3), -7px 0 14px -3px rgba(207,64,52,.60), 7px 0 14px -3px rgba(63,159,214,.60), 0 6px 18px rgba(0,0,0,.45), inset 0 0 18px rgba(160,118,73,.20); }

/* ── Beat 1+2+3: spawn in ──────────────────────────────────────────────── */
.oni-clock.gear-in .oni-clock-gear {
  opacity: 1;
  transition: opacity var(--ck-gear-in, 220ms) ease;
}
.oni-clock.panel-in .oni-clock-panel {
  opacity: 1; transform: translateX(0);
  transition: opacity var(--ck-panel-in, 280ms) ease,
              transform var(--ck-panel-in, 280ms) cubic-bezier(.22,.8,.3,1);
}

/* ── Exit: everything slides + fades at once ───────────────────────────── */
.oni-clock.leaving { pointer-events: none; }
.oni-clock.leaving .oni-clock-panel,
.oni-clock.leaving .oni-clock-gear {
  opacity: 0; transform: translateX(34px);
  transition: opacity var(--ck-out, 300ms) ease, transform var(--ck-out, 300ms) ease-in;
}

/* ── Finality: glow, then hold ─────────────────────────────────────────── */
.oni-clock.resolved .oni-clock-panel { animation: oni-clock-finale 1.1s ease-out; }
.oni-clock.resolved .oni-clock-gear  { animation: oni-clock-gear-spin 1.1s cubic-bezier(.22,.8,.3,1); }

.oni-clock.resolved-success .oni-clock-fill { background: linear-gradient(180deg, var(--ck-blue-hi), var(--ck-blue)) !important; }
.oni-clock.resolved-failure .oni-clock-fill { background: linear-gradient(180deg, var(--ck-red-hi), var(--ck-red)) !important; }

@keyframes oni-clock-finale {
  0%   { filter: brightness(1); }
  22%  { filter: brightness(1.9); }
  100% { filter: brightness(1); }
}
@keyframes oni-clock-gear-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(180deg); }
}

.oni-clock.resolved-success .oni-clock-panel { border-color: #2f6f96; }
.oni-clock.resolved-failure .oni-clock-panel { border-color: #8d2c24; }

/* The resolution chat card's CSS lives in clock-ui-resolve.js, NOT here: a card
   is posted even when this bar is switched off, and this stylesheet is only
   injected when the bar builds its layer. */

@media (prefers-reduced-motion: reduce) {
  .oni-clock, .oni-clock-panel, .oni-clock-gear, .oni-clock-fill { transition: none !important; }
  .oni-clock.resolved .oni-clock-panel, .oni-clock.resolved .oni-clock-gear { animation-duration: .01ms; }
}
`;
  document.head.appendChild(s);
}

// ── SFX ─────────────────────────────────────────────────────────────────────
const _SND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const CLOCK_SFX = Object.freeze({
  CREATE:  { src: `${_SND}clock_create.ogg`,  volume: 0.8 },
  ADVANCE: { src: `${_SND}clock_advance.ogg`, volume: 0.4 },
  // Kept level with ADVANCE: they are the two halves of one gesture, and a
  // regress that is louder than an advance sounds like a bug.
  REGRESS: { src: `${_SND}clock_regress.ogg`, volume: 0.4 },
  SUCCESS: { src: `${_SND}clock_success.ogg`, volume: 0.75 },
  FAILURE: { src: `${_SND}clock_failure.ogg`, volume: 0.75 },
});

/**
 * Play a clock sound locally. A fresh Audio node per call, deliberately: the
 * AudioHelper de-duplicates identical rapid plays, which would swallow the
 * second of two clocks advancing together.
 */
export function playClockSfx(key) {
  const cfg = typeof key === "string" ? CLOCK_SFX[key] : key;
  if (!cfg?.src) return;
  try {
    const a = new Audio(cfg.src);
    a.volume = cfg.volume ?? 0.6;
    a.play().catch(() => {});
  } catch { /* audio must never break the bar */ }
}
