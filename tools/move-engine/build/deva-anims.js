"use strict";
// Deva: the approved mockup moves (page deva-anim v20, artifact C7wZxC2jSAo15AAsJfQxRb, rounds rmwzrtftn / rmwzszayz / rmwzti7z1,
// all approved 2026-11-28) → the game's animation scripts.
//   node tools/move-engine/build/deva-anims.js
//     → modules/fabula-ultima-companion/data-migrations/_deva-anims.js (used by 2026-11-28-deva-anims)
// Same files the mockup page runs (moves/deva/head.js + deva.js). Approved slider values = the move defaults (each round's
// moved sliders were made the defaults on the page), so no tune block is needed here.
const fs = require("fs");
const path = require("path");
const GB = require("./game-build.js");
const PAGE = require("../moves/deva/page.js");
const ROOT = path.join(__dirname, "..");
const FAM = path.join(ROOT, "moves", "deva");
const OUT = path.join(ROOT, "..", "..", "modules", "fabula-ultima-companion", "data-migrations", "_deva-anims.js");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const FORGE = GB.FORGE;
const enc = (rel) => FORGE + rel.split("/").map(encodeURIComponent).join("/");

// ── assets: clips on Forge (the page's clip table: sizes, anchors, impact), sounds = the page's Forge sources,
// sprites: the fist art as data: URIs (3-4 KB, like the shipped v1.0.575 barrage), the GG mask sheets and her idle clips on Forge
const CLIP_PATH = {
  d4_flash_ring_white: "Animation/Disgaea 4/webm/flash_ring_white.webm",
  ro_efst_magiccircle__mc: "Animation/Ragnarok Online/efst_magiccircle__mc.webm",
  ro_rl_explosion__boom: "Animation/Ragnarok Online/rl_explosion__boom.webm",
  pxfx_dark_rahu_eclipse_back: "Animation/pixelfx/pxfx_dark_rahu_eclipse_back.webm",
  pxfx_dark_rahu_eclipse_front: "Animation/pixelfx/pxfx_dark_rahu_eclipse_front.webm",
  pxfx_dark_rahu_eclipse_light: "Animation/pixelfx/pxfx_dark_rahu_eclipse_light.webm",
};
function clips() { const out = {};
  for (const [k, c] of Object.entries(PAGE.CLIPS)) {
    const url = CLIP_PATH[k] ? enc(CLIP_PATH[k]) : GB.clipUrl(k); if (!url) throw new Error("no Forge path for clip " + k);
    out[k] = { url, w: c.w, h: c.h, dur: c.dur, ax: c.ax, ay: c.ay, k: c.ro || /^ro_/.test(k) ? 1.1 : .55, impact: c.impact,
      add: /_light$/.test(k) };   // a pixelfx light layer is made on black for ADD: drawn with plus-lighter (fix 3f5af4e2)
  }
  return out; }
const dataUrl = (f) => "data:image/png;base64," + fs.readFileSync(path.join(PAGE.ASSETS, f)).toString("base64");
const SPRITES = {
  fist: dataUrl("fist_red.png"), fist_blue: dataUrl("fist_blue.png"),
  ggs_burst_anim01: enc("Animation/Guilty Gear Strive/sheets/ggs_burst_anim01.png"), ggs_burst_anim05: enc("Animation/Guilty Gear Strive/sheets/ggs_burst_anim05.png"),
  ggs_burst_anim07: enc("Animation/Guilty Gear Strive/sheets/ggs_burst_anim07.png"), ggs_spark_anim01: enc("Animation/Guilty Gear Strive/sheets/ggs_spark_anim01.png"),
  deva: enc("Beastiary/Deva_Battle_Idle.webm"), deva_fury: enc("Beastiary/Deva/Deva_Fury_Battle_Idle.webm"), deva_focus: enc("Beastiary/Deva/Deva_Focus_Battle_Idle.webm"),
};
const SFX = Object.fromEntries(Object.entries(PAGE.SFX).map(([k, [, forge]]) => [k, enc(forge)]));
const ASSETS = { clips: clips(), sfx: SFX, sprites: SPRITES };
// her three idle clips as caster poses (setForm), the same art the form AEs' poseArt shows on the board
const POSES = { std: SPRITES.deva, fury: SPRITES.deva_fury, focus: SPRITES.deva_focus };

