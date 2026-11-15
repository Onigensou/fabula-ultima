"use strict";
// ============================================================================
// Gryphon (legacy boss, actor VceM9tFpaVT9Z9fT): his 8 skills on oni.timeline, ported from
// the approved legacy-boss animation mockup (2026-11-15/16; Downburst = the r2 "Rush past"
// rewrite). Each generator returns { script, timing, preload } like the Asura / Deva ports.
//
//   downburst({ key, name })                  Zero Power: Downburst (cut-in, rise, rush past, flyer slam)
//   move({ key, name, move })                 move = "talon" | "razorplume" | "airdrop" | "airblast"
//                                             | "aerialshock" | "turbulence" | "windwall"
//   (talon / razorPlume / airdrop / airBlast / aerialShockwave / turbulenceWind / windWall: shorthands)
//
// The inners live in legacy-shots/ as plain text: _zpkit (shipped cut-in, flinch, hit cue) +
// gryphon-kit (the mockup's shared particles/floor fx in canvas 2D) + the shot. Every number the
// mockup tuned is in the cfg below (mockup px on a 1682 px stage; the inner scales by stage w / 1682).
// Same storage rule as the other generators: no backticks in the inners.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const JB = "modules/JB2A_DnD5e/Library/";
const SB = FORGE + "Sound/Soundboard/";
const SND = FORGE + "Sound/";

// clip defs: w/h = source px, ax/ay = anchor, dur ms, k = the mockup's size factor (MV/JB2A .55),
// add = draw additive. Sizes then multiply straight through from the mockup's "scale".
const clip = (url, w, h, dur, ax, ay, k, add) => ({ url, w, h, dur, ax, ay, k, add: !!add });
const CLIPS = {
  jb_feathers: clip(JB + "Generic/Nature/SwirlingFeathersOutburst03_01_Regular_Textured_400x400.webm", 400, 400, 2333, 0.5, 0.5, 0.55),
  jb_gust: clip(JB + "2nd_Level/Gust_Of_Wind/GustOfWind_01_White_VeryFast_1200x200.webm", 1200, 200, 1000, 0, 0.5, 0.55),
  claw: clip(MV + "016_claw_physical.webm", 336, 336, 400, 0.5, 0.5774, 0.55),
  hit_phys: clip(MV + "001_hit_physical.webm", 488, 488, 333, 0.5, 0.5, 0.55),
  wind1: clip(MV + "091_wind_one_1.webm", 508, 510, 1000, 0.5, 0.8529, 0.55),
  wind2: clip(MV + "092_wind_one_2.webm", 816, 816, 733, 0.5, 0.4853, 0.55),
  powerdown: clip(MV + "054_powerdown_1.webm", 508, 656, 867, 0.5, 0.628, 0.55),
  powerup: clip(MV + "051_powerup_1.webm", 508, 790, 867, 0.5, 0.543, 0.55),
};
// the mockup's sound table (build-assets.js S), by the keys the mockup calls
const SFX = {
  overdrive: SND + "Overdrive.wav", shukuchi: SND + "Shukuchi.wav",
  flash2: SB + "Flash2.ogg", wind1: SB + "Wind1.ogg", wind4: SB + "Wind4.ogg", wind7: SB + "Wind7.ogg",
  damage5: SB + "Damage5.ogg", blowL: SB + "SE_BTL_HitBlowL.ogg", land: SB + "SE_JUMPLANDA.wav",
  slash1: SB + "Slash1.ogg", slash2: SB + "Slash2.ogg", evade: SB + "Evasion1.ogg", powerup: SB + "Powerup.ogg",
};
// his Zero Power cut-in (actor cut_in_zero_power; the inner reads the sheet first, this is the fallback)
const CUTIN = FORGE + "Beastiary/Gryphon/Gryphon_Portrait.png";

const read = (dir, f) => fs.readFileSync(path.join(__dirname, dir, f), "utf8");
const inner = (shot) => read("zp-shots", "_zpkit.inner.js") + "\n" + read("legacy-shots", "gryphon-kit.inner.js") + "\n// ── shot ──\n" + read("legacy-shots", shot);
const pick = (keys) => { const o = {}; for (const k of keys) o[k] = CLIPS[k]; return o; };
const urlsOf = (assets) => Array.from(new Set([...Object.values(assets.clips).map((c) => c.url), ...(assets.cutin ? [assets.cutin] : [])]));

