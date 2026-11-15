"use strict";
// ============================================================================
// Legacy bosses: Jack and Jill (+ the shared Mug / Cleaving Strike that Rauben
// also uses), built on oni.timeline (LIVE board) from the approved legacy boss
// mockup (part-b2.js, overridden by round 3: Apex afterimages on every move and
// the Temper Tantrum "Fuming" beat with comic puffs; round 4: one monster sound
// only; the eruption is the pixelfx fire pillar).
//
// Each shot = Zero Power kit (cut-in easings) + legacy-shots/twins-kit + one
// shot file, wrapped by dungeon-templates.shell(). Every tuned number is in the
// cfg below (mockup px on a 1682 px stage; the inner scales by stage width / 1682).
// Timing: default — the inner fires the damage gate (oni.fireDone) where the
// mockup's markGate() sits, and cues oni.hit() on every contact.
// Same storage rule as the other generators: no backticks in any inner.
//
//   LT.apexArrow({ key, name })      Jack  Zero Power: Apex Arrow
//   LT.thiefBow / snaringArrow / burningArrow / poisonArrow({ key, name })
//   LT.temperTantrum({ key, name })  Jill  Zero Power: Temper Tantrum
//   LT.pulverize / heavyAxe({ key, name })
//   LT.mug({ key, name, coins })     Jill (coins 2) / Rauben (coins 4)
//   LT.cleave({ key, name })         Jill / Rauben
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const GGW = FORGE + "Animation/Guilty%20Gear%20Strive/webm/";
const PX = FORGE + "Animation/pixelfx/";
const JB2A = "modules/JB2A_DnD5e/Library/";
const SB = FORGE + "Sound/Soundboard/";
const SND = FORGE + "Sound/";
const NPC = FORGE + "Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/";

// clip defs: w/h = source px, ax/ay = anchor, dur ms, k = the mockup's size factor (MV / JB2A / pixelfx .55),
// add = draw additive (GG masks, pixelfx light layers)
const clip = (url, w, h, dur, ax, ay, k, add) => ({ url, w, h, dur, ax, ay, k, add: !!add });
const CLIPS = {
  hit_phys: clip(MV + "001_hit_physical.webm", 488, 488, 333, 0.5, 0.5, 0.55),
  slash_phys: clip(MV + "006_slash_physical.webm", 378, 378, 333, 0.4683, 0.5794, 0.55),
  powerdown: clip(MV + "054_powerdown_1.webm", 508, 656, 867, 0.5, 0.628, 0.55),
  fire_one: clip(MV + "066_fire_one_1.webm", 776, 784, 733, 0.5, 0.8827, 0.55),
  wind: clip(MV + "091_wind_one_1.webm", 508, 510, 1000, 0.5, 0.8529, 0.55),
  ggslash: clip(GGW + "slashanim01.webm", 512, 682, 600, 0.5, 0.5, 0.55, true),
  smite: clip(JB2A + "2nd_Level/Divine_Smite/DivineSmite_01_Regular_BlueYellow_Target_400x400.webm", 400, 400, 2333, 0.5, 0.5, 0.55),
  // pixelfx fire/flame-pillar export (clip.json: 552x768, anchor .5/.9063, 5033 ms)
  pillar_back: clip(PX + "pxfx_fire_pillar_back.webm", 552, 768, 5033, 0.5, 0.9063, 0.55),
  pillar_front: clip(PX + "pxfx_fire_pillar_front.webm", 552, 768, 5033, 0.5, 0.9063, 0.55),
  pillar_light: clip(PX + "pxfx_fire_pillar_light.webm", 552, 768, 5033, 0.5, 0.9063, 0.55, true),
};
// the mockup's build-assets S table, for the keys these moves use
const SFX = {
  overdrive: SND + "Overdrive.wav", evade: SB + "Evasion1.ogg", bow1: SB + "Crossbow.ogg", jump2: SB + "SE_BTL_HighJump.ogg",
  sword1: SB + "Sword1.ogg", magic4: SB + "Magic4.ogg", crit: SB + "SE_BTL_HitCritical.ogg", coin: SB + "Coin.ogg",
  swingA: SB + "SE_SWINGA.wav", swingC: SB + "SE_SWINGC.wav", swingF: SB + "SE_SWINGF.wav", slash1: SB + "Slash1.ogg", slash2: SB + "Slash2.ogg",
  fire1: SB + "Fire1.ogg", darkness1: SB + "Darkness1.ogg", earth5: SB + "Earth5.ogg", blowL: SB + "SE_BTL_HitBlowL.ogg",
  explosion2: SB + "Explosion2.ogg", monster3: SB + "Monster3.ogg",
  charging: SND + "ChargingA.wav", shukuchi: SND + "Shukuchi.wav", berserker: SND + "BerzerkerCaster.wav",
  steal: SND + "Steal.ogg", hitpierceb: SND + "Hit_PiercingB.ogg", hitslashb: SND + "Hit_SlashingB.wav",
};
const CUT = { jack: NPC + "Jack/Jack_Standard.png", jill: NPC + "Jill/Jill_Standard.png" };

