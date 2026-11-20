"use strict";
// ============================================================================
// Nox Ghoul + Nox Hound (Nox Legion, Sealed Cavern) action animations, 2026-11-20, built on oni.timeline from the
// approved "Nox Legion action animations" mockup (claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU v8: part-ghoul-hound.js
// + r2 "no monster growls" + r4 "Monster1 bites on Rending Fangs / Zombie Bite"). Each shot =
// nox-shots/ghoul-hound-kit.inner.js + ghoul-hound-ghoul.inner.js or ghoul-hound-hound.inner.js, wrapped by
// dungeon-templates.shell(). The beat schedule (ms) is worked out here from the mockup's sequential awaits and
// handed to the inner as cfg.t, so the damage gate below and the shot's own fireDone use the same numbers.
// Storage rule: no backticks / dollar-brace in any inner.
//
//   const { GHOUL_ITEMS, HOUND_ITEMS } = require("./nox-ghoul-hound-signatures.js");
//   GHOUL_ITEMS["Grave Claw"]() -> { script, timing, preload }
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");
const NA = require("./nox-assets.js");

const KIT = fs.readFileSync(path.join(__dirname, "nox-shots", "ghoul-hound-kit.inner.js"), "utf8");
const inner = (shot) => KIT + "\n// ── shot ──\n" + fs.readFileSync(path.join(__dirname, "nox-shots", "ghoul-hound-" + shot + ".inner.js"), "utf8");

// assets for one shot: only the clips / sounds it uses. pixelfx names expand to their _back/_front/_light layers.
function assetsFor({ clips = [], px = [], sfx = [] }) {
  const a = { clips: {}, sfx: {} };
  const addClip = (k) => { const c = NA.CLIPS[k]; if (!c) throw new Error("nox-ghoul-hound: unknown clip " + k); a.clips[k] = { url: c.url, w: c.w, h: c.h, dur: c.dur, ax: c.ax, ay: c.ay, k: c.k, add: c.layer === "light" }; };
  for (const k of clips) addClip(k);
  for (const n of px) { let any = false; for (const L of ["back", "front", "light"]) if (NA.CLIPS[n + "_" + L]) { addClip(n + "_" + L); any = true; } if (!any) throw new Error("nox-ghoul-hound: no pixelfx layers for " + n); }
  for (const s of sfx) { if (!NA.SFX[s]) throw new Error("nox-ghoul-hound: unknown sfx " + s); a.sfx[s] = NA.SFX[s]; }
  return a;
}
const preloadOf = (a) => Array.from(new Set([...Object.values(a.clips).map((c) => c.url), ...Object.values(a.sfx)].filter(Boolean)));

function build(opts, shot, cfgIn, a, gate, end) {
  const cfg = Object.assign({ partyFoot: 0.97, volume: 0.75, totalTimeoutMs: end + 600 + 15000 }, cfgIn, opts.cfg || {});
  const script = shell({ key: opts.key, name: opts.name, cfg, assets: a, inner: inner(shot), timeout: cfg.totalTimeoutMs, startOnReady: true });
  return { script, timing: { mode: "offset", offset: gate }, preload: preloadOf(a) };
}

// mockup graveClawOn(t, { fast }) from 'start': dash (620 / fast 330, hop 12 / 6), rock back (200 / 110), swing,
// 70 ms to the hit, hitstop (90 / 60), lean back 160. The mockup's markGate() comes right after it returns.
function clawTimes(start, fast) {
  const c = { start, dash: fast ? 330 : 620, hop: fast ? 6 : 12, rockMs: fast ? 110 : 200 };
  c.rock = start + c.dash; c.swing = c.rock + c.rockMs; c.hit = c.swing + 70; c.back = c.hit + (fast ? 60 : 90); c.end = c.back + 160;
  return c;
}

