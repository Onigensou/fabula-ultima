// Reaction landing — a reaction card turning into its skill icon and flying into
// the action card's Reactions box.
//
// Used for your own card (reaction-deck.js deckPlay) and for an ally's small card
// (reaction-hand.js syncAllies), and for a reaction firing by itself
// (reaction-deck.js autoPlay). A reaction with no slot on an action card (a
// standalone window, or a card that doesn't list it) lands on your portrait card.
// Three beats:
//   1. the card's edges close in on the icon, which stays where it is
//   2. the icon flies on one smooth curve: it starts from rest, keeps accelerating
//      and stops dead on contact
//   3. everything fires on the frame it stops: stamp, white flash, sparks, ring,
//      the action card's knock, and the sound
//
// Two variants. A reaction that hinders the action (Negative) hits it: fire sparks,
// a ring that breaks up, the card knocked. One that helps it (Positive) lands in
// Light: rays, a whole ring, stars and rising motes, the card lifting. The action
// card stamps which is which on the pill (reactionTone, passive-card-classify.js).
//
// Only the view moves. The pill stays the source of truth: it is already Applied
// when this starts, and it is only hidden until the icon reaches it.
//
// Approved mockup: claude.ai/artifact/GffjCvdEsmCRXK8HNFYtje

import { playSfx, preloadSfx } from "./director-sfx.js";

const STYLE_ID = "fud-rxl-style";
const TOP_LAYER_ID = "rxd-fly-top";
const TAG = "[ReactionLanding]";

const BOX_OPEN_MS = 240;
const STAMP = 1.3;             // the icon arrives this much too big and presses down to size
const STAMP_MS = 110;
const FLASH_MS = 130;
const RING_MS = 560;
const JOLT_MS = 300;
const FADE_MS = 220;           // reduced motion: fades in place
const ACCEL = 2.2;             // distance = t^ACCEL: from rest, about twice the average speed at the end
const LANDING_GAP_MS = 500;    // landings on this client stay this far apart: the cue rings for ~0.44 s, the burst ~0.48 s

// Three of the game's own sounds on one instant: the ding leads, the thud is the
// hit, Cursor_Decide adds colour. Volumes put the mix at the level of the game's
// other battle UI cues (the click and the passive card, loudest 100 ms about
// -20 dB), so a landing never stands out over them. Cursor_Decide1's file is very
// quiet (peak -18.5 dB), which is why its gain is above 1. An ally's landing plays
// at ALLY_VOLUME of this.
const SOUND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
export const LANDING_CUE = Object.freeze([
  Object.freeze({ url: `${SOUND}clock_advance.ogg`, vol: 0.2 }),
  Object.freeze({ url: `${SOUND}Soundboard/SE_JUMPLANDA.wav`, vol: 0.18 }),
  Object.freeze({ url: `${SOUND}Cursor_Decide1.wav`, vol: 1.1 }),
]);
const ALLY_VOLUME = 0.7;

export function preloadLandingCue() {
  return preloadSfx(LANDING_CUE.map((c) => c.url)).catch(() => {});
}

function playLandingCue(power) {
  const scale = power < 1 ? ALLY_VOLUME : 1;
  for (const c of LANDING_CUE) {
    try { playSfx(c.url, c.vol * scale); } catch (e) { console.warn(TAG, "sound failed", e); }
  }
}

// Reactions often fire together. Each flight books its landing here, so each gets
// its own hit and its own sound instead of all landing on one frame. Returns how
// long a flight taking `flightMs` must hold back to land on its booked time.
let nextLandingAt = 0;
export function bookLanding(flightMs) {
  const now = performance.now();
  const landsAt = Math.max(now + flightMs, nextLandingAt);
  nextLandingAt = landsAt + LANDING_GAP_MS;
  return landsAt - (now + flightMs);
}
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const toneOfPill = (pill) => (pill.dataset.fudReactionTone === "pos" ? "pos" : "neg");
// No pill: against an action by the other side it hinders; otherwise there's nothing to hinder.
const toneWithoutPill = () => (document.querySelector("#fud-bf-mirror-root .fud-bf-card, #fud-battlefield-card-root .fud-bf-card")?.dataset.fudActionSide === "hostile" ? "neg" : "pos");
const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

