"use strict";
// Ninja Log (accessory passive) — the substitution trick, from the approved
// "Ninja Log: Substitution" mockup (round 3, 2026-11-06,
// https://claude.ai/artifact/PzakhaAGxbMu5E9vXyP8ny). Shot: party-shots/ninja-log.inner.js.
// Plays at the BLOCK moment (director-vfx playBlockVfx → the carrier item's
// flags.fabula-ultima-companion.animationScript), on whoever wears it.
// Every timing / size the review tuned lives here.
const PS = require("./party-signatures.js");
const { GG, cue, build } = PS;

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const LOG_IMG = FORGE + "Item%20Icon/Log.png";
// Klonoa/ is not a folder cue() searches, so this one is spelled out (mockup volume).
const WOOD_THUD = { url: FORGE + "Sound/Klonoa/wood_pop_a.wav", v: 0.55 };

function ninjaLog() {
  // ms. swap = when the log replaces the wearer (inside the first puff)
  const t = { swap: 70, pop: 360, drop: 380, bounce: 240, lie: 400, logGone: 90, vanishHold: 340, returnPause: 300, reveal: 70 };
  // sizes as fractions of the wearer's drawn height (mockup: Zarg 157 px tall)
  const k = { logSize: 0.6, popH: 0.55, drift: 0.26, swapPuff: 1.39, vanishPuff: 1.31, backPuff: 1.11 };
  const land = t.swap + t.pop + t.drop;
  const vanish = land + t.bounce + t.lie;
  const sfx = [
    cue(0, "Shukuchi.wav", 0.6 / 0.7),          // cue() scales by 0.7: lands at the mockup volume 0.6
    Object.assign({ at: land }, WOOD_THUD),
    cue(vanish, "SmokeBomb.wav", 0.55 / 0.7),
  ];
  const out = build({
    key: "ninja-log", name: "Ninja Log", shot: "ninja-log",
    clips: { poof: { url: GG("smoke_anim08"), w: 256, h: 256, dur: 800, ax: 0.5, ay: 0.5, mask: true } },
    images: { log: LOG_IMG },
    cfg: { t, k, sfx },
    gate: null,
  });
  // A carrier animation plays beside the attacker's own: it must never fire the global
  // oni:animationStart / oni:animationEnd hooks BD's damage gate listens to (unscoped).
  const n0 = (out.script.match(/'oni:animation(Start|End)'/g) || []).length;
  out.script = out.script.replace(/'oni:animationStart'/g, "'oni:carrierAnimationStart'").replace(/'oni:animationEnd'/g, "'oni:carrierAnimationEnd'");
  if (n0 < 2 || /'oni:animation(Start|End)'/.test(out.script)) throw new Error("ninja-log: shell hook rename failed (" + n0 + ")");
  return out;
}

module.exports = { ninjaLog };
