// ============================================================================
// Soul Tithe — the sounds of its three shows (pure; timed by soul-fx-effects).
//
// Every client plays its own show, so every client plays these locally, on the
// show's own clock (soul-fx-runtime Run.step). Re-tuning a sound is a change
// here, never in the runtime. `peak` = where the file's loudest moment is.
//
//   Tithe (a fragment is torn out of a party member, flies, condenses):
//     the strain → the soul wrenched out → the fireball launches → it lands
//   Calling (a fragment draws Max HP back along the tether):
//     the reach → each bead swallowed → the reel-in
//   Destroyed (a fragment breaks, its flamelets fly home and refund):
//     the cracks → the burst → each flamelet lands → the last one restores
// ============================================================================

import { TITHE, CALLING, DESTROY } from "./soul-fx-effects.js";
import { cueUrls } from "../../shared/sfx-cues.js";

export const SOUL_SFX = Object.freeze({
  tithe: [
    { beat: TITHE.GRIP,   file: "Soundboard/Darkness3.ogg", vol: 0.45, peak: 0.15, label: "the strain" },
    // Magic4's real peak is 0.75 s in, later than the tear: it starts with the show, so its peak
    // lands 0.25 s after the tear, which is how it was auditioned and picked (2026-11-11).
    { beat: TITHE.TEAR,   file: "Soundboard/Magic4.ogg",    vol: 0.55, peak: 0.50, label: "the soul wrenched out" },
    { beat: TITHE.FLY,    file: "Soundboard/Fire2.ogg",     vol: 0.50, peak: 0.20, label: "the fireball launches" },
    { beat: TITHE.ARRIVE, file: "HitFire.ogg",              vol: 0.50, peak: 0.15, label: "it lands and condenses" },
  ],
  calling: (() => {
    const { REACH, PULL, BEADS, TRAVEL, REEL } = CALLING;
    const land = Array.from({ length: BEADS }, (_, i) => PULL[0] + (i * (PULL[1] - PULL[0] - TRAVEL)) / (BEADS - 1) + TRAVEL);
    return [
      { beat: REACH[0], file: "Soundboard/Darkness2.ogg", vol: 0.45, peak: 0.10, label: "the reach" },
      ...land.map((t, i) => ({ beat: t, file: "Soundboard/Absorb1.ogg", vol: 0.24, peak: 0, label: `bead ${i + 1} swallowed` })),
      { beat: REEL[0],  file: "Soundboard/Darkness4.ogg", vol: 0.55, peak: 0.20, label: "the reel-in" },
    ];
  })(),
  destroy: [
    { beat: DESTROY.HIT,   file: "Hit_Ice2.ogg",            vol: 0.50, peak: 0.05, label: "the cracks" },
    { beat: DESTROY.BURST, file: "Soundboard/Collapse3.ogg", vol: 0.50, peak: 0.25, label: "the burst" },
    ...DESTROY.LANDINGS.slice(0, -1).map((t, i) => ({ beat: t, file: "Soundboard/Heal1.ogg", vol: 0.22, peak: 0.30, label: `flamelet ${i + 1} lands` })),
    { beat: DESTROY.LAST,  file: "Soundboard/Recovery.ogg",  vol: 0.50, peak: 0.10, label: "the last flamelet restores" },
  ],
});

/** Several shows of one kind at once (4 tithes, staggered): the later ones play quieter. */
export const STACK_VOL = 0.55;

export const SOUL_SFX_URLS = cueUrls(SOUL_SFX.tithe, SOUL_SFX.calling, SOUL_SFX.destroy);
