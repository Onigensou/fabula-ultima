"use strict";
// ============================================================================
// Kirin's signature shot, built on oni.timeline from an approved mockup. The
// inner script lives in kirin-shots/ as plain text; every timing and size the
// review tuned is here in the cfg, so a tuning pass only edits numbers.
// Same storage rule as the other generators: no backticks in the inner.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ANIM = FORGE + "Animation/";
const SND = FORGE + "Sound/";

// Manifest values (native px, ms, anchor). Soft effects decode smaller: they are
// drawn large and blurred anyway, and each frame is a canvas held for the run.
const CLIPS = {
  chaincast: { url: ANIM + "Ragnarok%20Online/new_chainlightning_cast.webm", w: 264, h: 264, dur: 1333, fps: 15, ax: 0.5, ay: 0.5 },
  laser:     { url: ANIM + "RPG%20Maker%20MV/115_laser_one.webm", w: 628, h: 876, dur: 933, fps: 15, scale: 0.6, ax: 0.457, ay: 0.6553 },
  flash:     { url: ANIM + "RPG%20Maker%20MV/040_flash.webm", w: 834, h: 834, dur: 667, fps: 15, scale: 0.6, ax: 0.5, ay: 0.512 },
  thunder1:  { url: ANIM + "RPG%20Maker%20MV/076_thunder_one_1.webm", w: 624, h: 704, dur: 467, fps: 15, ax: 0.5, ay: 0.858 },
  hit:       { url: ANIM + "RPG%20Maker%20MV/005_hit_thunder.webm", w: 580, h: 580, dur: 667, fps: 15, scale: 0.7, ax: 0.5, ay: 0.5207 },
  storm:     { url: ANIM + "Ragnarok%20Online/thunderstorm.webm", w: 680, h: 560, dur: 983, fps: 15, ax: 0.5147, ay: 0.7107 },
  pillar:    { url: ANIM + "RPG%20Maker%20MV/079_thunder_all_2.webm", w: 992, h: 800, dur: 933, fps: 15, scale: 0.6, ax: 0.4879, ay: 0.65 },
};

const VOLUME = 0.65;
const THUNDER = (n) => SND + "Soundboard/Thunder" + n + ".ogg";
const CUES = [
  [0, SND + "ChargingA.wav", 0.7], [3200, SND + "Laser2.ogg", 0.8], [3300, SND + "Thunder10.m4a", 0.5], [5000, SND + "Wind1.ogg", 0.6],
  [8100, SND + "Flash2.ogg", 0.9], [8150, THUNDER(1), 0.75],
  [9400, THUNDER(9), 0.5], [10000, THUNDER(5), 0.55], [10600, THUNDER(3), 0.55], [11100, THUNDER(7), 0.6],
  [12800, THUNDER(2), 0.6], [13800, THUNDER(4), 0.6], [14800, THUNDER(6), 0.65], [15800, THUNDER(8), 0.7],
  [17500, SND + "Amalthea_Explosion.ogg", 0.95],
];

function divineRailstream(opts = {}) {
  const t = {
    chargeEnd: 3200, rearFrom: 1700, rearTo: 3150,
    panUpFrom: 3700, panUpTo: 6700, panDist: 1.35, blackFrom: 4200, blackTo: 6400,
    flashAt: 8100, vpX: 0.52, vpY: 0.38, rainFrom: 9300, cutAt: 11500,
    firstTick: 11900, lastTick: 17500,
    silFrom: 15600, silTo: 17200, whiteFrom: 16200, whiteTo: 18000,
    eatFrom: 18100, eatTo: 19100, curtainFrom: 18700, curtainTo: 19200,
    clearFrom: 20000, clearTo: 21400, total: 22000,
    zoomHorn: 1.55, zoomParty: 1.22,
    pillars: [[14800, -20], [15600, 70], [16300, -60], [16900, 30]],
  };
  const cfg = Object.assign({
    t,
    ticks: 8,            // only when no Chain plan is supplied (Preview Bench without strikes)
    casterFoot: 0.95, partyFoot: 0.97,
    rearDeg: 40,
    blue: "#7fc1ff",
    // perspective streams: bolt lifetime in ms, how far the near end shoots, ms between bolts (start, end)
    streamMs: 120, streamMsSpread: 80, streamMsBig: 160, streamReach: 20, streamGap0: 50, streamGap1: 26,
    volume: VOLUME,
    sfx: CUES.map(([at, url, v]) => ({ at, url, v: v * VOLUME })),
    impacts: [SND + "Hit_Lightning.wav", SND + "HitElectric.ogg", SND + "Hit_Lightning2.wav"],
    totalTimeoutMs: 32000,
  }, opts.cfg || {});
  const inner = fs.readFileSync(path.join(__dirname, "kirin-shots", "divine-railstream.inner.js"), "utf8");
  const assets = { clips: CLIPS };
  const script = shell({ key: opts.key, name: opts.name, cfg, assets, inner, timeout: cfg.totalTimeoutMs, startOnReady: true });
  const preload = Object.values(CLIPS).map((c) => c.url);
  return { script, timing: { mode: "offset", offset: t.lastTick }, preload };
}

module.exports = { divineRailstream };
