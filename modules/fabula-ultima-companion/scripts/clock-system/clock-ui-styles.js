// ============================================================================
// Clock System — bundled UI styles (injected once) + live-tunable layout.
//
// A JRPG segmented gauge, not the rulebook's pizza slice. Notches read as
// discrete steps (a boss stagger bar / tension meter) rather than a continuous
// percentage, because a clock IS discrete — "two sections" is the unit the
// rules speak in.
//
// Colour follows the axis model directly:
//   notch i < value  → the HIGH pole's owner colour
//   notch i >= value → the LOW pole's owner colour
//   unclaimed pole   → neutral track
//
// which yields every shape without a special case:
//   progress  players fill left→right, remainder empty
//   threat    the GM's crimson creeps rightward
//   teardown  solid neutral "obstacle" eaten away from the right by the players
//   struggle  a true two-colour tug-of-war meeting wherever `value` sits
//
// NOTE: the global stylesheet puts a 1px black border on every <img>. Nothing
// here uses <img> — the icon is a background-image on a div. See
// [[feedback_dom_img_transparent_border]].
// ============================================================================

const STYLE_ID = "oni-clock-styles";

// Mutated by the tuner and re-applied as CSS custom properties, so layout can
// be dialled in live. Edit these defaults to bake a final design.
export const CLOCK_TUNE = {
  layerTop: 74,        // px from viewport top (below the scene name)
  layerGap: 10,        // px between stacked clocks
  barWidth: 320,       // px
  barHeight: 20,       // px
  notchGap: 3,         // px between sections
  labelSize: 14,       // px
  poleLabelSize: 11,   // px
  compactAt: 4,        // collapse to a compact strip past this many clocks
  tickStaggerMs: 90,   // per-section delay when animating a multi-section change
};

