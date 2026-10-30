// Round plate — the parchment banner that opens every round (and "Battle Start").
//
// The turn banner's sibling: same parchment, umber edge, gold hairlines and
// Cinzel lettering, but unslanted and symmetric, because a round belongs to
// neither side. It unrolls from the centre, holds while it is read, then
// either lifts toward the top and fades as the round bar assembles there
// ("dock"), or closes back to the centre ("close", battle start).
//
// When the round opens with an initiative (rolled side, advantage or ambush),
// a pennant in that side's colour drops in just below the plate (a small gap
// keeps the plate the heavier of the two), its winning end drawn into an arrow
// that points at that side's half of the field (party right, enemy left). The
// words sit on the plate's centre line whatever their length (see pennant()
// for how each side's shape is placed around them). Streaks pour in from that side and its screen edge lights up (the
// "edge flare", a separate screen-blended layer so it brightens the canvas).
//
// Visual only: no sound (director-round-banner.js plays the cues on the same
// beats), never takes the pointer. Geometry is authored on a 1920×1080 stage
// and scaled to the window, like the turn banner. Approved mockups:
// claude.ai/artifact/AdJs3fgmJKtVqn4bWTf1sH (A · plate opens in place) and
// claude.ai/artifact/Q9Hf1L7owpjMBoJ5Xzgkaa (A · pennant seal + edge flare).

import { warn } from "./logger.js";
import { registerAnimation } from "./director-surfaces.js";
import { pWait, shouldRender } from "./presentation-clock.js";

const STYLE_ID = "fu-round-plate-style";
const LAYER_ID = "fu-round-plate-layer";
const FLARE_ID = "fu-round-plate-flare";

const STAGE_W = 1920, STAGE_H = 1080;
const PLATE = { left: 470, top: 314, w: 980, h: 136 };
const PLATE_TOP_SEALED = 286;       // lifted so plate + gap + pennant stay centred where the plate alone was
// pennant: BODY wide (centred under the plate), the arrow adds TIP on the winning side
const PEN = { body: 700, tip: 90, h: 84, gap: 18 };
const FLARE_W = 760;
const SIDE = {
  party: { glow: "46,123,214", streak: "90,168,255", top: "#3f8ae0", bot: "#1f5aa0" },
  enemy: { glow: "179,38,30", streak: "255,80,70", top: "#d2453a", bot: "#8e2219" },
};
const GOLD_RGB = "213,182,122";
const GOLD_STREAK = "255,216,102";

// ── timing (ms from the plate start) ────────────────────────────────────
export const SEAL_AT_MS = 420;      // the pennant drops in (the initiative cue plays here)
const OPEN_MS = 420;
const TEXT_AT = 180, TEXT_MS = 240;
const SEAL_OPEN_MS = 360;
const HOLD_TO_MS = 1350;            // the plate starts to leave …
const SEAL_EXTRA_MS = 400;          // … this much later when it carries a pennant
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
/* the pennant: a tab in the side's colour below the plate, its winning end an arrow (drawn for the party; mirrored for the enemy) */
.frp-pen { position: absolute; top: ${PLATE.h + PEN.gap}px; width: ${PEN.body + PEN.tip}px; height: ${PEN.h}px; z-index: 5; filter: drop-shadow(0 4px 8px rgba(0,0,0,.5)); }
.frp-pen svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.frp-pen.enemy svg { transform: scaleX(-1); }
.frp-pen-tx { position: absolute; top: 0; width: ${PEN.body}px; height: 100%; display: flex; align-items: center; justify-content: center;
  font: 900 42px/1 "Cinzel", Georgia, serif; letter-spacing: .1em; text-indent: .1em; color: #fff; text-transform: uppercase; white-space: nowrap;
  text-shadow: 0 2px 0 rgba(0,0,0,.4), 0 0 14px rgba(0,0,0,.35); }
