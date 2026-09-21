// Boss Entrance FX — a boss plummets from the top of the screen and slams its
// spawn point, with a per-boss impact burst, screenshake and SFX.
//
// This is the data-driven entrance system that
// `battle-end/followups/wandering-flame-entrance.js` asked for in its own
// header ("to be folded into a future data-driven entrance-animation system
// (no per-boss hardcoding) once that exists"). That file now keeps only its
// socket entry point and delegates the render here under the `flame` style;
// its visuals are unchanged, constant for constant.
//
// Architecture (inherited from the Wandering Flame implementation, which shipped
// and is proven): position:fixed DOM elements projected onto each client's
// screen from the token's world centre, mirroring the director's damage-numbers
// / impact-fx subsystems. No Sequencer.
//
// ONE DELIBERATE CHANGE from that implementation: the fall is driven by rAF
// with the target re-projected EVERY FRAME, where the original ran a single
// WAAPI `top` animation against a target projected once up front. A one-shot
// projection is only correct while the camera is still — the moment a style
// pans the camera mid-fall (which `shadowstorm` does), a fixed target goes
// stale and the boss lands off her own token. Re-projecting per frame is
// correct under any camera motion, and for a style with no camera move it
// reduces to the same constant the original computed, so `flame` renders
// identically. The original's easing is preserved exactly via a cubic-bezier
// solver rather than approximated with a stock ease-in.
//
// Callers own the broadcast. `playDescentLocal` renders on the client it is
// called on and nothing else; the director's entrance already runs on every
// client via socketlib, and the Wandering Flame path has its own socket.

import { warn } from "./logger.js";
import { CameraApi } from "./director-camera.js";
import { suspendCamera, resumeCamera } from "./camera-authority.js";

const STYLE_ID = "fud-boss-entrance-style";

// Impact SFX — played on every client at the moment the boss hits the ground.
const IMPACT_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_DOWNC.wav";

// Landing roar, for styles that bellow once they are down.
const ROAR_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Monster5.ogg";

/* ── Styles ──────────────────────────────────────────────────────────────
 *
 * Every timing is in ms and every size is either a px scale factor on the
 * boss's own on-screen footprint or a fraction of the viewport, so a re-tune
 * is a constant change here and never a code change.
 *
 * `flame` reproduces the shipped Wandering Flame entrance exactly. Do not
 * re-tune it to taste — it was approved live. New bosses get new entries.
 */
