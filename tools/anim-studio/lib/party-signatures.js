"use strict";
// ============================================================================
// Party action animations (Hina, Zarg, Keren, Blanche), built on oni.timeline
// from the approved "Party Action Animations" mockup (artifact v8, 2026-11-05).
//
// Each shot = _kit.inner.js + <shot>.inner.js (plain text, every client), wrapped
// by dungeon-templates.shell(). Every timing the review tuned lives in the cfg
// here, so a tuning pass edits numbers, not inner code.
// Storage rule (encode.js validate): no backticks / dollar-brace in any inner.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ANIM = FORGE + "Animation/";
const MV = (slug) => ANIM + "RPG%20Maker%20MV/" + slug + ".webm";
const RO = (name) => ANIM + "Ragnarok%20Online/" + name + ".webm";
const GG = (name) => ANIM + "Guilty%20Gear%20Strive/webm/" + name + ".webm";
const MIRROR = path.resolve(__dirname, "..", "..", "..", "forge-mirror", "610d918102e7ac281373ffcb");

// Sound by file name, resolved against the local Forge mirror (Soundboard first,
// then Sound/) so a typo fails the BUILD instead of playing silence.
function snd(file) {
  for (const sub of ["Sound/Soundboard/", "Sound/"]) {
    if (fs.existsSync(path.join(MIRROR, sub, file))) return FORGE + sub.split("/").map(encodeURIComponent).join("/") + encodeURIComponent(file);
  }
  throw new Error("party-signatures: sound not on Forge mirror: " + file);
}
// Volumes in the mockup were x0.7 of the given number (VOLMUL); keep that here.
const cue = (at, file, v) => ({ at, url: snd(file), v: Math.min(1, (v == null ? 0.55 : v) * 0.7) });

// Clip registry: native px (w,h), ms, anchor; GG masks are white shapes, tinted per use.
const CLIPS = {
  mc:        { url: RO("efst_magiccircle__mc"), w: 112, h: 64, dur: 2417, ax: 0.5, ay: 0.5 },
  ringComet: { url: RO("new_comet_cast_bottom"), w: 592, h: 482, dur: 783, ax: 0.5, ay: 0.5 },
  burst:     { url: GG("burst_anim02"), w: 682, h: 1024, dur: 300, ax: 0.5, ay: 0.5, mask: true },
  slash:     { url: GG("slashanim01"), w: 512, h: 682, dur: 600, ax: 0.5, ay: 0.5, mask: true },
  twinkle:   { url: GG("twinkle_anim02"), w: 64, h: 64, dur: 250, ax: 0.5, ay: 0.5, mask: true },
  pierce:    { url: MV("012_pierce_effect"), w: 660, h: 660, dur: 600, ax: 0.5, ay: 0.5 },
  vanish:    { url: RO("rl_banishing_buster__vanishing1"), w: 332, h: 278, dur: 1500, ax: 0.5241, ay: 1.1403 },
  explosion: { url: "modules/boss-loot-assets-free/artwork/05-spell/homebrew/impact/Explosion_2_Radial_PURPLE_1200x1200.webm", w: 1200, h: 1200, dur: 1600, ax: 0.5, ay: 0.5 },
};
const IMAGES = {
  foxfire: "https://assets.forge-vtt.com/5faea46cf17c50c47382d836/Fire.png",
};

const KIT = fs.readFileSync(path.join(__dirname, "party-shots", "_kit.inner.js"), "utf8");
function inner(name) { return KIT + "\n// ── shot ──\n" + fs.readFileSync(path.join(__dirname, "party-shots", name + ".inner.js"), "utf8"); }
function pick(keys) { const o = {}; for (const k of keys) { if (!CLIPS[k]) throw new Error("unknown clip " + k); o[k] = CLIPS[k]; } return o; }
function build({ key, name, shot, clips, images, cfg, gate, timeout }) {
  const assets = { clips: pick(clips), images: images || {} };
  const full = Object.assign({ totalTimeoutMs: timeout || 20000 }, cfg);
  const script = shell({ key: "party." + key, name, cfg: full, assets, inner: inner(shot), timeout: full.totalTimeoutMs, startOnReady: true });
  const preload = Object.values(assets.clips).map((c) => c.url).concat(Object.values(assets.images)).concat((full.sfx || []).map((c) => c.url));
  return { script, timing: gate == null ? { mode: "default", offset: 0 } : { mode: "offset", offset: gate }, preload };
}

// ── Batch A ─────────────────────────────────────────────────────────────────

// Create Phantasm: Strike. skin 'mirage' (class default) | 'foxfire' (Keren).
function phantasmStrike({ skin = "mirage" } = {}) {
  const t = { cast: 380, castHold: 550, appear: 930, dash: 1380, slash1: 2000, leave: 2550, back: skin === "foxfire" ? 3350 : 2900, total: skin === "foxfire" ? 4100 : 5300 };
  const sfx = [cue(380, "Magic4.ogg"), cue(1380, "Evasion1.ogg", 0.45), cue(2000, "SE_BTL_HitSlashS.ogg"), cue(2300, "SE_BTL_HitSlashS.ogg")];
  if (skin === "foxfire") sfx.push(cue(930, "Fire2.ogg", 0.5));
  else sfx.push(cue(2550, "Teleport.ogg", 0.4));
  return build({
    key: "phantasm-strike-" + skin, name: "Create Phantasm: Strike (" + skin + ")", shot: "phantasm-strike",
    clips: ["mc", "burst", "slash", "pierce", "vanish"], images: skin === "foxfire" ? IMAGES : {},
    cfg: { skin, t, sfx }, gate: t.slash1 + 300,
  });
}
// Detonate Phantasm: the real phantasm token on the field goes in; original explosion.
function detonatePhantasm({ skin = "mirage", dark = true } = {}) {
  const t = { cast: 0, castHold: 650, overload: 1300, rush: 2000, boom: 2420, back: 2900, total: 4200 };
  const sfx = [cue(0, "Skill1.ogg", 0.45), cue(380, dark ? "Darkness4.ogg" : "Saint3.ogg", 0.5), cue(1300, "Magic4.ogg", 0.5), cue(2000, "Evasion1.ogg", 0.45), cue(2420, "Explosion2.ogg", 0.6)];
  return build({
    key: "detonate-phantasm-" + skin, name: "Detonate Phantasm (" + skin + ")", shot: "detonate-phantasm",
    clips: ["mc", "explosion"], images: skin === "foxfire" ? IMAGES : {},
    cfg: { skin, dark, t, sfx }, gate: t.boom + 220,
  });
}
// High Speed: the original AfterImageBlurStep, ported. No damage → default gate (end).
function highSpeed() {
  const p = { amplitude: 70, swings: 7, swingMs: 55, afterimageEveryMs: 35, afterimageFadeMs: 240, disappearFadeMs: 120, hiddenHoldMs: 140, returnFadeMs: 520, blurStrength: 12 };
  return build({ key: "high-speed", name: "High Speed", shot: "high-speed", clips: [], cfg: { p, sfx: [{ at: 0, url: snd("Wind2.ogg"), v: 0.85 }] }, gate: null });
}

module.exports = { CLIPS, IMAGES, snd, cue, build, inner, phantasmStrike, detonatePhantasm, highSpeed };
