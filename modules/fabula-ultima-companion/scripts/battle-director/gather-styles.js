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

  // King Gorger (Wild): a cinematic fake-out. A colossal shadow swallows the
  // field; a letterboxed cutaway shows a building-sized black silhouette from
  // a 3D camera that lowers down his front and pulls back past the party; a
  // last strike whites the screen out — then a hard cut to the battle, where he
  // is one tile big, with a small ring of rays behind him. Drawn by
  // giant-entrance-fx.js (it has its own scene; only the beats live here).
  giant: {
    label: "Giant (fake-out cinematic)",
    renderer: "giant",
    totalMs: 12900,
    shadowMs: 3400,   // the shadow has swallowed the field (black) by here
    headMs: 3600,     // the cutaway fades in on his crown
    restMs: 8100,     // the camera move ends behind the party
    whiteMs: 9100,    // the last strike: the screen eases to white and holds
    cutMs: 11300,     // hard cut to the battle; every storm cue stops dead
    raysMs: 1500,     // the rays behind him, from the cut
    // lightning in the cutaway's 3D scene: { atMs, strength, x, z, top, bottom } (metres)
    strikes: [
      { atMs: 4150, strength: 1,    x: -6,  z: 32, top: 85, bottom: 17 },
      { atMs: 5300, strength: 0.85, x: 10,  z: 33, top: 80, bottom: 12 },
      { atMs: 6600, strength: 0.8,  x: -12, z: 33, top: 80, bottom: 6 },
      { atMs: 8100, strength: 1,    x: 5,   z: 29, top: 75, bottom: 9 },    // behind his shoulder
      { atMs: 9100, strength: 1,    x: -6,  z: 30, top: 85, bottom: 19 },   // onto his crown: the white-out
    ],
    sfx: [
      { atMs: 0,    url: SFX + "BGS/Quake.ogg",             volume: 0.6 },
      { atMs: 1700, url: SFX + "BGS/Quake.ogg",             volume: 0.45 },
      { atMs: 4150, url: SFX + "Soundboard/Thunder10.ogg",  volume: 0.6 },
      { atMs: 5300, url: SFX + "Soundboard/Thunder9.ogg",   volume: 0.5 },
      { atMs: 6600, url: SFX + "Soundboard/Thunder5.ogg",   volume: 0.45 },
      { atMs: 8100, url: SFX + "Soundboard/Thunder1.ogg",   volume: 0.55 },
      { atMs: 9100, url: SFX + "Soundboard/Thunder9.ogg",   volume: 0.6 },
      { atMs: 9300, url: SFX + "BGS/Quake.ogg",             volume: 0.4 },
    ],
    // after the cut (everything above is silenced first)
    cutSfx: { url: SFX + "Klonoa/wood_pop_a.wav", volume: 0.54 },
  },
};
