"use strict";
// ============================================================================
// Nox Executioner (Nox Legion, Sealed Cavern): five action animations built on oni.timeline from the approved mockup
// (claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU v8; specs nx/spec/{guillotine,gibbet,soulsever,beheading,parry}.md).
// Each shot = nox-shots/executioner-kit.inner.js + one executioner-<move>.inner.js, wrapped by dungeon-templates.shell().
// The beat schedule (and so the damage gate) is computed HERE from the approved slider defaults and the Slash / Parry
// clip frame times (nox-assets EXEC_POSES), handed to the inner as cfg.t, so the gate offset and the picture agree.
// Storage rule: no backticks / dollar-brace in any inner.
//
//   const { EXECUTIONER_ITEMS } = require("./nox-executioner-signatures.js");
//   EXECUTIONER_ITEMS["Nox Guillotine"]() -> { script, timing, preload }
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");
const NA = require("./nox-assets.js");

const DIRN = path.join(__dirname, "nox-shots");
const KIT = fs.readFileSync(path.join(DIRN, "executioner-kit.inner.js"), "utf8");
const inner = (shot) => KIT + "\n// ── shot ──\n" + fs.readFileSync(path.join(DIRN, "executioner-" + shot + ".inner.js"), "utf8");

const EP = NA.EXEC_POSES;
const ms = (name) => EP[name].frames.map((f) => f.ms);
const keyAt = (name, key) => EP[name].frames.findIndex((f) => f.key === key);
const sum = (a, i0, i1) => a.slice(i0, i1 + 1).reduce((s, v) => s + v, 0);
// the Slash clip: wind-up = frames 0..windup (held), swing = smear..end; contact offset from the smear frame
const SL = ms("slash"), W_I = keyAt("slash", "windup"), SM_I = keyAt("slash", "smear"), CO_I = keyAt("slash", "contact");
const UP = (sp) => sum(SL, 0, W_I) / sp;                        // 570
const SWING = (sp) => sum(SL, SM_I, SL.length - 1) / sp;        // 750
const CONTACT = (sp) => sum(SL, SM_I, CO_I - 1) / sp;           // 60
const PA = ms("parry"), IM_I = keyAt("parry", "impact");
const HEAVY = (glide) => glide + 240;                           // heavyStep: glide + the 240 ms settle
const TAIL = 600;                                               // the mockup's 600 ms after the last beat

// poses for the inner: canvas, idle size, frame ms + keys, points (strip urls go in images)
const POSES = { canvas: EP.canvas, idle: EP.idle, slash: { frames: EP.slash.frames }, parry: { frames: EP.parry.frames } };
const RAISED = EP.points.raisedBlade, SHIELD = EP.points.parryShield;

function assetsFor({ clips = [], sfx = [], poses = [] }) {
  const a = { clips: {}, images: {}, sfx: {} };
  for (const k of clips) {
    const c = NA.CLIPS[k]; if (!c) throw new Error("nox-executioner: unknown clip " + k);
    a.clips[k] = { url: c.url, w: c.w, h: c.h, dur: c.dur, ax: c.ax, ay: c.ay, k: c.k, add: !!c.ro };
  }
  for (const p of poses) a.images[p] = EP[p].url;
  for (const s of sfx) { if (!NA.SFX[s]) throw new Error("nox-executioner: unknown sfx " + s); a.sfx[s] = NA.SFX[s]; }
  return a;
}
const px = (base) => ["back", "front", "light"].map((l) => base + "_" + l).filter((k) => NA.CLIPS[k]);
const preloadOf = (a) => Array.from(new Set([...Object.values(a.clips).map((c) => c.url), ...Object.values(a.images), ...Object.values(a.sfx)].filter(Boolean)));

function build(key, name, shot, cfgIn, a, gate) {
  const cfg = Object.assign({ volume: 0.75, poses: POSES, raised: RAISED, shield: SHIELD, rgb: NA.RGB, fragFilter: NA.FILTERS.FRAG_F }, cfgIn);
  cfg.totalTimeoutMs = cfg.t.total + 15000;
  const script = shell({ key: "nox.executioner." + key, name, cfg, assets: a, inner: inner(shot), timeout: cfg.totalTimeoutMs, startOnReady: true });
  return { script, timing: { mode: "offset", offset: Math.round(gate) }, preload: preloadOf(a) };
}

