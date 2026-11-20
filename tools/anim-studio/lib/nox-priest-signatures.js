"use strict";
// ============================================================================
// Nox Priest: the six moves built on oni.timeline from the approved Nox Legion mockup
// (claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU v8, 2026-11-20; spec = the final per-move code + slider defaults).
// Each shot = nox-shots/priest-kit.inner.js + one priest-<shot>.inner.js, wrapped by dungeon-templates.shell().
// Every number the review tuned is in the cfg below (mockup px on a 1682 px stage; the inner scales them by
// stage width / 1682). Assets come from nox-assets.js (CLIPS / SFX / EDGE_FADE), never re-derived here.
// Storage rule: no backticks / dollar-brace in any inner.
//
//   Nox Tome, Gravis (+ "Gravis Alta"), Lux Finis, Zombie Plague, Revive (+ "Resurrection"), Soul Siphon (passive)
//   Gravis / Revive and their aliases are optional (renames in flight): the build skips the name the actor lacks.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");
const NA = require("./nox-assets.js");

const DIR = path.join(__dirname, "nox-shots");
const KIT = fs.readFileSync(path.join(DIR, "priest-kit.inner.js"), "utf8");
const inner = (shot) => KIT + "\n// ── shot ──\n" + fs.readFileSync(path.join(DIR, "priest-" + shot + ".inner.js"), "utf8");

// a clip key, or a pixelfx effect name (expands to its _back / _front / _light layers)
function clipKeys(names) {
  const out = [];
  for (const n of names) {
    if (NA.CLIPS[n]) { out.push(n); continue; }
    const layers = ["_back", "_front", "_light"].map((l) => n + l).filter((k) => NA.CLIPS[k]);
    if (!layers.length) throw new Error("nox-priest: unknown clip " + n);
    out.push(...layers);
  }
  return out;
}
function assetsFor({ clips = [], sfx = [] }) {
  const a = { clips: {}, sfx: {}, edge: {} };
  for (const k of clipKeys(clips)) {
    const c = NA.CLIPS[k];
    a.clips[k] = { url: c.url, w: c.w, h: c.h, dur: c.dur, ax: c.ax, ay: c.ay, k: c.k, impact: c.impact };
    if (NA.EDGE_FADE[k]) a.edge[k] = NA.EDGE_FADE[k];
  }
  for (const s of sfx) { if (!NA.SFX[s]) throw new Error("nox-priest: unknown sfx " + s); a.sfx[s] = NA.SFX[s]; }
  return a;
}
const preloadOf = (a) => Array.from(new Set([...Object.values(a.clips).map((c) => c.url), ...Object.values(a.sfx)].filter(Boolean)));

// gate: a number = the director starts RESOLVE that many ms after animationStart (the shot's first frame);
// null = the gate moves with the target count, so the inner fires oni.fireDone at it (mode default)
function build(opts, shot, cfgIn, a, gate) {
  const cfg = Object.assign({ casterFoot: 0.95, partyFoot: 0.97, volume: 0.75, rgb: NA.RGB, totalTimeoutMs: 25000 }, cfgIn, opts.cfg || {});
  const script = shell({ key: opts.key, name: opts.name, cfg, assets: a, inner: inner(shot), timeout: cfg.totalTimeoutMs, startOnReady: true });
  return { script, timing: gate == null ? { mode: "default", offset: 0 } : { mode: "offset", offset: gate }, preload: preloadOf(a) };
}