// which clips / sounds each shot file draws on (so a script only carries what it plays)
const USES = {
  apex: { clips: ["wind"], sfx: ["overdrive", "evade", "bow1", "hitpierceb", "jump2", "sword1", "charging", "shukuchi", "crit", "magic4"], cut: "jack" },
  thief: { clips: ["hit_phys"], sfx: ["bow1", "hitpierceb", "steal", "coin"] },
  snaring: { clips: ["hit_phys", "powerdown"], sfx: ["bow1", "hitpierceb", "swingC"] },
  burning: { clips: ["hit_phys", "powerdown", "fire_one"], sfx: ["bow1", "hitpierceb", "fire1"] },
  poison: { clips: ["hit_phys", "powerdown"], sfx: ["bow1", "hitpierceb", "darkness1"] },
  tantrum: { clips: ["pillar_back", "pillar_front", "pillar_light"], sfx: ["overdrive", "earth5", "blowL", "berserker", "explosion2", "monster3"], cut: "jill" },
  pulverize: { clips: ["smite", "powerdown"], sfx: ["jump2", "hitslashb"] },
  heavyaxe: { clips: ["slash_phys", "powerdown"], sfx: ["swingF", "blowL"] },
  mug: { clips: ["hit_phys"], sfx: ["swingA", "slash1", "steal", "coin"] },
  cleave: { clips: ["ggslash", "slash_phys"], sfx: ["swingF", "slash1", "slash2"] },
};
const SHOT = { apex: "jack", thief: "jack", snaring: "jack", burning: "jack", poison: "jack", tantrum: "jill", pulverize: "jill", heavyaxe: "jill", mug: "shared", cleave: "shared" };

const read = (p) => fs.readFileSync(p, "utf8");
const ZPKIT = read(path.join(__dirname, "zp-shots", "_zpkit.inner.js"));
const KIT = read(path.join(__dirname, "legacy-shots", "twins-kit.inner.js"));
const inner = (move) => ZPKIT + "\n" + KIT + "\n// ── shot ──\n" + read(path.join(__dirname, "legacy-shots", "twins-" + SHOT[move] + ".inner.js"));
const pickObj = (src, keys) => Object.fromEntries(keys.map((k) => [k, src[k]]));

function build(move, opts, tune, timeoutMs) {
  const u = USES[move];
  const assets = { clips: pickObj(CLIPS, u.clips), sfx: pickObj(SFX, u.sfx), images: u.cut ? { cut: CUT[u.cut] } : {} };
  const cfg = Object.assign({ move, casterFoot: 0.95, partyFoot: 0.97, seed: 2525, volume: 0.75, totalTimeoutMs: timeoutMs }, tune || {}, opts.cfg || {});
  const script = shell({ key: opts.key, name: opts.name, cfg, assets, inner: inner(move), timeout: cfg.totalTimeoutMs, startOnReady: true });
  const preload = Array.from(new Set([...Object.values(assets.clips).map((c) => c.url), ...Object.values(assets.images)]));
  return { script, timing: { mode: "default", offset: 0 }, preload };
}

// ── Jack ──
// Apex Arrow tune (mockup defaults): flip = backflip ms, slow = slow-mo hold ms, height = flip height (mockup px)
// Full takeover (live: false): the camera pushes in to zoom 1.25 over 300 ms on the apex and snaps back in 200 ms.
const apexArrow = (o = {}) => build("apex", o, { flip: 560, slow: 750, height: 150, zoom: 1.25, live: false }, 22000);
const thiefBow = (o = {}) => build("thief", o, {}, 15000);
const snaringArrow = (o = {}) => build("snaring", o, {}, 15000);
const burningArrow = (o = {}) => build("burning", o, {}, 15000);
const poisonArrow = (o = {}) => build("poison", o, {}, 15000);
// ── Jill ──
// Temper Tantrum tune: stomp gap, eruption, fuming (ms)
const temperTantrum = (o = {}) => build("tantrum", o, { stomp: 380, erupt: 900, fume: 1200 }, 25000);
const pulverize = (o = {}) => build("pulverize", o, {}, 15000);
const heavyAxe = (o = {}) => build("heavyaxe", o, {}, 15000);
// ── shared (Rauben's port calls these with his own key / name; Mug takes coins: 4 for him) ──
const mug = (o = {}) => build("mug", o, { coins: o.coins ?? 2 }, 15000);
const cleave = (o = {}) => build("cleave", o, {}, 15000);

module.exports = { apexArrow, thiefBow, snaringArrow, burningArrow, poisonArrow, temperTantrum, pulverize, heavyAxe, mug, cleave, CLIPS, SFX };