// ── Nox Guillotine ──
function guillotine() {
  const tune = { hold: 650, bw: 34, sw: 46, zin: 1.35, punch: 1.6, pspd: 1 };
  const t = {}; t.b2 = HEAVY(1000); t.b3 = t.b2 + UP(tune.pspd); t.b4 = t.b3 + tune.hold;
  t.gate = t.b4 + CONTACT(tune.pspd); t.b5 = t.b4 + SWING(tune.pspd); t.end = t.b5 + 220 + HEAVY(900); t.total = t.end + TAIL;
  const a = assetsFor({ clips: [...px("pxfx_nox_soulfire")], poses: ["slash"], sfx: ["wind7", "shing", "magic4", "swingC", "crit", "slashL"] });
  return build("guillotine", "Nox Guillotine", "guillotine", { move: "guillotine", live: false, needsTarget: true, stanceCx: 60, t, ...tune, seed: 7311 }, a, t.gate);
}

// ── Nox Gibbet ──
function gibbet() {
  const tune = { hang: 500, zin: 1.3, punch: 1.55, pspd: 1 };
  const t = {}; t.b1End = HEAVY(800); t.b2 = t.b1End + 250; t.b3 = t.b2 + UP(tune.pspd) + tune.hang;
  t.gate = t.b3 + CONTACT(tune.pspd); t.b4 = t.b3 + SWING(tune.pspd); t.end = t.b4 + 260 + 300 + HEAVY(800); t.total = t.end + TAIL;
  const a = assetsFor({ clips: [...px("pxfx_nox_soulfire"), ...px("pxfx_nox_swordslash"), ...px("pxfx_nox_reap")], poses: ["slash"],
    sfx: ["wind7", "shing", "swingA", "swingC", "crit", "slashL", "break", "downc"] });
  return build("gibbet", "Nox Gibbet", "gibbet", { move: "gibbet", live: false, needsTarget: true, stanceCx: 70, t, ...tune, seed: 7312 }, a, t.gate);
}

// ── Soul Sever ──
function soulSever() {
  const tune = { zoom: 1.45, charge: 1600, slash: 3.2, x: 1.15, wave: 2.8, sweep: 650, pspd: 1 };
  const t = {}; t.b2 = HEAVY(900); t.b3 = t.b2 + 220 + 350; t.s4 = t.b3 + 250 + tune.charge;
  t.gate = t.s4 + 120 + tune.sweep; t.b5 = Math.max(t.gate, t.s4 + SWING(tune.pspd)) + 200; t.end = t.b5 + 300 + HEAVY(900); t.total = t.end + TAIL;
  const a = assetsFor({ clips: [...px("pxfx_nox_soulfire"), ...px("pxfx_nox_swordslash"), ...px("pxfx_nox_crescent"), ...px("pxfx_nox_xslash"), ...px("pxfx_nox_acid")], poses: ["slash"],
    sfx: ["wind7", "sword5", "break", "darkness3", "absorb2", "swingC", "slashL"] });
  return build("soulSever", "Soul Sever", "soulsever", { move: "soulsever", live: false, frag: "largest", t, ...tune, seed: 7313 }, a, t.gate);
}

// ── Beheading (passive, round end) ──
function beheading() {
  const tune = { hush: 900, parts: 1, pspd: 1 };
  const t = {}; t.b3 = 1100; t.b4 = t.b3 + 200 + 250 + UP(tune.pspd) + tune.hush;
  t.gate = t.b4 + CONTACT(tune.pspd); t.b5 = t.b4 + SWING(tune.pspd) + 700; t.end = t.b5 + 200 + 300 + 400; t.total = t.end + TAIL;
  const a = assetsFor({ clips: [...px("pxfx_nox_soulfire"), ...px("pxfx_nox_crithit"), "065_death"], poses: ["slash"],
    sfx: ["down1", "shing", "execution", "collapse4"] });
  return build("beheading", "Beheading", "beheading", { move: "beheading", live: false, needsTarget: true, frag: "owner", stanceCx: 95, t, ...tune, seed: 7314 }, a, t.gate);
}

// ── Parry (passive) ──
function parry() {
  const tune = { pspd: 1 };
  const t = {}; t.gate = sum(PA, 0, IM_I - 1) / tune.pspd; t.end = sum(PA, 0, PA.length - 1) / tune.pspd + 500; t.total = t.end + 200;
  const a = assetsFor({ clips: [...px("pxfx_nox_parry")], poses: ["parry"], sfx: ["parry", "guard"] });
  return build("parry", "Parry", "parry", { move: "parry", live: true, faceToken: true, t, ...tune, seed: 7315 }, a, t.gate);
}

const EXECUTIONER_ITEMS = {
  "Nox Guillotine": guillotine,
  "Nox Gibbet": gibbet,
  "Soul Sever": soulSever,
  "Beheading": beheading,
  "Parry": parry,
};

module.exports = { EXECUTIONER_ITEMS, guillotine, gibbet, soulSever, beheading, parry };
