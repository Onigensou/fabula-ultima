"use strict";
// The move files the game tests build, the same ones test/assemble-sonic.js puts on the page.
//   gunblade: the pilot (moves/sonic-katar/head.js + gunblade.js), exactly what the Gunblade migration ships
//   page:     + the page's own part (Sonic Blow, the attack-for-scale; comparison only, not shipped from here)
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FX = path.join(__dirname, "fixtures", "sonic-katar");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const head = { name: "moves/sonic-katar/head.js", text: rd(path.join(ROOT, "moves", "sonic-katar", "head.js")) };
const gunblade = { name: "moves/sonic-katar/gunblade.js", text: rd(path.join(ROOT, "moves", "sonic-katar", "gunblade.js")) };
function pagePart() { const ps = rd(path.join(FX, "part-sonic.js"));
  const i = ps.indexOf("// ───────── Gunblade (replaces Imperial Gunblade)"), j = ps.indexOf("// ═════════ Balance panels");
  return { name: "page part-sonic.js (Sonic Blow, sk_attack)", text: ps.slice(0, i) + ps.slice(j) }; }
// the page's wielder dice for the test caster (only a rolled-mode fallback reads them)
const dice = { name: "test-dice.js", text: "if (typeof PDICE !== 'undefined') PDICE.caster = PDICE.keren;" };
const GUNBLADE_KEYS = ["gb_sword", "gb_gun", "gb_tf"];
const filesFor = (key) => (GUNBLADE_KEYS.includes(key) ? [head, gunblade] : [head, pagePart(), gunblade, dice]);
// the RO sounds the Sonic Katar build uploaded to Forge (feat/sonic-gunblade)
const RO = "Sound/Ragnarok Online/";
const SFX_URLS = { ro_sonicblow: RO + "ro_sonicblow.wav", ro_katar: RO + "ro_attack_katar.wav", ro_katar2: RO + "ro_attack_katar2.wav", ro_hitdagger: RO + "ro_hit_dagger.wav" };
const META = "E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation/Sonic Katar/src/assets/meta.json";
module.exports = { head, gunblade, pagePart, dice, filesFor, GUNBLADE_KEYS, SFX_URLS, META };