export const DESCENT_STYLES = {
  flame: {
    fallMs: 640,
    // cubic-bezier(0.55,0,1,0.45) — accelerating plummet.
    ease: [0.55, 0, 1, 0.45],
    rotateFromDeg: -6,
    rotateToDeg: 4,
    fallerClass: "fud-be-faller fud-be-faller--flame",
    burstClass: "fud-be-burst fud-be-burst--flame",
    burstScale: 2.4,
    burstMs: 640,
    shakeClass: "fud-be-shake",
    shakeMs: 700,
    sfxUrl: IMPACT_SFX,
    sfxVolume: 0.8,
    fadeOutMs: 220,
    shards: null,
    camera: null,
    // null = size the impact FX straight off the sprite footprint, which is
    // what the shipped Wandering Flame entrance does. Do not add a cap here:
    // it would change an approved animation.
    fxBasisMaxFrac: null,
  },

  // ⭐ Fafnir — Dreadwyrm Descent. She does not fade in like an ordinary
  // monster: she falls out of the sky as a shadow, the camera riding her down,
  // and bursts into purple lightning on landing to reveal the sprite.
  shadowstorm: {
    // A WING-BEAT descent, not a fall. Three drop-and-arrest cycles then a
    // flare onto the ground — see buildDescentTimeline. `fallMs`/`ease` are
    // unused when `beats` is present; the duration is the sum of the segments
    // (~2.8s), which is long on purpose. This is the opening shot of a boss
    // fight, not a hit reaction.
    beats: [
      // Each beat drops hard, the wing catches her, then she hangs a moment.
      { to: 0.34, dropMs: 380, ease: [0.45, 0, 0.9, 0.45], reboundFrac: 0.045, reboundMs: 220, holdMs: 240 },
      { to: 0.62, dropMs: 360, ease: [0.45, 0, 0.9, 0.45], reboundFrac: 0.038, reboundMs: 200, holdMs: 220 },
      { to: 0.86, dropMs: 320, ease: [0.45, 0, 0.9, 0.45], reboundFrac: 0.030, reboundMs: 180, holdMs: 240 },
      // FLARE — wings out, descent almost stops, then she settles onto it.
      // Decelerating (not accelerating) easing is what sells the landing as
      // controlled rather than a crash.
      { to: 1.0, dropMs: 460, ease: [0.25, 0.6, 0.3, 1], reboundFrac: 0, reboundMs: 0, holdMs: 0 },
    ],
    // Subtle hover ride on top of the descent — the wing cycle. Fades out over
    // the flare so she does not bob through the floor on touchdown.
    floatAmpFrac: 0.016,
    floatHz: 1.15,
    swayDeg: 1.8,
    rotateFromDeg: -3,
    rotateToDeg: 2,
    fallerClass: "fud-be-faller fud-be-faller--shadow",
    burstClass: "fud-be-burst fud-be-burst--shadow",
    burstScale: 3.1,
    burstMs: 900,
    shakeClass: "fud-be-shake fud-be-shake--heavy",
    shakeMs: 900,
    sfxUrl: IMPACT_SFX,
    sfxVolume: 0.9,
    fadeOutMs: 320,
    // Purple electrical shards thrown outward on landing.
    shards: { count: 18, spreadScale: 1.9, ms: 760, lenScale: 0.42 },
    // Cap the impact FX against the VIEWPORT, not the sprite. Fafnir's sprite
    // renders ~825px wide, so scaling the burst off the footprint alone gave a
    // ~2500px flash that washed the whole UI violet — fine on the Wandering
    // Flame's much smaller token, overwhelming on a boss this size. Capping the
    // basis keeps the impact proportional to the SCREEN on any sprite.
    fxBasisMaxFrac: 0.28,
    // Landing roar. Plays on the revealed sprite, after the impact burst.
    roar: {
      sfxUrl: ROAR_SFX,
      sfxVolume: 0.95,
      delayMs: 140,        // a beat to read the reveal before she bellows
      ms: 1150,
      recoilScale: 0.962,  // draws back first
      scalePeak: 1.10,
      blurPx: 8,           // motion blur through the fastest part of the bellow
      revealClass: "fud-be-faller fud-be-faller--revealed",
      revealFilter: "drop-shadow(0 0 26px rgba(150,80,255,0.75))",
      shakeClass: "fud-be-shake fud-be-shake--roar",
      shakeMs: 820,
    },
    // The camera starts above her, looking at empty sky, and rides her down.
    // `riseFrac` is how far above the impact point the shot starts, as a
    // fraction of viewport height; the clamp means a spawn point near the top
    // of the artwork simply gets less rise rather than a broken shot.
    camera: { riseFrac: 0.85, zoom: 1.35, settleMs: 700 },
  },
};

/* ── Entrance style selection ────────────────────────────────────────────
 *
 * Pure, and exported for that reason — these two decide whether an existing
 * fight's entrance changes at all, so they are covered bare in
 * boss-entrance-fx.test.mjs rather than only exercised live.
 */

export const ENTRANCE_MODULE_ID    = "fabula-ultima-companion";
export const ENTRANCE_STYLE_FLAG   = "entranceStyle";
export const DEFAULT_ENTRANCE_STYLE = "fade";

/**
 * Read an actor's entrance style out of its flags.
 *
 * Returns "fade" for anything that is not an explicitly recognised descent
 * style — unset, blank, wrong type, or a typo'd/retired style name. That last
 * case matters: routing an unrecognised style into the renderer would land on
 * its `flame` fallback and drop a fiery explosion on some monster that never
 * asked for one, which is a far worse failure than simply fading in.
 */
export function entranceStyleFromFlags(flags, ns = ENTRANCE_MODULE_ID) {
  try {
    const key = String(flags?.[ns]?.[ENTRANCE_STYLE_FLAG] ?? "").trim();
    if (!key || key === DEFAULT_ENTRANCE_STYLE) return DEFAULT_ENTRANCE_STYLE;
    return DESCENT_STYLES[key] ? key : DEFAULT_ENTRANCE_STYLE;
  } catch { return DEFAULT_ENTRANCE_STYLE; }
}

/**
 * Partition enemy token ids into the plain faders and the bespoke descents,
 * preserving roster order in both. `styleOf` may throw or return junk; that
 * token just fades.
 */