export function clockTuneVars(t = CLOCK_TUNE) {
  return {
    "--ck-top": `${t.layerTop}px`,
    "--ck-gap": `${t.layerGap}px`,
    "--ck-bar-w": `${t.barWidth}px`,
    "--ck-bar-h": `${t.barHeight}px`,
    "--ck-notch-gap": `${t.notchGap}px`,
    "--ck-label-size": `${t.labelSize}px`,
    "--ck-pole-size": `${t.poleLabelSize}px`,
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
  --ck-players: #47b7e8;
  --ck-players-hi: #a7e6ff;
  --ck-gm: #d1443c;
  --ck-gm-hi: #ff9a8f;
  --ck-track: #2a2a30;
  --ck-track-edge: #4a4a54;
  --ck-neutral: #6c6c78;
  --ck-ink: #f2ece1;
  --ck-plate: rgba(14, 13, 18, 0.78);

  position: fixed;
  top: var(--ck-top, 74px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 70;
  display: flex; flex-direction: column; align-items: center;
  gap: var(--ck-gap, 10px);
  pointer-events: none;
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
}

.oni-clock {
  pointer-events: auto;
  min-width: var(--ck-bar-w, 320px);
  padding: 7px 12px 8px;
  background: var(--ck-plate);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 9px;
  box-shadow: 0 6px 22px rgba(0,0,0,0.5);
  color: var(--ck-ink);
  opacity: 0; transform: translateY(-10px);
  transition: opacity .22s ease, transform .22s cubic-bezier(.22,.8,.3,1);
}
.oni-clock.visible { opacity: 1; transform: translateY(0); }
.oni-clock.leaving { opacity: 0; transform: translateY(-8px) scale(.98); }

.oni-clock-head {
  display: flex; align-items: center; gap: 7px;
  margin-bottom: 5px;
}
.oni-clock-icon {
  width: 16px; height: 16px; flex: 0 0 auto;
  background-size: contain; background-repeat: no-repeat; background-position: center;
  border: 0; outline: 0; box-shadow: none;
}
.oni-clock-name {
  font-size: var(--ck-label-size, 14px); font-weight: 600;
  letter-spacing: .2px; text-shadow: 0 1px 2px rgba(0,0,0,.7);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.oni-clock-count {
  margin-left: auto; font-size: 11px; opacity: .62; font-variant-numeric: tabular-nums;
}
.oni-clock-gmonly { font-size: 10px; opacity: .55; letter-spacing: .5px; }

/* ── the gauge ─────────────────────────────────────────────────────────── */
.oni-clock-track {
  display: flex; gap: var(--ck-notch-gap, 3px);
  height: var(--ck-bar-h, 20px);
  padding: 2px; border-radius: 5px;
  background: rgba(0,0,0,.45);
  box-shadow: inset 0 0 0 1px var(--ck-track-edge);
}
.oni-clock-notch {
  flex: 1 1 0; border-radius: 2px;
  background: var(--ck-track);
  transition: background-color .16s ease, box-shadow .16s ease, transform .16s ease;
}
.oni-clock-notch.players { background: var(--ck-players); }
.oni-clock-notch.gm      { background: var(--ck-gm); }
.oni-clock-notch.neutral { background: var(--ck-neutral); }
.oni-clock-notch.empty   { background: var(--ck-track); }

/* the section that just moved */
.oni-clock-notch.pop { transform: scaleY(1.28); }
.oni-clock-notch.pop.players { box-shadow: 0 0 10px 2px var(--ck-players-hi); }
.oni-clock-notch.pop.gm      { box-shadow: 0 0 10px 2px var(--ck-gm-hi); }
.oni-clock-notch.pop.neutral,
.oni-clock-notch.pop.empty   { box-shadow: 0 0 8px 1px rgba(255,255,255,.35); }

/* ── pole labels ───────────────────────────────────────────────────────── */
.oni-clock-poles {
  display: flex; justify-content: space-between; margin-top: 4px;
  font-size: var(--ck-pole-size, 11px); letter-spacing: .3px; opacity: .74;
}
.oni-clock-pole-low  { text-align: left; }
.oni-clock-pole-high { text-align: right; margin-left: auto; }
.oni-clock-pole-low.players, .oni-clock-pole-high.players { color: var(--ck-players-hi); }
.oni-clock-pole-low.gm, .oni-clock-pole-high.gm { color: var(--ck-gm-hi); }

/* ── resolution flourish ───────────────────────────────────────────────── */
.oni-clock.resolved .oni-clock-track { box-shadow: inset 0 0 0 1px currentColor; }
.oni-clock.resolved-success { color: var(--ck-players-hi); }
.oni-clock.resolved-failure { color: var(--ck-gm-hi); }

.oni-clock-flash {
  position: absolute; inset: 0; border-radius: 9px; pointer-events: none;
  background: currentColor; opacity: 0;
}
.oni-clock-flash.fire { animation: oni-clock-flash .62s ease-out; }
@keyframes oni-clock-flash {
  0% { opacity: .55; } 100% { opacity: 0; }
}

.oni-clock-banner {
  margin-top: 5px; text-align: center;
  font-size: 13px; font-weight: 700; letter-spacing: 1.1px; text-transform: uppercase;
  text-shadow: 0 0 12px currentColor;
  opacity: 0; transform: scale(.9);
  animation: oni-clock-banner .5s cubic-bezier(.22,.8,.3,1) forwards;
}
@keyframes oni-clock-banner {
  to { opacity: 1; transform: scale(1); }
}

/* ── compact strip (many clocks at once) ───────────────────────────────── */
#oni-clock-layer.compact .oni-clock { padding: 4px 9px 5px; }
#oni-clock-layer.compact .oni-clock-track { height: calc(var(--ck-bar-h, 20px) * 0.6); }
#oni-clock-layer.compact .oni-clock-poles { display: none; }
#oni-clock-layer.compact .oni-clock-name { font-size: calc(var(--ck-label-size, 14px) - 2px); }

/* the clock element needs a positioning context for the flash overlay */
.oni-clock { position: relative; }

@media (prefers-reduced-motion: reduce) {
  .oni-clock, .oni-clock-notch { transition: none; }
  .oni-clock-flash.fire, .oni-clock-banner { animation-duration: .01ms; }
}
`;
  document.head.appendChild(s);
}

// ── SFX ─────────────────────────────────────────────────────────────────────
// Same soundboard the Progress opportunity effect uses, so a clock tick sounds
// like a clock tick everywhere in the game.
const _SND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const CLOCK_SFX = Object.freeze({
  TICK_FILL:  { src: `${_SND}SFX_TINK.wav`, volume: 0.55 },
  TICK_ERASE: { src: `${_SND}collision_1.wav`, volume: 0.5 },
  SUCCESS:    { src: `${_SND}opportunity_confirmed.wav`, volume: 0.7 },
  FAILURE:    { src: `${_SND}bond_cleared.wav`, volume: 0.7 },
});

/**
 * Play a clock sound locally. A fresh Audio node per call, deliberately: the
 * AudioHelper de-duplicates identical rapid plays, which would swallow every
 * tick after the first in a multi-section fill.
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
