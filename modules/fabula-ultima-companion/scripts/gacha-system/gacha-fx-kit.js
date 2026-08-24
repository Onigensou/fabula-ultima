// ============================================================================
// Gacha System — Reveal FX kit
// ----------------------------------------------------------------------------
// Everything the three-phase reveal draws with: its stylesheet, its particle
// emitter, and the timing helper the phases await on. gacha-fx.js owns the
// sequence; this owns the materials.
//
// Performance rules, same as the rest of the system:
//   * animate transform / opacity / filter only — never layout properties
//   * particles are capped, WAAPI-driven, and remove themselves
//   * orchestration uses timers, never rAF: rAF stalls on a background tab and
//     has left this codebase's overlays wedged before
// ============================================================================

import { RARITY } from "./gacha-const.js";
import { ensureTheme } from "./gacha-theme.js";

export const FX_ROOT_ID = "gacha-fx";
const STYLE_ID = "gacha-fx-style";

// PLACEHOLDER, pending a final choice of chest art. Swapping it is this one
// line; CHEST_OPEN_SRC below takes the open-lid frame when there is one, and is
// swapped in automatically at the burst.
//
// Whatever replaces it wants a TRANSPARENT background — the earlier
// icons/containers/chest/*.webp tiles bake in sky and sand, which reads as a
// floating rectangle on the dark gradient.
export const CHEST_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Gold_Chest.png";
export const CHEST_OPEN_SRC = null;   // when set, swapped in at the burst

/** Per-rarity drama. Higher rarity buys more of everything. */
export const DRAMA = {
  three: { rays: 0,  particles: 14, shake: 0,   glow: 0.35, ring: false, tint: RARITY.three.color },
  four:  { rays: 10, particles: 26, shake: 0,   glow: 0.60, ring: true,  tint: RARITY.four.color },
  five:  { rays: 18, particles: 46, shake: 1,   glow: 1.00, ring: true,  tint: RARITY.five.color },
};

// ── timing ──────────────────────────────────────────────────────────────────

/**
 * Await `ms`, unless the sequence has been skipped.
 *
 * Resolvers are handed to the state so a skip can settle every pending phase at
 * once — clearing the timers alone would leave the sequence's async frame
 * permanently parked.
 */
export function phase(ms, state) {
  return new Promise((resolve) => {
    if (state.skip) return resolve();
    state.timers.push(setTimeout(resolve, ms));
    state.pending.push(resolve);
  });
}

/** Settle every in-flight phase immediately. */
export function flush(state) {
  for (const t of state.timers ?? []) clearTimeout(t);
  state.timers = [];
  for (const r of state.pending ?? []) { try { r(); } catch {} }
  state.pending = [];
}

