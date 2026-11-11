// ============================================================================
// Nidhogg's fall → his crystal: the whole show on one clock (pure; no DOM, no
// Foundry). docs/nidhogg-boss-design.md §8b, mockup v15 FINAL
// (tools/nidhogg-fall-mockup/work/script.js SHOW + render()).
//
// Two variants:
//   first  (20.6 s) — the first time the dragon falls: the smoke covers the
//          party too, black at 7.4, the camera centres the crystal unseen, three
//          red + green blips, the crystal fades in SOLID, one quick 3D flash
//          shows the soul, the camera goes back, the party fades back, the HUD
//          comes back (19.4–19.9), the Crystal Round goes on.
//   repeat (5.8 s)  — every later fall: mockup 3's blip without its glass shards;
//          the party stays, no camera move, the HUD stays.
//
// fallState(kind, T) is everything the show (nidhogg-fall-show.js) draws at
// time T; FALL_SFX the user's sound picks (§8b "Sound — RULED").
// ============================================================================

import { FALL } from "./fall-smoke.js";
import { BIRTH, COMBO, comboAt } from "./void-birth.js";

export { FALL, BIRTH, COMBO };
export const KINDS = Object.freeze(["first", "repeat"]);

/** The soul (the heart the blips beat at) above the crystal's feet, in effect px (seed 68: 18 + bot - soulY). */
export const SOUL_UP_FX = 117.2;

/** The first fall's camera, party and HUD (s). The later fall moves none of them. */
export const SHOW = Object.freeze({
  first: Object.freeze({ camIn: Object.freeze([7.5, 8.2]), camOut: Object.freeze([18.2, 19.4]), partyIn: Object.freeze([18.5, 19.4]),
    hudOut: Object.freeze([0.15, 0.6]), hudIn: Object.freeze([19.4, 19.9]), end: COMBO.first.end }),
  repeat: Object.freeze({ end: BIRTH.repeat.end }),
});

/** Named beats a rule can wait on (s). */
export const BEATS = Object.freeze({
  first: Object.freeze({ engulf: FALL.first.engulfFrom, black: FALL.first.settleTo, crystal: COMBO.first.fadeFrom, soul: COMBO.first.clearAt, end: SHOW.first.end }),
  repeat: Object.freeze({ engulf: FALL.repeat.engulfFrom, black: FALL.repeat.settleTo, crystal: BIRTH.repeat.blip, soul: BIRTH.repeat.blip, end: SHOW.repeat.end }),
});

export const fallEnd = (kind) => SHOW[kind === "first" ? "first" : "repeat"].end;

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const ease2 = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const span = (T, [a, b]) => ease2((T - a) / (b - a));

/**
 * Everything drawn at time T (s into the fall) of `kind`:
 *   smoke      — the smoke layer is drawn (the arena is drawn exactly as long: it once blinked back for 0.1 s)
 *   smokeOver  — the smoke is drawn OVER the party (first fall: it covers them too)
 *   arenaBlack — the arena is gone (pitch black from the smoke's settle on; the Crystal Round stays black)
 *   party      — the party + summons alpha (first fall: hidden under the black, back 18.5–19.4)
 *   hud        — the HUD's opacity (first fall: out 0.15–0.6, back 19.4–19.9)
 *   cam        — 0 = the battle framing, 1 = the crystal centred (first fall only)
 *   crystal    — null, or { alpha, reveal, opaque, sweep, flameK, scale (about the soul), hitAge (s, null = no hit),
 *                debris } for the crystal host
 *   void       — null, or { birth: the void-birth plan, k: its light } for the heart's effect layer
 *   swell      — the soft light as the soul shows (first fall)
 *   screenFlash — the blip's screen flash alpha (later fall)
 *   done       — the battle can go on (the Crystal Round)
 */
