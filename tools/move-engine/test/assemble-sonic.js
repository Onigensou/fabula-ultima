"use strict";
// Test fixture: rebuild the approved Sonic Katar + Gunblade mockup (v2) on the move-engine package instead of its own
// vendor copy, so the beat clock can be checked against the approved page.
//   node test/assemble-sonic.js <out.html>
// Reads (read-only): the page's assets + review kit on E: (not in the repo: 4.3 MB of ripped art / sounds).
// The family parts (part-hud / part-sonic-head / part-sonic / part-ui / page files) are copied into
// test/fixtures/sonic-katar unchanged from E:\...\Animation\Sonic Katar\src (v2, 2026-11-21).
const fs = require("fs");
const path = require("path");
const ME = require("../build/mockup-parts.js");

const ANIM = "E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation";
const A = path.join(ANIM, "Sonic Katar/src/assets");
const FX = path.join(__dirname, "fixtures/sonic-katar");
const KITB = require(path.join(ANIM, "mockup-kit/kit-build.js"));
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const OUT = process.argv[2] || path.join(__dirname, "..", "out", "sonic-katar-move-engine.html");

let head = ME.pageHead();
const rep = (a, b) => { if (typeof a === "string" ? !head.includes(a) : !a.test(head)) throw new Error("miss " + String(a).slice(0, 70)); head = head.replace(a, b); };
rep("<title>Nox Legion Actions</title>", "<title>Sonic Blow Gunblade (move-engine)</title>");
rep(/\.num \{[^\n]*\}\n\.num\.heal \{[^\n]*\}\n/, "");
rep("</style>", ME.css(["hud", "dn", "hpbar", "namecard"]) + "\n" + rd(path.join(FX, "page.css")) + "\n</style>");

const MIME = { webm: "video/webm", webp: "image/webp", png: "image/png", ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg" };
const uri = (f) => { const ext = path.extname(f).slice(1).toLowerCase(); if (!MIME[ext]) throw new Error("mime " + f); return "data:" + MIME[ext] + ";base64," + fs.readFileSync(path.join(A, f)).toString("base64"); };
const meta = JSON.parse(rd(path.join(A, "meta.json")));
for (const k of Object.keys(meta.sprites)) meta.sprites[k] = uri(meta.sprites[k]);
for (const k of Object.keys(meta.clips)) meta.clips[k].src = uri(meta.clips[k].src);
for (const k of Object.keys(meta.sfx)) meta.sfx[k] = uri(meta.sfx[k]);

// the stage the approved page used (it regex-patched these into its engine copy)
const stage = ME.stageScript({ preset: ME.PRESETS.valley001, actors: { ...ME.PARTY_LINE, orc: { cx: 400, cy: 320, sc: 1.84, kind: "enemy" } }, seed: 2611,
  roles: "{ caster: () => ACT[WIELD], target: () => ACT.orc }" });
// every move comes from the repo (moves/sonic-katar: head, sonic, gunblade), the same files the game build uses; the page keeps
// only its own part (the wielders' dice + the balance panels) and its UI, plus the shared result picker
const pagePart = require("./lib-files.js").pagePart().text;
const parts = [ME.engine(), ME.common(), rd(path.join(FX, "part-hud.js")), ME.fxMelee(), ME.moves(), ME.family("sonic-katar", "head"), pagePart,
  ME.family("sonic-katar", "sonic"), ME.family("sonic-katar", "gunblade"), ME.resultPicker(), rd(path.join(FX, "part-ui.js")),
  'mountResultPicker(document.querySelector(".panel"));'];
const js = KITB.wrap(parts.join("\n"), { page: "sonic-katar-gunblade-me", version: "me-test" });
const out = head + "\n" + rd(path.join(FX, "page-lower.html")) +
  "\n<script>\nwindow.META = " + JSON.stringify(meta) + ";\nwindow.HPBAR_T = " + ME.hpbarTiming() + ";\n" + stage + "\n</script>\n<script>\n" + js + "\n</script>\n";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log("ok", (fs.statSync(OUT).size / 1e6).toFixed(2) + " MB", OUT);
