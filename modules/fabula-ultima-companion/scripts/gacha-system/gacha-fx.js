// ============================================================================
// Gacha System — Reveal animation
// ----------------------------------------------------------------------------
// ONE sequence whose star count equals the pull count. A x10 is not the x1
// animation played ten times — it is the same beats with ten stars in the sky,
// so a ten-pull costs about as much wall-clock as a single.
//
//   darken -> streak (N stars) -> warm -> hold -> burst -> reveal
//                                 \_______________/
//                                  the anticipation beat, ported verbatim
//                                  from the v2.7 macro (8 x 120ms warm, then
//                                  a 400ms hold). Only the DELIVERY changed:
//                                  that macro spent 8 ChatMessage.update()
//                                  calls per pull -- 80 broadcast document
//                                  writes for a x10 -- to do what one CSS
//                                  keyframe does here.
//
// The streak colour is the BEST rarity in the batch. That is where the
// anticipation lands; which specific card is the gold one stays hidden until
// the reveal grid.
//
// Performance rules held throughout:
//   * only `transform` and `opacity` are animated (compositor-only, no layout)
//   * stars and cards are <=10 nodes each, staggered by CSS animation-delay,
//     so there is NO per-frame JavaScript anywhere in this file
//   * orchestration uses timers, never requestAnimationFrame -- rAF stalls on
//     a background tab and has hung this codebase before
//   * SFX play LOCALLY: every client runs this animation, so broadcasting the
//     sound would stack one copy per connected client
// ============================================================================

import { GACHA, RARITY, FX, bestRarity } from "./gacha-const.js";

const ROOT_ID  = "gacha-fx";
const STYLE_ID = "gacha-fx-style";

const SFX = {
  start:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/TreasureGet.ogg",
  rare:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success2.ogg",
  normal: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ItemGet.ogg",
};

const sfx = (key) => {
  try { AudioHelper?.play({ src: SFX[key], volume: 0.7, loop: false }, false); } catch {}
};

let _active = null; // { skip: boolean, el: HTMLElement }

// ── Stylesheet ──────────────────────────────────────────────────────────────