.frp-pen.party .frp-pen-tx { left: ${PEN.tip / 2}px; }
.frp-pen.enemy .frp-pen-tx { left: ${PEN.tip}px; }
.frp-pen-glint { position: absolute; left: 0; top: 6px; bottom: 6px; width: 120px; background: linear-gradient(90deg, transparent, rgba(255,246,220,.55), transparent); mix-blend-mode: screen; }
/* edge flare: its own layer so screen-blending lightens the canvas under it (inside the plate layer it would blend with nothing) */
#${FLARE_ID} { position: fixed; inset: 0; z-index: 99; pointer-events: none; overflow: hidden; mix-blend-mode: screen; }
.frp-flare { position: absolute; top: 0; bottom: 0; }
.frp-flare-line { position: absolute; top: 0; bottom: 0; width: 6px; }
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

// Streaks pouring in from the winning side's edge toward the middle.
function rush(card, { at, rgb, dir }) {
  const rnd = mulberry(11);
  for (let i = 0; i < 14; i++) {
    const len = 220 + rnd() * 420, y = 250 + rnd() * 330;
    const s = div("frp-streak", card);
    s.style.left = `${dir > 0 ? STAGE_W + 40 : -40 - len}px`; s.style.top = `${y}px`; s.style.width = `${len}px`;
    if (rnd() > .55) s.style.height = "3px";
    s.style.background = `linear-gradient(${dir > 0 ? 90 : 270}deg, rgba(${rgb},.95), rgba(${rgb},0))`;
    s.style.boxShadow = `0 0 7px rgba(${rgb},.6)`;
    s.style.opacity = "0";
    const travel = -dir * (900 + rnd() * 500);
    s.animate([
      { opacity: 0, transform: "translateX(0)" },
      { opacity: 1, transform: `translateX(${travel * .35}px)`, offset: .3 },
      { opacity: 0, transform: `translateX(${travel}px)` },
    ], { duration: 620, delay: at + i * 18, easing: "cubic-bezier(.2,.7,.3,1)", fill: "both" });
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.appendChild(e);
  return e;
}

// The initiative pennant, hung below the plate (plate-local coordinates).
function pennant(p, { side, text, c, dir }) {
  const { body: B, tip: T, h: H } = PEN;
  const pen = div(`frp-pen ${side}`, p);
  // The words always sit on the plate's centre line. The enemy's arrow sticks out
  // to the left of a centred body; the party's whole shape is centred instead
  // (body nudged left by half the arrow), because an arrow sticking out to the
  // right read as off-centre — the chat sidebar already crowds that side.
  pen.style.left = `${PLATE.w / 2 - B / 2 - (dir > 0 ? T / 2 : T)}px`;
  const svg = svgEl("svg", { viewBox: `0 0 ${B + T} ${H}` }, pen);
  const gid = `frp-pen-g-${side}`;
  const g = svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, svgEl("defs", {}, svg));
  svgEl("stop", { offset: 0, "stop-color": c.top }, g);
  svgEl("stop", { offset: 1, "stop-color": c.bot }, g);
  svgEl("path", { d: `M2 2 H${B} L${B + T - 4} ${H / 2} L${B} ${H - 2} H22 Z`, fill: `url(#${gid})`, stroke: "#d5b67a", "stroke-width": 3 }, svg);
  svgEl("path", { d: `M13 8 H${B - 5} L${B + T - 20} ${H / 2} L${B - 5} ${H - 8} H27 Z`, fill: "none", stroke: "rgba(255,236,190,.55)", "stroke-width": 1 }, svg);
  for (let i = 0; i < 3; i++) {
    const x = B + 8 + i * 18;
    svgEl("path", { d: `M${x} ${H / 2 - 12} L${x + 12} ${H / 2} L${x} ${H / 2 + 12}`, fill: "none", stroke: "rgba(255,240,205,.9)",
      "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
  }
  div("frp-pen-tx", pen, text ?? "");
  const glint = div("frp-pen-glint", pen);

  // drops onto its spot as it opens from the centre, then a glint runs toward the point
  pen.animate([
    { opacity: 0, transform: "translateY(-34px)" },
    { opacity: 1, transform: "translateY(5px)", offset: .6 },
    { opacity: 1, transform: "translateY(0)" },
  ], { duration: SEAL_OPEN_MS, delay: SEAL_AT_MS, easing: "cubic-bezier(.3,.9,.4,1)", fill: "both" });
  svg.animate([{ clipPath: "inset(0 50% 0 50%)" }, { clipPath: "inset(0 0% 0 0%)" }],
    { duration: SEAL_OPEN_MS, delay: SEAL_AT_MS, easing: EASE_E, fill: "both" });
  const from = dir > 0 ? 40 : B - 60, to = dir > 0 ? B - 60 : 40;
  glint.animate([
    { opacity: 0, transform: `translateX(${from}px)` },
    { opacity: 1, offset: .2 },
    { opacity: 0, transform: `translateX(${to}px)` },
  ], { duration: 620, delay: SEAL_AT_MS + 300, easing: "ease-in-out", fill: "both" });
}

// The winning side's screen edge lights up as the pennant lands and fades as the plate leaves.
function edgeFlare(root, { c, dir, scale, untilMs }) {
  const at = SEAL_AT_MS - 80;
  const edge = dir > 0 ? "right" : "left";
  // the party's edge is the battlefield's, not the window's: start at the chat sidebar when it is open
  let inset = 0;
  if (dir > 0) {
    const sb = document.getElementById("sidebar")?.getBoundingClientRect();
    if (sb && sb.width > 0 && sb.left > window.innerWidth / 2) inset = Math.max(0, Math.round(window.innerWidth - sb.left));
  }
  const f = div("frp-flare", root);
  f.style[edge] = `${inset}px`;
  f.style.width = `${Math.round(FLARE_W * scale)}px`;
  f.style.background = `linear-gradient(${dir > 0 ? 270 : 90}deg, rgba(${c.glow},.62), rgba(${c.glow},.22) 38%, rgba(${c.glow},0))`;
  const line = div("frp-flare-line", root);
  line.style[edge] = `${inset}px`;
  line.style.background = `rgba(${c.streak},.9)`;
  line.style.boxShadow = `0 0 24px 8px rgba(${c.streak},.7)`;
  for (const e of [f, line]) {
    e.animate([{ opacity: 0 }, { opacity: 1, offset: .18 }, { opacity: .7, offset: .75 }, { opacity: 0 }],
      { duration: untilMs - at, delay: at, easing: "linear", fill: "both" });
  }
}

function ensureFlareLayer(beforeEl) {
  let fl = document.getElementById(FLARE_ID);
  if (!fl) {
    fl = document.createElement("div");
    fl.id = FLARE_ID;
    document.body.insertBefore(fl, beforeEl); // under the plate
  }
  return fl;
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
    const flareLayer = ensureFlareLayer(layer);
    flareLayer.replaceChildren();
    const scale = stageScale();
    const stage = div("frp-stage", layer);
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    const card = div("frp-fill", stage);

    const side = seal ? (seal.side === "enemy" ? "enemy" : "party") : null;
    const c = side ? SIDE[side] : null;
    const dir = side === "enemy" ? -1 : 1; // party stands on the right, enemies on the left
    streaks(card, { at: 60, rgb: GOLD_STREAK, seed: 5 });
    if (c) rush(card, { at: SEAL_AT_MS - 100, rgb: c.streak, dir });

    const p = div("frp-plate", card);
    if (c) p.style.top = `${PLATE_TOP_SEALED}px`;
    p.style.filter = c
      ? `drop-shadow(0 0 22px rgba(${c.glow},.75)) drop-shadow(0 10px 18px rgba(0,0,0,.42))`
      : `drop-shadow(0 0 14px rgba(${GOLD_RGB},.5)) drop-shadow(0 10px 18px rgba(0,0,0,.42))`;
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

    const leaveAt = HOLD_TO_MS + (c ? SEAL_EXTRA_MS : 0);
    if (c) {
      pennant(p, { side, text: seal.text, c, dir });
      edgeFlare(flareLayer, { c, dir, scale, untilMs: leaveAt + 420 });
    }

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

    const flares = [...flareLayer.children];
    const clear = () => { try { stage.remove(); for (const f of flares) f.remove(); } catch { /* gone */ } };
    const leaving = pWait(leaveAt);
    const done = pWait(Math.max(leaveAt + leaveMs, c ? leaveAt + 420 : 0)).then(clear);
    // Safety: never leave a plate on screen (a hidden window that stopped the clock).
    setTimeout(clear, leaveAt + leaveMs + 3000);
    return { leaving, done };
  } catch (e) {
    warn("playRoundPlateLocal threw", e);
    return NONE;
  }
}