function topLayer() {
  let l = document.getElementById(TOP_LAYER_ID);
  if (!l) { l = document.createElement("div"); l.id = TOP_LAYER_ID; document.body.appendChild(l); }
  return l;
}

// ── the Reactions box ────────────────────────────────────────────────────────
// With no reaction in effect the box isn't on the card, so the first landing
// opens it. The opening is one animation (held shut through its delay), which
// lets a flight see the box's final layout by seeking to the end for a moment.
const OPEN_ID = "rxl-box-open";
const OTHER_IN_EFFECT = '.fud-bf-reaction-pill:is(.is-applied, .is-auto):not(.is-skipped, .is-unavailable, .is-moot, [data-fud-reaction-moot="1"], .rxh-arriving)';

function holdBoxShut(row, delayMs) {
  const cs = getComputedStyle(row);
  const props = ["height", "marginTop", "marginBottom", "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"];
  const open = {}, shut = {};
  for (const p of props) { open[p] = cs[p]; shut[p] = "0px"; }
  row.style.overflow = "hidden";
  const a = row.animate([{ ...shut, opacity: 0 }, { ...open, opacity: 1 }],
    { id: OPEN_ID, delay: delayMs, duration: BOX_OPEN_MS, easing: "cubic-bezier(.3,.7,.3,1)", fill: "both" });
  const done = () => { row.style.overflow = ""; try { a.cancel(); } catch { /* */ } };
  a.finished.then(done, () => { row.style.overflow = ""; });
}

// Where the pill will be once the box is fully open, whatever the box is doing.
function finalSlot(pill, row) {
  const opening = (row?.getAnimations?.() ?? []).filter((a) => a.id === OPEN_ID && a.playState !== "finished");
  const at = opening.map((a) => a.currentTime);
  opening.forEach((a) => { a.currentTime = a.effect.getComputedTiming().endTime; });
  const slot = box(pill);
  opening.forEach((a, i) => { a.currentTime = at[i]; });
  return slot;
}

// ── the path ─────────────────────────────────────────────────────────────────
// One cubic arc bowed up the screen: a single curve with no inflection, so no
// corner anywhere. Sampled by DISTANCE, so the speed is only the acceleration and
// not an accident of the curve. Exported for the test.
export function flightFrames(dx, dy, startScale, endScale) {
  const len = Math.hypot(dx, dy) || 1;
  let nx = dy / len, ny = -dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const bow = Math.min(len * 0.34, 200);
  const c1 = { x: dx * 0.18 + nx * bow, y: dy * 0.18 + ny * bow };
  const c2 = { x: dx * 0.7 + nx * bow * 0.9, y: dy * 0.7 + ny * bow * 0.9 };
  const at = (u) => {
    const v = 1 - u, A = 3 * v * v * u, B = 3 * v * u * u, C = u * u * u;
    return { x: A * c1.x + B * c2.x + C * dx, y: A * c1.y + B * c2.y + C * dy };
  };
  const STEPS = 200, table = [{ d: 0, ...at(0) }];
  for (let i = 1; i <= STEPS; i++) {
    const pt = at(i / STEPS), prev = table[i - 1];
    table.push({ d: prev.d + Math.hypot(pt.x - prev.x, pt.y - prev.y), ...pt });
  }
  const total = table[STEPS].d || 1;
  const frames = [], N = 60;
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N, dist = total * Math.pow(t, ACCEL);
    while (j < STEPS - 1 && table[j + 1].d < dist) j++;
    const A = table[j], B = table[j + 1], f = Math.min(1, (dist - A.d) / ((B.d - A.d) || 1));
    const prog = dist / total;
    frames.push({
      translate: `${(A.x + (B.x - A.x) * f).toFixed(2)}px ${(A.y + (B.y - A.y) * f).toFixed(2)}px`,
      scale: startScale + (endScale - startScale) * prog * prog,
      offset: t,
    });
  }
  // Which way it was travelling when it stopped: the knock and the sparks follow this.
  const tx = dx - c2.x, ty = dy - c2.y, tl = Math.hypot(tx, ty) || 1;
  return { frames, dir: { x: tx / tl, y: ty / tl } };
}

