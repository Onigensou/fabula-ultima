"use strict";
// ============================================================================
// Geist (legacy boss, Actor UYAabJiUZJ1uKers): the July oni-helper scripts ported to oni.timeline on the
// LIVE board, from the approved legacy-boss mockup (artifact L94fYQHEHkfasPW8fhfJ3G; session 9c564c42 lb/
// part-b4.js + overrides r3b, r6, r7). Each shot = legacy-shots/geist-kit.inner.js + one move file,
// wrapped by dungeon-templates shell(). Every tuned number is in the cfg below.
//
//   LG.darkBane / souleater / torcleaver   attacks: the gate fires at the END of the shot (July round 2:
//                                          keeps BD's CSB HP-recompute pause out of the motion); pass
//                                          cfg.gateAtContact to gate on the hit instead
//   LG.shadowWall / shadowStrike           buffs: gate on the buff beat
//   LG.livingShadow / darkMissionary       summons: gate when the shade(s) have condensed, on the July
//                                          spawn-cell prediction, so the real token appears on the shade
//   LG.imbuedAttack                        "Attack (imbued by Shadow Strike)": generator only, not wired
//
// Mockup px (1682 px Training Ground stage) are scaled by stage width / 1682 in the inner; values ported
// from the shipped scripts (slash sizes, particle spreads, shake) are scene px, as shipped.
// Storage rule: no backticks / dollar-brace in the inner files.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const PX = FORGE + "Animation/pixelfx/";
const SB = FORGE + "Sound/Soundboard/";
const SND = FORGE + "Sound/";
const JB2A = "modules/JB2A_DnD5e/Library/";

// clip defs for oni.timeline: w/h = source px, dur ms, ax/ay = anchor, add = draw additive
const clip = (url, w, h, dur, ax, ay, add) => ({ url, w, h, dur, ax, ay, add: !!add });
const px = (name, layer, w, h, dur, ax, ay) => clip(PX + name + "_" + layer + ".webm", w, h, dur, ax, ay, layer === "light");
const CLIPS = {
  trail01: clip(JB2A + "Generic/Weapon_Attacks/Melee/Group01/TrailAttack01_01_02_Regular_PinkPurple_800x600.webm", 800, 600, 1333, 0.5, 0.5),
  trail05: clip(JB2A + "Generic/Weapon_Attacks/Melee/Group05/TrailAttack05_01_04_Regular_PinkPurple_800x600.webm", 800, 600, 1467, 0.5, 0.5),
  skull: clip(JB2A + "Cantrip/Toll_The_Dead/TollTheDeadSkullSmoke_01_Regular_Green_400x400.webm", 400, 400, 1867, 0.5, 0.5),
  circle: clip(JB2A + "Generic/Magic_Signs/IllusionCircleIntro_02_Dark_Purple_800x800.webm", 800, 800, 3542, 0.5, 0.5),
  powerup: clip(MV + "051_powerup_1.webm", 508, 790, 867, 0.5, 0.543),
  // pixelfx exports (clip.json: fu/crescent-wave 360x300 anchor .6111/.5 500 ms loop; plasma-explosion 672x600 1733 ms)
  pxfx_dark_crescent_front: px("pxfx_dark_crescent", "front", 360, 300, 500, 0.6111, 0.5),
  pxfx_dark_crescent_light: px("pxfx_dark_crescent", "light", 360, 300, 500, 0.6111, 0.5),
  pxfx_dark_plasma_back: px("pxfx_dark_plasma", "back", 672, 600, 1733, 0.5, 0.5),
  pxfx_dark_plasma_front: px("pxfx_dark_plasma", "front", 672, 600, 1733, 0.5, 0.5),
  pxfx_dark_plasma_light: px("pxfx_dark_plasma", "light", 672, 600, 1733, 0.5, 0.5),
};
const SFX = {
  swingA: SB + "SE_SWINGA.wav", swingF: SB + "SE_SWINGF.wav", slashL: SB + "SE_BTL_HitSlashL.ogg", blowL: SB + "SE_BTL_HitBlowL.ogg",
  wind7: SB + "Wind7.ogg", magic4: SB + "Magic4.ogg", powerup: SB + "Powerup.ogg",
  darkness1: SB + "Darkness1.ogg", darkness3: SB + "Darkness3.ogg", darkness4: SB + "Darkness4.ogg", darkness5: SB + "Darkness5.ogg",
  hitpierceb: SND + "Hit_PiercingB.ogg", blind: SND + "Blind.ogg", spook: SND + "Spook.mp3",
};

const KIT = fs.readFileSync(path.join(__dirname, "legacy-shots", "geist-kit.inner.js"), "utf8");
const inner = (f) => KIT + "\n// ── shot ──\n" + fs.readFileSync(path.join(__dirname, "legacy-shots", f), "utf8");

