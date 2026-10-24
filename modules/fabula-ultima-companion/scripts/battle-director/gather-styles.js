// ============================================================================
// Gather entrance styles — the table (pure; no Foundry, no DOM).
//
// A second family of entrance styles beside boss-entrance-fx.js's descents.
// Where a descent drops a creature in from above, a GATHER builds it out of
// the field: energy is pulled in to the spot, and the creature pops out of it.
// Chosen with the same actor flag,
//
//   actor.flags["fabula-ultima-companion"].entranceStyle = "feast"
//
// and played by gather-entrance-fx.js — at the battle-start entrance, and when
// the creature joins a battle already running (a companion or summon arriving;
// director-init.spawnLiveDirectorTokens).
//
// Times are ms from the start; sizes are fractions of the token's on-screen
// height `h`, so a style reads the same at any zoom. Re-tuning is a constant
// change here. Approved on the mockup claude.ai/artifact/S6HVbfQxWZiKBTATsT83rz.
// ============================================================================

const SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

// The seven element colours King Gorger eats.
export const ELEMENT_RGB = [
  "255,92,54",   // fire
  "111,214,255", // ice
  "255,225,74",  // bolt
  "125,255,154", // air
  "196,140,74",  // earth
  "255,246,208", // light
  "160,96,255",  // dark
];

export const GATHER_STYLES = {
  // King Gorger (companion): the field's elements are pulled into one spot,
  // he gulps them and springs out. No dimming; over in 2 s.
  feast: {
    label: "The Feast",
    totalMs: 2000,
    // dark ripples on the ground where he will appear (until he pops)
    ripples: { count: 3, everyMs: 260, lifeMs: 700, untilMs: 1030, reach: 1.0, width: 0.055, rgb: "60,30,90", alpha: 0.55 },
    // motes rush in from the screen edges; `from` = start distance as a share
    // of the screen's long side
    motes: { count: 84, spawnOverMs: 450, lifeMs: [380, 520], from: [0.45, 0.7], swirl: [1.4, 2.6], size: [0.064, 0.145] },
    orb: { growMs: [80, 850], shrinkMs: [900, 1000], radius: 0.33, spinMs: 120, y: -0.055 },
    flash: { atMs: 980, ms: 200, radius: 1.36, rgb: "255,250,235" },
    fluff: { atMs: 980, ms: 470, count: 12, reach: [0.5, 0.9], size: [0.27, 0.5] },
    // the creature itself: squash-and-stretch out of the fluff with a little hop
    pop: { atMs: 1030, ms: 350, hopMs: 300, hop: 0.24, fromScale: [1.45, 0.35] },
    glint: { atMs: 1380, ms: 300, size: 0.2, at: [0.153, -0.39] },
    ring: { atMs: 1380, ms: 570, from: 0.36, to: 1.18, width: 0.064, alpha: 0.75 },
    sfx: [
      { atMs: 0,    url: SFX + "AbsorbElement.ogg",  volume: 0.5 },
      { atMs: 950,  url: SFX + "Eating.mp3",         volume: 0.6 },
      { atMs: 1030, url: SFX + "Soundboard/SE_Jump.wav", volume: 0.5 },
      { atMs: 1380, url: SFX + "SFX_TINK.wav",       volume: 0.45 },
    ],
  },
};