export function splitByEntranceStyle(ids, styleOf) {
  const fading = [];
  const descending = [];
  for (const id of ids ?? []) {
    let style = DEFAULT_ENTRANCE_STYLE;
    try { style = styleOf?.(id) || DEFAULT_ENTRANCE_STYLE; } catch { style = DEFAULT_ENTRANCE_STYLE; }
    if (style === DEFAULT_ENTRANCE_STYLE) fading.push(id);
    else descending.push({ id, style });
  }
  return { fading, descending };
}

/* ── Easing ──────────────────────────────────────────────────────────────── */

// Evaluate a CSS cubic-bezier(x1,y1,x2,y2) at time t. Newton-Raphson on x with
// a bisection fallback — the standard solver. Present so the flame style keeps
// the exact curve its WAAPI keyframes used; an approximated ease-in would
// change a shipped, approved animation.
function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const d = slope(u, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      const x = calc(u, x1, x2) - t;
      if (Math.abs(x) < 1e-6) break;
      u -= x / d;
    }
    // Bisection fallback if Newton wandered out of range.
    if (u < 0 || u > 1) {
      let lo = 0, hi = 1;
      u = t;
      for (let i = 0; i < 20; i++) {
        const x = calc(u, x1, x2);
        if (Math.abs(x - t) < 1e-6) break;
        if (x > t) hi = u; else lo = u;
        u = (lo + hi) / 2;
      }
    }
    return calc(u, y1, y2);
  };
}

/* ── Wing-beat descent timeline ──────────────────────────────────────────
 *
 * A big flying creature does not fall — it descends in stages. Each wing-beat
 * arrests the drop, giving a brief upward rebound and a hover before gravity
 * takes over again, and the last beat is a FLARE: the animal pitches back,
 * spreads its wings and the descent almost stops just before touchdown.
 *
 * So each beat expands into up to three segments — drop, rebound, hold — and
 * the next beat's drop starts from wherever the rebound left off. Positions are
 * fractions of the total distance from the top of the screen to the landing
 * spot, so the shape is resolution-independent.
 */
function buildDescentTimeline(beats) {
  const segs = [];
  let from = 0;
  for (const b of beats) {
    segs.push({ from, to: b.to, ms: b.dropMs, ease: cubicBezier(...(b.ease ?? [0.4, 0, 0.9, 0.5])) });
    let cur = b.to;
    if (b.reboundFrac > 0 && b.reboundMs > 0) {
      // The wing-beat catches her: a short, decelerating rise.
      const up = Math.max(0, b.to - b.reboundFrac);
      segs.push({ from: b.to, to: up, ms: b.reboundMs, ease: cubicBezier(0.2, 0.7, 0.35, 1) });
      cur = up;
    }
    if (b.holdMs > 0) segs.push({ from: cur, to: cur, ms: b.holdMs, ease: (t) => t });
    from = cur;
  }
  return { segs, totalMs: segs.reduce((a, s) => a + s.ms, 0) };
}

// Fraction of the total drop at `elapsed` ms. Clamped at both ends so an
// overrun frame lands exactly on the ground rather than past it.
function sampleDescent(tl, elapsed) {
  if (elapsed <= 0) return tl.segs[0]?.from ?? 0;
  if (elapsed >= tl.totalMs) return tl.segs[tl.segs.length - 1]?.to ?? 1;
  let acc = 0;
  for (const s of tl.segs) {
    if (elapsed < acc + s.ms) {
      const local = s.ms ? (elapsed - acc) / s.ms : 1;
      return s.from + (s.to - s.from) * s.ease(local);
    }
    acc += s.ms;
  }
  return 1;
}

/* ── Stylesheet ──────────────────────────────────────────────────────────── */

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
@keyframes fud-be-shake {
  0%,100% { transform: translate(0,0); }
  10% { transform: translate(-9px, 7px); }
  20% { transform: translate(8px,-6px); }
  30% { transform: translate(-7px,-8px); }
  40% { transform: translate(7px, 7px); }
  50% { transform: translate(-6px, 5px); }
  60% { transform: translate(6px,-5px); }
  70% { transform: translate(-4px, 4px); }
  80% { transform: translate(4px, 3px); }
  90% { transform: translate(-2px,-2px); }
}
@keyframes fud-be-shake-heavy {
  0%,100% { transform: translate(0,0); }
  8%  { transform: translate(-16px, 12px); }
  18% { transform: translate(14px,-11px); }
  28% { transform: translate(-13px,-13px); }
  38% { transform: translate(12px, 12px); }
  48% { transform: translate(-10px, 9px); }
  58% { transform: translate(9px,-8px); }
  68% { transform: translate(-7px, 6px); }
  78% { transform: translate(6px, 5px); }
  88% { transform: translate(-3px,-3px); }
}
/* The roar shake is faster and tighter than the landing's — a bellow rattles
   the frame rather than heaving it. */
