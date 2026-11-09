"use strict";
// ============================================================================
// Deva — Fists of Fury / Fists of Focus, built on oni.timeline from the approved
// animation mockup (artifact C7wZxC2jSAo15AAsJfQxRb, v16, "wide cone, full
// screen"). The inner script lives in deva-shots/ as plain text; every number the
// review tuned is in the cfg below (mockup px; the inner scales them by stage
// width / 1682), so a tuning pass only edits numbers here.
// Same storage rule as the other generators: no backticks in the inner.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const GG = FORGE + "Animation/Guilty%20Gear%20Strive/sheets/";
const SB = FORGE + "Sound/Soundboard/";

// The fist art is a 68x101 crop of her own arm (red = Fury, blue = Focus). It is
// tiny, so it rides inside the script as a data URL rather than as a Forge asset.
const dataUrl = (f) => "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "deva-shots", f)).toString("base64");

const ASSETS = () => ({
  fistRed: dataUrl("fist_red.png"),
  fistBlue: dataUrl("fist_blue.png"),
  // Guilty Gear Strive mask sheets; the inner downscales each to ~frameW per frame once
  sheets: {
    burst01: { url: GG + "burst_anim01.png", cols: 2, rows: 2, frames: 4, frameW: 256 },
    burst07: { url: GG + "burst_anim07.png", cols: 2, rows: 2, frames: 4, frameW: 256 },
    burst05: { url: GG + "burst_anim05.png", cols: 5, rows: 2, frames: 10, frameW: 256 },
    spark01: { url: GG + "spark_anim01.png", cols: 3, rows: 2, frames: 6, frameW: 256 },
  },
  powerup: { url: FORGE + "Animation/RPG%20Maker%20MV/051_powerup_1.webm", w: 508, h: 790, dur: 867, ax: 0.5, ay: 0.543 },
  sfx: {
    teleport: SB + "Stare.ogg", powerup: SB + "Powerup.ogg", magic: SB + "Magic4.ogg",
    blowA: SB + "Blow1.ogg", blowB: SB + "Blow3.ogg", blowL: SB + "SE_BTL_HitBlowL.ogg", absorb: SB + "Absorb1.ogg",
  },
});

// mockup tint(hue, sat, br) = sepia(1) saturate(sat) hue-rotate(hue - 38) brightness(br)
const tint = (hue, sat = 6, br = 1.1) => "sepia(1) saturate(" + sat + ") hue-rotate(" + (hue - 38) + "deg) brightness(" + br + ")";
const FORMS = {
  fury:  { rgb: "255,90,60",  bright: 1.25, spark: "#ff6a2a", streak: "255,200,130", lines: "255,215,190", mote: "255,190,150", aura: tint(5) },
  focus: { rgb: "90,200,255", bright: 1.05, spark: "#4cc8ff", streak: "150,220,255", lines: "170,215,255", mote: "150,215,255", aura: tint(205) },
};

function fistsBarrage(opts = {}) {
  const form = opts.form === "focus" ? "focus" : "fury";
  // the user's tuned values (mockup v16)
  const tune = {
    dur: 4000, rate: 9, cone: 66, size: 120, grow: 2.4, flight: 410, trail: 3, aim: 10, spark: 1,
    lines: 140, ticks: 30, jolt: 5, step: 230, tp: 220, zoom: 1.35, zoomMs: 450,
  };
  // the beat clock, derived exactly as the mockup's beats run back to back
  const t = {};
  t.tpOut = tune.tp;                                  // squeezed out
  t.tpShow = t.tpOut + 90;                            // reappears in front of the party
  t.zoomFrom = t.tpShow + Math.round(tune.tp * 1.1);  // camera pushes in
  t.windup = t.zoomFrom + tune.zoomMs;                // aura + lean back
  t.barrage = t.windup + 420;                         // fists
  t.closeAfter = 520;                                 // the last fists clear the frame, then the closing impact
  const close = t.barrage + tune.dur + t.closeAfter;
  t.zoomOutFrom = close + 450 + (form === "focus" ? 800 : 0);
  t.homeFrom = t.zoomOutFrom + 600 + 250 + 200;
  t.homeOut = t.homeFrom + tune.tp;
  t.homeShow = t.homeOut + 90;
  t.total = t.homeShow + Math.round(tune.tp * 1.1) + 350;
  const cfg = Object.assign({
    t, form, ...tune,
    red: FORMS.fury, blue: FORMS.focus,
    casterFoot: 0.95, partyFoot: 0.97,
    fistBake: 3, seed: form === "focus" ? 5151 : 4242,
    volume: 0.9,
    totalTimeoutMs: t.total + 12000,
  }, opts.cfg || {});
  const inner = fs.readFileSync(path.join(__dirname, "deva-shots", "fists-barrage.inner.js"), "utf8");
  const assets = ASSETS();
  const script = shell({ key: opts.key, name: opts.name, cfg, assets, inner, timeout: cfg.totalTimeoutMs, startOnReady: true });
  const preload = [assets.powerup.url, ...Object.values(assets.sheets).map((s) => s.url)];
  // damage gate at the closing impact (offset from animationStart, which the inner emits on its first frame)
  return { script, timing: { mode: "offset", offset: close }, preload };
}

module.exports = { fistsBarrage };
