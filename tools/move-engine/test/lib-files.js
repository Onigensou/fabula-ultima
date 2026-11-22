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
// the page's own part: the wielders' dice and the balance panels (the moves now live in moves/sonic-katar)
function pagePart() { const ps = rd(path.join(FX, "part-sonic.js"));
  const i = ps.indexOf("// ───────── Sonic Blow helpers"), j = ps.indexOf("// ═════════ Balance panels");
  if (i < 0 || j < 0) throw new Error("part-sonic sections");
  const top = ps.slice(0, i).replace('const DIE_OPTS = ["d6", "d8", "d10", "d12"];\n', "");   // now in sonic.js
  return { name: "page part (wielders' dice + balance panels)", text: 'WIELD = "keren";   // Keren holds the weapons on this page (the chips switch it)\n' + top + ps.slice(j) }; }
const GUNBLADE_KEYS = ["gb_sword", "gb_gun", "gb_tf"];
const SONIC_KEYS = ["sonicblow", "sk_attack"];
const filesFor = (key) => (GUNBLADE_KEYS.includes(key) ? [head, gunblade] : [head, sonic]);
// the RO sounds the Sonic Katar build uploaded to Forge (v1.0.652)
const RO = "Sound/Ragnarok Online/";
const SFX_URLS = { ro_sonicblow: RO + "ro_sonicblow.wav", ro_katar: RO + "ro_attack_katar.wav", ro_katar2: RO + "ro_attack_katar2.wav", ro_hitdagger: RO + "ro_hit_dagger.wav" };
const META = "E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation/Sonic Katar/src/assets/meta.json";
module.exports = { head, gunblade, sonic, pagePart, filesFor, GUNBLADE_KEYS, SONIC_KEYS, SFX_URLS, META };