function downburst(opts = {}) {
  const tune = {
    // mockup tunables (defaults approved): rise height px, rise ms, wind gathers ms, rush past ms, flyer spun ms
    lift: 110, rise: 900, gather: 700, rush: 520, spin: 520,
    // fixed beats of the mockup
    cutIn: 650, cutHold: 850, cutOut: 650, flapDown: 110, flapUp: 130, dim: 0.55, pullBack: 60, rushLift: 40,
    spinDeg: 540, spinLift: 120, drop: 190, bounce: 14, bounceUp: 110, bounceDown: 140,
    swoop: 650, swoopLift: 260, swoopUp: 40,
    gustEvery: 2,          // a gust clip on every 2nd ghost (the mockup spawns one per ghost; halved to stay under the live-decoder cap)
  };
  const cfg = Object.assign({ ...tune, casterFoot: 0.95, partyFoot: 0.97, seed: 4410, volume: 0.9, totalTimeoutMs: 30000 }, opts.cfg || {});
  const assets = { clips: pick(["jb_feathers", "jb_gust"]), sfx: SFX, cutin: CUTIN };
  const script = shell({ key: opts.key, name: opts.name, cfg, assets, inner: inner("gryphon-downburst.inner.js"), timeout: cfg.totalTimeoutMs, startOnReady: true });
  // the gate depends on whether anyone is Flying at cast time (the slam beat), so the inner fires it
  return { script, timing: { mode: "default", offset: 0 }, preload: urlsOf(assets) };
}

const MOVE_CLIPS = {
  talon: ["claw"], razorplume: ["hit_phys"], airdrop: [], airblast: ["wind1"], aerialshock: ["wind2"],
  turbulence: ["powerdown"], windwall: ["powerup"],
};
function move(opts = {}) {
  const mv = opts.move;
  if (!MOVE_CLIPS[mv]) throw new Error("legacy-gryphon: unknown move " + mv);
  const tune = { talonGap: 90, lunge: 380, back: 420, grabGap: 40, grab: 420, climb: 700, climbLift: 260, carryLift: 220, drop: 360, ret: 700, wallAhead: 240 };
  const cfg = Object.assign({ move: mv, ...tune, casterFoot: 0.95, partyFoot: 0.97, seed: 1170, volume: 0.9, totalTimeoutMs: 20000 }, opts.cfg || {});
  const assets = { clips: pick(MOVE_CLIPS[mv]), sfx: SFX };
  const script = shell({ key: opts.key, name: opts.name, cfg, assets, inner: inner("gryphon-moves.inner.js"), timeout: cfg.totalTimeoutMs, startOnReady: true });
  // fixed gates (offset from animationStart, which the inner emits on its first frame); target-count
  // dependent ones (Razor Plume, Aerial Shockwave) fire from the inner
  const fixed = {
    talon: cfg.lunge + 3 * 70,
    airdrop: cfg.grab + cfg.climb + 150 + cfg.drop,
    airblast: 450 + 480,
    turbulence: 700,
    windwall: 1300,
  };
  const timing = fixed[mv] != null ? { mode: "offset", offset: fixed[mv] } : { mode: "default", offset: 0 };
  return { script, timing, preload: urlsOf(assets) };
}

const talon = (o = {}) => move({ ...o, move: "talon" });
const razorPlume = (o = {}) => move({ ...o, move: "razorplume" });
const airdrop = (o = {}) => move({ ...o, move: "airdrop" });
const airBlast = (o = {}) => move({ ...o, move: "airblast" });
const aerialShockwave = (o = {}) => move({ ...o, move: "aerialshock" });
const turbulenceWind = (o = {}) => move({ ...o, move: "turbulence" });
const windWall = (o = {}) => move({ ...o, move: "windwall" });

// skill table: item name (exact, world fabula-ultima-2) -> item id + generator
const ACTOR_ID = "VceM9tFpaVT9Z9fT";
const SKILLS = [
  { item: "Zero Power: Downburst", id: "Z5LoMhYj2dfL7pnC", key: "legacy.gryphon.downburst", gen: downburst },
  { item: "Talon", id: "dg2ZGq8uSMPJJXbC", key: "legacy.gryphon.talon", gen: talon },
  { item: "Razor Plume", id: "TIqQFBmYPXji7a58", key: "legacy.gryphon.razorplume", gen: razorPlume },
  { item: "Airdrop", id: "tlpf4YMlOr8XjiqP", key: "legacy.gryphon.airdrop", gen: airdrop },
  { item: "Air Blast", id: "Rl8hDAnGd1YbbVjR", key: "legacy.gryphon.airblast", gen: airBlast },
  { item: "Aerial Shockwave", id: "qxvfCLaGtD1TqWOq", key: "legacy.gryphon.aerialshock", gen: aerialShockwave },
  { item: "Turbulence Wind", id: "eQZ0JjtYYavAx8x8", key: "legacy.gryphon.turbulence", gen: turbulenceWind },
  { item: "Wind Wall", id: "CaOZAPIyTKNdx3BI", key: "legacy.gryphon.windwall", gen: windWall },
];
const buildAll = () => SKILLS.map((s) => ({ ...s, out: s.gen({ key: s.key, name: "Gryphon · " + s.item }) }));

module.exports = { downburst, move, talon, razorPlume, airdrop, airBlast, aerialShockwave, turbulenceWind, windWall, ACTOR_ID, SKILLS, buildAll, CLIPS, SFX };
