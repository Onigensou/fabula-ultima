// Battle Director — Passive Card tuning.
//
// Every knob here is named after a control in the passive card mockup
// (https://claude.ai/artifact/6HN55WN8zNHM3UgqizuKrK), so a screenshot of the
// mockup's settings maps straight onto this file. The values below are the
// user's pick of 2026-11-03 ("not concrete — keep tuning"):
//
//   Detail level 6 — Ready: Card · Enemy states: Card once · Background: Card every time
//   Compact when 5+ cards are up · B Points readout · C Sound by tier · F Color by tier
//   Sound lab: per-cue picks below, gap 350 ms, repeats sound each time
//   Look lab: ×N white with glow · Background lines neutral
//
// Not built (other mockup values): A passive log, D icon flash, E opening in one
// beat, and Background "name on number" (needs the damage numbers to carry the
// passive's name).

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";

export const PASSIVE_CARD_CONFIG = Object.freeze({
  // Detail row. ready: "card" | "chime" (Ready sound with the gold pop, no card) | "pop" (no card, no sound)
  //             enemy: "once" (card the first time each battle) | "icon" (status icon only)
  //             bg:    "every" | "once" (card the first time each battle) | "num" (number only)
  detail: Object.freeze({ ready: "card", enemy: "once", bg: "every" }),

  compact: true,        // cards that arrive while BUSY or more are up come in the compact size
  readout: true,        // B: a points line shows what it granted and the new total, "+1 Adoration (1/5)"
  soundByTier: true,    // C: each tier plays its own cue; off = passive_card for every line
  colorByTier: true,    // F: the tier colors the band's hairlines and each icon frame
  xStyle: "glow",       // ×N suffix look: "glow" | "outline" | "raised"
  backgroundLines: "neutral",   // "neutral" | "gold" (gold = today's lines; gold also means Ready)

  sound: Object.freeze({
    gapMs: 350,         // one character never repeats the same cue within this
    repeats: "each",    // "each" = every ×N count sounds | "first" = only a line's first count
    // null = silent. The volumes are the mockup's loudness-matched ones.
    cues: Object.freeze({
      spotlight:  Object.freeze({ url: `${FORGE}Sound/super_armor.wav`,         vol: 0.30 }),
      offense:    Object.freeze({ url: `${FORGE}Sound/passive_card.wav`,        vol: 0.30 }),
      defense:    Object.freeze({ url: `${FORGE}Sound/passive_card.wav`,        vol: 0.30 }),
      support:    Object.freeze({ url: `${FORGE}Sound/passive_card.wav`,        vol: 0.30 }),
      ready:      Object.freeze({ url: `${FORGE}Sound/Soundboard/Item1.ogg`,    vol: 0.15 }),
      points:     Object.freeze({ url: `${FORGE}Sound/clock_advance.ogg`,       vol: 0.25 }),
      pointsDown: Object.freeze({ url: `${FORGE}Sound/clock_regress.ogg`,       vol: 1.00 }),
      background: null,
    }),
    // C off, or a card with no tier (a notify card): one cue for every line.
    plain: Object.freeze({ url: `${FORGE}Sound/passive_card.wav`, vol: 0.30 }),
  }),

  // Pacing (ms), the mockup's own numbers.
  timing: Object.freeze({
    IN: 280,            // card entrance
    OUT: 260,           // card exit
    HOLD: 1600,         // a card stays this long after its newest line
    LINE_IN: 300,       // a joining line's slide-in
    JOIN: 1000,         // a passive joins its character's live card only within this of the card's last line
    LIFE_CAP: 3000,     // joins stop extending a card past this from its spawn…
    MIN_AFTER: 1000,    // …but every line gets at least this on screen
    CASCADE: 90,        // new cards spawn at least this far apart
    SWAP: 180,          // a character's newer card waits this after the older one slides out
    PLATE_WAIT: 1500,   // a new card waits for a battle-start / round / turn plate, up to this
    BUSY: 5,            // compact size from this many cards on screen
  }),
});

// The seven tiers, highest first: a card takes the color of its highest line.
export const CARD_TIERS = Object.freeze(["spotlight", "offense", "defense", "support", "ready", "points", "background"]);
