"use strict";
// The Spell Fencer animation mockup, built from the repo: the two moves (moves/spell-fencer/head.js + rhapsody.js), the
// page's own parts (page/: the status-cue port source, the cue reviews + turn-loop sandbox, the UI), the move-engine
// mockup host and the review kit. Art / sounds come from E: (the Sonic Katar page's stage + party, the pixelfx exports)
// and the local Forge mirror (Keren's token art, icons, Soundboard sounds); everything is inlined as data: URIs.
//   node tools/move-engine/moves/spell-fencer/page.js [out.html] [--publish --version v1]
//   build({ out, version: "v1", publish: true })  → the review page (kit page id "spell-fencer-anim")
//   build({ out })                                 → a test page (its own kit page id, never touches the review db)
const fs = require("fs");
const path = require("path");
const ME = require("../../build/mockup-parts.js");

const ANIM = "E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation";
const SONIC = path.join(ANIM, "Sonic Katar/src/assets");
const PXOUT = path.join(ANIM, "pixelfx/foundry/out");
const MIRROR = path.join(ME.ROOT, "..", "..", "..", "..", "Data", "forge-mirror", "610d918102e7ac281373ffcb");
const MIRROR_ALT = "C:/Users/Oni/AppData/Local/FoundryVTT/Data/forge-mirror/610d918102e7ac281373ffcb";
const PAGE = path.join(__dirname, "page");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const mirror = (rel) => { for (const b of [MIRROR, MIRROR_ALT]) { const p = path.join(b, rel); if (fs.existsSync(p)) return p; } throw new Error("not in the Forge mirror: " + rel); };