// ── the flight ───────────────────────────────────────────────────────────────
// `target()` is asked at set-off, so it sees the layout as it is then; null means
// the destination has gone, and the icon just fades. Resolves with the flyer still
// on screen ({ fly, clone, slot, dir, last }): the caller's landing takes it over.
async function flyIcon({ el, iconEl, collapseMs, travelMs, apex, clipBottom, target }) {
  const r = box(el), ic = box(iconEl);
  if (!(r.w > 0) || !(ic.w > 0)) return null;
  const k = r.w / (el.offsetWidth || r.w);

  const fly = document.createElement("div");
  fly.className = "rxl-fly";
  fly.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;transform-origin:${ic.x - r.x + ic.w / 2}px ${ic.y - r.y + ic.h / 2}px`;
  const clone = el.cloneNode(true);
  clone.classList.remove("is-held", "is-busy", "is-leaving", "is-dealt", "is-incoming");
  clone.classList.add("rxl-clone");
  clone.removeAttribute("style");
  clone.style.transform = `scale(${k})`;
  fly.appendChild(clone);
  topLayer().appendChild(fly);
  el.style.visibility = "hidden";

  try {
    // 1. The edges close in on the icon. Clip values are the clone's own px.
    const pad = 3;
    const top = (ic.y - r.y) / k - pad, left = (ic.x - r.x) / k - pad;
    const bottom = (r.h - (ic.y - r.y + ic.h)) / k - pad, right = (r.w - (ic.x - r.x + ic.w)) / k - pad;
    const ease = "cubic-bezier(.5,0,.2,1)";
    clone.querySelector(".bg")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: collapseMs, fill: "both" });
    clone.animate([
      { clipPath: `inset(0px 0px ${clipBottom}px 0px round 12px)` },
      { clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round 9px)` },
    ], { duration: collapseMs, easing: ease, fill: "both" });
    await fly.animate([{ scale: 1 }, { scale: apex }], { duration: collapseMs, easing: ease, fill: "both" }).finished;

    const slot = target();
    if (!slot) {
      await fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: "both" }).finished.catch(() => {});
      fly.remove();
      return null;
    }

    // 2. It sets off, and stops dead on the slot.
    const dx = slot.x + slot.w / 2 - (ic.x + ic.w / 2), dy = slot.y + slot.h / 2 - (ic.y + ic.h / 2);
    const { frames, dir } = flightFrames(dx, dy, apex, slot.w / ic.w * STAMP);
    await fly.animate(frames, { duration: travelMs, easing: "linear", fill: "both" }).finished;
    return { fly, clone, slot, dir, last: frames[frames.length - 1] };
  } catch (e) {
    fly.remove();
    throw e;
  }
}

/**
 * Fly `el` (a hand card or an ally's small card, showing `iconEl`) into `pill`.
 * Must be called in the frame the pill turned Applied, so the pill is hidden
 * before anything paints. A pill that is already showing (Active by itself) stays
 * as it is and just takes the hit. Returns false if it couldn't start (the caller
 * falls back); resolves true once the icon has landed, or the card closed under it.
 *
 * clipBottom: px of the card hidden behind a panel when it starts (local px).
 * booked: the caller has already held back for its landing time (bookLanding).
 */
export async function flyToReactionBox({ el, iconEl, pill, power = 1, collapseMs = 260, travelMs = 480, apex = 1.34, clipBottom = 0, booked = false } = {}) {
  if (!el?.isConnected || !iconEl?.isConnected || !pill?.isConnected) return false;
  const row = pill.closest(".fud-bf-reactions-row");
  if (!row) return false;
  ensureStyles();
  const alreadyShown = pill.classList.contains("is-auto");
  if (!alreadyShown) pill.classList.add("rxh-arriving");
  const firstIn = !alreadyShown && !row.querySelector(OTHER_IN_EFFECT) && !row.getAnimations().some((a) => a.id === OPEN_ID);
  const rm = reducedMotion();
  const hold = booked ? 0 : bookLanding(rm ? FADE_MS : collapseMs + travelMs);
  try {
    if (rm) {
      await sleep(hold);
      if (!el.isConnected || !pill.isConnected) return true;
      // Nothing moves: the card fades out where it is, the icon fades in, the flash marks it.
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: "both" });
      pill.classList.remove("rxh-arriving");
      if (!alreadyShown) pill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS });
      await new Promise((r) => setTimeout(r, FADE_MS));
      el.style.visibility = "hidden";
      if (pill.isConnected) land(pill, row, { power, dir: null, moves: false, tone: toneOfPill(pill) });
      return true;
    }
    if (firstIn) holdBoxShut(row, collapseMs + hold);
    await sleep(hold);
    const flight = await flyIcon({ el, iconEl, collapseMs, travelMs, apex, clipBottom, target: () => (pill.isConnected ? finalSlot(pill, row) : null) });
    if (flight) {
      // 3. The real icon takes over on the frame it stops.
      flight.fly.remove();
      if (pill.isConnected) land(pill, row, { power, dir: flight.dir, moves: true, slot: flight.slot, tone: toneOfPill(pill) });
    }
    return true;
  } catch (e) {
    console.warn(TAG, "flight failed", e);
    return true;
  } finally {
    pill.classList.remove("rxh-arriving");
  }
}

