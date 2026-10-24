// ============================================================================
// Defeat styles — the table and the flag read (pure; no Foundry, no DOM).
//
// The twin of boss-entrance-fx.js's DESCENT_STYLES: a monster opts into a
// bespoke defeat with an actor flag naming a style here,
//
//   actor.flags["fabula-ultima-companion"].defeatStyle = "dissolve"
//
// set from Token Config → Appearance → Battle Defeat. Anything without the
// flag — every monster in the world when this landed — reads as "standard" and
// keeps the defeat it always had (death SFX → red tint or KO fall → fade).
// The renderer lives in defeat-fx.js; this file is what the bare-Node test
// (defeat-styles.test.mjs) covers.
//
// Every timing is in ms; every size is a fraction of the token's on-screen
// height, so a style reads the same at any zoom. Re-tuning is a constant
// change here, never a code change.
// ============================================================================

export const DEFEAT_MODULE_ID     = "fabula-ultima-companion";
export const DEFEAT_STYLE_FLAG    = "defeatStyle";
export const DEFAULT_DEFEAT_STYLE = "standard";

import { ELEMENT_RGB } from "./gather-styles.js";

const SFX_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const DEFEAT_STYLES = {
  // The body thins into pale motes that drift upward and go out.
  dissolve: {
    label: "Dissolve",
    totalMs: 1700,
    // The sprite cools toward `tintTo` while it fades.
    body: { delayMs: 120, fadeMs: 1150, tintTo: 0xa8d8ff },
    motes: {
      count: 48,
      spawnOverMs: 650,            // motes keep leaving while the body fades
      lifeMs: [600, 1000],
      rise: [0.45, 1.1],           // how far each drifts up
      size: [0.035, 0.085],
      sway: 0.12,
      rgb: ["205,235,255", "160,210,255", "255,255,255"],
    },
    glow: { rgb: "170,215,255", alpha: 0.32, ms: 1100 },
    shake: null,
    sfx: { url: SFX_BASE + "MG_DEATH_BLUR01.wav", volume: 0.55 },
  },

  // A hard white flash, an afterimage that blows outward, a ring and embers.
  burst: {
    label: "Burst",
    totalMs: 1050,
    body: { delayMs: 90, fadeMs: 120, tintTo: null },
    flash: { rgb: "255,248,230", ms: 260, size: 0.9 },
    afterimage: { growTo: 2.3, alpha: 0.55, ms: 620 },
    ring: { rgb: "255,190,120", ms: 700, reach: 1.25, width: 0.07 },
    embers: { count: 28, ms: 820, reach: [0.7, 1.6], size: [0.04, 0.09], lift: 0.35,
              rgb: ["255,175,90", "255,235,190", "255,120,70"] },
    shake: { px: 7, ms: 320 },
    sfx: { url: SFX_BASE + "Enemy_Death.ogg", volume: 0.6 },
  },

  // King Gorger: he ate too much. He shudders through every element colour,
  // swells and bursts; the elements he swallowed scatter and his crown is flung
  // off, lands, bounces once and fades. The crown cut-out (`crown.clip` /
  // `crown.center`) is measured on KingGorger_Standard.png — on other art it
  // would cut the wrong piece. Mockup: claude.ai/artifact/S6HVbfQxWZiKBTATsT83rz.
  overfed: {
    label: "Overfed (King Gorger)",
    totalMs: 2600,
    // the real token goes at once; the copy below stands in for it
    body: { delayMs: 0, fadeMs: 1, tintTo: null },
    copy: { shudderMs: 600, popMs: 1250, jitterHz: 0.11, jitter: [0.018, 0.036, 0.027], hueDeg: 120, swell: 0.38, wobble: 0.04, bright: 0.7 },
    leak: { count: 26, fromMs: 650, toMs: 1200, lifeMs: 450, from: 0.36, to: 0.82, size: 0.064, rgb: ELEMENT_RGB },
    screenFlash: { atMs: 1250, ms: 220, alpha: 0.55, rgb: "255,250,235" },
    flash: { atMs: 1250, ms: 950, size: 1.1, rgb: "255,250,235" },
    embers: { atMs: 1250, ms: 950, count: 63, reach: [1.09, 3.8], size: [0.064, 0.145], lift: 0.45, rgb: ELEMENT_RGB },
    fluff: { atMs: 1250, ms: 950, count: 10, reach: [0.45, 0.82], size: [0.25, 0.45], alpha: 0.8 },
    crown: {
      clip: "inset(0 27% 60% 36%)", center: [0.135, -0.3],
      atMs: 1250, lift: 0.09, up: 0.64, side: 0.42, flyMs: 560, ground: 0.42,
      bounceMs: 240, bounce: 0.145, roll: 0.09, spinDeg: -540, restTiltDeg: 25,
      fadeAfterMs: 1050, fadeMs: 300,
    },
    shake: null,
    sfx: [
      { atMs: 600,  url: SFX_BASE + "Soundboard/Up4.ogg", volume: 0.5 },   // the swell
      { atMs: 1250, url: SFX_BASE + "BurstMax.ogg",       volume: 0.55 },  // the burst
      { atMs: 1810, url: SFX_BASE + "SFX_TINK.wav",       volume: 0.45 },  // crown lands
      { atMs: 2050, url: SFX_BASE + "SFX_TINK.wav",       volume: 0.3 },   // and bounces
    ],
  },

  // King Gorger (Wild): a Smash Bros. KO. The finishing hit freezes him under
  // a camera punch-in, then he is launched off the screen away from whoever hit
  // him, and the screen edge he leaves through erupts in colour. The flight is
  // timed, not paced: he crosses the edge exactly `hitstop.ms + launch.edgeMs`
  // in, however far that edge is, so the blast cue can sit on a constant.
  launched: {
    label: "Launched (Smash KO)",
    totalMs: 2200,
    // Begin on the killing blow — the frame its damage number pops — not when
    // the action has settled (measured 0.15–1.9 s later in real battles). The
    // freeze IS the hit. See defeatStartsOnHit below.
    startOnHit: true,
    body: { delayMs: 0, fadeMs: 1, tintTo: null },
    // The freeze: punch the camera in (a multiple of the current zoom), shake
    // him in place, strobe him white, darken the field around him.
    hitstop: { ms: 700, zoom: 1.7, zoomInMs: 110, shake: [0.075, 0.02], shakeHz: 0.62, strobeMs: 55, strobeUntilMs: 330, dim: 0.4, lines: 36, lineAlpha: 0.55 },
    impact: { ms: 240, size: 0.95, rgb: "255,246,214", ring: "255,206,110" },
    // The release: a kick of the board, then he is gone to the edge in
    // `edgeMs` — short on purpose, the speed is what sells the force.
    launch: { angleDeg: 34, edgeMs: 240, overshoot: 0.9, spinDeg: 900, zoomOutMs: 170, kick: { px: 7, ms: 150 }, trailMs: 200, trailAlpha: 0.75, rings: [0, 0.45], ringMs: 300 },
    // The KO blast, after Smash: one beam fired back across the whole screen
    // along his flight line. A white bloom down its middle, near-parallel
    // streaks in the seven element colours on both fringes sliding inward.
    // `band` (the beam's width) and streak widths are fractions of the SCREEN
    // height; `length` of the screen diagonal — it is a screen-scale event,
    // not a token-scale one.
    blast: {
      ms: 1150, band: 0.46, length: 1.5, core: 0.42, streaks: 58, streakW: [0.002, 0.022], streakLen: [0.12, 0.55],
      slide: [0.6, 1.4], dim: 0.52, dimLeadMs: 80, flash: { ms: 140, alpha: 0.35, size: 0.55 },
      // the opening spray of spikes, the hairline rays fanning wide, the shock
      // ring travelling down the beam, the haze where he went out (`life` =
      // fraction of the beam's life)
      spray: { count: 22, spreadDeg: 16, len: [0.45, 0.95], width: [0.004, 0.012], life: 0.35 },
      rays: { count: 26, spreadDeg: 30, alpha: 0.5 },
      ring: { life: 0.4, travel: 0.55 },
      haze: { rgb: "190,120,255", alpha: 0.35, size: 0.5 },
      shake: { px: 14, ms: 460 }, rgb: ELEMENT_RGB,
    },
    shake: null,
    // Only the exit: the finishing blow already plays its own damage sound.
    sfx: [
      { atMs: 700,  url: SFX_BASE + "Soundboard/SE_SWINGC.wav", volume: 0.5 },   // the launch: heavy swing
      { atMs: 940,  url: SFX_BASE + "Soundboard/SE_EXPLODE3.wav", volume: 0.55 }, // the blast: instant punch
    ],
  },
};

