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
 * The outline is built from text-shadow, NOT `-webkit-text-stroke` +
 * `paint-order: stroke fill`. Chromium only honours `paint-order` on HTML text
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
.oni-clock[data-tone="contest"]  .oni-clock-fill { background: linear-gradient(90deg, var(--ck-red), var(--ck-blue)); }

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

/* ── The resolution chat card ──────────────────────────────────────────── */
/* Foundry stamps a sender header + portrait on every message. A clock has no
   speaker, so hide it — the card is the whole message. */
.message:has(.oni-clock-card) .message-header { display: none; }
.message:has(.oni-clock-card) .message-content { margin: 0; }

.oni-clock-card {
  border-left: 4px solid var(--tone, #8d5f38);
  padding: 5px 9px;
  line-height: 1.35;
}
.oni-clock-card .ck-verdict {
  font-weight: 700; letter-spacing: .4px; color: var(--tone, #8d5f38);
}
.oni-clock-card .ck-line { opacity: .88; font-size: 12px; }

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
  CREATE:  { src: `${_SND}clock_create.ogg`,  volume: 0.7 },
  ADVANCE: { src: `${_SND}clock_advance.ogg`, volume: 0.65 },
  REGRESS: { src: `${_SND}clock_regress.ogg`, volume: 0.65 },
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