@keyframes fud-be-shake-roar {
  0%,100% { transform: translate(0,0); }
  6%  { transform: translate(-11px, 5px); }
  14% { transform: translate(10px,-7px); }
  22% { transform: translate(-9px,-4px); }
  30% { transform: translate(9px, 6px); }
  40% { transform: translate(-8px, 4px); }
  50% { transform: translate(7px,-5px); }
  62% { transform: translate(-5px, 3px); }
  74% { transform: translate(4px, 3px); }
  86% { transform: translate(-2px,-2px); }
}
.fud-be-shake { animation: fud-be-shake 0.6s cubic-bezier(.36,.07,.19,.97) both; }
.fud-be-shake--heavy { animation: fud-be-shake-heavy 0.85s cubic-bezier(.36,.07,.19,.97) both; }
.fud-be-shake--roar { animation: fud-be-shake-roar 0.8s cubic-bezier(.36,.07,.19,.97) both; }

.fud-be-faller {
  position: fixed; z-index: 99990; pointer-events: none;
  transform: translate(-50%, -50%);
  will-change: transform, top;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
}
.fud-be-faller--flame { filter: drop-shadow(0 0 20px rgba(255,120,20,0.9)); }
/* brightness(0) crushes the sprite to a pure silhouette while keeping its
   alpha, so the shape reads without any of its colour. The violet rim is what
   stops it reading as a hole in the screen. */
.fud-be-faller--shadow {
  filter: brightness(0) drop-shadow(0 0 26px rgba(150,80,255,0.85))
          drop-shadow(0 0 60px rgba(90,30,180,0.55));
}
/* Post-reveal: her real colours, keeping only the violet rim. The roar
   animates the filter property directly, so this is the resting value it
   returns to. NOTE: no backticks in this stylesheet — it is a template
   literal, and one would close it early. */
.fud-be-faller--revealed {
  filter: drop-shadow(0 0 26px rgba(150,80,255,0.75));
}

.fud-be-burst {
  position: fixed; z-index: 99989; pointer-events: none;
  border-radius: 50%;
  mix-blend-mode: screen; opacity: 0;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
}
.fud-be-burst--flame {
  background: radial-gradient(circle,
    rgba(255,248,210,1) 0%,
    rgba(255,165,45,0.96) 26%,
    rgba(255,72,0,0.88) 50%,
    rgba(120,20,0,0) 72%);
}
.fud-be-burst--shadow {
  background: radial-gradient(circle,
    rgba(245,230,255,1) 0%,
    rgba(190,130,255,0.96) 24%,
    rgba(120,50,230,0.86) 48%,
    rgba(40,10,90,0) 74%);
}

/* Electrical shards — thin rotated slivers thrown out of the impact. */
.fud-be-shard {
  position: fixed; z-index: 99991; pointer-events: none;
  background: linear-gradient(90deg,
    rgba(255,255,255,0.95) 0%,
    rgba(200,150,255,0.9) 45%,
    rgba(120,50,230,0) 100%);
  transform-origin: 0% 50%;
  opacity: 0;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
  filter: drop-shadow(0 0 6px rgba(170,110,255,0.9));
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/* ── Geometry helpers (moved verbatim from the Wandering Flame entrance) ─── */

// World point → client (screen) coords. Mirrors impact-fx / damage-numbers.
function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

function isVideo(src) { return /\.(webm|mp4|m4v|mov)$/i.test(String(src ?? "")); }

// Wait until the media element actually has a decoded first frame, so the fall
// never plays on an empty element. This is the fix for the inconsistent
// "boss just appears at the spot" behavior: on an uncached sprite the motion
// ran while the <img>/<video> had no pixels yet, so all you saw was the final
// pop-in. Resolves on ready / error / hard timeout.
function awaitMediaReady(el, isVid, timeoutMs = 2500) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    try {
      if (isVid) {
        if (el.readyState >= 2) return fin(); // HAVE_CURRENT_DATA
        el.addEventListener("loadeddata", fin, { once: true });
        el.addEventListener("canplay",    fin, { once: true });
        el.addEventListener("error",      fin, { once: true });
      } else {
        if (el.complete && el.naturalWidth > 0) return fin();
        if (typeof el.decode === "function") { el.decode().then(fin).catch(fin); }
        el.addEventListener("load",  fin, { once: true });
        el.addEventListener("error", fin, { once: true });
      }
    } catch { return fin(); }
    setTimeout(fin, timeoutMs);
  });
}