// clips = keys of CLIPS this shot uses; sfx = keys of SFX
function build(opts, file, base, clipKeys, sfxKeys) {
  const cfg = Object.assign({ casterFoot: 0.95, partyFoot: 0.97, seed: 4417, volume: 1, totalTimeoutMs: 20000 }, base, opts.cfg || {});
  const assets = { clips: {}, sfx: {} };
  for (const k of clipKeys) assets.clips[k] = CLIPS[k];
  for (const k of sfxKeys) assets.sfx[k] = SFX[k];
  const script = shell({ key: opts.key || "geist." + file.replace(/\.inner\.js$/, ""), name: opts.name || file, cfg, assets, inner: inner(file), timeout: cfg.totalTimeoutMs, startOnReady: true });
  const preload = Array.from(new Set([...Object.values(assets.clips).map((c) => c.url), ...Object.values(assets.sfx)]));
  return { script, timing: { mode: "default", offset: 0 }, preload };
}

const darkBane = (opts = {}) => build(opts, "geist-dark-bane.inner.js", {
  needsTarget: true, lungeMs: 340, backMs: 420,
  slashSize: 420, impactParticles: 14, particleSpread: 130, particleMs: 460, shakeMs: 300, shakeIntensity: 7, hitVol: 0.5,
  gateAtContact: false,
}, ["trail01"], ["swingF", "hitpierceb"]);

const souleater = (opts = {}) => build(opts, "geist-souleater.inner.js", {
  needsTarget: true, dimTo: 0.4, castVol: 0.85,
  impactSize: 240, impactMs: 300, shakeMs: 460, shakeAmp: 12, soulSize: 70, drainMs: 800,
  gateAtContact: false,
}, [], ["darkness4"]);

const torcleaver = (opts = {}) => build(opts, "geist-torcleaver.inner.js", {
  needsTarget: true,
  // shipped CFG (July)
  slashSize: 460, slashSideDist: 150, dashMs: 160, dashFrac: 0.22, homeMs: 300, waveTravelMs: 360,
  particleMs: 460, shakeMs: 300,
  // approved round 3/6 changes: bigger crescent (pixelfx, ~2.2x), more particles, harder shake, small plasma on impact
  crescentScale: 2.5, hitParticles: 22, particleSpread: 200, shakeIntensity: 10, plasmaScale: 0.7,
  gateAtContact: false,
}, ["trail05", "pxfx_dark_crescent_front", "pxfx_dark_crescent_light", "pxfx_dark_plasma_back", "pxfx_dark_plasma_front", "pxfx_dark_plasma_light"],
["swingA", "swingF", "slashL", "wind7", "darkness4", "blowL"]);

const shadowWall = (opts = {}) => build(opts, "geist-shadow-wall.inner.js", {
  sacSize: 260, sacRise: 0.55, sacHold: 600, sacVol: 0.85, circleSize: 340, circleVol: 0.85,
}, ["skull", "circle", "powerup"], ["blind", "darkness3", "powerup"]);

const shadowStrike = (opts = {}) => build(opts, "geist-shadow-strike.inner.js", {}, [], ["darkness5", "darkness3", "magic4"]);

const livingShadow = (opts = {}) => build(opts, "geist-soul-summon.inner.js", { count: 1, shadeScale: 0.8 }, [], ["darkness1", "darkness4"]);
const darkMissionary = (opts = {}) => build(opts, "geist-soul-summon.inner.js", { count: 3, shadeScale: 0.55 }, [], ["darkness1", "darkness4", "spook"]);

const imbuedAttack = (opts = {}) => build(opts, "geist-imbued.inner.js", {
  needsTarget: true, lungeMs: 340, backMs: 420, gateAtEnd: false,
}, ["pxfx_dark_plasma_back", "pxfx_dark_plasma_front", "pxfx_dark_plasma_light"], ["darkness4", "darkness3", "swingF", "slashL"]);

// actor UYAabJiUZJ1uKers item ids -> generator (Shadowbringers and The Blackest Night are not here)
const ITEMS = {
  bUu8h4C4kis0z3QL: { name: "Dark Bane", gen: darkBane },
  TNYXBbOxhHCXZZ5S: { name: "Souleater", gen: souleater },
  jFDqULDfaJIyCqp0: { name: "Torcleaver", gen: torcleaver },
  slPJ2kAvobcND9QL: { name: "Shadow Wall", gen: shadowWall },
  S01TD1lW8JUnapHh: { name: "Shadow Strike", gen: shadowStrike },
  tkplYk5nVtf3nu66: { name: "Living Shadow", gen: livingShadow },
  hwRQZH4zxC0vB8wh: { name: "Dark Missionary", gen: darkMissionary },
};

module.exports = { ACTOR: "UYAabJiUZJ1uKers", ITEMS, darkBane, souleater, torcleaver, shadowWall, shadowStrike, livingShadow, darkMissionary, imbuedAttack, CLIPS, SFX };