/**
 * The same flight for a reaction with no slot to land in (one played from a
 * standalone window, or an auto-firing one the action card doesn't list): the icon lands on your
 * portrait card, takes the same hit, and is gone. Nothing waits on it.
 * Returns false if it couldn't start.
 */
export async function flyToPortrait({ el, iconEl, portrait, power = 0.6, collapseMs = 180, travelMs = 400, apex = 1.2, booked = false } = {}) {
  if (!el?.isConnected || !iconEl?.isConnected || !portrait?.isConnected) return false;
  ensureStyles();
  const rm = reducedMotion();
  const hold = booked ? 0 : bookLanding(rm ? FADE_MS : collapseMs + travelMs);
  try {
    await sleep(hold);
    if (!el.isConnected || !portrait.isConnected) return true;
    if (rm) {
      await el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: "both" }).finished.catch(() => {});
      el.style.visibility = "hidden";
      playLandingCue(power);
      return true;
    }
    const SIZE = 40;
    const flight = await flyIcon({ el, iconEl, collapseMs, travelMs, apex, clipBottom: 0, target: () => {
      if (!portrait.isConnected) return null;
      const b = box(portrait);
      return b.w > 0 ? { x: b.x + b.w / 2 - SIZE / 2, y: b.y + b.h * 0.56 - SIZE / 2, w: SIZE, h: SIZE } : null;
    } });
    if (!flight) return true;
    const { fly, clone, slot, dir, last } = flight;
    playLandingCue(power);
    clone.animate([
      { filter: "brightness(0) invert(1)" }, { filter: "brightness(0) invert(1)", offset: 0.4 }, { filter: "none" },
    ], { duration: FLASH_MS, fill: "both" });
    portrait.animate([
      { boxShadow: "0 0 0 3px #f3dca3, 0 0 22px 8px rgba(226,194,126,.95)" },
      { boxShadow: "0 0 0 3px rgba(226,194,126,.6), 0 0 12px 4px rgba(226,194,126,.5)", offset: 0.55 },
      { boxShadow: "0 0 0 0 rgba(226,194,126,0), 0 0 0 0 rgba(226,194,126,0)" },
    ], { duration: RING_MS, easing: "ease-out", composite: "add" });
    const tone = toneWithoutPill();
    if (tone === "pos") liftCard(portrait, power); else joltCard(portrait, dir, power, slot);
    burst(slot.x + slot.w / 2, slot.y + slot.h / 2, dir, power, 3, tone);
    // Stamped onto the portrait, a beat to register, then gone.
    const end = last.scale / STAMP, total = STAMP_MS + 200 + 180;
    await fly.animate([
      { translate: last.translate, scale: last.scale, opacity: 1, easing: "cubic-bezier(.2,.9,.3,1)" },
      { translate: last.translate, scale: end, opacity: 1, offset: STAMP_MS / total },
      { translate: last.translate, scale: end, opacity: 1, offset: (STAMP_MS + 200) / total },
      { translate: last.translate, scale: end, opacity: 0 },
    ], { duration: total, fill: "both" }).finished.catch(() => {});
    fly.remove();
    return true;
  } catch (e) {
    console.warn(TAG, "flight failed", e);
    return true;
  }
}