// On-screen sprite size in WORLD px (pre-zoom), matching Foundry's token
// render. Prefers the live mesh (exact); otherwise reproduces the fit + scale
// math from the document + the texture's native dimensions. Verified against
// the WF probe: native 240×348, "contain" into a 110×110 frame (×0.3161),
// then texture scale ×2.56 → 194.2 × 281.6 (== mesh_width/height).
function spriteWorldSize(token, naturalW, naturalH) {
  const mw = Math.abs(Number(token?.mesh?.width));
  const mh = Math.abs(Number(token?.mesh?.height));
  if (Number.isFinite(mw) && mw > 20 && Number.isFinite(mh) && mh > 20) return { w: mw, h: mh };

  const grid   = canvas?.scene?.grid?.size ?? 100;
  const doc    = token?.document ?? token ?? {};
  const frameW = (Number(doc.width)  || 1) * grid;
  const frameH = (Number(doc.height) || 1) * grid;
  const nW = Number(naturalW) || frameW;
  const nH = Number(naturalH) || frameH;
  const sx = Math.abs(Number(doc.texture?.scaleX) || 1) || 1;
  const sy = Math.abs(Number(doc.texture?.scaleY) || 1) || 1;
  const fit = String(doc.texture?.fit ?? "contain");

  let fs;
  if (fit === "cover")       fs = Math.max(frameW / nW, frameH / nH);
  else if (fit === "width")  fs = frameW / nW;
  else if (fit === "height") fs = frameH / nH;
  else if (fit === "fill")   return { w: frameW * sx, h: frameH * sy };
  else                       fs = Math.min(frameW / nW, frameH / nH); // contain (default)
  return { w: nW * fs * sx, h: nH * fs * sy };
}

// The token's world centre, tolerating a placeable that has not laid out yet.
function tokenCenter(token) {
  return token?.center ?? {
    x: (token?.x ?? 0) + (token?.w ?? 100) / 2,
    y: (token?.y ?? 0) + (token?.h ?? 100) / 2,
  };
}

/* ── Payload ─────────────────────────────────────────────────────────────── */

// Build the broadcast payload for a token. Kept here so every caller describes
// an entrance the same way.
export function buildDescentPayload(token, styleKey = "flame", scene = null) {
  const doc = token?.document ?? token ?? {};
  const src = String(
    doc?.texture?.src ??
    token?.actor?.system?.props?.sprite_battle ??
    ""
  ).trim();
  // Mirror the token's horizontal flip so the falling sprite faces the same way
  // as the placed token (enemy tokens spawn mirrored via texture.scaleX < 0).
  const sx = Number(doc?.texture?.scaleX);
  return {
    sceneId: scene?.id ?? token?.parent?.id ?? doc?.parent?.id ?? canvas?.scene?.id ?? null,
    tokenId: token?.id ?? null,
    src,
    flipX: Number.isFinite(sx) ? sx < 0 : false,
    style: styleKey,
  };
}

/* ── Render ──────────────────────────────────────────────────────────────── */

/**
 * Render a descent on THIS client. Resolves at IMPACT — the burst, shake and
 * faller fade-out run on after the resolve, so a caller can reveal the real
 * token the moment the boss lands without waiting out the cosmetic tail.
 *
 * Never rejects: a broken sprite, a missing token or a client on another scene
 * all resolve immediately, because every caller uses this to gate a battle
 * from starting and a throw here must not strand it.
 */
export function playDescentLocal(opts = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    runDescent(opts, done).catch((e) => { warn("[boss-entrance] runDescent threw", e); done(); });
  });
}

