// Turn-start cue — announces whose turn it is before anything happens to them.
//
// Before this, TURN_START had no announcement: Active Effects ticked, Guard
// released and turn_start reactions fired before anything said whose turn it
// was. Now every creature turn (a 2nd turn included) opens with:
//
//   0 s      the side's sound + the TURN BANNER (every client)
//   0.4 s    the name has landed → round-bar spotlight swap + token glow
//            (both via director-round-banner.js) + the SHORT STEP out
//   0.86 s   the actor is in place → turn-start effects (TURN_START body)
//   1.3 s    input allowed (DECLARE / autopilot thinking)
//
// "Overlap" order: the banner never blocks input. It is visual only, it never
// takes the pointer, and a click or any key sends it out early.
//
// Banner: a parchment band (the battle-UI family: plate tokens of
// director-player-hud.js) that passes across the middle of the screen as ONE
// rigid piece — a SlowMo pass: fast in, a slow drift while it is read, then it
// accelerates out the OPPOSITE side. Party enters from the right, enemies from
// the left. The actor's portrait sits inside the band between the gold
// hairlines, fading only toward the name. Geometry is authored on a 1920×1080
// stage and scaled to the window. Approved mockup:
// claude.ai/artifact/G97w6tP5vr8eMcKshksdZq (v12).
//
// Short step: once the name has landed the actor makes a plain move (no hop,
// no walk) of ~110 px toward the enemy side, and moves back when its turn
// ends. It is a REAL token move, because animation scripts read the token
// placeable's position (director-animation.js) — effects fire from the new
// spot. The home spot is saved on the token (flags.<ns>.turnStepHome), so a
// token left forward by a rewind, a reload or a crash is walked home by the
// next TURN_START, by battle end, or by stop().
//
// Banner art: the actor's portrait (actor.img), framed by the per-actor
// flags.<ns>.bannerFocus (Icon Adjuster → Turn banner). With no portrait (or
// the portrait IS the token image) it falls back to the token texture framed by
// the round-bar iconFocus.

import { log, warn } from "./logger.js";
import { playSfx, preloadSfx } from "./director-sfx.js";
import { registerAnimation } from "./director-surfaces.js";
import { pWait, interval, isDwellSuppressed, shouldRender, hasOtherViewers } from "./presentation-clock.js";

const MODULE_ID = "fabula-ultima-companion";
const SETTING_KEY = "bdTurnStartCues";
const ACTION_PLAY = "FU_DIRECTOR_TURN_BANNER_PLAY";
const STYLE_ID = "fu-turn-cue-style";
const LAYER_ID = "fu-turn-cue-layer";
const FONT_LINK_ID = "fu-turn-cue-fonts";
const HOME_FLAG = "turnStepHome";
export const BANNER_FOCUS_FLAG = "bannerFocus";
// Fired on the GM when the name has landed — the round bar swaps its spotlight
// (and with it the token glow) on this beat.
export const CUE_LANDED_HOOK = "fu-director-turn-cue-landed";

const SFX_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
const SFX = {
  party: SFX_BASE + "ffxiv_sps05001_mp3/FFXIV_Notification.mp3",
  enemy: SFX_BASE + "ffxiv_sps05001_mp3/FFXIV_Aggro.mp3",
};
const SFX_VOL = 0.6;

// ── timing (ms from the cue start) ──────────────────────────────────────
const LANDED_MS = 400;              // name has landed
const STEP_MS = 380;                // the step out (and back)
const EFFECTS_MS = LANDED_MS + STEP_MS + 80;    // 860 — actor in place
const INPUT_MS = EFFECTS_MS + 450;              // 1310 — input allowed
const IN_MS = 420;                  // banner: fast in
const OUT_MS = 340;                 // banner: accelerate out
const EXIT_AT_MS = 1150;            // banner: drift ends, exit starts
const DRIFT_PX = 90;
const TEXT_FADE_AT = 160, TEXT_FADE_MS = 220;
const SKIP_MS = 240;
// The step: ~110 screen px on a 1920-wide view, converted to canvas units.
const STEP_REF_PX = 110;
// Waiting on the round-opening cinematic (round plate + the bar assembling).
const ROUND_CINEMATIC_MAX_MS = 8000;