// ── the landing ──────────────────────────────────────────────────────────────
function land(pill, row, { power, dir, moves, slot = null, tone = "neg" }) {
  pill.classList.remove("rxh-arriving");
  playLandingCue(power);
  // The list scrolls, so it would clip the stamp and the ring.
  const list = pill.closest(".fud-bf-reactions-list");
  if (list) {
    list.classList.add("rxl-open-list");
    setTimeout(() => list.classList.remove("rxl-open-list"), RING_MS + 40);
  }
  pill.animate([
    { boxShadow: "0 0 0 3px #f3dca3, 0 0 18px 7px rgba(226,194,126,.95)" },
    { boxShadow: "0 0 0 3px #e2c27e, 0 0 10px 3px rgba(226,194,126,.55)", offset: 0.55 },
    { boxShadow: "0 0 0 2px #3c8c3c, 0 0 0 0 rgba(226,194,126,0)" },
  ], { duration: RING_MS, easing: "ease-out" });
  // White, through the ::after the pill already has for its hover glow.
  pill.animate([
    { backgroundColor: "rgba(255,255,255,1)" },
    { backgroundColor: "rgba(255,255,255,1)", offset: 0.4 },
    { backgroundColor: "rgba(255,255,255,0)" },
  ], { duration: FLASH_MS, pseudoElement: "::after" });
  row.animate([
    { boxShadow: "0 0 0 0 rgba(226,194,126,0)" },
    { boxShadow: "0 0 0 2px rgba(226,194,126,.85), 0 0 14px 3px rgba(226,194,126,.6)", offset: 0.25 },
    { boxShadow: "0 0 0 0 rgba(226,194,126,0)" },
  ], { duration: RING_MS, easing: "ease-out" });
  if (!moves) return;
  pill.animate([{ scale: STAMP }, { scale: 1 }], { duration: STAMP_MS, easing: "cubic-bezier(.2,.9,.3,1)" });
  const s = slot ?? box(pill);
  const card = pill.closest(".fud-bf-card");
  if (card && dir) { if (tone === "pos") liftCard(card, power); else joltCard(card, dir, power, s); }
  burst(s.x + s.w / 2, s.y + s.h / 2, dir, power, [...(pill.parentElement?.children ?? [])].indexOf(pill), tone);
}

// The hit knocks the action card along the flight's direction and tips it a little,
// because the slot is off centre. A short damped spring, back in place in 0.3 s.
function joltCard(card, dir, power, slot) {
  const c = box(card);
  const rx = (slot.x + slot.w / 2 - (c.x + c.w / 2)) / (c.w / 2 || 1);
  const ry = (slot.y + slot.h / 2 - (c.y + c.h / 2)) / (c.h / 2 || 1);
  const torque = Math.max(-1, Math.min(1, rx * dir.y - ry * dir.x));
  const a = 7 * power, rot = torque * 1.1 * power;
  const at = (m) => ({ translate: `${(dir.x * a * m).toFixed(2)}px ${(dir.y * a * m).toFixed(2)}px`, rotate: `${(rot * m).toFixed(3)}deg` });
  card.animate([
    { ...at(0), offset: 0 }, { ...at(1), offset: 0.1 }, { ...at(-0.4), offset: 0.38 }, { ...at(0.15), offset: 0.68 }, { ...at(0), offset: 1 },
  ], { duration: JOLT_MS, easing: "ease-out", composite: "add" });
}

// Positive: nothing hits the card. It lifts as if it took the power, and settles.
function liftCard(card, power) {
  card.animate([
    { translate: "0 0", offset: 0 },
    { translate: `0 ${(-6 * power).toFixed(2)}px`, offset: 0.22, easing: "cubic-bezier(.3,.7,.3,1)" },
    { translate: "0 0", offset: 1 },
  ], { duration: 420, easing: "cubic-bezier(.2,.9,.3,1)", composite: "add" });
}