async function runDescent({ sceneId, tokenId, src, flipX = false, style = "flame" } = {}, done) {
  if (typeof PIXI === "undefined" || !canvas?.ready) { done(); return; }
  // Only animate on clients currently viewing the boss's scene.
  if (sceneId && canvas.scene?.id !== sceneId) { done(); return; }

  const cfg = DESCENT_STYLES[style] ?? DESCENT_STYLES.flame;
  if (!DESCENT_STYLES[style]) warn(`[boss-entrance] unknown style "${style}" — falling back to flame`);
  ensureStyle();

  const token = tokenId ? canvas.tokens?.get?.(tokenId) : null;
  const hasToken = !!(token && !token.destroyed);
  const zoom = canvas.stage?.scale?.x ?? 1;

  // Screen position of the landing spot. Re-read through this closure every
  // frame so a camera move during the fall cannot leave the faller behind.
  const impactPoint = () => {
    if (!hasToken) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const c = tokenCenter(token);
    return worldToClient(c.x, c.y);
  };

  const isVid  = isVideo(src);
  const faller = isVid ? document.createElement("video") : document.createElement("img");
  faller.className = cfg.fallerClass;
  if (isVid) { faller.muted = true; faller.autoplay = true; faller.loop = true; faller.playsInline = true; faller.preload = "auto"; }
  const start0 = impactPoint();
  faller.style.left    = `${start0.x}px`;
  faller.style.opacity = "0"; // hidden until decoded + sized
  if (src) faller.src = src;
  document.body.appendChild(faller);
  try { faller.play?.()?.catch?.(() => {}); } catch {}

  // Don't start the fall until the sprite has real pixels — consistency fix.
  await awaitMediaReady(faller, isVid);
  if (!document.body.contains(faller)) { done(); return; }

  // Size to match the rendered token sprite, now that native dims are known.
  const natW = isVid ? faller.videoWidth  : faller.naturalWidth;
  const natH = isVid ? faller.videoHeight : faller.naturalHeight;
  const size = spriteWorldSize(token, natW, natH);
  const footprintPx = Math.max(48, size.w * zoom);
  const startY = -footprintPx - 40; // start above the top edge

  faller.style.width  = `${footprintPx}px`;
  faller.style.height = "auto"; // native aspect == the contained sprite's aspect
  faller.style.top    = `${startY}px`;

  const flipStr = flipX ? " scaleX(-1)" : "";
  const setPose = (x, y, deg) => {
    faller.style.left = `${x}px`;
    faller.style.top  = `${y}px`;
    faller.style.transform = `translate(-50%,-50%)${flipStr} rotate(${deg}deg)`;
  };
  setPose(start0.x, startY, cfg.rotateFromDeg);
  faller.style.opacity = "1";

  // Resolve the descent shape BEFORE the camera, which needs its duration. A
  // style either describes a single eased plummet (`fallMs` + `ease`, what
  // `flame` does) or a wing-beat descent (`beats`), whose length is the sum of
  // its segments.
  const timeline = cfg.beats ? buildDescentTimeline(cfg.beats) : null;
  const fallMs = timeline ? timeline.totalMs : cfg.fallMs;
  const ease = timeline ? null : cubicBezier(...cfg.ease);
  const floatAmpPx = (cfg.floatAmpFrac ?? 0) * (window.innerHeight || 1080);

  // Camera ride. Starts on empty sky above the landing spot and travels down
  // with her. Clamped by the camera API, so a spawn near the top edge of the
  // artwork degrades to a shorter ride rather than a broken shot.
  let releaseCamera = null;
  let restoreCamera = null;
  if (cfg.camera && hasToken) {
    try {
      const scene = canvas.scene ?? null;
      const c = tokenCenter(token);
      const vh = window.innerHeight || 1080;
      const rise = (cfg.camera.riseFrac * vh) / (zoom || 1);
      const ground = CameraApi.resolveIntent({ point: { x: c.x, y: c.y }, zoom: cfg.camera.zoom }, scene);
      suspendCamera();
      releaseCamera = () => { try { resumeCamera(); } catch {} };
      // Snap to the sky, then ride down over the length of the fall.
      CameraApi.panSnap({ x: c.x, y: c.y - rise, scale: ground?.scale }, { scene });
      CameraApi.panTo({ x: c.x, y: c.y, scale: ground?.scale }, { duration: fallMs, scene });
      restoreCamera = async () => {
        try { await CameraApi.settleRestFraming(scene, { attempts: 1 }); } catch {}
      };
    } catch (e) {
      warn("[boss-entrance] camera ride failed — falling without it", e);
      try { releaseCamera?.(); } catch {}
      releaseCamera = null;
      restoreCamera = null;
    }
  }

  // rAF fall with per-frame re-projection (see the header note).
  await new Promise((res) => {
    const t0 = performance.now();
    const step = (now) => {
      const elapsed = now - t0;
      const t = Math.min(1, elapsed / fallMs);
      const e = timeline ? sampleDescent(timeline, elapsed) : ease(t);
      const p = impactPoint();

      // The idle float rides on top of the descent and fades out over the last
      // stretch, so she settles onto the ground rather than bobbing through it.
      const floatFade = Math.max(0, 1 - Math.max(0, t - 0.82) / 0.18);
      const bob = floatAmpPx
        ? Math.sin((elapsed / 1000) * (cfg.floatHz ?? 1) * Math.PI * 2) * floatAmpPx * floatFade
        : 0;
      const sway = cfg.swayDeg
        ? Math.sin((elapsed / 1000) * (cfg.floatHz ?? 1) * Math.PI * 2 + 0.9) * cfg.swayDeg * floatFade
        : 0;

      setPose(
        p.x,
        startY + (p.y - startY) * e + bob,
        cfg.rotateFromDeg + (cfg.rotateToDeg - cfg.rotateFromDeg) * e + sway,
      );
      if (t < 1) requestAnimationFrame(step);
      else res();
    };
    requestAnimationFrame(step);
  });

  const target = impactPoint();
  setPose(target.x, target.y, cfg.rotateToDeg); // settle exactly, no residual bob

  // ── Impact ──
  // The impact FX size off `fxBasis`, not the raw footprint: a boss sprite can
  // be several times a mook's, and a burst scaled straight off it covers the
  // screen. With no cap configured this IS the footprint, so a style that never
  // sets one renders exactly as before.
  const fxBasis = cfg.fxBasisMaxFrac
    ? Math.min(footprintPx, (window.innerHeight || 1080) * cfg.fxBasisMaxFrac)
    : footprintPx;

  try { spawnBurst(cfg, target, fxBasis); } catch (e) { warn("[boss-entrance] burst threw", e); }
  try { spawnShards(cfg, target, fxBasis); } catch (e) { warn("[boss-entrance] shards threw", e); }
  try { shakeBoard(cfg); } catch (e) { warn("[boss-entrance] shake threw", e); }

  if (cfg.sfxUrl) {
    try { foundry.audio?.AudioHelper?.play?.({ src: cfg.sfxUrl, volume: cfg.sfxVolume, autoplay: true, loop: false }, false); }
    catch {}
  }

  // ── Roar ──
  // Runs on the FALLER, not the real token, because the faller is a DOM element
  // we can blur and scale freely. The real token stays hidden underneath until
  // this finishes, so there is never a doubled silhouette at the edges.
  if (cfg.roar) {
    try { await playRoar(faller, cfg, flipStr); }
    catch (e) { warn("[boss-entrance] roar threw", e); }
  }

  // Fade the faller out — the real animated token takes over underneath.
  try {
    const f = faller.animate([{ opacity: 1 }, { opacity: 0 }], { duration: cfg.fadeOutMs, fill: "forwards" });
    f?.addEventListener?.("finish", () => { try { faller.remove(); } catch {} });
    setTimeout(() => { try { faller.remove(); } catch {} }, cfg.fadeOutMs + 230);
  } catch { try { faller.remove(); } catch {} }

  // Hand the caller the landing (and, for a style with a roar, the roar) before
  // the fade-out tail finishes.
  done();

  // Release the camera after the shot has settled. Detached from `done` on
  // purpose: the caller should not wait on framing to reveal the token.
  if (releaseCamera) {
    setTimeout(async () => {
      try { await restoreCamera?.(); } finally { releaseCamera(); }
    }, cfg.camera?.settleMs ?? 0);
  }
}

