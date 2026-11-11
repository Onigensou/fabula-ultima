// ============================================================================
// Nidhogg's death (his crystal body shatters) — its sounds (pure; timed by
// crystal-death.js DEATH). Played by every client on the show's own clock
// (crystal-death-show.js step), as the show itself. `peak` = where the file's
// loudest moment is, so it lands on the beat.
//
//   four flashes (the seal straining) → the cracks spread → three soul jets →
//   the build-up (a rumble that peaks on the shatter, four more pours)
//   → the shatter (a break and an explosion) → the rumble rolls on under the held
//   white (no swell, no shimmer: user ruling 2026-11-11) → silence into the black
//   (the battle music already stopped on the kill).
// ============================================================================

import { DEATH } from "./crystal-death.js";
import { cueUrls } from "../shared/sfx-cues.js";

export const DEATH_SFX = Object.freeze([
  ...DEATH.flashes.map((t, i) => ({ beat: t, file: "Soundboard/Flash1.ogg", vol: 0.32 + 0.06 * i, peak: 0, label: `flash ${i + 1}` })),
  { beat: DEATH.crack, file: "Soundboard/Crash.ogg", vol: 0.60, peak: 0.40, label: "the cracks spread" },
  ...DEATH.jets.map((t, i) => ({ beat: t, file: "Soundboard/Darkness4.ogg", vol: 0.42, peak: 0.20, label: `soul jet ${i + 1}` })),
  // a 12 s dark rumble whose loudest moment is 4.35 s in: it swells through the build-up into the
  // shatter, then rolls on under the white for ~8 s
  { beat: DEATH.shatter, file: "BGS/Darkness.ogg", vol: 0.55, peak: 4.35, label: "the build-up rumble" },
  ...DEATH.pours.map((t, i) => ({ beat: t, file: "Soundboard/Fire1.ogg", vol: 0.36, peak: 0.35, label: `pour ${i + 1}` })),
  { beat: DEATH.shatter, file: "Soundboard/Collapse4.ogg", vol: 0.70, peak: 0.05, label: "the shatter" },
  { beat: DEATH.shatter, file: "Soundboard/SE_EXPLODE3.wav", vol: 0.60, peak: 0.20, label: "the explosion" },
]);

export const DEATH_SFX_URLS = cueUrls(DEATH_SFX);