// ── Nox Ghoul ──
function graveClaw(opts = {}) {
  const claw = clawTimes(0, false);                       // contact 890, gate 1140
  const t = { claw, gate: claw.end, bleed: claw.end, home: claw.end + 700 }; t.end = t.home + 520;
  const a = assetsFor({ px: ["pxfx_nox_claw"], sfx: ["swingC", "slashL", "blowM", "darkness1"] });
  return build(opts, "ghoul", { move: "graveclaw", t, seed: 5101 }, a, t.gate, t.end);
}
function poisonBlade(opts = {}) {
  const t = { lunge: 900 }; t.rock = t.lunge + 360; t.swing = t.rock + 160; t.hit = t.swing + 60; t.gate = t.hit; t.back = t.hit + 110; t.status = t.back + 200;
  const end = t.status + 1300 + 520;                       // the longer (Envenomed) branch, for the timeout only
  const a = assetsFor({ clips: ["059_poison"], px: ["pxfx_nox_acid", "pxfx_nox_puddle"], sfx: ["liquid", "poison", "swingC", "sword5", "slashL", "water3", "cpoison"] });
  return build(opts, "ghoul", { move: "poisonblade", t, seed: 5102 }, a, t.gate, end);
}
// Passive TELL (owner = the Ghoul, target = the healed enemy). Wiring: [play_animation Counter when enemy Healed,
// free_action Grave Claw]. The free Grave Claw runs the full action pipeline and plays its own animation, so this
// script only smells the heal: dim .25, squash, head snap (lean 90 + 90 + 120, wait 220), jade glint + glow, then
// undim 400 (squash eases back) -> idle at home. Gate = the end of the tell (920 ms); the attack follows at once.
function counterHeal(opts = {}) {
  const t = { undim: 520 }; t.end = t.undim + 400;
  const a = assetsFor({});
  return build(opts, "ghoul", { move: "counterheal", t, seed: 5103 }, a, t.end, t.end);
}

// ── Nox Hound ──
function rendingFangs(opts = {}) {
  const dash = 260;                                        // approved slider
  const t = { dash1: 260 + 160 }; t.bite1 = t.dash1 + dash; t.spring = t.bite1 + 200; t.bite2 = t.spring + dash + 80; t.gate = t.bite2 + 200; t.end = t.gate + 460;
  const a = assetsFor({ clips: ["011_pierce_physical"], sfx: ["evade", "jump1", "monster1", "hitpierceb"] });
  return build(opts, "hound", { move: "rendingfangs", dash, t, seed: 5201 }, a, t.gate, t.end);
}
function zombieBite(opts = {}) {
  const t = { bite: 900 }; t.latch = t.bite + 200; t.gate = t.latch; t.zombie = t.latch + 600; t.end = t.zombie + 1400;
  const a = assetsFor({ clips: ["011_pierce_physical", "059_poison"], sfx: ["monster1", "hitpierceb", "absorb1", "darkness2"] });
  return build(opts, "hound", { move: "zombiebite", t, seed: 5202 }, a, t.gate, t.end);
}
// Passive TELL (owner = the Hound, target = the enemy that just entered Crisis). Wiring: [play_animation On the Hunt,
// free_action Rending Fangs]. The free Rending Fangs plays its own animation, so this script is only the scent:
// howl (rate 1.15, fades 1300 ms in, ringing into the attack), lean 300, red glint, wait 800, lean back 150 -> idle
// at home. Gate = the end of the tell (950 ms); the attack follows at once.
function onTheHunt(opts = {}) {
  const t = { lookBack: 800 }; t.end = t.lookBack + 150;
  const a = assetsFor({ sfx: ["howl"] });
  return build(opts, "hound", { move: "onthehunt", t, seed: 5203 }, a, t.end, t.end);
}

const g = (fn, key, name) => () => fn({ key: "nox-" + key, name });
const GHOUL_ITEMS = {
  "Grave Claw": g(graveClaw, "ghoul-grave-claw", "Grave Claw"),
  "Poison Blade": g(poisonBlade, "ghoul-poison-blade", "Poison Blade"),
  "Counter when enemy Healed": g(counterHeal, "ghoul-counter-healed", "Counter when enemy Healed"),
};
const HOUND_ITEMS = {
  "Rending Fangs": g(rendingFangs, "hound-rending-fangs", "Rending Fangs"),
  "Zombie Bite": g(zombieBite, "hound-zombie-bite", "Zombie Bite"),
  "On the Hunt": g(onTheHunt, "hound-on-the-hunt", "On the Hunt"),
};

module.exports = { GHOUL_ITEMS, HOUND_ITEMS, graveClaw, poisonBlade, counterHeal, rendingFangs, zombieBite, onTheHunt };
