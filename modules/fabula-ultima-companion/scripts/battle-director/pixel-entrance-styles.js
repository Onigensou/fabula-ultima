// ============================================================================
// Pixel entrance styles — the table (pure; no Foundry, no DOM).
//
// A third family of enemy entrance styles beside the descents
// (boss-entrance-fx.js) and the gathers (gather-styles.js): pixel-art effects
// drawn live with pixelfx (MIT, github.com/patch-gg/pixelfx; vendored with its
// LICENSE + NOTICE under pixel-entrance/pixelfx/) at the party sprites'
// density, built round the creature's own silhouette. Chosen with the same
// actor flag,
//
//   actor.flags["fabula-ultima-companion"].entranceStyle = "voidDash"
//
// and played by pixel-entrance-fx.js at the battle-start entrance and when the
// creature joins a battle already running.
//
// Approved on the mockup claude.ai/artifact/WQXfrnXm8PPTdQSeaJ9WXk (final
// version, 2026-10-31). `module` names the effect file under pixel-entrance/;
// `options` go to it as they did in the mockup; `reveal` says when the real
// creature shows: "fade" = alpha over d s from t, "module" = the effect's own
// reveal(t) ({ a, rise, shadow }: the summoning circle raises it out of the
// floor). No sound of their own: the group's species roar plays as today.
// ============================================================================

export const PIXEL_ENTRANCE_STYLES = {
  // Tempered Voidog: a glint at the field's edge, then it tears in from
  // off-screen in afterimages and speed lines over a burning floor streak,
  // skids onto its mark in a held white frame and cools under a crackling rim.
  // No flame trail (rejected four times; do not add one without asking).
  voidDash: {
    label: "Void dash (pixel)",
    renderer: "pixel",
    module: "void-dash",
    palette: "VOID",
    totalMs: 1300,
    options: {},
    // the dust is the arena's floor colour (sampled under the creature), never the palette
    arenaDust: true,
    reveal: { mode: "fade", t: 0.33, d: 0.02 },
  },
  // Tempered Banestrix: pixelfx's blink-in scaled to the bird, bursting out of
  // its silhouette in black feathers that dissolve into motes mid-flight.
  blinkFeathers: {
    label: "Blink in + black feathers (pixel)",
    renderer: "pixel",
    module: "blink-in-hd",
    palette: "VOID",
    totalMs: 1500,
    options: { feathers: ["#0e0a14", "#21172f", "#3b2852", "#5d4278", "#8a6ca6", "#c4b0da"] },
    reveal: { mode: "fade", t: 0.48, d: 0.08 },
  },
  // Tempered Looker: a summoning circle sized to its footprint; at the flash
  // it rises out of the circle through a white seam, lit from below, and its
  // eye catches a glint at the end.
  summonCircle: {
    label: "Summoning circle (pixel)",
    renderer: "pixel",
    module: "summon-circle-hd",
    palette: "VOID",
    totalMs: 2200,
    options: {},
    reveal: { mode: "module" },
  },
};

// Every frame gets this many px of room round the effect's own layout: the
// mockup's frames cut a few sparks and the outer glow at their edges (up to
// 23 px past them, measured); the game draws them whole.
export const FRAME_PAD = 24;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * How the creature shows at t seconds into a style whose reveal is "fade":
 * { a, rise, shadow }. "module" reveals are the effect's own (null here).
 */
export function fadeReveal(reveal, t) {
  if (!reveal || reveal.mode !== "fade") return null;
  const k = clamp01((t - reveal.t) / Math.max(1e-6, reveal.d));
  return { a: k, rise: 1, shadow: k };
}

/**
 * Where the void dash starts and where its warning glint shows, in floor px
 * along its run (negative = behind the mark). `edge` = floor px from its feet
 * to the screen edge behind it, `inset` = floor px the glint sits inside that
 * edge, `bodyW` = its width. The mockup's values (feet 362 px from the left
 * edge, 73 px wide): from -460, glint -282. The run always starts with the
 * body fully off-screen; the glint never sits on top of the creature.
 */
export function dashSpan({ edge, inset, bodyW }) {
  const from = -Math.max(460, edge + bodyW * 0.6 + 20);
  const glint = Math.min(-(edge - inset), -bodyW * 2);
  return { from, glint: Math.max(from, glint) };
}
