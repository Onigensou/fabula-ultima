// Round plate — the parchment banner that opens every round (and "Battle Start").
//
// The turn banner's sibling: same parchment, umber edge, gold hairlines and
// Cinzel lettering, but unslanted and symmetric, because a round belongs to
// neither side. It unrolls from the centre, holds while it is read, then
// either lifts toward the top and fades as the round bar assembles there
// ("dock"), or closes back to the centre ("close", battle start).
//
// When the round opens with an initiative (rolled side, advantage or ambush),
// a solid seal in that side's colour hangs from the plate's bottom edge with
// the words in white. The seal is the same width for every side, so the words
// sit on the plate's centre line whatever their length.
//
// Visual only: no sound (director-round-banner.js plays the cues on the same
// beats), never takes the pointer. Geometry is authored on a 1920×1080 stage
// and scaled to the window, like the turn banner. Approved mockup:
// claude.ai/artifact/AdJs3fgmJKtVqn4bWTf1sH (A · plate opens in place, colour seal).

import { warn } from "./logger.js";
import { registerAnimation } from "./director-surfaces.js";
import { pWait, shouldRender } from "./presentation-clock.js";

const STYLE_ID = "fu-round-plate-style";
const LAYER_ID = "fu-round-plate-layer";

const STAGE_W = 1920, STAGE_H = 1080;
const PLATE = { left: 470, top: 314, w: 980, h: 136 };
const SEAL_W = 640;
const SIDE = {
  party: { glow: "46,123,214", streak: "90,168,255", fill: "linear-gradient(180deg, #3f8ae0, #1f5aa0)" },
  enemy: { glow: "179,38,30", streak: "255,80,70", fill: "linear-gradient(180deg, #d2453a, #8e2219)" },
};
const GOLD_RGB = "213,182,122";
const GOLD_STREAK = "255,216,102";