export const rgba = (hex, a) => {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Blend two hex colours. Used for the nudge's half-shift toward the next tier. */
export function mixHex(a, b, t) {
  const A = parseInt(String(a).replace("#", ""), 16);
  const B = parseInt(String(b).replace("#", ""), 16);
  const ch = (s) => [(s >> 16) & 255, (s >> 8) & 255, s & 255];
  const [ar, ag, ab] = ch(A), [br, bg, bb] = ch(B);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `#${[m(ar, br), m(ag, bg), m(ab, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The colour the chest glows on each successive shake.
 *
 * Indexed by SHAKE NUMBER, never by the outcome. The wiggle count is already
 * the tell; if the glow were tinted from the final rarity it would spoil the
 * result on the very first shake — a 5-star chest would come up gold before the
 * player had been given anything to wonder about.
 */
export const TIER_TINT = [RARITY.three.color, RARITY.four.color, RARITY.five.color];

// ── particles ───────────────────────────────────────────────────────────────

/**
 * Spray particles from a point, in viewport coordinates.
 *
 * Fixed-position nodes appended to the FX root rather than to the emitting
 * element: the emitter usually lives inside something with its own transform,
 * and a child would be dragged around by it mid-flight.
 */
export function emit(root, {
  x, y, n = 20, tints = ["#ffd479", "#fff3c4", "#ffffff"],
  spreadX = 220, up = 320, drift = 120, size = [3, 8], dur = [520, 1100], delay = 0,
} = {}) {
  if (!root) return;

  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    p.className = "gfx-particle";
    const s = size[0] + Math.random() * (size[1] - size[0]);
    Object.assign(p.style, {
      left: `${x}px`, top: `${y}px`,
      width: `${s}px`, height: `${s}px`,
      background: tints[(Math.random() * tints.length) | 0],
    });
    root.appendChild(p);

    const dx = (Math.random() - 0.5) * spreadX;
    const rise = up * (0.55 + Math.random() * 0.75);
    const fall = rise + drift * (0.5 + Math.random());
    const d = dur[0] + Math.random() * (dur[1] - dur[0]);

    p.animate(
      [
        { opacity: 1, transform: "translate(-50%,-50%) translate(0,0) scale(1)" },
        { opacity: 1, transform: `translate(-50%,-50%) translate(${dx * 0.6}px, ${-rise}px) scale(.9)`, offset: 0.45 },
        { opacity: 0, transform: `translate(-50%,-50%) translate(${dx}px, ${fall - rise}px) scale(.25)` },
      ],
      { duration: d, delay: delay + Math.random() * 120, easing: "cubic-bezier(.2,.6,.35,1)", fill: "both" }
    ).finished.catch(() => {}).finally(() => p.remove());
  }
}

/**
 * Drop every particle still in flight, fading rather than snapping.
 *
 * Particles are parented to the FX ROOT, not to the stage or the prize wrap,
 * which is what lets them survive a transform-bearing ancestor mid-flight. The
 * cost is that tearing a phase down leaves its particles hanging in the NEXT
 * one — the burst's spray runs up to 1.6s and was still falling through the
 * first prize. Every phase boundary calls this, so each phase owns its own.
 *
 * The fade is a second opacity animation rather than a cancel(). Cancelling
 * drops the particle back to its spawn point for one frame before removal,
 * which reads as the whole spray jumping inward.
 */
export function clearParticles(root, { fade = 140 } = {}) {
  if (!root) return;
  for (const n of root.querySelectorAll(".gfx-particle, .gfx-shock")) {
    if (n.dataset.clearing) continue;
    n.dataset.clearing = "1";
    const cur = Number(getComputedStyle(n).opacity) || 1;
    n.animate([{ opacity: cur }, { opacity: 0 }], { duration: fade, fill: "forwards" })
      .finished.catch(() => {}).finally(() => n.remove());
  }
}

// ── rank-climb burst ────────────────────────────────────────────────────────

/**
 * How hard the chest pops when the strain climbs a rank, indexed by SHAKE.
 *
 * Blue is deliberately empty. It is the floor every roll starts from, so a
 * burst there would dramatise the ABSENCE of a climb as though it were one,
 * and the two escalations above it would lose the contrast that makes them
 * read as escalations at all. The drama has to start from a quiet.
 *
 * Carries no information the wiggle count has not already given away, so it
 * cannot spoil a roll — it only makes the tell hit harder.
 */
export const RANK_BURST = [
  null,                                                                   // blue
  { n: 18, radius: 165, size: [3, 7],  dur: [420, 760],  shock: false },  // purple
  { n: 42, radius: 290, size: [4, 12], dur: [520, 1000], shock: true  },  // gold
];

/**
 * Radial pop from a point — the chest releasing pressure as it gains a rank.
 *
 * Deliberately NOT the emit() fountain. That one is gravity-bound dust kicked
 * off the base, and it reads as the chest being physically jostled; this has
 * to read as the thing INSIDE getting stronger, so it throws evenly in every
 * direction and decelerates outward instead of arcing back down.
 */
export function rankBurst(root, { x, y, tint, spec } = {}) {
  if (!root || !spec) return;

  if (spec.shock) {
    const w = document.createElement("div");
    w.className = "gfx-shock";
    // `color`, not border-color: the border and both glows all read currentColor.
    Object.assign(w.style, { left: `${x}px`, top: `${y}px`, color: rgba(tint, 0.9) });
    root.appendChild(w);
    w.animate(
      [
        { opacity: 0.95, transform: "translate(-50%,-50%) scale(.15)" },
        { opacity: 0,    transform: `translate(-50%,-50%) scale(${spec.radius / 55})` },
      ],
      { duration: 620, easing: "cubic-bezier(.15,.75,.3,1)", fill: "both" }
    ).finished.catch(() => {}).finally(() => w.remove());
  }

  for (let i = 0; i < spec.n; i++) {
    const p = document.createElement("div");
    p.className = "gfx-particle";
    const s = spec.size[0] + Math.random() * (spec.size[1] - spec.size[0]);
    Object.assign(p.style, {
      left: `${x}px`, top: `${y}px`,
      width: `${s}px`, height: `${s}px`,
      background: Math.random() < 0.62 ? tint : "#fff3c4",
    });
    root.appendChild(p);

    // Angles are STRIDED, not purely random. Random angles clump, and the bald
    // patches read as the burst having misfired rather than as randomness.
    const a = ((i + Math.random() * 0.85) / spec.n) * Math.PI * 2;
    const r = spec.radius * (0.55 + Math.random() * 0.6);
    const d = spec.dur[0] + Math.random() * (spec.dur[1] - spec.dur[0]);

    p.animate(
      [
        { opacity: 1, transform: "translate(-50%,-50%) translate(0,0) scale(1)" },
        { opacity: 1, transform: `translate(-50%,-50%) translate(${Math.cos(a) * r * 0.55}px, ${Math.sin(a) * r * 0.55}px) scale(.95)`, offset: 0.4 },
        { opacity: 0, transform: `translate(-50%,-50%) translate(${Math.cos(a) * r}px, ${Math.sin(a) * r + 26}px) scale(.2)` },
      ],
      { duration: d, delay: Math.random() * 70, easing: "cubic-bezier(.1,.7,.3,1)", fill: "both" }
    ).finished.catch(() => {}).finally(() => p.remove());
  }
}

// ── stylesheet ──────────────────────────────────────────────────────────────

const CSS = `
/* Above everything, not merely above the gacha UI. The reveal is a full-screen
   cinematic, and the module parks its own button roots at z-index 81 and 83
   while the GM Screen sits at 99 — at the old 80 all three punched through. */
#${FX_ROOT_ID} {
  position: fixed; inset: 0; z-index: 200;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; user-select: none;
  /* Opaque, not a scrim: the reveal takes the whole screen. */
  background:
    radial-gradient(ellipse at 50% 42%, #3b3550 0%, #241f33 45%, #14111f 100%);
  opacity: 0; transition: opacity 320ms ease-out;
}
#${FX_ROOT_ID}.is-on { opacity: 1; }
#${FX_ROOT_ID} * { box-sizing: border-box; }
#${FX_ROOT_ID} img { border: 0 !important; outline: 0 !important; background: transparent; }

.gfx-particle {
  position: absolute; border-radius: 50%; pointer-events: none; z-index: 6;
  box-shadow: 0 0 8px currentColor; will-change: transform, opacity;
}

/* Shockwave for the top rank climb. Sized by the animation's scale, so the
   base ring stays small and cheap — 110px is the unscaled diameter.

   The glow is not decoration. A bare 3px border thins out as the ring scales
   and, at the opacity it is already fading through, the tint muddies to brown
   against the dark field — it read as a drawn circle rather than as energy.
   Bleeding the colour outward keeps it reading as gold the whole way out. */
.gfx-shock {
  position: absolute; z-index: 5; pointer-events: none;
  width: 110px; height: 110px; margin: 0;
  border-radius: 50%; border: 4px solid currentColor;
  box-shadow: 0 0 26px currentColor, inset 0 0 16px currentColor;
  will-change: transform, opacity;
}

/* ── skip ─────────────────────────────────────────────────────────────── */
/* width:auto is NOT redundant. Foundry ships a bare button rule setting width
   to 100%; the theme neutralises it for #gacha-ui and #gacha-panel, and this
   root is neither, so the Skip button rendered as a full-width bar. */
.gfx-skip {
  position: absolute; top: 18px; left: 18px; z-index: 20; cursor: pointer;
  width: auto; padding: 7px 20px; border-radius: 6px;
  font-family: 'Lucida Console','Courier New',monospace;
  font-size: 12px; letter-spacing: 2px; text-transform: uppercase;
  background: linear-gradient(180deg, #f7f0df, #e6dabd);
  border: 2px solid #8a6c45; color: #3b2a17;
  box-shadow: 0 6px 16px -8px rgba(0,0,0,.7);
  transition: background .12s, transform .12s;
}
.gfx-skip:hover { background: #fffaec; transform: translateY(-1px); }

/* ── intro: chest ─────────────────────────────────────────────────────── */
.gfx-stage { position: relative; width: min(560px, 70vw); height: min(560px, 70vh); }

.gfx-plinth {
  position: absolute; left: 50%; bottom: 22%;
  width: 300px; height: 74px; transform: translateX(-50%);
  border-radius: 50%; z-index: 1;
  background: radial-gradient(ellipse at 50% 50%, rgba(196,166,110,.55) 0%, rgba(120,96,52,0) 70%);
}

.gfx-chest {
  position: absolute; left: 50%; bottom: 26%; z-index: 3;
  width: 210px; height: 210px; object-fit: contain;
  transform: translateX(-50%);
  transform-origin: 50% 88%;
  filter: drop-shadow(0 14px 22px rgba(0,0,0,.6));
}
/* Registered so the tint can TRANSITION. A bare custom property snaps, and the
   glow needs to slide blue → purple → gold across the shakes (and half-way back
   again on a nudge) rather than cutting between them. */
@property --gfx-strain-tint {
  syntax: '<color>';
  inherits: true;
  initial-value: rgba(255, 214, 120, 0);
}

/* Strain: rises with each wiggle so the chest looks increasingly loaded. */
.gfx-chest-glow {
  position: absolute; left: 50%; bottom: 24%; z-index: 2;
  width: 300px; height: 300px; transform: translate(-50%, 0);
  border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, var(--gfx-strain-tint, rgba(255,214,120,.9)) 0%, rgba(255,214,120,0) 62%);
  opacity: 0;
  transition: opacity 260ms ease-out, transform 260ms ease-out,
              --gfx-strain-tint 300ms ease-out;
}

@keyframes gfx-chest-in {
  0%   { opacity: 0; transform: translateX(-50%) translateY(-180px) scale(.7); }
  70%  { opacity: 1; transform: translateX(-50%) translateY(14px)   scale(1.04); }
  100% { opacity: 1; transform: translateX(-50%) translateY(0)      scale(1); }
}
.gfx-chest.is-entering { animation: gfx-chest-in var(--in-ms,620ms) cubic-bezier(.2,.9,.3,1.2) both; }

@keyframes gfx-idle {
  0%,100% { transform: translateX(-50%) translateY(0)    scale(1); }
  50%     { transform: translateX(-50%) translateY(-5px) scale(1.012); }
}
.gfx-chest.is-idle { animation: gfx-idle 2.4s ease-in-out infinite; }

/* One shake. Pokeball-style: over, back, over, settle. */
@keyframes gfx-wiggle {
  0%   { transform: translateX(-50%) rotate(0deg); }
  18%  { transform: translateX(-50%) rotate(-11deg); }
  42%  { transform: translateX(-50%) rotate(9deg); }
  66%  { transform: translateX(-50%) rotate(-6deg); }
  85%  { transform: translateX(-50%) rotate(3deg); }
  100% { transform: translateX(-50%) rotate(0deg); }
}
.gfx-chest.is-wiggling { animation: gfx-wiggle var(--wig-ms,380ms) cubic-bezier(.3,.1,.3,1) both; }

/* The FAKE-OUT nudge. It must never be mistakable for a real shake: it starts
   in the same direction, stalls partway as though the energy died, and falls
   back WITHOUT crossing to the other side. A real wiggle swings through -11 to
   +9; this one barely reaches -7 and never goes positive. The feeling wanted is
   "huh — I thought that was going to go" and not "it went, and I got nothing". */
@keyframes gfx-nudge {
  0%   { transform: translateX(-50%) rotate(0deg); }
  28%  { transform: translateX(-50%) rotate(-7deg); }
  44%  { transform: translateX(-50%) rotate(-6.2deg); }   /* the stall */
  100% { transform: translateX(-50%) rotate(0deg); }
}
.gfx-chest.is-nudging { animation: gfx-nudge var(--nudge-ms,300ms) cubic-bezier(.25,.75,.4,1) both; }

/* ── intro: burst ─────────────────────────────────────────────────────── */
.gfx-beam {
  position: absolute; left: 50%; bottom: 34%; z-index: 4;
  width: 120px; height: 0; transform: translateX(-50%);
  transform-origin: 50% 100%; pointer-events: none;
  background: linear-gradient(to top,
    rgba(255,236,170,.95) 0%, rgba(255,214,120,.75) 40%, rgba(255,240,200,0) 100%);
  filter: blur(2px);
}
@keyframes gfx-beam-up {
  0%   { height: 0;     opacity: 0;   width: 60px; }
  22%  { opacity: 1; }
  100% { height: 150vh; opacity: .95; width: 150px; }
}
.gfx-beam.is-on { animation: gfx-beam-up var(--burst-ms,520ms) cubic-bezier(.15,.85,.3,1) both; }

.gfx-white {
  position: absolute; inset: 0; z-index: 10; pointer-events: none;
  background: radial-gradient(circle at 50% 58%, #fffdf2 0%, #fff6dd 45%, #ffeec2 100%);
  opacity: 0;
}
.gfx-white.is-on { animation: gfx-white var(--white-ms,420ms) ease-out both; }
@keyframes gfx-white { 0% { opacity: 0; } 55% { opacity: 1; } 100% { opacity: 1; } }
.gfx-white.is-off { animation: gfx-white-out 420ms ease-in both; }
@keyframes gfx-white-out { from { opacity: 1; } to { opacity: 0; } }

/* ── reveal ───────────────────────────────────────────────────────────── */
.gfx-reveal { position: absolute; inset: 0; z-index: 8; display: flex;
  align-items: center; justify-content: center; }

.gfx-rays {
  position: absolute; left: 50%; top: 50%; width: 150vmax; height: 150vmax;
  transform: translate(-50%,-50%); pointer-events: none; opacity: 0;
  /* REPEATING. A plain conic-gradient runs its stops once and then holds the
     last colour for the remaining 342 degrees — which drew a single wedge
     pointing straight up rather than a wheel of rays. */
  background: repeating-conic-gradient(from 0deg, var(--ray) 0deg 3deg, transparent 3deg 18deg);
  mask-image: radial-gradient(circle, transparent 8%, #000 26%, #000 45%, transparent 62%);
  -webkit-mask-image: radial-gradient(circle, transparent 8%, #000 26%, #000 45%, transparent 62%);
}
.gfx-rays.is-on { animation: gfx-rays-in 900ms ease-out both, gfx-spin 14s linear infinite; }
@keyframes gfx-rays-in { from { opacity: 0; transform: translate(-50%,-50%) scale(.6); }
                         to   { opacity: .5; transform: translate(-50%,-50%) scale(1); } }
@keyframes gfx-spin { to { transform: translate(-50%,-50%) rotate(360deg); } }

.gfx-ring {
  position: absolute; left: 50%; top: 50%; width: 240px; height: 240px;
  transform: translate(-50%,-50%); border-radius: 50%; pointer-events: none;
  border: 3px solid var(--ray); opacity: 0;
}
.gfx-ring.is-on { animation: gfx-ring 700ms cubic-bezier(.2,.8,.3,1) both; }
@keyframes gfx-ring {
  0%   { opacity: .9; transform: translate(-50%,-50%) scale(.2); }
  100% { opacity: 0;  transform: translate(-50%,-50%) scale(2.6); }
}

.gfx-prize { position: relative; z-index: 3; display: flex; flex-direction: column;
  align-items: center; gap: 20px; }

.gfx-prize-img {
  width: min(440px, 56vh); height: min(440px, 56vh); object-fit: contain;
  filter: brightness(0) drop-shadow(0 0 0 transparent);
  transform: translateX(-70vw);
}
.gfx-prize-img.is-pixel { image-rendering: pixelated; }
.gfx-prize-img.is-sliding {
  animation: gfx-slide var(--slide-ms,380ms) cubic-bezier(.15,.75,.25,1) both;
}
@keyframes gfx-slide {
  from { transform: translateX(-70vw) scale(.9); }
  to   { transform: translateX(0)     scale(1); }
}
/* The flash is what turns the silhouette into the item.
   Rounded + rim-lit on purpose: much of the item art is opaque white-background
   illustration, which reads as a bare rectangle pasted on the backdrop. The
   corner radius and rarity-tinted rim make that look like a lit artifact. */
.gfx-prize-img.is-lit {
  filter: brightness(1);
  border-radius: 18px;
  box-shadow:
    0 0 0 4px var(--ray),
    0 0 48px 10px var(--rayGlow, rgba(255,214,120,.5)),
    0 16px 40px rgba(0,0,0,.6);
  transition: filter 160ms ease-out, box-shadow 220ms ease-out;
}

.gfx-prize-name {
  font-family: "Trebuchet MS","Segoe UI",Verdana,sans-serif;
  font-size: 62px; font-weight: 800; font-style: italic; color: #fffdf6;
  text-align: center; opacity: 0;
  text-shadow: -2px -2px 0 #2a1c08, 2px -2px 0 #2a1c08, -2px 2px 0 #2a1c08,
                2px  2px 0 #2a1c08, 0 6px 18px rgba(0,0,0,.8);
}
.gfx-prize-stars { font-size: 42px; letter-spacing: 8px; color: var(--ray); opacity: 0;
  text-shadow: 0 2px 10px rgba(0,0,0,.8); }
.gfx-prize-name.is-on, .gfx-prize-stars.is-on {
  animation: gfx-pop 320ms cubic-bezier(.2,.9,.3,1.3) both;
}
@keyframes gfx-pop {
  from { opacity: 0; transform: translateY(16px) scale(.86); }
  to   { opacity: 1; transform: none; }
}

@keyframes gfx-shake {
  0%,100% { transform: translate(0,0); }
  20% { transform: translate(-9px, 5px); }
  40% { transform: translate(8px, -6px); }
  60% { transform: translate(-6px, -4px); }
  80% { transform: translate(5px, 4px); }
}
#${FX_ROOT_ID}.is-shaking { animation: gfx-shake 380ms ease-out; }

.gfx-counter {
  position: absolute; right: 22px; bottom: 20px; z-index: 20;
  font-family: 'Lucida Console','Courier New',monospace;
  font-size: 13px; letter-spacing: 3px; color: rgba(255,248,225,.62);
}

/* ── summary ──────────────────────────────────────────────────────────── */
.gfx-summary { position: absolute; inset: 0; z-index: 12; display: flex;
  flex-direction: column; align-items: center; justify-content: center; gap: 22px; }
/* Banner title, filling the dead space above the grid. Anchored to the root
   rather than flowing in the column: as a flex child it would push the cards
   off the centre line they are composed on. */
.gfx-summary-title {
  position: absolute; top: 9%; left: 50%; z-index: 1;
  transform: translateX(-50%);
  max-width: 80vw; text-align: center; pointer-events: none;
  font-size: 34px; font-weight: 600; letter-spacing: 7px; text-transform: uppercase;
  color: #f7ecd2;
  text-shadow: 0 0 22px rgba(230,178,96,.45), 0 2px 12px rgba(0,0,0,.65);
  animation: gfx-title-in 520ms cubic-bezier(.2,.8,.3,1) both;
}
/* Hairline under the name so it reads as a heading rather than loose text. */
.gfx-summary-title::after {
  content: ""; display: block; margin: 14px auto 0; width: 62%; height: 1px;
  background: linear-gradient(90deg,
    rgba(230,178,96,0), rgba(230,178,96,.75), rgba(230,178,96,0));
}
/* Down from above, matching the cards' own entrance direction. */
@keyframes gfx-title-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-26px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.gfx-summary-grid {
  display: grid; grid-template-columns: repeat(5, 186px); gap: 18px;
  justify-content: center;
}
.gfx-summary-grid.is-few { display: flex; gap: 20px; }
.gfx-card {
  width: 186px; padding: 16px 10px 14px; border-radius: 12px; text-align: center;
  background: linear-gradient(180deg, rgba(58,50,74,.96), rgba(30,25,42,.96));
  border: 2px solid var(--cc);
  box-shadow: 0 0 22px -6px var(--ccGlow), inset 0 0 26px -14px var(--cc);
  opacity: 0;
  animation: gfx-card-in 420ms cubic-bezier(.2,.8,.3,1) both;
  animation-delay: calc(var(--i) * var(--stagger, 70ms));
}
@keyframes gfx-card-in {
  from { opacity: 0; transform: translateY(-38px) scale(.9); }
  to   { opacity: 1; transform: none; }
}
.gfx-card img {
  width: 118px; height: 118px; object-fit: contain; display: block; margin: 0 auto 10px;
}
.gfx-card img.is-pixel { image-rendering: pixelated; }
.gfx-card-name { font-size: 14px; line-height: 1.3; color: #f2eee2; word-break: break-word; }
.gfx-card-stars { margin-top: 7px; font-size: 17px; color: var(--cc); letter-spacing: 2px; }

.gfx-anykey {
  font-family: 'Lucida Console','Courier New',monospace;
  font-size: 17px; letter-spacing: 7px; text-transform: uppercase;
  color: #f3e6c0; opacity: 0;
  animation: gfx-anykey-in 400ms ease-out both, gfx-anykey-pulse 1.9s ease-in-out infinite 400ms;
}
@keyframes gfx-anykey-in { to { opacity: 1; } }
@keyframes gfx-anykey-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .gfx-particle, .gfx-rays, .gfx-ring, .gfx-beam, .gfx-shock { display: none; }
  .gfx-card { animation-duration: 1ms; animation-delay: 0ms; }
}
`;

export function ensureFxStyle() {
  // The reveal can run for a spectator who never opened a panel, so it cannot
  // assume the theme tokens are already installed.
  ensureTheme();
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** Small sprites upscale to mush; snap those to nearest-neighbour. */
export function markPixel(img) {
  if (!img) return;
  const apply = () => img.classList.toggle("is-pixel", img.naturalWidth > 0 && img.naturalWidth < 256);
  if (img.complete) apply();
  else img.addEventListener("load", apply, { once: true });
}