/**
 * Read an actor's defeat style out of its flags. "standard" for anything that
 * is not an explicitly recognised style — unset, blank, wrong type, typo'd or
 * retired — so a bad value never turns into an effect nobody asked for.
 */
export function defeatStyleFromFlags(flags, ns = DEFEAT_MODULE_ID) {
  try {
    const key = String(flags?.[ns]?.[DEFEAT_STYLE_FLAG] ?? "").trim();
    if (!key || key === DEFAULT_DEFEAT_STYLE) return DEFAULT_DEFEAT_STYLE;
    return Object.prototype.hasOwnProperty.call(DEFEAT_STYLES, key) ? key : DEFAULT_DEFEAT_STYLE;
  } catch { return DEFAULT_DEFEAT_STYLE; }
}

/**
 * Does `actor` itself carry a reaction to its own defeat? Scans every item's
 * `reaction_config_table` and every Active Effect's `reactionConfig` blob for a
 * row with `reaction_trigger: "creature_defeated"`. Any such row could change
 * the creature's fate after the blow lands (an undying passive, a last stand),
 * so a style that starts on the hit must not. Conservative on purpose: a row
 * reacting to OTHER creatures' deaths also counts — that only costs the early
 * start, never correctness. Pure: plain objects or Foundry documents.
 */