// ── banner geometry (1920×1080 stage, from the mockup) ──────────────────
const STAGE_W = 1920, STAGE_H = 1080;
const BAND = { left: 430, top: 318, w: 1060, h: 128 };
// Portrait box inside the band, between the hairlines. Party: right part of
// the band; enemy: left part.
const ART = { w: 300, h: 114, partyLeft: 720, enemyLeft: 40 };
const NAME_PX = 78;
const NAME_MAX_W = 700;
const TEXT_EDGE = 724;              // party: right inset; enemy: left inset
const RGB = {
  party: { glow: "46,123,214", streak: "90,168,255", ink: "#1f5aa0" },
  enemy: { glow: "179,38,30", streak: "255,80,70", ink: "#b3261e" },
};

export const BANNER_FOCUS_DEFAULT = Object.freeze({ x: 50, y: 30, zoom: 1 });
const ICON_FOCUS_DEFAULT = Object.freeze({ x: 50, y: 0, zoom: 2 });
const NO_PORTRAIT = new Set(["", "icons/svg/mystery-man.svg"]);

let _socket = null;
let _live = null;   // the banner on screen: { card, mover, moverAnim, dir, far, outStreaks, done }

// ── settings + boot ─────────────────────────────────────────────────────

Hooks.once("init", () => {
  try {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Battle: turn-start cues",
      hint: "Every creature turn opens with a turn banner and a sound, the acting creature glows for its whole turn, and it takes a short step toward the enemy while it acts.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });
  } catch (e) { warn("turn-start-cue: setting registration failed", e); }
});

export function isTurnCueEnabled() {
  try { return game.settings.get(MODULE_ID, SETTING_KEY) !== false; }
  catch { return true; }
}

// Will the GM-side cue run for the next turn? A sim that does not watch (dwell
// suppressed) skips it; so does the setting.
export function turnCueWillRun() {
  return isTurnCueEnabled() && !isDwellSuppressed();
}

// Every client, once at ready.
export function initTurnStartCue() {
  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(MODULE_ID);
      _socket.register(ACTION_PLAY, (payload) => playTurnBannerLocal(payload));
    } else {
      warn("turn-start-cue: socketlib unavailable — the banner stays local-only");
    }
  } catch (e) { warn("turn-start-cue: socket init failed", e); }
  try {
    ensureStyle();
    mountFonts();
    preloadSfx([SFX.party, SFX.enemy]);
  } catch (e) { warn("turn-start-cue: warm-up failed", e); }
  log("turn-start-cue: ready");
}

function mountFonts() {
  if (document.getElementById(FONT_LINK_ID)) return;
  const link = document.createElement("link");
  link.id = FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&display=swap";
  document.head.appendChild(link);
  try { document.fonts?.load?.(`900 ${NAME_PX}px Cinzel`); } catch { /* measured with the fallback */ }
}

// ── art + focus ─────────────────────────────────────────────────────────

const clampPct = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : d; };
const clampZoom = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(6, Math.max(1, n)) : d; };
const normalizeFocus = (raw, def) => ({
  x: clampPct(raw?.x, def.x), y: clampPct(raw?.y, def.y), zoom: clampZoom(raw?.zoom, def.zoom),
});

export function normalizeBannerFocus(raw) { return normalizeFocus(raw, BANNER_FOCUS_DEFAULT); }