// The canvas both landings draw on: 2 px grid, 30 fps. `paint(g, O, t)` draws the
// frame at time t round the centre O; `step()` moves any simulation one tick.
const IMPACT_SIZE = 160, IMPACT_PX = 2, IMPACT_DT = 1 / 30;
function playImpact(cx, cy, end, cls, step, paint) {
  const c = document.createElement("canvas");
  c.width = c.height = IMPACT_SIZE;
  c.className = cls;
  c.style.cssText = `left:${Math.round(cx - IMPACT_SIZE)}px;top:${Math.round(cy - IMPACT_SIZE)}px;width:${IMPACT_SIZE * IMPACT_PX}px;height:${IMPACT_SIZE * IMPACT_PX}px`;
  topLayer().appendChild(c);
  const g = c.getContext("2d"), O = IMPACT_SIZE / 2;
  let t = 0, acc = 0, last = performance.now();
  paint(g, O, t);
  // A hidden window gets no frames: the effect must still clean up after itself.
  const bail = setTimeout(() => c.remove(), (end + 1) * 1000);
  const loop = (now) => {
    if (!c.isConnected) { clearTimeout(bail); return; }
    acc += (now - last) / 1000; last = now;
    let moved = false;
    while (acc >= IMPACT_DT) { acc -= IMPACT_DT; t += IMPACT_DT; step(); moved = true; }
    if (t >= end) { clearTimeout(bail); c.remove(); return; }
    if (moved) paint(g, O, t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Light, for a reaction helping the action. Our own effect in stock holy's language
// (pixelfx fx/holy, sunburst + halo): light has no weight, so nothing falls. A long
// cross glint, tapered rays that fly clear of the icon, one whole ring that fades
// evenly, stars that wink and motes that rise. The gold ramp keeps its amber and rust
// ends for the rims, or it vanishes on the bright parchment card.
const LIGHT = { rust: "#c4652e", amber: "#f0a040", gold: "#ffd25e", pale: "#fff0a0", cream: "#fffbe0", white: "#ffffff" };
function burstLight(cx, cy, power, seedBase) {
  let seed = 11 + seedBase * 131;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const size = 0.7 + power * 0.3, R0 = 9;
  const rays = [], stars = [], motes = [];
  for (let i = 0, n = 2 * Math.round(6 * (0.6 + power * 0.4)); i < n; i++) {
    const long = i % 2 === 0;
    rays.push({ a: (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.12, L: (long ? 34 : 19) * size * (0.86 + rnd() * 0.28), w: long ? 4 : 2.6 });
  }
  for (let i = 0, n = Math.round(9 * power) + 2; i < n; i++) {
    stars.push({ a: (i / n) * Math.PI * 2 + rnd() * 1.1, r: (15 + rnd() * 28) * size, b: 0.07 + rnd() * 0.24, life: 0.16 + rnd() * 0.1, big: 1.6 + rnd() * 1.8 });
  }
  for (let i = 0, n = Math.round(13 * power) + 3; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    motes.push({ x: Math.cos(a) * (7 + rnd() * 17), y: Math.sin(a) * (5 + rnd() * 11), b: rnd() * 0.12, life: 0.28 + rnd() * 0.14, up: 18 + rnd() * 26, ph: rnd() * 6, id: i });
  }
  const paint = (g, O, t) => {
    const put = (x, y, col) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), 1, 1); };
    g.clearRect(0, 0, O * 2, O * 2);
    if (t < 0.26) {
      // The glow, in stepped tones so it stays pixel art.
      const f = 1 - t / 0.26, R = (15 + t * 40) * size;
      g.fillStyle = LIGHT.pale;
      for (const [rr, al] of [[1, 0.1], [0.72, 0.16], [0.46, 0.24]]) {
        g.globalAlpha = al * f;
        const r = R * rr;
        for (let y = -Math.floor(r); y <= r; y++) { const w = Math.floor(Math.sqrt(r * r - y * y)); g.fillRect(O - w, O + y, w * 2 + 1, 1); }
      }
      g.globalAlpha = 1;
    }
    const rot = t * 0.55;
    for (const q of rays) {
      const a = q.a + rot, ca = Math.cos(a), sa = Math.sin(a);
      const grow = 1 - Math.pow(1 - Math.min(1, t / 0.13), 3);
      const head = R0 + q.L * (grow + Math.max(0, t - 0.13) * 0.55);
      const tailK = t < 0.13 ? 0 : Math.pow((t - 0.13) / 0.28, 1.25);
      if (tailK >= 1) continue;
      const tail = R0 + (head - R0) * tailK, len = (head - tail) || 1, wid = q.w * (1 - t / 0.5);
      const x0 = ca * tail, y0 = sa * tail, x1 = ca * head, y1 = sa * head, pad = Math.ceil(wid);
      // Each pixel asks where it is along the ray and across it, so a diagonal has no holes.
      for (let Y = Math.floor(Math.min(y0, y1)) - pad; Y <= Math.max(y0, y1) + pad; Y++) {
        for (let X = Math.floor(Math.min(x0, x1)) - pad; X <= Math.max(x0, x1) + pad; X++) {
          const u = (X * ca + Y * sa - tail) / len;
          if (u < 0 || u > 1) continue;
          const across = Math.abs(-X * sa + Y * ca), half = (wid / 2) * (1 - u * 0.85) + 0.3;
          if (across > half) continue;
          const spine = across < 0.5, rim = across > half - 0.7 && half > 0.9;
          put(O + X, O + Y, rim ? (u < 0.6 ? LIGHT.amber : LIGHT.rust)
            : spine ? (u < 0.5 ? LIGHT.white : u < 0.82 ? LIGHT.cream : LIGHT.amber)
            : u < 0.45 ? LIGHT.pale : LIGHT.gold);
        }
      }
    }
    if (t < 0.16) {
      const L = (t < 0.05 ? 30 : 30 * (1 - (t - 0.05) / 0.11)) * size + 6;
      for (const [ux, uy, k] of [[1, 0, 1], [-1, 0, 1], [0, 1, 0.72], [0, -1, 0.72]]) {
        for (let i = 0, n = Math.round(L * k); i <= n; i++) {
          const x = O + ux * (R0 + i), y = O + uy * (R0 + i), u = i / (n || 1);
          put(x, y, u < 0.6 ? LIGHT.white : u < 0.85 ? LIGHT.pale : LIGHT.amber);
          if (u < 0.3) { put(x + uy, y + ux, LIGHT.gold); put(x - uy, y - ux, LIGHT.gold); }
        }
      }
    }
    if (t < 0.32) {
      const m = 1 - Math.pow(1 - t / 0.32, 2.2), r = (11 + m * 26) * size;
      const col = t < 0.08 ? LIGHT.white : t < 0.17 ? LIGHT.pale : LIGHT.gold;
      let i = 0;
      for (let a = 0; a < Math.PI * 2; a += 1 / r) {
        i++;
        if (t > 0.2 && i % (t > 0.26 ? 4 : 2)) continue;
        put(O + Math.cos(a) * r, O + Math.sin(a) * r, col);
        if (t < 0.17) put(O + Math.cos(a) * (r + 1), O + Math.sin(a) * (r + 1), LIGHT.amber);
      }
    }
    for (const s of stars) {
      const u = (t - s.b) / s.life;
      if (u < 0 || u >= 1) continue;
      const L = Math.round(s.big * Math.sin(u * Math.PI) + 0.4), x = O + Math.cos(s.a) * s.r, y = O + Math.sin(s.a) * s.r - u * 4;
      for (let i = 1; i <= L; i++) {
        const c = i === L ? LIGHT.amber : LIGHT.gold;
        put(x + i, y, c); put(x - i, y, c); put(x, y + i, c); put(x, y - i, c);
      }
      put(x, y, LIGHT.white);
    }
    for (const q of motes) {
      const u = (t - q.b) / q.life;
      if (u < 0 || u >= 1) continue;
      if (u > 0.72 && (q.id + Math.round(t * 30)) % 2) continue;   // flicker out
      const x = O + q.x + Math.sin(u * 5 + q.ph) * 1.6, y = O + q.y - q.up * (1 - Math.pow(1 - u, 1.6));
      const col = u < 0.35 ? LIGHT.white : u < 0.7 ? LIGHT.gold : LIGHT.amber;
      put(x, y, col);
      if (u < 0.3) { put(x + 1, y, col); put(x, y + 1, col); put(x + 1, y + 1, col); }
    }
  };
  playImpact(cx, cy, 0.52, "rxl-impact rxl-light", () => {}, paint);
}

// House-style pixel effect, written to the spark rules of the pixel-vfx-materials
// skill (materials/fire.md): a white pop for under 0.1 s, then ballistic sparks with
// streaks, cooling white > yellow > orange > deep red, on a 2 px grid at 30 fps, and
// a pixel ring that breaks up. Deep hues on purpose: the action card is bright
// parchment, so gold alone would vanish.
const SPARK_RAMP = ["#fff8d8", "#ffd23c", "#f2811c", "#b02c16"];
function burst(cx, cy, dir, power, seedBase = 0, tone = "neg") {
  if (tone === "pos") { burstLight(cx, cy, power, seedBase); return; }
  const O = IMPACT_SIZE / 2;
  let seed = 7 + seedBase * 131;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const push = dir ? { x: dir.x * 45, y: dir.y * 45 } : { x: 0, y: 0 };
  const sparks = [];
  const count = Math.round(16 * power) + 2;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rnd() * 0.5, v = (70 + rnd() * 130) * (0.75 + power * 0.25);
    sparks.push({ x: O + Math.cos(ang) * 9, y: O + Math.sin(ang) * 9, vx: Math.cos(ang) * v + push.x, vy: Math.sin(ang) * v + push.y - 30, life: 0.2 + rnd() * 0.2, age: 0, id: i });
  }
  const paint = (g, _O, t) => {
    const put = (x, y, col) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), 1, 1); };
    const line = (x0, y0, x1, y1, col) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= n; i++) put(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, col);
    };
    g.clearRect(0, 0, IMPACT_SIZE, IMPACT_SIZE);
    if (t < 0.3) {
      const m = 1 - Math.pow(1 - t / 0.3, 2.4), r = 11 + m * 25 * (0.7 + power * 0.3);
      const col = t < 0.1 ? "#ffc53a" : t < 0.2 ? "#f2811c" : "#c8481a";
      for (let a = 0; a < Math.PI * 2; a += 1 / r) {
        if (t > 0.18 && Math.sin(a * 11 + 1.3) > 0.1 - (t - 0.18) * 6) continue;
        put(O + Math.cos(a) * r, O + Math.sin(a) * r, col);
        if (t < 0.13) put(O + Math.cos(a) * (r + 1), O + Math.sin(a) * (r + 1), col);
      }
    }
    if (t < 0.1) {
      const L = (t < 0.04 ? 13 : 7) * (0.7 + power * 0.3);
      for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) line(O + ux * 9, O + uy * 9, O + ux * (9 + L), O + uy * (9 + L), "#ffffff");
      for (const [ux, uy] of [[0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) line(O + ux * 10, O + uy * 10, O + ux * (10 + L * 0.5), O + uy * (10 + L * 0.5), "#ffe27a");
    }
    for (const q of sparks) {
      if (q.age >= q.life) continue;
      const f = q.age / q.life;
      if (f > 0.75 && (q.id + Math.round(t * 30)) % 2) continue;   // flicker out in the last quarter
      const col = SPARK_RAMP[Math.min(3, Math.floor(f * 4))], tail = SPARK_RAMP[Math.min(3, Math.floor(f * 4) + 1)];
      line(q.x - q.vx * 0.035, q.y - q.vy * 0.035, q.x, q.y, tail);
      put(q.x, q.y, col);
      // Fat and hot while young, so they read against sand and parchment alike.
      if (f < 0.55) { put(q.x + 1, q.y, col); put(q.x, q.y + 1, col); put(q.x + 1, q.y + 1, col); }
    }
  };
  const DT = IMPACT_DT;
  const step = () => {
    const d = Math.exp(-3.2 * DT);
    for (const q of sparks) {
      q.vx *= d; q.vy = q.vy * d + 320 * DT;
      q.x += q.vx * DT; q.y += q.vy * DT; q.age += DT;
    }
  };
  playImpact(cx, cy, 0.48, "rxl-impact", step, paint);
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#${TOP_LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 120; }
.rxl-fly { position: absolute; pointer-events: none; will-change: translate, scale;
  filter: drop-shadow(0 6px 10px rgba(0,0,0,.5)) drop-shadow(0 0 9px rgba(226,194,126,.8)); }
.rxl-clone { position: absolute !important; left: 0 !important; top: 0 !important; margin: 0 !important; translate: none !important;
  transform-origin: 0 0 !important; transition: none !important; animation: none !important; visibility: visible !important;
  opacity: 1 !important; pointer-events: none !important; box-shadow: none !important; }
.rxl-impact { position: absolute; image-rendering: pixelated; pointer-events: none; }
/* The pill is Applied already; its icon appears when the flight reaches it. */
.fud-bf-card .fud-bf-reaction-pill.rxh-arriving { visibility: hidden; }
.fud-bf-card .fud-bf-reactions-list.rxl-open-list { overflow: visible; }
`;
  document.head.appendChild(st);
}
