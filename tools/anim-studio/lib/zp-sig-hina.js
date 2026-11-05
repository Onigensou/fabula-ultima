"use strict";
// ============================================================================
// Hina — Zero Power: A Million Possibility, from the approved Zero Power overhaul
// mockup (v17; Hina's cfg locked by the user 2026-11-06, round 10 + Magic2 once).
// Shot: zp-shots/zp-hina.inner.js. No damage (Hina picks 3 Opportunities; the
// wheel opens when the animation ends) → gate null, no Chain.
// ============================================================================
const ZS = require("./zp-signatures.js");
const { build, F, RO, MV, snd } = ZS;

const HINA = "dafTLBUscCDNgq8H";
const IMG = "Campaign/The Legend of Dragonslayer/Image/";
// The mockup's volumes were x0.75 of the given number (its sfx()); keep that here.
const at = (ms, file, v) => ({ at: Math.round(ms), url: snd(file), v: Math.min(1, v * 0.75) });

function hina(over) {
  const cfg = Object.assign({ rippleMs: 1100, voidMs: 6000, spawnMs: 250, diveMs: 1325, diveZoom: 40, revealDown: 90, revealScale: 1.35, revealMs: 450, revealTilt: 45, revealHold: 2200 }, over || {});
  // beat times (ms from the start), as the mockup's beats chain them
  const t = {};
  t.ripple = 2150;                                               // cut-in 650 + 850 + 650
  t.dive = t.ripple + 560 + cfg.rippleMs + 250 + 600;            // last ring, reticle pulse, beat
  t.futures = t.dive + cfg.diveMs + 900;                         // black, Pollen at +250, fade 650
  t.reveal = t.futures + cfg.voidMs + 700;
  t.white = t.reveal + 120 + cfg.revealMs + cfg.revealHold;
  t.total = t.white + 1200 + 850 + 1400;
  cfg.t = t;
  cfg.sfx = [
    at(0, "Overdrive.wav", 0.9),
    at(t.ripple, "Teleport.ogg", 0.6),
    at(t.dive, "Teleport.ogg", 0.7),
    at(t.dive + cfg.diveMs + 250, "Pollen.ogg", 0.9),
    at(t.futures, "Magic2.ogg", 0.45),
    at(t.reveal + 120 + cfg.revealMs, "Metal_Shing.mp3", 0.95),
    at(t.white + 2050, "Teleport.ogg", 0.9),
    at(t.white + 2050, "Powerup.ogg", 0.35 / 0.75),
  ];
  return build({
    key: "hina-million-possibility", name: "Zero Power: A Million Possibility", shot: "zp-hina",
    clips: {
      mc: { url: RO("efst_magiccircle__mc"), w: 112, h: 64, dur: 2417, ax: 0.5, ay: 0.5 },
      powerup: { url: MV("051_powerup_1"), w: 508, h: 790, dur: 867, ax: 0.5, ay: 0.543 },
    },
    images: {
      cut: F(IMG + "Cut-in/hina_Cut-in002.png"),
      orb: F(IMG + "Cut-in/hina_Cut-in003.png"),
      voidbg: F(IMG + "Map/Game Map/Hina_Map001.png"),
    },
    cfg, gate: null, timeout: t.total + 15000,
  });
}

// Hina's own copy + the world parent.
const TARGETS = [{ actor: HINA, item: "oe3OP8VmjHJpWJ41" }, { world: "WjrBIzz4zJvO4C4k" }];

module.exports = { hina, TARGETS, HINA };