export function ownsDefeatReaction(actor, ns = DEFEAT_MODULE_ID) {
  const TRIG = "creature_defeated";
  const hasRow = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 3) return false;
    if (String(node.reaction_trigger ?? "").trim() === TRIG && !node.$deleted) return true;
    return Object.values(node).some((v) => hasRow(v, depth + 1));
  };
  const list = (c) => (Array.isArray(c) ? c : (c?.contents ?? (c ? Object.values(c) : [])));
  try {
    for (const it of list(actor?.items)) if (hasRow(it?.system?.props?.reaction_config_table)) return true;
    for (const ae of list(actor?.effects)) if (hasRow(ae?.flags?.[ns]?.reactionConfig)) return true;
  } catch { return true; }   // unreadable → assume it might react
  return false;
}

/**
 * May this defeat begin on the killing blow instead of when the action settles?
 * Every input is a fact the caller has already read; this only combines them, so
 * the rule lives in one place and is testable. All must hold:
 *   style        the actor's defeat style opts in (`startOnHit`)
 *   hp           the blow left exactly 0 HP
 *   inBattle     a Battle Director battle is running (only it removes the token)
 *   willRemove   the removal gates pass now — rank, auto-defeat setting, side
 *   ownReaction  false: nothing of its own can react to its defeat
 */
export function defeatStartsOnHit({ style, hp, inBattle, willRemove, ownReaction }) {
  // Number(null) and Number("") are 0: a missing HP read must not count as dead.
  const dead = hp != null && String(hp).trim() !== "" && Number(hp) === 0;
  return !!(DEFEAT_STYLES[style]?.startOnHit && dead && inBattle && willRemove && ownReaction === false);
}
