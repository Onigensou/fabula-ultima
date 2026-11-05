"use strict";
// ============================================================================
// Party Zero Powers (Hina, Blanche, Keren, Zarg), built on oni.timeline from the
// approved "Zero Power overhaul" mockup (artifact 5FPS7VFAX7oqnTGy9KZAVC, v17,
// 2026-11-06). Each shot = party _kit + _zpkit + zp-<skill>.inner.js, wrapped by
// dungeon-templates.shell(). Every timing the review tuned lives in the cfg of
// zp-sig-<skill>.js, so a tuning pass edits numbers, not inner code.
// Storage rule (encode.js validate): no backticks / dollar-brace in any inner.
// ============================================================================
const fs = require("fs");
const path = require("path");
const PS = require("./party-signatures.js");
const { shell } = require("./dungeon-templates.js");

const FORGE = PS.FORGE;
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const F = (p) => FORGE + enc(p);                       // a Forge asset by its path
const D5 = (sub, file) => F("Animation/Disgaea 5/" + sub + "/" + file);
const D4 = (name) => F("Animation/Disgaea 4/webm/" + name + ".webm");

const KIT = fs.readFileSync(path.join(__dirname, "party-shots", "_kit.inner.js"), "utf8");
const ZPKIT = fs.readFileSync(path.join(__dirname, "zp-shots", "_zpkit.inner.js"), "utf8");
function inner(name) { return KIT + "\n" + ZPKIT + "\n// ── shot ──\n" + fs.readFileSync(path.join(__dirname, "zp-shots", name + ".inner.js"), "utf8"); }

// clips: { key: { url, w, h, dur, ax, ay } }; images: { key: url }; cfg.sfx: [{ at, url, v }].
// gate: null = the director waits for the end of the shot (Chain skills: every tick is
// shown before RESOLVE writes HP); a number = RESOLVE starts that many ms in.
function build({ key, name, shot, clips, images, cfg, gate, timeout }) {
  const assets = { clips: clips || {}, images: images || {} };
  const full = Object.assign({ totalTimeoutMs: timeout || 45000 }, cfg);
  const script = shell({ key: "zp." + key, name, cfg: full, assets, inner: inner(shot), timeout: full.totalTimeoutMs, startOnReady: true });
  const preload = Object.values(assets.clips).map((c) => c.url).concat(Object.values(assets.images)).concat((full.sfx || []).map((c) => c.url)).filter(Boolean);
  return { script, timing: gate == null ? { mode: "default", offset: 0 } : { mode: "offset", offset: gate }, preload: Array.from(new Set(preload)) };
}

module.exports = { FORGE, F, D5, D4, enc, snd: PS.snd, cue: PS.cue, MV: PS.MV, RO: PS.RO, GG: PS.GG, build, inner };
