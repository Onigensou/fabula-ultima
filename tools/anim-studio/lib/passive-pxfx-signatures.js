"use strict";
// ============================================================================
// Passive shots built from pixelfx clips (approved mockup 2026-11-10:
// claude.ai/artifact/GmHAYWhV8rCRHVigfTc4bw).
//
//   Ampere · Volt Counter        pxfx_bolt_volt_counter (fu/volt-counter)
//   Skizzik · Static Buildup     pxfx_bolt_static_orbit3 + _ball + _burst (fu/static-orbit, fu/static-burst)
//
// Both are played by a play_animation row in the passive's own chain, before its
// deal_damage, so the hit lands at the shot's impact (default timing: the inner
// calls oni.fireDone() there). The Static orbit while charges build is NOT here:
// it is a charge cue (battle-director/charge-orbit-fx.js) read from the Static AE.
//
// Clip sources: E:\...\Animation\pixelfx\src\fx\fu\ (volt-counter.js, static-orbit.js,
// static-burst.js); export commands in that repo's foundry/manifest.json.
// Same storage rule as the other generators: no backticks in the inner.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const PX = FORGE + "Animation/pixelfx/";
const SND = FORGE + "Sound/";

// manifest entries (width = clip px at export scale 2, anchor = the pixelfx origin)
const CLIPS = {
  volt:   { base: PX + "pxfx_bolt_volt_counter",  width: 528, anchor: { x: 0.5, y: 0.6667 } },
  orbit1: { base: PX + "pxfx_bolt_static_orbit1", width: 240, anchor: { x: 0.5, y: 0.875 } },
  orbit2: { base: PX + "pxfx_bolt_static_orbit2", width: 240, anchor: { x: 0.5, y: 0.875 } },
  orbit3: { base: PX + "pxfx_bolt_static_orbit3", width: 240, anchor: { x: 0.5, y: 0.875 } },
  ball:   { base: PX + "pxfx_bolt_static_ball",   width: 240, anchor: { x: 0.5, y: 0.875 } },
  burst:  { base: PX + "pxfx_bolt_static_burst",  width: 352, anchor: { x: 0.5, y: 0.8125 } },
};
const layersOf = (c, layers = ["back", "front", "light"]) => layers.map((l) => c.base + "_" + l + ".webm");

// The Static AE's charge cue (written onto the AE template by the builder).
const STATIC_CHARGE_ORBIT = {
  clips: { "1": CLIPS.orbit1.base, "2": CLIPS.orbit2.base },
  w: 240, anchor: { x: 0.5, y: 0.875 },
  bodyH: 90,          // Skizzik was 45 px tall at pixelfx 1x in the mockup; clips export at 2x
};

const inner = (f) => fs.readFileSync(path.join(__dirname, "passive-shots", f), "utf8");

function voltCounter(opts = {}) {
  const cfg = Object.assign({
    clip: CLIPS.volt,
    k: 1,
    bodyPx: 66,             // Ampere was 33 px tall at 1x in the mockup (×2 export)
    impactMs: 300,          // the first ring is out; = the clip's brightest frame
    sfx: SND + "Soundboard/Paralyze3.ogg", sfxVol: 0.6,     // Volt Counter's existing cue
    sfx2: "HitElectric", sfx2Vol: 0.45,
    volume: 1,
    totalTimeoutMs: 6000,
  }, opts.cfg || {});
  const script = shell({ key: opts.key, name: opts.name, cfg, inner: inner("volt-counter.inner.js"), timeout: cfg.totalTimeoutMs });
  return { script, timing: { mode: "default", offset: 0 }, preload: layersOf(CLIPS.volt) };
}

function staticDischarge(opts = {}) {
  const cfg = Object.assign({
    orbit3: CLIPS.orbit3, ball: CLIPS.ball, burst: CLIPS.burst,
    casterBodyPx: 90,       // Skizzik, as above
    victimBodyPx: 80,       // a party battler was 40 px tall at 1x in the mockup
    // orbit / burst geometry in clip px (the pixelfx options ×2): where the balls leave and land
    orbitRx: 60, orbitRy: 18, orbitCy: -40,
    burstRx: 40, burstRy: 12, burstCy: -40,
    spinMs: 350, spinTurnsPerSec: 2,
    flyMs: 320, staggerMs: 50, arcPx: 60, arcStepPx: 25,
    burstLeadMs: 40,        // the burst starts this long before the last ball lands (its balls take over)
    burstImpactMs: 360,     // the balls meet: fu/static-burst MEET
    hitstopMs: 60,
    sfxCharge: SND + "Soundboard/Paralyze3.ogg", sfxChargeVol: 0.45,
    sfxFly: "ThunderStep", sfxFlyVol: 0.45,
    sfxBlow: "HitElectric", sfxBlowVol: 0.7,
    volume: 1,
    totalTimeoutMs: 8000,
  }, opts.cfg || {});
  const script = shell({ key: opts.key, name: opts.name, cfg, inner: inner("static-discharge.inner.js"), timeout: cfg.totalTimeoutMs });
  return { script, timing: { mode: "default", offset: 0 }, preload: [...layersOf(CLIPS.orbit3), ...layersOf(CLIPS.ball, ["front", "light"]), ...layersOf(CLIPS.burst)] };
}

module.exports = { voltCounter, staticDischarge, CLIPS, STATIC_CHARGE_ORBIT };