// ── timing (ms from the plate start) ────────────────────────────────────
export const SEAL_AT_MS = 420;      // the seal opens (the initiative cue plays here)
const OPEN_MS = 420;
const TEXT_AT = 180, TEXT_MS = 240;
const SEAL_OPEN_MS = 340;
const HOLD_TO_MS = 1350;            // the plate starts to leave …
const SEAL_EXTRA_MS = 200;          // … this much later when it carries a seal
const DOCK_MS = 440;
const CLOSE_MS = 300;
const EASE_E = "cubic-bezier(.08,.82,.17,1)";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${LAYER_ID} { position: fixed; inset: 0; z-index: 99; pointer-events: none; overflow: hidden; }
#${LAYER_ID} .frp-stage { position: absolute; left: 50%; top: 50%; width: ${STAGE_W}px; height: ${STAGE_H}px; transform-origin: 50% 50%; }
.frp-fill { position: absolute; inset: 0; }
.frp-streak { position: absolute; height: 2px; border-radius: 2px; }
.frp-plate { position: absolute; left: ${PLATE.left}px; top: ${PLATE.top}px; width: ${PLATE.w}px; height: ${PLATE.h}px; }
.frp-shape { position: absolute; inset: 0; box-sizing: border-box; overflow: hidden;
  border-top: 2px solid #7a6a55; border-bottom: 2px solid #7a6a55;
  background: linear-gradient(180deg, #f6f1e6, #ebe3d0);
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 16%, #000 84%, transparent);
  mask-image: linear-gradient(90deg, transparent 0, #000 16%, #000 84%, transparent); }
.frp-shape::before { content: ""; position: absolute; z-index: 2; left: 0; right: 0; top: 4px; bottom: 4px;
  border-top: 1px solid #d5b67a; border-bottom: 1px solid #d5b67a; pointer-events: none; }
.frp-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 4; }
.frp-row { display: flex; align-items: center; gap: 22px; }
.frp-rule { width: 120px; height: 9px; position: relative; }
.frp-rule::before { content: ""; position: absolute; left: 0; right: 7px; top: 4px; height: 1px; background: linear-gradient(90deg, transparent, #d5b67a); }
.frp-rule::after { content: ""; position: absolute; right: 0; top: 0; width: 7px; height: 7px; transform: rotate(45deg); background: #d5b67a; box-shadow: 0 0 0 1px rgba(122,106,85,.5); }
.frp-rule.r { transform: scaleX(-1); }
/* letter-spacing trails after the last letter; the negative margin keeps the word on the centre line */
.frp-title { font: 900 84px/.9 "Cinzel", Georgia, serif; letter-spacing: .06em; margin-right: -.06em; color: #3a3228; white-space: nowrap;
  text-shadow: 0 0 2px #f6f1e6, 0 0 7px #f6f1e6, 0 0 16px rgba(246,241,230,.9); }
.frp-title.small { font-size: 66px; }
/* the seal: a solid tab in the side's colour, the round-bar spotlight's shape (wider at the top) */
.frp-seal { position: absolute; left: 50%; top: 108px; height: 60px; transform: translateX(-50%); z-index: 5; filter: drop-shadow(0 3px 6px rgba(0,0,0,.45)); }
.frp-seal-in { position: relative; height: 100%; width: ${SEAL_W}px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  background: #d5b67a; clip-path: polygon(0 0, 100% 0, calc(100% - 18px) 100%, 18px 100%); }
.frp-seal-fill { position: absolute; inset: 2px 3px; clip-path: polygon(0 0, 100% 0, calc(100% - 16px) 100%, 16px 100%); }
.frp-seal-fill::after { content: ""; position: absolute; left: 0; right: 0; top: 4px; bottom: 4px;
  border-top: 1px solid rgba(255,236,190,.55); border-bottom: 1px solid rgba(255,236,190,.55); }
.frp-seal-tx { position: relative; font: 900 32px/1 "Cinzel", Georgia, serif; letter-spacing: .12em; margin-right: -.12em; color: #fff;
  text-transform: uppercase; white-space: nowrap; text-shadow: 0 1px 0 rgba(0,0,0,.45), 0 0 10px rgba(0,0,0,.3); }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function ensureLayer() {
  ensureStyle();
  let layer = document.getElementById(LAYER_ID);
  if (!layer) {
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    document.body.appendChild(layer);
  }
  return layer;
}

function stageScale() {
  const w = window.innerWidth || STAGE_W, h = window.innerHeight || STAGE_H;
  return Math.min(w / STAGE_W, h / STAGE_H);
}

function div(cls, parent, text) {
  const e = document.createElement("div");
  e.className = cls;
  if (text != null) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function mulberry(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Light streaks bursting out from the centre as the plate opens.
function streaks(card, { at, rgb, seed }) {
  const rnd = mulberry(seed);
  for (let i = 0; i < 10; i++) {
    const len = 140 + rnd() * 300, y = 300 + rnd() * 170;
    const sgn = i % 2 ? 1 : -1;
    const x = STAGE_W / 2 - len / 2 + sgn * (120 + rnd() * 160);
    const s = div("frp-streak", card);
    s.style.left = `${x}px`; s.style.top = `${y}px`; s.style.width = `${len}px`;
    if (rnd() > .6) s.style.height = "3px";
    s.style.background = `linear-gradient(${sgn > 0 ? 90 : 270}deg, rgba(${rgb},0), rgba(${rgb},.95))`;
    s.style.boxShadow = `0 0 6px rgba(${rgb},.6)`;
    s.style.opacity = "0";
    s.animate([
      { opacity: 0, transform: "translateX(0)" },
      { opacity: 1, transform: `translateX(${sgn * 260}px)`, offset: .4 },
      { opacity: 0, transform: `translateX(${sgn * 700}px)` },
    ], { duration: 560, delay: at + i * 24, easing: "ease-out", fill: "both" });
  }
}

const NONE = Object.freeze({ leaving: Promise.resolve(), done: Promise.resolve() });

// Play one plate on THIS client.
//   title  — "Round 2" / "Battle Start" (Cinzel draws lowercase as small caps)
//   seal   — { side: "party"|"enemy", text } or null
//   exit   — "dock" (lift toward the round bar) | "close" (back to the centre)
// Returns { leaving, done }: `leaving` resolves as the plate starts to leave
// (the round bar assembles on that beat), `done` once it is gone. Nothing draws
// while nobody can see it (hidden window, unwatched sim); both resolve at once.
export function playRoundPlateLocal({ title = "", small = false, seal = null, exit = "dock" } = {}) {
  try {
    if (!shouldRender()) return NONE;
    const layer = ensureLayer();
    layer.replaceChildren();
    const stage = div("frp-stage", layer);
    stage.style.transform = `translate(-50%, -50%) scale(${stageScale()})`;
    const card = div("frp-fill", stage);

    const c = seal ? SIDE[seal.side === "enemy" ? "enemy" : "party"] : null;
    streaks(card, { at: 60, rgb: c ? c.streak : GOLD_STREAK, seed: 5 });

    const p = div("frp-plate", card);
    p.style.filter = `drop-shadow(0 0 14px rgba(${c ? c.glow : GOLD_RGB},.5)) drop-shadow(0 10px 18px rgba(0,0,0,.42))`;
    const shape = div("frp-shape", p);
    const tx = div("frp-text", p);
    const row = div("frp-row", tx);
    div("frp-rule", row);
    div("frp-title" + (small ? " small" : ""), row, title);
    div("frp-rule r", row);

    shape.animate([{ clipPath: "inset(0 50% 0 50%)" }, { clipPath: "inset(0 0% 0 0%)" }],
      { duration: OPEN_MS, easing: EASE_E, fill: "both" });
    p.animate([{ transform: "scaleY(.6)" }, { transform: "scaleY(1)" }], { duration: 300, easing: EASE_E, fill: "both" });
    tx.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TEXT_MS, delay: TEXT_AT, easing: "ease-out", fill: "both" });

    if (c) {
      const sw = div("frp-seal", p);
      const inner = div("frp-seal-in", sw);
      div("frp-seal-fill", inner).style.background = c.fill;
      div("frp-seal-tx", inner, seal.text ?? "");
      sw.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: SEAL_AT_MS, easing: "ease-out", fill: "both" });
      inner.animate([{ clipPath: "inset(0 50% 0 50%)" }, { clipPath: "inset(0 0% 0 0%)" }],
        { duration: SEAL_OPEN_MS, delay: SEAL_AT_MS, easing: EASE_E, fill: "both" });
    }

    const leaveAt = HOLD_TO_MS + (c ? SEAL_EXTRA_MS : 0);
    let leaveMs;
    if (exit === "close") {
      leaveMs = CLOSE_MS;
      shape.animate([{ clipPath: "inset(0 0% 0 0%)" }, { clipPath: "inset(0 50% 0 50%)" }],
        { duration: CLOSE_MS, delay: leaveAt, easing: "cubic-bezier(.6,0,.9,.4)", fill: "forwards" });
      tx.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: leaveAt, fill: "forwards" });
      p.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, delay: leaveAt, fill: "forwards" });
    } else {
      leaveMs = DOCK_MS;
      // lifts toward the round bar and fades as the bar assembles there
      p.animate([
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-300px) scale(.42)" },
      ], { duration: DOCK_MS, delay: leaveAt, easing: "cubic-bezier(.5,0,.75,0)", fill: "forwards" });
    }
    registerAnimation({ kind: "round-plate", durationMs: leaveAt + leaveMs });

    const leaving = pWait(leaveAt);
    const done = pWait(leaveAt + leaveMs).then(() => { try { stage.remove(); } catch { /* gone */ } });
    // Safety: never leave a plate on screen (a hidden window that stopped the clock).
    setTimeout(() => { try { stage.remove(); } catch { /* gone */ } }, leaveAt + leaveMs + 3000);
    return { leaving, done };
  } catch (e) {
    warn("playRoundPlateLocal threw", e);
    return NONE;
  }
}