const CSS = `
#${ROOT_ID} {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4,6,16,0);
  transition: background ${FX.DARKEN}ms ease-out;
  user-select: none; cursor: pointer;
  overflow: hidden;
}
#${ROOT_ID}.is-dark { background: rgba(4,6,16,0.92); }

/* ── streak ─────────────────────────────────────────────────────────────── */
.gfx-sky { position: absolute; inset: 0; pointer-events: none; }

.gfx-star {
  position: absolute; top: 0; left: 0;
  width: 6px; height: 6px; border-radius: 50%;
  background: #cfd6e6;
  box-shadow: 0 0 12px 4px rgba(207,214,230,0.85);
  opacity: 0;
  transform: translate3d(var(--x0), var(--y0), 0);
  animation:
    gfx-fly ${FX.STREAK}ms cubic-bezier(.22,.61,.36,1) forwards,
    gfx-warm ${FX.WARM}ms ease-in-out forwards;
  animation-delay:
    calc(var(--i) * ${FX.STAR_STAGGER}ms),
    calc(${FX.STREAK}ms + var(--i) * ${FX.STAR_STAGGER}ms);
}
.gfx-star::after {
  content: ""; position: absolute; right: 3px; top: 50%;
  width: 90px; height: 2px; transform: translateY(-50%);
  background: linear-gradient(to left, currentColor, transparent);
  opacity: .55;
}
@keyframes gfx-fly {
  0%   { opacity: 0; transform: translate3d(var(--x0), var(--y0), 0) scale(.6); }
  12%  { opacity: 1; }
  100% { opacity: 1; transform: translate3d(var(--x1), var(--y1), 0) scale(1); }
}
@keyframes gfx-warm {
  0%   { background: #cfd6e6; box-shadow: 0 0 12px 4px rgba(207,214,230,0.85); }
  100% { background: var(--rc); box-shadow: 0 0 26px 10px var(--rcGlow); }
}

/* ── burst ──────────────────────────────────────────────────────────────── */
.gfx-burst {
  position: absolute; width: 14px; height: 14px; border-radius: 50%;
  background: var(--rc); opacity: 0;
  transform: scale(0);
}
.gfx-burst.is-on {
  animation: gfx-burst ${FX.BURST}ms ease-out forwards;
}
@keyframes gfx-burst {
  0%   { opacity: 1; transform: scale(0); box-shadow: 0 0 40px 16px var(--rcGlow); }
  100% { opacity: 0; transform: scale(90); box-shadow: 0 0 0 0 var(--rcGlow); }
}

/* ── reveal ─────────────────────────────────────────────────────────────── */
.gfx-results {
  display: flex; flex-wrap: wrap; gap: 14px;
  align-items: center; justify-content: center;
  max-width: min(1100px, 88vw);
  z-index: 2;
}
.gfx-card {
  width: 118px; padding: 12px 8px 10px;
  border-radius: 10px; text-align: center;
  background: linear-gradient(180deg, rgba(28,32,48,.95), rgba(14,16,26,.95));
  border: 1px solid var(--cc);
  box-shadow: 0 0 22px -4px var(--ccGlow), inset 0 0 26px -12px var(--cc);
  opacity: 0; transform: translate3d(0, 18px, 0) scale(.92);
  animation: gfx-pop 320ms cubic-bezier(.2,.8,.3,1) forwards;
  animation-delay: calc(var(--i) * ${FX.REVEAL_STEP}ms);
}
.gfx-card.is-solo { width: 190px; padding: 18px 12px 14px; }
@keyframes gfx-pop {
  to { opacity: 1; transform: translate3d(0,0,0) scale(1); }
}
.gfx-card img {
  width: 74px; height: 74px; object-fit: contain;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
  background: transparent; display: block; margin: 0 auto 8px;
}
.gfx-card.is-solo img { width: 118px; height: 118px; }
.gfx-card-name {
  font-size: 12px; line-height: 1.25; color: #eef1f8;
  text-shadow: 0 1px 3px rgba(0,0,0,.9);
  word-break: break-word;
}
.gfx-card.is-solo .gfx-card-name { font-size: 15px; }
.gfx-card-stars { margin-top: 5px; font-size: 13px; color: var(--cc); letter-spacing: 1px; }

/* ── chrome ─────────────────────────────────────────────────────────────── */
.gfx-banner-label {
  position: absolute; top: 6vh; left: 0; right: 0; text-align: center;
  font-size: 13px; letter-spacing: 6px; text-transform: uppercase;
  color: #b9c2d8; text-shadow: 0 1px 6px rgba(0,0,0,.9);
  opacity: 0; animation: gfx-fade 400ms ease-out forwards; z-index: 2;
}
.gfx-skip {
  position: absolute; bottom: 5vh; left: 0; right: 0; text-align: center;
  font-size: 11px; letter-spacing: 3px; text-transform: uppercase;
  color: rgba(200,208,226,.55); z-index: 2;
  opacity: 0; animation: gfx-fade 500ms ease-out 700ms forwards;
}
@keyframes gfx-fade { to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .gfx-star, .gfx-burst { display: none; }
  .gfx-card { animation-duration: 1ms; animation-delay: 0ms; }
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ── Timing helper ───────────────────────────────────────────────────────────
// Deliberately setTimeout and not animationend/rAF: a background tab never
// fires animationend and stalls rAF outright, which would leave the overlay
// wedged on screen. Timers still fire (throttled), so the sequence always
// completes and always tears down.
function phase(ms, state) {
  return new Promise((resolve) => {
    if (state.skip) return resolve();
    const t = setTimeout(resolve, ms);
    state.timers.push(t);
  });
}

const rgba = (hex, a) => {
  const h = String(hex).replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Play a reveal. Safe to call on any client; spectators see the same thing.
 * @param {{bannerName:string, results:Array<{rarity,name,img,uuid}>}} payload
 */
export async function playReveal({ bannerName, results } = {}) {
  if (!Array.isArray(results) || !results.length) return;

  // A hidden or inactive tab renders nothing — the chat receipt still lands,
  // so the player misses the show, not the outcome.
  if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return;

  stop(); // never stack two sequences

  ensureStyle();

  const best  = bestRarity(results.map((r) => r.rarity));
  const color = RARITY[best].color;
  const state = { skip: false, timers: [] };

  const el = document.createElement("div");
  el.id = ROOT_ID;
  el.style.setProperty("--rc", color);
  el.style.setProperty("--rcGlow", rgba(color, 0.55));

  const sky = document.createElement("div");
  sky.className = "gfx-sky";
  sky.innerHTML = results.map((_, i) => starHTML(i, results.length)).join("");

  const burst = document.createElement("div");
  burst.className = "gfx-burst";

  const label = document.createElement("div");
  label.className = "gfx-banner-label";
  label.textContent = bannerName ?? "";

  const skip = document.createElement("div");
  skip.className = "gfx-skip";
  skip.textContent = "Click or press ESC to skip";

  el.append(sky, burst, label, skip);
  document.body.appendChild(el);

  const onSkip = () => { state.skip = true; finish(el, state, results, true); };
  const onKey = (ev) => { if (ev.key === "Escape") onSkip(); };
  el.addEventListener("click", onSkip);
  window.addEventListener("keydown", onKey);

  _active = { state, el, cleanup: () => window.removeEventListener("keydown", onKey) };

  // ── sequence ──
  sfx("start");
  requestAnimationFrame(() => el.classList.add("is-dark")); // one frame, to let the transition take
  await phase(FX.DARKEN, state);
  if (state.skip) return;

  const flight = FX.STREAK + (results.length - 1) * FX.STAR_STAGGER;
  await phase(flight, state);
  if (state.skip) return;

  await phase(FX.WARM, state);
  if (state.skip) return;

  await phase(FX.HOLD, state);          // ← the beat
  if (state.skip) return;

  sfx(best === "five" ? "rare" : "normal");
  burst.classList.add("is-on");
  sky.style.opacity = "0";
  sky.style.transition = "opacity 160ms linear";
  await phase(FX.BURST, state);
  if (state.skip) return;

  finish(el, state, results, false);
}

function starHTML(i, total) {
  // Spread launch points across the top edge and converge toward centre. All
  // values are baked into CSS custom properties so the motion is pure CSS.
  const spread = total === 1 ? 0 : (i / (total - 1)) - 0.5; // -0.5 .. 0.5
  const x0 = `${50 + spread * 70}vw`;
  const y0 = `-12vh`;
  const x1 = `${50 + spread * 12}vw`;
  const y1 = `${48 + Math.abs(spread) * 6}vh`;
  return `<div class="gfx-star" style="--i:${i};--x0:${x0};--y0:${y0};--x1:${x1};--y1:${y1};color:var(--rc)"></div>`;
}

/** Swap the sky for the results grid. Idempotent — skip and natural end share it. */
function finish(el, state, results, skipped) {
  if (state.done) return;
  state.done = true;
  for (const t of state.timers) clearTimeout(t);

  const solo = results.length === 1;
  const grid = document.createElement("div");
  grid.className = "gfx-results";
  grid.innerHTML = results
    .map((r, i) => {
      const c = RARITY[r.rarity];
      return `
        <div class="gfx-card${solo ? " is-solo" : ""}"
             style="--i:${skipped ? 0 : i};--cc:${c.color};--ccGlow:${rgba(c.color, 0.5)}">
          <img src="${r.img}" alt="">
          <div class="gfx-card-name">${foundry.utils.escapeHTML?.(r.name) ?? r.name}</div>
          <div class="gfx-card-stars">${"★".repeat(c.stars)}</div>
        </div>`;
    })
    .join("");

  el.querySelector(".gfx-sky")?.remove();
  el.querySelector(".gfx-burst")?.remove();
  el.appendChild(grid);

  // Dismiss on the next click rather than auto-closing: players want to read
  // a ten-pull, and a timer that beats them to it is worse than one more click.
  const dismiss = () => stop();
  setTimeout(() => el.addEventListener("click", dismiss, { once: true }), 250);
}

/** Tear down immediately. Safe to call when nothing is playing. */
export function stop() {
  if (!_active) return;
  const { state, el, cleanup } = _active;
  state.skip = true;
  state.done = true;
  for (const t of state.timers ?? []) clearTimeout(t);
  cleanup?.();
  el?.remove();
  _active = null;
}