export const isVideoSrc = (u) => /\.(webm|mp4|m4v|ogv)(\?|#|$)/i.test(String(u ?? ""));

// Which image the banner shows for an actor, and how it is framed.
// `baseActor` = the WORLD actor (focus flags live there, shared by every copy).
export function bannerArtFor(baseActor, tokenDoc) {
  const portrait = String(baseActor?.img ?? "").trim();
  const tokenSrc = String(tokenDoc?.texture?.src ?? baseActor?.prototypeToken?.texture?.src ?? "").trim();
  const hasPortrait = !NO_PORTRAIT.has(portrait) && portrait !== tokenSrc;
  if (hasPortrait) {
    return { src: portrait, portrait: true,
      focus: normalizeBannerFocus(baseActor?.getFlag?.(MODULE_ID, BANNER_FOCUS_FLAG)) };
  }
  return { src: tokenSrc || portrait || null, portrait: false,
    focus: normalizeFocus(baseActor?.getFlag?.(MODULE_ID, "iconFocus"), ICON_FOCUS_DEFAULT) };
}

// object-position picks which point of the cover-cropped art is anchored and
// a matching transform-origin keeps it fixed while zooming — the same model as
// the round-bar icons (applyIconFocusStyle). `skew` cancels the band's slant;
// `flip` mirrors the art around the focal point, which stays where it is.
export function applyBannerFocusStyle(media, focus, { skew = 0, flip = false } = {}) {
  if (!media) return;
  const f = normalizeBannerFocus(focus);
  media.style.objectPosition = `${f.x}% ${f.y}%`;
  media.style.transformOrigin = `${f.x}% ${f.y}%`;
  media.style.transform = `${skew ? `skewX(${skew}deg) ` : ""}scale(${f.zoom})${flip ? " scaleX(-1)" : ""}`;
}

function buildMedia(src, cls) {
  let media;
  if (isVideoSrc(src)) {
    media = document.createElement("video");
    media.autoplay = true; media.loop = true; media.muted = true;
    media.playsInline = true; media.setAttribute("playsinline", "");
  } else {
    media = document.createElement("img");
    media.draggable = false;
    media.decoding = "async";
  }
  media.className = cls;
  media.alt = "";
  if (src) media.src = src;
  return media;
}

// ── style ───────────────────────────────────────────────────────────────

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${LAYER_ID} { position: fixed; inset: 0; z-index: 99; pointer-events: none; overflow: hidden; }
#${LAYER_ID} .ftc-stage { position: absolute; left: 50%; top: 50%; width: ${STAGE_W}px; height: ${STAGE_H}px; transform-origin: 50% 50%; }
.ftc-abs { position: absolute; }
.ftc-fill { position: absolute; inset: 0; }
.ftc-streak { position: absolute; height: 2px; border-radius: 2px; }
.ftc-band { position: absolute; left: ${BAND.left}px; top: ${BAND.top}px; width: ${BAND.w}px; height: ${BAND.h}px; }
.ftc-shape { position: absolute; inset: 0; transform: skewX(-12deg); box-sizing: border-box; overflow: hidden;
  border-top: 2px solid #7a6a55; border-bottom: 2px solid #7a6a55;
  background: linear-gradient(180deg, #f6f1e6, #ebe3d0); }
.ftc-shape::before { content: ""; position: absolute; z-index: 2; left: 0; right: 0; top: 4px; bottom: 4px;
  border-top: 1px solid #d5b67a; border-bottom: 1px solid #d5b67a; pointer-events: none; }
.ftc-spine { position: absolute; top: 0; bottom: 0; width: 10px; z-index: 3; }
.ftc-art-clip { position: absolute; left: 0; right: 0; top: 5px; bottom: 5px; overflow: hidden; z-index: 1; }
.ftc-art { position: absolute; top: 0; width: ${ART.w}px; height: ${ART.h}px; overflow: hidden; }
.ftc-art .ftc-media { width: 100%; height: 100%; display: block; object-fit: cover; }
.ftc-text { position: absolute; top: ${BAND.top}px; height: ${BAND.h}px; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.ftc-text.party { align-items: flex-end; text-align: right; right: ${TEXT_EDGE}px; }
.ftc-text.enemy { align-items: flex-start; text-align: left; left: ${TEXT_EDGE}px; }
.ftc-eyebrow { font: 700 16px/1 "Signika", sans-serif; letter-spacing: .3em; text-transform: uppercase; padding: 3px 0; white-space: nowrap; }
.ftc-name { font: 900 ${NAME_PX}px/.88 "Cinzel", Georgia, serif; letter-spacing: .03em; color: #3a3228; white-space: nowrap;
  text-shadow: 0 0 2px #f6f1e6, 0 0 7px #f6f1e6, 0 0 16px rgba(246,241,230,.9); }
.ftc-sub { font: 600 14px/1 "Signika", sans-serif; letter-spacing: .24em; text-transform: uppercase; color: #6a5d4c; white-space: nowrap; }
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

// ── banner DOM ──────────────────────────────────────────────────────────

const ordinal = (n) => {
  const v = n % 100;
  const suf = (v >= 11 && v <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${suf}`;
};

export function bannerSubline({ round = 0, activation = 1 } = {}) {
  const parts = [];
  if (Number(round) > 0) parts.push(`Round ${round}`);
  if (Number(activation) > 1) parts.push(`${ordinal(Number(activation))} turn`);
  return parts.join(" · ");
}

// The band + words, positioned where they rest mid-pass (the mover adds the
// travel). Used by the live banner and by the Icon Adjuster preview.
export function buildBannerParts({ name = "", side = "party", round = 0, activation = 1, art = null, focus = null, flip } = {}) {
  const party = side !== "enemy";
  const c = party ? RGB.party : RGB.enemy;
  const mover = document.createElement("div");
  mover.className = "ftc-fill";

  // The glow lives on the wrapper so it follows the masked, faded shape.
  const band = document.createElement("div");
  band.className = "ftc-band";
  band.style.filter = `drop-shadow(0 0 14px rgba(${c.glow},.55)) drop-shadow(0 10px 18px rgba(0,0,0,.42))`;
  const shape = document.createElement("div");
  shape.className = "ftc-shape";
  const mask = `linear-gradient(${party ? 270 : 90}deg, #000 0%, #000 60%, transparent 100%)`;
  shape.style.webkitMaskImage = mask; shape.style.maskImage = mask;
  const spine = document.createElement("div");
  spine.className = "ftc-spine";
  spine.style[party ? "right" : "left"] = "16px";
  spine.style.background = `rgb(${c.glow})`;
  shape.appendChild(spine);

  // Portrait: fully opaque, inside the band between the gold hairlines,
  // fading only toward the words. No motion of its own.
  let media = null;
  if (art) {
    const clip = document.createElement("div");
    clip.className = "ftc-art-clip";
    const box = document.createElement("div");
    box.className = "ftc-art";
    box.style.left = `${party ? ART.partyLeft : ART.enemyLeft}px`;
    const am = `linear-gradient(${party ? 90 : 270}deg, transparent 0%, #000 34%)`;
    box.style.webkitMaskImage = am; box.style.maskImage = am;
    media = buildMedia(art, "ftc-media");
    // Enemies face right, toward the words (sprites are drawn facing left).
    applyBannerFocusStyle(media, focus, { skew: 12, flip: flip ?? !party });
    box.appendChild(media);
    clip.appendChild(box);
    shape.appendChild(clip);
  }
  band.appendChild(shape);

  const text = document.createElement("div");
  text.className = `ftc-text ${party ? "party" : "enemy"}`;
  const eyebrow = document.createElement("div");
  eyebrow.className = "ftc-eyebrow";
  eyebrow.style.color = c.ink;
  eyebrow.textContent = party ? "Party turn" : "Enemy turn";
  const nameEl = document.createElement("div");
  nameEl.className = "ftc-name";
  nameEl.textContent = name;
  text.append(eyebrow, nameEl);
  const subline = bannerSubline({ round, activation });
  if (subline) {
    const sub = document.createElement("div");
    sub.className = "ftc-sub";
    sub.textContent = subline;
    text.appendChild(sub);
  }

  mover.append(band, text);
  return { mover, band, text, nameEl, media };
}

// Long names shrink to fit the band. Layout px (the stage scale is a transform).
function fitName(nameEl) {
  try {
    const w = nameEl.offsetWidth;
    if (w > NAME_MAX_W) nameEl.style.fontSize = `${Math.floor(NAME_PX * NAME_MAX_W / w)}px`;
  } catch { /* not laid out — keep the authored size */ }
}

function stageScale() {
  const w = window.innerWidth || STAGE_W, h = window.innerHeight || STAGE_H;
  return Math.min(w / STAGE_W, h / STAGE_H);
}

// One continuous pass, the fast-slow-fast profile of a SlowMo ease. Each
// segment's easing is matched to the drift speed at the joins, so the motion
// never stops dead or jerks.
function passFrames(dir, drift, holdMs, far) {
  const half = drift / 2;
  const v = holdMs > 0 ? drift / holdMs : 0;
  const inSlope = v * IN_MS / Math.max(1, far - half);
  const outSlope = v * OUT_MS / Math.max(1, far + 100 - half);
  const x2 = .3, y2 = Math.min(.999, 1 - inSlope * (1 - x2));
  const x1 = .6, y1 = Math.max(0, outSlope * x1);
  return {
    inEase: `cubic-bezier(.1,.8,${x2},${y2.toFixed(3)})`,
    outEase: `cubic-bezier(${x1},${y1.toFixed(3)},.9,.6)`,
    from: dir * far, a: dir * half, b: -dir * half, to: -dir * (far + 100),
  };
}

function mulberry(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Light streaks in the side colour: a burst on the way in, one on the way out.
function streakBurst(card, { n, at, sgn, rgb, rnd }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = 160 + rnd() * 320;
    const y = 300 + rnd() * 160;
    const x = STAGE_W / 2 - len / 2 + (rnd() - .5) * 500;
    const s = document.createElement("div");
    s.className = "ftc-streak";
    s.style.left = `${x}px`; s.style.top = `${y}px`; s.style.width = `${len}px`;
    if (rnd() > .6) s.style.height = "3px";
    s.style.background = `linear-gradient(${sgn > 0 ? 270 : 90}deg, rgba(${rgb},.95), rgba(${rgb},0))`;
    s.style.boxShadow = `0 0 6px rgba(${rgb},.6)`;
    s.style.opacity = "0";
    card.appendChild(s);
    s.animate([
      { opacity: 0, transform: `translateX(${sgn * 1100}px)` },
      { opacity: 1, transform: `translateX(${sgn * 300}px)`, offset: .45 },
      { opacity: 0, transform: `translateX(${-sgn * 520}px)` },
    ], { duration: 560, delay: at + i * 28, easing: "ease-out", fill: "both" });
    out.push(s);
  }
  return out;
}

// Click or any key while the banner is up → it speeds out at once. Visual only.
function skipBanner(ev) {
  const live = _live;
  if (!live) return;
  if (ev?.type === "keydown") {
    const t = ev.target;
    if (t?.closest?.("input, textarea, select, [contenteditable='true']")) return;
  }
  const now = live.moverAnim.currentTime ?? 0;
  if (now <= 0 || now >= EXIT_AT_MS) return;
  let x = 0;
  try { x = new DOMMatrix(getComputedStyle(live.mover).transform).m41; } catch { /* from the rest spot */ }
  live.moverAnim.cancel();
  for (const s of live.outStreaks) s.getAnimations().forEach((a) => a.cancel());
  const a = live.mover.animate(
    [{ transform: `translateX(${x}px)` }, { transform: `translateX(${-live.dir * (live.far + 100)}px)` }],
    { duration: SKIP_MS, easing: "cubic-bezier(.5,0,.9,.5)", fill: "forwards" });
  a.finished.then(() => live.done()).catch(() => {});
  unbindSkip();
}

function bindSkip() {
  document.addEventListener("pointerdown", skipBanner, { capture: true, passive: true });
  document.addEventListener("keydown", skipBanner, { capture: true, passive: true });
}
function unbindSkip() {
  document.removeEventListener("pointerdown", skipBanner, { capture: true });
  document.removeEventListener("keydown", skipBanner, { capture: true });
}

function clearLive() {
  unbindSkip();
  const live = _live;
  _live = null;
  try { live?.card?.remove(); } catch { /* gone */ }
}

// ── local render (every client) ─────────────────────────────────────────

// payload: { name, side, round, activation, art, focus, flip }
export function playTurnBannerLocal(payload = {}) {
  try {
    const side = payload.side === "enemy" ? "enemy" : "party";
    if (payload.sfx !== false) playSfx(SFX[side], SFX_VOL);
    // Nothing draws while hidden; the sound still tells a tabbed-away player.
    if (!shouldRender()) return;
    clearLive();

    const layer = ensureLayer();
    const s = stageScale();
    const stage = document.createElement("div");
    stage.className = "ftc-stage";
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
    const card = document.createElement("div");
    card.className = "ftc-fill";
    stage.appendChild(card);
    layer.appendChild(stage);

    const party = side === "party";
    const dir = party ? 1 : -1;                 // +1 = enters from the right
    const far = Math.max(1500, (window.innerWidth / s) / 2 + BAND.w / 2 + 80);
    const rgb = RGB[side].streak;
    const rnd = mulberry(party ? 7 : 11);
    streakBurst(card, { n: 9, at: 40, sgn: dir, rgb, rnd });
    const outStreaks = streakBurst(card, { n: 6, at: EXIT_AT_MS - 60, sgn: dir, rgb, rnd });

    const parts = buildBannerParts({ ...payload, side });
    const { mover, text, nameEl } = parts;
    card.appendChild(mover);
    fitName(nameEl);

    // ONE rigid piece: the band and the words travel together.
    const total = EXIT_AT_MS + OUT_MS;
    const k = (ms) => ms / total;
    const P = passFrames(dir, DRIFT_PX, EXIT_AT_MS - IN_MS, far);
    const moverAnim = mover.animate([
      { transform: `translateX(${P.from}px)`, offset: 0, easing: P.inEase },
      { transform: `translateX(${P.a}px)`, offset: k(IN_MS), easing: "linear" },
      { transform: `translateX(${P.b}px)`, offset: k(EXIT_AT_MS), easing: P.outEase },
      { transform: `translateX(${P.to}px)`, offset: 1 },
    ], { duration: total, fill: "both" });
    // The words only fade in as it lands.
    text.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: TEXT_FADE_MS, delay: TEXT_FADE_AT, easing: "ease-out", fill: "both" });

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (_live?.card === stage) clearLive();
      else { try { stage.remove(); } catch { /* gone */ } }
    };
    _live = { card: stage, mover, moverAnim, dir, far, outStreaks, done };
    moverAnim.finished.then(() => setTimeout(done, 300)).catch(() => {});
    // Safety: never leave a banner on screen (a cancelled animation, a hidden
    // window that stopped the clock).
    setTimeout(done, total + 2000);
    bindSkip();
    registerAnimation({ kind: "turn-banner", durationMs: total });
  } catch (e) {
    warn("playTurnBannerLocal threw", e);
  }
}

// GM: play here + on every other client.
export function playTurnBanner(payload) {
  playTurnBannerLocal(payload);
  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("playTurnBanner: broadcast failed", e); }
}

// Dev preview on THIS client only:
//   FUCompanion.api.experimental.battleDirector.previewTurnBanner({ name: "Hina" })
export function previewTurnBanner(opts = {}) {
  playTurnBannerLocal({ name: "Hina", side: "party", round: 1, activation: 1, ...opts });
}

// ── short step (GM) ─────────────────────────────────────────────────────

function stepDistance() {
  const scale = Number(canvas?.stage?.scale?.x) || 1;
  const grid = Number(canvas?.dimensions?.size) || 100;
  const d = (STEP_REF_PX * stageScale()) / scale;
  return Math.max(grid * 0.4, Math.min(grid * 2.5, d));
}

// +1 = toward larger x. Toward the middle of the opposing side; with nobody
// there, the convention (party on the right, enemies on the left).
function stepDirection(dCombat, current) {
  const td = current?.tokenDoc;
  const me = td ? td.x + (td.width * (canvas?.dimensions?.size ?? 100)) / 2 : null;
  const foes = (dCombat?.combatants ?? []).filter((c) => c.side !== current.side && c.tokenDoc);
  if (me != null && foes.length) {
    const size = canvas?.dimensions?.size ?? 100;
    const mid = foes.reduce((s, c) => s + c.tokenDoc.x + (c.tokenDoc.width * size) / 2, 0) / foes.length;
    if (Math.abs(mid - me) > 1) return mid > me ? 1 : -1;
  }
  return current?.side === "enemy" ? 1 : -1;
}

async function moveToken(tokenDoc, change, { animate = true } = {}) {
  const options = { oniBypassGate: true, fuTurnStep: true };
  if (animate) options.animation = { duration: STEP_MS, easing: "easeInOutCosine" };
  else options.animate = false;
  return tokenDoc.update(change, options);
}

async function stepOut(dCombat, current) {
  const td = current?.tokenDoc;
  if (!td || !game.user?.isGM) return;
  // Already forward (a resume / rewind into its own turn): stay there.
  if (td.getFlag?.(MODULE_ID, HOME_FLAG)) return;
  const dx = Math.round(stepDirection(dCombat, current) * stepDistance());
  await moveToken(td, { x: td.x + dx, [`flags.${MODULE_ID}.${HOME_FLAG}`]: { x: td.x, y: td.y } });
}

// Walk one token back to its saved home spot. True if it was away.
export async function stepHome(tokenDoc, { animate = true } = {}) {
  try {
    const home = tokenDoc?.getFlag?.(MODULE_ID, HOME_FLAG);
    if (!home || !game.user?.isGM) return false;
    const change = { [`flags.${MODULE_ID}.-=${HOME_FLAG}`]: null };
    if (Number.isFinite(Number(home.x))) change.x = Number(home.x);
    if (Number.isFinite(Number(home.y))) change.y = Number(home.y);
    await moveToken(tokenDoc, change, { animate });
    return true;
  } catch (e) {
    warn(`turn step: return home failed for ${tokenDoc?.name ?? "?"}`, e);
    return false;
  }
}

// Walk every stepped token on the scene home (turn end, battle end, stop, and
// a TURN_START that finds a token left forward by a rewind / reload).
export async function returnSteppedTokens(scene, { except = null, animate = true } = {}) {
  if (!scene || !game.user?.isGM) return 0;
  const away = (scene.tokens?.contents ?? []).filter((td) => td.id !== except && td.getFlag?.(MODULE_ID, HOME_FLAG));
  const res = await Promise.all(away.map((td) => stepHome(td, { animate })));
  const n = res.filter(Boolean).length;
  if (n) log(`turn step: returned ${n} token(s) home`);
  return n;
}

// ── orchestration (GM, from TURN_START) ─────────────────────────────────

function cueLanded() {
  try { Hooks.callAll(CUE_LANDED_HOOK); } catch { /* listeners never break the turn */ }
}

const remaining = (t0, at) => Math.max(0, at - (performance.now() - t0));

const NO_CUE = Object.freeze({ untilEffects: async () => {}, untilInput: async () => {} });

function buildPayload(dCombat, current) {
  const td = current.tokenDoc;
  const base = game.actors?.get?.(td?.actorId) ?? current.actorDoc ?? null;
  const side = current.side === "enemy" ? "enemy" : "party";
  const per = Math.max(1, Number(current.turnsPerRound) || 1);
  const left = Math.max(0, Number(current.turnsRemaining) || 0);
  const art = bannerArtFor(base, td);
  return {
    name: td?.name ?? current.name ?? "",
    side,
    round: Number(dCombat.round) || 0,
    // turnsRemaining still counts this turn while it runs.
    activation: Math.max(1, per - left + 1),
    art: art.src,
    focus: art.focus,
  };
}

// Start the cue for the turn that just resolved who acts. Returns two waits for
// TURN_START: untilEffects (the actor is in place — run the turn-start effects)
// and untilInput (hand over to DECLARE). Never throws; on any failure the turn
// just proceeds without the show.
export async function startTurnCue(director) {
  const dc = director?.dCombat;
  const current = dc?.current ?? null;
  try {
    // A token left forward by a rewind / reload / crash goes home first.
    await returnSteppedTokens(dc?.scene, { except: current?.tokenDoc?.id ?? null });
  } catch (e) { warn("startTurnCue: return home threw", e); }

  const nobodyWatching = !shouldRender() && !hasOtherViewers();
  if (!current || !turnCueWillRun() || nobodyWatching) { cueLanded(); return NO_CUE; }

  try {
    // The round-opening cinematic (round plate + the bar assembling) plays first.
    // The enemy autopilot already consumed this; every other path waits here.
    const opening = director.ctx?.initiativeBannerDone;
    if (opening) {
      director.ctx.initiativeBannerDone = null;
      try { await Promise.race([opening, interval(ROUND_CINEMATIC_MAX_MS)]); } catch { /* proceed */ }
    }

    const t0 = performance.now();
    playTurnBanner(buildPayload(dc, current));
    const stepped = (async () => {
      await pWait(LANDED_MS);
      cueLanded();
      try { await stepOut(dc, current); }
      catch (e) { warn("startTurnCue: step out failed", e); }
    })();
    return {
      async untilEffects() {
        await stepped;
        await pWait(remaining(t0, EFFECTS_MS));
      },
      async untilInput() {
        await pWait(remaining(t0, INPUT_MS));
      },
    };
  } catch (e) {
    warn("startTurnCue threw — turn proceeds without the cue", e);
    cueLanded();
    return NO_CUE;
  }
}