export function fallState(kind, T) {
  const first = kind === "first", P = FALL[first ? "first" : "repeat"];
  const out = { kind: first ? "first" : "repeat", T, smoke: T < P.settleTo, smokeOver: first, arenaBlack: T >= P.settleTo,
    party: 1, hud: 1, cam: 0, crystal: null, void: null, swell: 0, screenFlash: 0, done: T >= fallEnd(kind) };
  if (first) {
    const S = SHOW.first, C = COMBO.first, K = comboAt(T, C);
    out.cam = span(T, S.camIn) * (1 - span(T, S.camOut));
    out.party = T < P.settleTo ? 1 : span(T, S.partyIn);
    out.hud = clamp01(1 - span(T, S.hudOut) + span(T, S.hudIn));
    if (K.on) out.crystal = { alpha: Math.min(1, K.fade * 4), reveal: K.fade, opaque: K.opaque, sweep: K.sweep, flameK: 1 + 0.6 * K.flare + 0.4 * K.swell, scale: 1, hitAge: null, debris: true };
    if (T >= C.beats[0]) out.void = { birth: C.birth, k: 1 - K.fade };
    out.swell = K.swell;
    return out;
  }
  const B = BIRTH.repeat;
  if (T >= B.blip) {
    // the pop: 1.14 → 0.97 → 1, a white frame for 0.05 s, the hit's shake (no shards)
    const f = T - B.blip, s = f < 0.05 ? 1.14 : f < 0.16 ? 1.14 - 0.17 * ((f - 0.05) / 0.11) : f < 0.32 ? 0.97 + 0.03 * ((f - 0.16) / 0.16) : 1;
    out.crystal = { alpha: 1, reveal: 1, opaque: 0, sweep: null, flameK: 1, scale: s, hitAge: Math.max(0, f - 0.05), debris: false };
    if (f < 0.35) out.screenFlash = f < 0.05 ? B.flash : B.flash * Math.pow(1 - (f - 0.05) / 0.3, 2);
  }
  if (T >= B.sparkAt) out.void = { birth: B, k: 1 };
  return out;
}

/* ── Sound: the user's picks (2026-11-11/12, §8b). A one-shot starts at beat − peak (shared/sfx-cues.js). ── */

const C1 = COMBO.first;
export const FALL_SFX = Object.freeze({
  first: Object.freeze([
    { beat: FALL.first.flash, file: "Soundboard/Magic3.ogg", vol: 0.5, peak: 0.05, label: "his soul's light gathers" },
    { beat: FALL.first.flash, file: "Flash.mp3", vol: 0.55, peak: 0.5, label: "the white flash" },
    ...C1.beats.map((b, i) => ({ beat: b, file: "Soundboard/Blind.ogg", vol: 0.5, peak: 0.15, label: `blip ${i + 1}` })),
    { beat: C1.sweepAt + 0.15, file: "Soundboard/Wind1.ogg", vol: 0.55, peak: 0.4, label: "the flash passes through" },
    { beat: C1.clearAt + 0.05, file: "Soundboard/Fire1.ogg", vol: 0.5, peak: 0.35, label: "his soul shows" },
  ]),
  repeat: Object.freeze([
    { beat: FALL.repeat.flash, file: "Soundboard/Magic3.ogg", vol: 0.5, peak: 0.05, label: "his soul's light gathers" },
    { beat: FALL.repeat.flash, file: "Flash.mp3", vol: 0.55, peak: 0.5, label: "the white flash" },
    { beat: 3.95, file: "Soundboard/Magic2.ogg", vol: 0.45, peak: 0.6, label: "red motes gather" },
    { beat: BIRTH.repeat.blip, file: "Soundboard/Ice2.ogg", vol: 0.5, peak: 0, label: "the crystal pops in" },
  ]),
});
/** The smoke swallows everything: a BED (fade in 0.8 s, loops, fades out over its last 1.2 s). */
export const FALL_BED = Object.freeze({
  first: Object.freeze({ from: 2.8, to: 7.4, file: "BGS/Darkness.ogg", vol: 0.5, fadeIn: 0.8, fadeOut: 1.2 }),
  repeat: Object.freeze({ from: 1.0, to: 3.25, file: "BGS/Darkness.ogg", vol: 0.5, fadeIn: 0.8, fadeOut: 1.2 }),
});
/** The bed's volume at T (0 outside it). */
export function bedVolume(bed, T) {
  if (!bed || T < bed.from || T >= bed.to) return 0;
  return bed.vol * Math.min(1, (T - bed.from) / bed.fadeIn) * Math.min(1, (bed.to - T) / bed.fadeOut);
}
