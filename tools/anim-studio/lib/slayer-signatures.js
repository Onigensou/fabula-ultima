"use strict";
// ============================================================================
// Slayer (Zarg's class, 2026-11-13): Bane Oils, Giant Killer, Lockdown.
// Approved mockup v3: claude.ai/artifact/H7kodjsPFBHdSeufy2CqNM (source part-slayer.js).
//
// The drawing lives in the module (battle-director/slayer-fx.js, procedural PIXI,
// every number from the mockup); these scripts only pick the take and call it, so
// a tuning pass is a module edit, not a world rewrite. Takes come from the
// play_animation row's "#variant" (Bane Oils, Lockdown) or the rider cosmetic's
// variant + amount (Giant Killer, Lockdown "cut"): shell({ passVariant: true }).
//
// Every sound and clip the shots use is already on Forge (Sound/Soundboard,
// Sound/Klonoa, Animation/RPG Maker MV, Animation/Disgaea 4).
// Written by tools/safe-edit/bin/_build-slayer-animations.js.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const inner = (f) => fs.readFileSync(path.join(__dirname, "slayer-shots", f), "utf8");

function baneOils() {
  const script = shell({ key: "slayer-bane-oils", name: "Bane Oils", cfg: { totalTimeoutMs: 9000 }, inner: inner("bane-oils.inner.js"), timeout: 9000, passVariant: true });
  // "resolve": the item's own ANIMATION state never plays it; the species chains' play_animation rows do
  return { script, timing: { mode: "resolve", offset: 0 }, preload: [MV + "051_powerup_1.webm", MV + "054_powerdown_1.webm", MV + "055_powerdown_2.webm"] };
}
function giantKiller() {
  const script = shell({ key: "slayer-giant-killer", name: "Giant Killer", cfg: { totalTimeoutMs: 4000 }, inner: inner("giant-killer.inner.js"), timeout: 4000, passVariant: true });
  return { script, timing: { mode: "resolve", offset: 0 }, preload: null };
}
function lockdown() {
  const script = shell({ key: "slayer-lockdown", name: "Lockdown", cfg: { totalTimeoutMs: 8000 }, inner: inner("lockdown.inner.js"), timeout: 8000, passVariant: true });
  return { script, timing: { mode: "resolve", offset: 0 }, preload: null };
}

module.exports = { baneOils, giantKiller, lockdown };