// The roar: she is revealed out of the silhouette, rears back, then bellows —
// a hard scale-up with a motion blur through the peak, its own screenshake, and
// the roar SFX. Resolves when the pose has settled.
async function playRoar(faller, cfg, flipStr) {
  const r = cfg.roar;

  // Drop the silhouette so the roar happens on her actual colours — this is the
  // "burst reveals Fafnir" beat the shadow has been building to.
  if (r.revealClass) faller.className = r.revealClass;
  const base = r.revealFilter ?? "";

  if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
  if (!document.body.contains(faller)) return;

  if (r.sfxUrl) {
    try { foundry.audio?.AudioHelper?.play?.({ src: r.sfxUrl, volume: r.sfxVolume ?? 0.9, autoplay: true, loop: false }, false); }
    catch {}
  }
  // Shake lands with the bellow, not with the recoil that precedes it.
  if (r.shakeClass) {
    setTimeout(() => {
      try { shakeBoard({ shakeClass: r.shakeClass, shakeMs: r.shakeMs ?? 900 }); } catch {}
    }, Math.round(r.ms * 0.16));
  }

  const pose = (s, blur) => ({
    transform: `translate(-50%,-50%)${flipStr} scale(${s})`,
    filter: blur ? `${base} blur(${blur}px)`.trim() : (base || "none"),
  });

  const anim = faller.animate(
    [
      { ...pose(1, 0), offset: 0 },
      // Recoil — she draws back before the bellow.
      { ...pose(r.recoilScale ?? 0.965, 0), offset: 0.16 },
      // The bellow itself: snap out, blurred through the fastest part.
      { ...pose(r.scalePeak ?? 1.09, r.blurPx ?? 7), offset: 0.34 },
      { ...pose(1.035, Math.max(1, (r.blurPx ?? 7) * 0.28)), offset: 0.62 },
      { ...pose(1, 0), offset: 1 },
    ],
    { duration: r.ms ?? 1150, easing: "cubic-bezier(.2,.75,.3,1)", fill: "forwards" },
  );

  await new Promise((res) => {
    let settled = false;
    const fin = () => { if (!settled) { settled = true; res(); } };
    anim?.addEventListener?.("finish", fin);
    setTimeout(fin, (r.ms ?? 1150) + 120); // safety net if WAAPI finish never fires
  });
}