// ── one script per skill. cfg: camera = the move drives the camera (Fury / Focus push in, Enlightenment's close-up);
// gateOnNum = a non-Chain move's numbers land where the mockup shows them. Fury is a Chain (it cues its strikes),
// Focus shows its one number at the final impact (gameNum), the Missile Fist moves play from chain rows (timing "resolve").
const BASE = { partyFoot: 0.97, seed: 1109, totalTimeoutMs: 30000 };
const SCRIPTS = {
  VAJRA:   { key: "vajra", name: "Deva · Vajra Fist", cfg: { gateOnNum: true } },
  LANCE:   { key: "lance", name: "Deva · Mudra Lance", cfg: { gateOnNum: true } },
  SLAP:    { key: "slap",  name: "Deva · Double Slap", cfg: { gateOnNum: true, targetPoses: { walkd: "sprite_walk_down", walkdl: "sprite_walk_left", walkul: "sprite_walk_up_left" } } },
  SLAM:    { key: "slam",  name: "Deva · Ground Slam", cfg: { gateOnNum: true, poses: POSES } },
  SURYA:   { key: "surya", name: "Deva · Surya Palm", cfg: { gateOnNum: true, poses: POSES } },
  RAHU:    { key: "rahu",  name: "Deva · Rahu's Eclipse", cfg: { gateOnNum: true, poses: POSES } },
  KALA:    { key: "kala",  name: "Deva · Kala Strike", cfg: { gateOnNum: true, poses: POSES } },
  FURY:    { key: "fury",  name: "Deva · Fists of Fury", cfg: { camera: true, poses: POSES } },
  FOCUS:   { key: "focus", name: "Deva · Fists of Focus", cfg: { camera: true, poses: POSES } },
  ENL:     { key: "enl",   name: "Deva · Enlightenment", cfg: { camera: true, poses: POSES } },
  MFIST:   { key: "fist",  name: "Deva · Missile Fist", cfg: {} },
  // the Missile Fist's own: Detonate (the fist casts it) and the break, played by its Fuse's creature_defeated row:
  // only the last beat (the third hit cracks it and it shatters), the first two hits are the party's own attacks
  F_BOOM:  { key: "boom",  name: "Missile Fist · Detonate", cfg: { gateOnNum: true } },
  F_BREAK: { key: "brk",   name: "Missile Fist · break", cfg: { skip: [0, 1, 2] } },
  // Celestial Discipline (her round-start passive) carries the round-start moves; its play_animation rows pick one by variant
  DISC:    { key: "stance", name: "Deva · Stance Change / Form Change", cfg: { poses: POSES },
    playOpts: { byVariant: { stance_maya: "stance", stance_vajra: "stance", form_fury: "form", form_focus: "form" },
      variantTune: { stance_maya: { from: 0 }, stance_vajra: { from: 1 }, form_fury: { form: 0 }, form_focus: { form: 1 } } } },
};

const files = ["head", "deva"].map((f) => ({ name: "moves/deva/" + f + ".js", text: rd(path.join(FAM, f + ".js")) }));
const out = {};
for (const [id, s] of Object.entries(SCRIPTS)) {
  const r = GB.buildScript({ key: s.key, name: s.name, files, assets: ASSETS, cfg: { ...BASE, ...s.cfg }, playOpts: s.playOpts || null, timeout: 30000 });
  if (!r.ok) { console.error(id, r.errors); process.exit(1); }
  console.log(id.padEnd(8), s.key.padEnd(7), (r.chars / 1024).toFixed(0) + " KB", r.warnings.length ? "· warnings: " + r.warnings.length : "");
  out[id] = r;
}
const ENGINE = /MOVE_ENGINE_VERSION = "([^"]+)"/.exec(rd(path.join(ROOT, "shared", "core.js")))[1];
const body = [
  "// GENERATED by tools/move-engine/build/deva-anims.js — do not edit by hand.",
  "// The approved Deva mockup moves (page deva-anim v20) run unchanged on the game runtime.",
  "// Source: tools/move-engine/moves/deva/{head,deva}.js (the same files the mockup page runs).",
  "export const ENGINE_VERSION = " + JSON.stringify(ENGINE) + ";",
  ...Object.entries(out).map(([id, r]) => "export const " + id + "_SCRIPT = " + JSON.stringify(r.encoded) + ";"),
  "",
].join("\n");
fs.writeFileSync(OUT, body);
console.log("wrote", OUT, (body.length / 1024).toFixed(0) + " KB");
module.exports = { SCRIPTS, ASSETS, files, BASE };
