"use strict";
// The move files the game tests build, the same ones test/assemble-sonic.js puts on the page (moves/sonic-katar):
//   head.js      the family head (actors via the host, colours / dice sizes)
//   gunblade.js  the Gunblade pilot (shipped by migration)
//   sonic.js     Sonic Blow + the plain attack (comparison only: v1.0.652 ships Sonic Blow's hand-made port)
// The page part (fixtures/sonic-katar/part-sonic.js minus the moves) keeps only the page's data + balance panels.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FX = path.join(__dirname, "fixtures", "sonic-katar");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const fam = (f) => ({ name: "moves/sonic-katar/" + f + ".js", text: rd(path.join(ROOT, "moves", "sonic-katar", f + ".js")) });

const head = fam("head"), gunblade = fam("gunblade"), sonic = fam("sonic");
// the page's own part (the wielders' dice + the balance panels): moves/sonic-katar/page.js
function pagePart() { return { name: "page part (wielders' dice + balance panels)", text: require("../moves/sonic-katar/page.js").pagePart() }; }
const GUNBLADE_KEYS = ["gb_sword", "gb_gun", "gb_tf"];
const SONIC_KEYS = ["sonicblow", "sk_attack"];
const filesFor = (key) => (GUNBLADE_KEYS.includes(key) ? [head, gunblade] : [head, sonic]);
// the RO sounds the Sonic Katar build uploaded to Forge (v1.0.652)
const RO = "Sound/Ragnarok Online/";
const SFX_URLS = { ro_sonicblow: RO + "ro_sonicblow.wav", ro_katar: RO + "ro_attack_katar.wav", ro_katar2: RO + "ro_attack_katar2.wav", ro_hitdagger: RO + "ro_hit_dagger.wav" };
const META = require("../moves/sonic-katar/page.js").META;
module.exports = { head, gunblade, sonic, pagePart, filesFor, GUNBLADE_KEYS, SONIC_KEYS, SFX_URLS, META };
