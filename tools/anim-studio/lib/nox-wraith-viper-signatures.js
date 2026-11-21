"use strict";
// ============================================================================
// Nox Wraith + Nox Viper (Nox Legion, Sealed Cavern) action animations on oni.timeline, ported from the approved
// mockup (claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU v8, all approved; per-move spec = the final round code + slider
// defaults). Each shot = nox-shots/wraith-viper-kit.inner.js + wraith-viper-<monster>.inner.js, wrapped by
// dungeon-templates.shell(). Numbers the review tuned live in the cfg below (mockup px on a 1682 px stage).
// Storage rule: no backticks / dollar-brace in any inner.
//   WRAITH_ITEMS / VIPER_ITEMS: { "<item name>": () => ({ script, timing, preload }) } (nox-registry.js)
//   EXTRA: generators for play_animation rows that are not an item's own script (Bile Spew's Armor Break beat).
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");
const { CLIPS, SFX, RGB } = require("./nox-assets.js");

const read = (f) => fs.readFileSync(path.join(__dirname, "nox-shots", f), "utf8");
const inner = (shot) => read("wraith-viper-kit.inner.js") + "\n// ── shot ──\n" + read("wraith-viper-" + shot + ".inner.js");
const PX = (name) => ["_back", "_front", "_light"].map((l) => name + l).filter((k) => CLIPS[k]);

function assetsFor({ clips = [], sfx = [] }) {
  const a = { clips: {}, sfx: {} };
  for (const k of clips) {
    const c = CLIPS[k]; if (!c) throw new Error("nox-assets: no clip " + k);
    a.clips[k] = { url: c.url, w: c.w, h: c.h, dur: c.dur, ax: c.ax, ay: c.ay, k: c.k, impact: c.impact, add: c.layer === "light" };
  }
  for (const s of sfx) { if (!SFX[s]) throw new Error("nox-assets: no sfx " + s); a.sfx[s] = SFX[s]; }
  return a;
}
const preloadOf = (a) => Array.from(new Set([...Object.values(a.clips).map((c) => c.url), ...Object.values(a.sfx)].filter((u) => /^https?:/.test(u))));

// gate: a number = offset mode (RESOLVE starts that many ms after animationStart); null = default mode, the shot
// fires the gate itself (its time depends on the target count)
function build(opts, shot, cfgIn, a, gate, passVariant = false) {
  const cfg = Object.assign({ casterFoot: 0.95, partyFoot: 0.97, volume: 0.75, rgb: RGB, totalTimeoutMs: 25000 }, cfgIn, opts.cfg || {});
  const script = shell({ key: opts.key, name: opts.name, cfg, assets: a, inner: inner(shot), timeout: cfg.totalTimeoutMs, startOnReady: true, passVariant });
  return { script, timing: gate == null ? { mode: "default", offset: 0 } : { mode: "offset", offset: gate }, preload: preloadOf(a) };
}

// ── Nox Wraith ──
// Soul Ripper (approved sliders): full takeover (camera zooms / follows)
const SR = { rise: 46, arc: 1900, peak: 70, zin: 1.25, hands: 1.9, gap: 140, hover: 900, pull: 900, soulN: 22 };
function soulRipper(opts = {}) {
  const gate = 900 + SR.arc + CLIPS.pxfx_nox_hands_front.impact;   // the hands' grab (clip time 500)
  const a = assetsFor({ clips: ["pxfx_nox_hands_front", "pxfx_nox_hands_light", "101_darkness_one_1"], sfx: ["spook", "wind7", "darkness1", "absorb1", "absorb2", "magic4"] });
  return build(opts, "wraith", { move: "soulripper", live: false, frag: "owner", ...SR, seed: 5101 }, a, gate);
}
function devourSoul(opts = {}) {
  // gate = the heal (600 flicker + 500 dash + 1100 pull + 400); with no fragment to eat (the heal row then does not
  // apply) the shot skips the fragment part and is over by 1700 ms, and its own fireDone at 1000 releases RESOLVE
  const a = assetsFor({ clips: ["041_heal_one_1"], sfx: ["monster5", "absorb2", "heal3", "skill2"] });
  return build(opts, "wraith", { move: "devoursoul", frag: "eat", seed: 5102 }, a, 600 + 500 + 1100 + 400);
}
function ethereal(opts = {}) {
  const a = assetsFor({ sfx: ["spook"] });
  return build(opts, "wraith", { move: "ethereal", seed: 5103 }, a, 100);
}

// ── Nox Viper ──
function poisonFang(opts = {}) {
  const a = assetsFor({ clips: PX("pxfx_nox_acid"), sfx: ["cpoison", "monster2", "hitpierceb", "water3"] });
  return build(opts, "viper", { move: "poisonfang", seed: 5201 }, a, null);   // 2 targets: 2570 ms, 1 target: 1730 ms
}
function coil(opts = {}) {
  const a = assetsFor({ clips: ["057_bind"], sfx: ["cpoison", "monster2", "blowM"] });
  return build(opts, "viper", { move: "coil", seed: 5202 }, a, 900 + 3 * 140);
}
function bileSpew(opts = {}) {
  // "Bile Spew#armorbreak" (play_animation row on save_failed_targets, after the DL13 save) plays the Armor Break beat
  // (move 'bilebreak') from this same item script: the variant switches the move in the inner.
  const a = assetsFor({ clips: [...PX("pxfx_nox_acid"), "059_poison", ...PX("pxfx_nox_puddle")], sfx: ["liquid", "monster3", "water1", "poison"] });
  return build(opts, "viper", { move: "bilespew", gob: 1.9, seed: 5203 }, a, null, true);   // 900 + 450 + 130 per target
}
function bileSpewArmorBreak(opts = {}) {
  const a = assetsFor({ clips: PX("pxfx_nox_puddle"), sfx: [] });
  return build(opts, "viper", { move: "bilebreak", seed: 5204 }, a, 0);
}
function feedingCoil(opts = {}) {
  const a = assetsFor({ sfx: ["monster2"] });
  return build(opts, "viper", { move: "feedingcoil", seed: 5205 }, a, 700 + 160 + 300);
}

const g = (fn, key, name) => () => fn({ key: "nox-" + key, name });
const WRAITH_ITEMS = {
  "Soul Ripper": g(soulRipper, "wraith-soul-ripper", "Soul Ripper"),
  "Devour Soul": g(devourSoul, "wraith-devour-soul", "Devour Soul"),
  "Ethereal": g(ethereal, "wraith-ethereal", "Ethereal"),
};
const VIPER_ITEMS = {
  "Poison Fang": g(poisonFang, "viper-poison-fang", "Poison Fang"),
  "Coil": g(coil, "viper-coil", "Coil"),
  "Bile Spew": g(bileSpew, "viper-bile-spew", "Bile Spew"),
  "Feeding Coil": g(feedingCoil, "viper-feeding-coil", "Feeding Coil"),
};
const EXTRA = { "Bile Spew: Armor Break": g(bileSpewArmorBreak, "viper-bile-spew-break", "Bile Spew: Armor Break") };

module.exports = { WRAITH_ITEMS, VIPER_ITEMS, EXTRA, soulRipper, devourSoul, ethereal, poisonFang, coil, bileSpew, bileSpewArmorBreak, feedingCoil };
