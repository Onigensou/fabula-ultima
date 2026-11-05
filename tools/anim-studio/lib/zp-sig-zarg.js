"use strict";
// ============================================================================
// Zero Power: Meteor Shower (Zarg) — the approved "Zero Power overhaul" mockup,
// round 8 (artifact 5FPS7VFAX7oqnTGy9KZAVC; user-locked cfg, vine bow).
// Shot: zp-shots/zp-zarg.inner.js. Every tuned number lives in CFG below.
// Damage: a 24-hit one-roll Chain (KEYWORDS); the shot cues each tick with
// oni.hit() during the volley and ends after the tail (gate = end).
// ============================================================================
const ZS = require("./zp-signatures.js");
const { F, D5, D4, RO, MV, GG, snd, build } = ZS;

const ZARG = "Z4CFy505cD3nzl1W";
const TARGETS = [{ actor: ZARG, item: "NwH4UInAFxCn958U" }, { world: "hTb8c9ZREooiKs9k" }];
// The items carry no action_keywords today (actor copy and world parent): the builder adds the prop.
const KEYWORDS = "chain 24";

const IMG = "Campaign/The Legend of Dragonslayer/Image/";
const BOWS = { vine: "03308", serpent: "03306" };

// Clip defs from the mockup's assets/meta.js (native px, ms, anchor; GG masks are white shapes).
const CLIPS = {
  ring:     { url: D4("flash_ring_white"), w: 82, h: 82, dur: 233, ax: 0.5, ay: 0.5 },
  storm0:   { url: RO("new_arrowstorm_00"), w: 266, h: 636, dur: 2000, ax: 0.5263, ay: 0.9355, ro: true },
  storm1:   { url: RO("new_arrowstorm_01"), w: 332, h: 670, dur: 2000, ax: 0.5, ay: 0.9567, ro: true },
  psmoke:   { url: RO("new_poisonsmoke_1"), w: 188, h: 310, dur: 1000, ax: 0.5, ay: 0.8097, ro: true },
  hpoison:  { url: RO("hunter_poison"), w: 296, h: 242, dur: 1500, ax: 0.5, ay: 0.6694, ro: true },
  fireBurst:{ url: D4("fire_explosion"), w: 132, h: 164, dur: 633, ax: 0.5, ay: 0.5 },
  ggBurst:  { url: GG("burst_anim02"), w: 682, h: 1024, dur: 300, ax: 0.5, ay: 0.5, mask: true },
  ggSmoke:  { url: GG("smoke_anim11"), w: 170, h: 204, dur: 1500, ax: 0.5, ay: 0.5, mask: true },
  pillar:   { url: MV("117_light_pillar_1"), w: 384, h: 384, dur: 2467, ax: 0.5, ay: 0.8438 },
  darkness: { url: MV("101_darkness_one_1"), w: 546, h: 546, dur: 1467, ax: 0.5, ay: 0.5 },
};
// the volley's per-hit burst for a non-poison element (the mockup's elemBurst map)
const BURST_FOR = { fire: "fireBurst", ice: "ggBurst", bolt: "ggBurst", air: "ggBurst", earth: "ggSmoke", light: "pillar", dark: "darkness" };

const SND = {
  overdrive: "Overdrive.wav", magic4: "Magic4.ogg", wind4: "Wind4.ogg", shot1: "Shot1.ogg", wind7: "Wind7.ogg", magic3: "Magic3.ogg",
  saint4: "Saint4.ogg", saint5: "Saint5.ogg", cpoison: "Condition_Poison.ogg", tick: "System_Tick.mp3", powerup: "Powerup.ogg",
  piercing: "Hit_Piercing.wav", explode: "SE_EXPLODE.wav",
};

// The user-locked cfg (mockup round 8).
const CFG = { tilt: 30, bowSize: 1, chargeMs: 1700, trackMs: 600, flightMs: 1300, skyHold: 1700, skyAngle: 30, glyphScale: 2.4, glyphMs: 1800, glyphCharge: 1400, lensMs: 2200, rainMs: 2600, density: 110, hits: 24 };

function zarg({ bow = "vine" } = {}) {
  const id = BOWS[bow] || BOWS.vine;
  const images = {
    cut: F(IMG + "Cut-in/Zarg_Cut-in002.png"),
    sky: F(IMG + "Map/Game Map/Zarg_Map001.png"),
    bowU: D5("Weapons/Bow", id + "_00.png"), bowL: D5("Weapons/Bow", id + "_01.png"), bowG: D5("Weapons/Bow", id + "_02.png"),
    rune: D5("VFX", "03639_07.png"),
  };
  const sndUrls = {}; for (const [k, f] of Object.entries(SND)) sndUrls[k] = snd(f);
  // every sound is also listed (at -1e9, never fired by the run) so it lands in the preload list
  const sfxPreload = Object.values(sndUrls).map((url) => ({ at: -1e9, url, v: 0 }));
  return build({
    key: "zarg-meteor-shower", name: "Zero Power: Meteor Shower", shot: "zp-zarg",
    clips: CLIPS, images,
    cfg: Object.assign({}, CFG, { bow, snd: sndUrls, burstFor: BURST_FOR, sfx: sfxPreload }),
    gate: null, timeout: 40000,
  });
}

module.exports = { zarg, TARGETS, KEYWORDS, CFG, CLIPS, ZARG };