// ── Nox Tome: walk 700, lean back 220, swing; the thud 80 ms into the swing ──
function noxTome(opts) {
  const a = assetsFor({ clips: ["001_hit_physical"], sfx: ["swingA", "blow1"] });
  return build(opts, "tome", { seed: 7311 }, a, 700 + 220 + 80);
}
// ── Gravis: rite 700, orb hold (slider 1100), collapse + 260 = everyone crushed ──
function gravis(opts) {
  const tune = { hold: 1100 };
  const a = assetsFor({ clips: ["pxfx_nox_gravorb", "pxfx_dark_implosion"], sfx: ["darkness4", "magic3", "charging", "darkness5", "collapse2"] });
  return build(opts, "gravis", { seed: 7312, ...tune }, a, 700 + tune.hold + 260);
}
// ── Lux Finis (default "Finis" style): full takeover (camera). Gate = the detonation's white-out peak; it moves with the
// number of targets (one lance slot each), so the inner fires it ──
function luxFinis(opts) {
  // approved slider defaults (zom / blind / style are game state or not ported: see the inner)
  const tune = { charge: 1500, lance: 2.2, gap: 420, zoom: 1.35, boom: 1.6, pin: 450, stars: 1.3, fw: 1.2 };
  // brightest frame of each clip (ms on the clip) and loudest moment of each sound (ms into it), mockup part-r4 VPEAK / SPEAK
  const vpeak = { ro_new_adoramus: 333, ro_new_judex_target: 133, gg_burst_anim02: 50, gg_burst_anim05: 100, jb_expl03: 167, pxfx_nox_solarburst: 100, pxfx_nox_goldfirework: 433 };
  const speak = { saint3: 92, saint5: 32, flash2: 180, break: 0, saint1: 440, magic3: 60 };
  const a = assetsFor({
    clips: ["ro_new_rayofgenesis_cast", "pxfx_nox_luxpillar", "pxfx_nox_goldstarfall", "ro_new_adoramus", "ro_new_judex_target",
      "pxfx_nox_solarburst", "gg_burst_anim02", "jb_expl03", "gg_burst_anim05", "pxfx_nox_goldfirework"],
    sfx: ["saint1", "saint4", "magic3", "saint3", "saint5", "flash2", "break"],
  });
  return build(opts, "luxfinis", { live: false, seed: 7313, ...tune, vpeak, speak, goldF: NA.FILTERS.GOLD_F, totalTimeoutMs: 30000 }, a, null);
}
// ── Zombie Plague: the gate follows the check row (one beat per target), so the inner fires it ──
function zombiePlague(opts) {
  const a = assetsFor({ clips: ["pxfx_nox_miasma", "pxfx_nox_hands"], sfx: ["spook", "darkness3", "magic3", "wind4", "water1", "darkness2", "evade"] });
  // failIdx = EVERY target (decision 2026-11-20): the save (zp_save) rolls AFTER the animation, so the shot cannot know who
  // fails; the grave hands reach for everyone as the plague's grasp and the game's Zombie status shows who actually turned.
  // (was: the mockup's default Zarg + Keren = [1, 2]); the real save rolls after
  return build(opts, "plague", { seed: 7314, failIdx: [0, 1, 2, 3, 4, 5, 6, 7] }, a, null);
}
// ── Revive / Resurrection: rite 700, feather 1300, heal 700, flash 220, silhouette 160 + 420 = the skull lands ──
function revive(opts) {
  const a = assetsFor({ clips: ["pxfx_nox_feather", "041_heal_one_1", "065_death"], sfx: ["magic3", "saint1", "heal3", "collapse4", "darkness5"] });
  return build(opts, "revive", { seed: 7315 }, a, 700 + 1300 + 700 + 220 + 160 + 420);
}
// ── Soul Siphon (passive): first mote in at 900 * .85, +500 = the jade flare and +30 MP ──
function soulSiphon(opts) {
  const a = assetsFor({ clips: ["051_powerup_1"], sfx: ["absorb2", "powerup"] });
  return build(opts, "siphon", { seed: 7316, fragment: true }, a, Math.round(900 * 0.85) + 500);
}

const g = (fn, key, name, optional) => { const f = () => fn({ key: "nox-priest-" + key, name }); if (optional) f.optional = true; return f; };
const PRIEST_ITEMS = {
  "Nox Tome": g(noxTome, "nox-tome", "Nox Tome"),
  "Gravis": g(gravis, "gravis", "Gravis", true),
  "Gravis Alta": g(gravis, "gravis", "Gravis Alta", true),
  "Lux Finis": g(luxFinis, "lux-finis", "Lux Finis"),
  "Zombie Plague": g(zombiePlague, "zombie-plague", "Zombie Plague"),
  "Revive": g(revive, "revive", "Revive", true),
  "Resurrection": g(revive, "revive", "Resurrection", true),
  "Soul Siphon": g(soulSiphon, "soul-siphon", "Soul Siphon"),
};

module.exports = { PRIEST_ITEMS, noxTome, gravis, luxFinis, zombiePlague, revive, soulSiphon };