const MIME = { webm: "video/webm", webp: "image/webp", png: "image/png", ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg" };
const uri = (f) => { const ext = path.extname(f).slice(1).toLowerCase(); if (!MIME[ext]) throw new Error("mime " + f); return "data:" + MIME[ext] + ";base64," + fs.readFileSync(f).toString("base64"); };

// sounds: page key → Forge path (meta.sfxSrc; the review kit lists them with these paths)
const SFX = { guard: "Sound/Soundboard/SE_GUARDC.wav", wind7: "Sound/Soundboard/Wind7.ogg", magic1: "Sound/Soundboard/Magic1.ogg",
  bell3: "Sound/Soundboard/Bell3.ogg", starlight: "Sound/Soundboard/Starlight.ogg", item3: "Sound/Soundboard/Item3.ogg",
  saint5: "Sound/Soundboard/Saint5.ogg", bell1: "Sound/Soundboard/Bell1.ogg", powerup: "Sound/Soundboard/Powerup.ogg" };
const BRAIDS = [];
for (const r of [0, 1, 2]) for (const n of [0, 1, 2]) for (const c of [0, 1]) BRAIDS.push(`sf_braid_r${r}n${n}c${c}`);

function meta() {
  const m = { sprites: {}, clips: {}, sfx: {}, sfxSrc: {} };
  m.sprites.tg_bg = uri(path.join(SONIC, "valley001.webp")); m.sprites.tg_depth = uri(path.join(SONIC, "valley001_depth.webp"));
  m.sprites.keren = uri(mirror("Character/Keren/Keren_Standard.png"));
  for (const id of ["hina", "zarg", "blanche"]) m.sprites[id] = uri(path.join(SONIC, "spr_" + id + ".webm"));
  m.sprites.icon_rh = uri(mirror("Skill Icon/FFXIVIcons Battle(PvE)/15_RDM/fleche.png"));
  m.sprites.icon_reso = uri(mirror("Skill Icon/FFXIVIcons Battle(PvE)/15_RDM/dualcast.png"));
  const sk = JSON.parse(rd(path.join(SONIC, "meta.json")));
  m.clips["051_powerup_1"] = { ...sk.clips["051_powerup_1"], src: uri(path.join(SONIC, sk.clips["051_powerup_1"].src)) };
  for (const b of BRAIDS) { const dir = path.join(PXOUT, "pxfx_" + b), cj = JSON.parse(rd(path.join(dir, "clip.json")));
    for (const L of ["back", "front", "light"]) m.clips["px_" + b + "_" + L] = { src: uri(path.join(dir, cj.layers[L].file)), w: cj.width, h: cj.height, dur: cj.durationMs,
      ax: cj.anchor.x, ay: cj.anchor.y, impact: cj.impactMs, pos: "feet" }; }
  for (const [k, rel] of Object.entries(SFX)) { m.sfx[k] = uri(mirror(rel)); m.sfxSrc[k] = rel; }
  return m;
}

function build({ out, version = "test", publish = false } = {}) {
  const KITB = require(path.join(ANIM, "mockup-kit/kit-build.js"));
  let head = ME.pageHead();
  const rep = (a, b) => { if (typeof a === "string" ? !head.includes(a) : !a.test(head)) throw new Error("miss " + String(a).slice(0, 70)); head = head.replace(a, b); };
  rep("<title>Nox Legion Actions</title>", publish ? "<title>Spell Fencer Animations</title>" : "<title>Spell Fencer Animations (move-engine test)</title>");
  rep(/<div class="eyebrow">[^<]*<\/div>/, `<div class="eyebrow">Battle Director · class animations · Spell Fencer · mockup ${version}</div>`);
  rep("<h1>Nox Legion Actions</h1>", "<h1>Spell Fencer · Rhapsody &amp; Resonance</h1>");
  rep(/<p>Every active move[^]*?<\/p>/, `<p>Keren's Spellblade Rhapsody activation, the +1 Resonance pulse, and the four held auras that tell the player what comes next (blue = cast, red = attack, gold = Rhapsody ready, red + blue braid = the Rhapsody turn). Valley battle map on the 3D stage, the party at in-game size. Review each entry: approve it, write a note, pause anywhere to comment on that moment, drag any slider, then press Send feedback. The sandbox under the move sheet plays a turn loop.</p>`);
  rep("Valley_Battlemap004 · 3D stage", "Valley_Battlemap001 · 3D stage");
  rep(`<p class="muted" style="margin:0">Damage, heal and MP numbers are the game's own look. The real scripts won't draw text.</p>`,
    `<p class="muted" style="margin:0">Self-only moves: no numbers. The game draws the action card and the HUD's Resonance count itself.</p>`);
  rep(/\.num \{[^\n]*\}\n\.num\.heal \{[^\n]*\}\n/, "");
  rep("</style>", ME.css(["dn"]) + "\n" + rd(path.join(PAGE, "page.css")) + "\n</style>");

  const stage = ME.stageScript({ preset: ME.PRESETS.valley001, actors: { ...ME.PARTY_LINE }, seed: 1123, roles: "{ caster: () => ACT.keren, target: () => null }" });
  const parts = [ME.engine(), ME.common(), ME.fxMelee(), ME.moves(), ME.family("spell-fencer", "head"), ME.family("spell-fencer", "rhapsody"),
    rd(path.join(PAGE, "part-cues.js")), rd(path.join(PAGE, "part-page.js")), rd(path.join(PAGE, "part-ui.js"))];
  const js = KITB.wrap(parts.join("\n"), publish ? { page: "spell-fencer-anim", version } : { page: "spell-fencer-anim-me", version: "me-test" });
  const html = head + "\n" + rd(path.join(PAGE, "page-lower.html")) + "\n<script>\nwindow.META = " + JSON.stringify(meta()) + ";\nwindow.HPBAR_T = " + ME.hpbarTiming() + ";\n" + stage + "\n</script>\n<script>\n" + js + "\n</script>\n";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return out;
}

// the game side: build each move's script the way the port will (shared parts + game host + the two files)
function gameCheck() {
  const GB = require("../../build/game-build.js");
  const files = ["head", "rhapsody"].map((f) => path.join(__dirname, f + ".js"));
  const clipUrls = {}; const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
  for (const b of BRAIDS) for (const L of ["back", "front", "light"]) clipUrls["px_" + b + "_" + L] = FORGE + "Animation/pixelfx/px" + "fx_" + b + "_" + L + ".webm";
  const m = meta(); for (const c of Object.values(m.clips)) delete c.src;
  const sfxUrls = Object.fromEntries(Object.entries(SFX));
  const assets = GB.assetsFromMeta(m, { clipUrls, sfxUrls });
  return ["rhapsody", "resonance_gain"].map((key) => { const r = GB.buildScript({ key: "sf_" + key, name: "Spell Fencer · " + key, files, assets, cfg: { tune: {} } });
    return { key, ok: r.ok, errors: r.errors, warnings: r.warnings, bytes: (r.encoded || r.script || "").length }; });
}

module.exports = { build, meta, gameCheck, SFX, BRAIDS };
if (require.main === module) {
  const a = process.argv.slice(2), pub = a.includes("--publish"), vi = a.indexOf("--version");
  const out = a.find((x) => !x.startsWith("--") && a[a.indexOf(x) - 1] !== "--version") || path.join(__dirname, "..", "..", "out", "spell-fencer-anim.html");
  console.log("ok", build({ out, publish: pub, version: vi >= 0 ? a[vi + 1] : pub ? "v1" : "test" }), (fs.statSync(out).size / 1e6).toFixed(2) + " MB");
  if (a.includes("--game")) console.log(JSON.stringify(gameCheck(), null, 1));
}