function spawnBurst(cfg, target, basisPx) {
  const burst = document.createElement("div");
  burst.className = cfg.burstClass;
  const burstPx = basisPx * cfg.burstScale;
  burst.style.left   = `${target.x}px`;
  burst.style.top    = `${target.y}px`;
  burst.style.width  = `${burstPx}px`;
  burst.style.height = `${burstPx}px`;
  document.body.appendChild(burst);
  const b = burst.animate(
    [
      { transform: "translate(-50%,-50%) scale(0.2)", opacity: 0 },
      { transform: "translate(-50%,-50%) scale(0.95)", opacity: 1, offset: 0.25 },
      { transform: "translate(-50%,-50%) scale(1.7)", opacity: 0 },
    ],
    { duration: cfg.burstMs, easing: "ease-out", fill: "forwards" },
  );
  b?.addEventListener?.("finish", () => { try { burst.remove(); } catch {} });
  setTimeout(() => { try { burst.remove(); } catch {} }, cfg.burstMs + 360);
}

// Electrical slivers thrown out of the landing, evenly spread with a jitter so
// the ring never reads as a mechanical starburst.
function spawnShards(cfg, target, basisPx) {
  const s = cfg.shards;
  if (!s) return;
  const len = basisPx * s.lenScale;
  for (let i = 0; i < s.count; i++) {
    const baseAng = (360 / s.count) * i;
    const ang = baseAng + (Math.random() * 18 - 9);
    const reach = basisPx * s.spreadScale * (0.55 + Math.random() * 0.45);
    const el = document.createElement("div");
    el.className = "fud-be-shard";
    el.style.left   = `${target.x}px`;
    el.style.top    = `${target.y}px`;
    el.style.width  = `${len * (0.6 + Math.random() * 0.8)}px`;
    el.style.height = `${Math.max(2, basisPx * 0.018)}px`;
    document.body.appendChild(el);
    const a = el.animate(
      [
        { transform: `rotate(${ang}deg) translateX(0px) scaleX(0.3)`, opacity: 0 },
        { transform: `rotate(${ang}deg) translateX(${reach * 0.45}px) scaleX(1)`, opacity: 1, offset: 0.3 },
        { transform: `rotate(${ang}deg) translateX(${reach}px) scaleX(0.2)`, opacity: 0 },
      ],
      { duration: s.ms * (0.75 + Math.random() * 0.5), easing: "cubic-bezier(.15,.7,.3,1)", fill: "forwards" },
    );
    a?.addEventListener?.("finish", () => { try { el.remove(); } catch {} });
    setTimeout(() => { try { el.remove(); } catch {} }, s.ms + 500);
  }
}

function shakeBoard(cfg) {
  const board = canvas.app?.view ?? document.getElementById("board");
  if (!board) return;
  const classes = cfg.shakeClass.split(/\s+/).filter(Boolean);
  board.classList.remove(...classes);
  void board.offsetWidth; // reflow to restart
  board.classList.add(...classes);
  setTimeout(() => { try { board.classList.remove(...classes); } catch {} }, cfg.shakeMs);
}
