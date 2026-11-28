"use strict";
// The Deva animation mockup, built from the repo: the moves (moves/deva/head.js + deva.js), the page's own UI
// (moves/deva/page), the move-engine mockup host, the review kit. Stage = Valley_Battlemap007 (Deva's arena) with its 3D
// preset from battle-stage-3d-rules.js. Assets are files next to the page (assets/…), not data: URIs:
//   - E:/…/Animation/Deva/src/assets        the old v16 page's published files (MV / RO / GG / D4 clips, Soundboard sfx, party
//                                            battlers + poses, GG spark sheets, pixelfx rahu-eclipse) + the baked fist art
//   - Data/forge-mirror                      Valley_Battlemap007.webp, Deva's in-game idle clips (Standard / Fury / Focus)
//   - modules/…/assets/battle-depth          Valley_Battlemap007 depth map
//   - E:/…/Sprite/Monster/Deva               the form PNGs (move-list icons only)
//   node tools/move-engine/moves/deva/page.js [out.html] [--publish --version v19]
const fs = require("fs");
const path = require("path");
const ME = require("../../build/mockup-parts.js");

const ANIM = "E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation";
const ASSETS = path.join(ANIM, "Deva/src/assets");
const SPRITES = "E:/Art(New Com)/DND/Fabula Ultima/Quest/The Legend of Dragonslayer/Sprite/Monster/Deva";
const MIRROR = "C:/Users/Oni/AppData/Local/FoundryVTT/Data/forge-mirror/610d918102e7ac281373ffcb";
const DEPTH = path.join(ME.ROOT, "..", "..", "modules", "fabula-ultima-companion", "assets", "battle-depth", "Valley_Battlemap007.webp");
const PAGE = path.join(__dirname, "page");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// Valley_Battlemap007 (battle-stage-3d-rules.js: horizon 69.4, strength 0.357, relief); scene 2560 x 1270 = the engine default
const PRESET = { horizon: 69.4, strength: .357 };
// the lineup: the party line, Deva at in-game token scale (prototypeToken scale 2.25, 1x1), the two Missile Fists (scale 1)
// on the approved v1 hover spots (feet at y 268 / 470)
const ACTORS = { ...ME.PARTY_LINE, deva: { cx: 330, cy: 345, sc: 2.25, kind: "enemy" },
  fistA: { cx: 700, cy: 231, sc: 1, kind: "enemy" }, fistB: { cx: 760, cy: 433, sc: 1, kind: "enemy" } };

// clip table (sizes / anchors / impact) = the old page's meta
const CLIPS = {"gg_explosion_anim01":{"w":1024,"h":1024,"ax":0.5,"ay":0.5,"dur":800,"impact":240},"ro_rl_explosion__boom":{"w":588,"h":568,"ax":0.483,"ay":0.5704,"dur":833,"impact":150,"ro":true},"d4_flash_ring_white":{"w":82,"h":82,"ax":0.5,"ay":0.5,"dur":233,"impact":70},"gg_burst_anim02":{"w":682,"h":1024,"ax":0.5,"ay":0.5,"dur":300,"impact":90},"ro_efst_magiccircle__mc":{"w":112,"h":64,"ax":0.5,"ay":0.5,"dur":2417,"impact":0,"ro":true},"gg_dashsmoke_anim01":{"w":1024,"h":256,"ax":0.5,"ay":0.5,"dur":800,"impact":240},"051_powerup_1":{"w":508,"h":790,"ax":0.5,"ay":0.543,"dur":867,"impact":333,"pos":"feet"},"117_light_pillar_1":{"w":384,"h":384,"ax":0.5,"ay":0.8438,"dur":2467,"impact":987,"pos":"feet"},"001_hit_physical":{"w":488,"h":488,"ax":0.5,"ay":0.5,"dur":333,"impact":0,"pos":"center"},"002_hit_effect":{"w":488,"h":488,"ax":0.5,"ay":0.5,"dur":400,"impact":67,"pos":"center"},"021_hit_special_1":{"w":994,"h":986,"ax":0.492,"ay":0.4848,"dur":1333,"impact":133,"pos":"center"},"054_powerdown_1":{"w":508,"h":656,"ax":0.5,"ay":0.628,"dur":867,"impact":333,"pos":"feet"},"119_ball_of_light":{"w":728,"h":728,"ax":0.5,"ay":0.5,"dur":1667,"impact":667,"pos":"center"},"120_glowing_light":{"w":584,"h":584,"ax":0.5,"ay":0.5,"dur":2067,"impact":827,"pos":"center"},"055_powerdown_2":{"w":384,"h":384,"ax":0.5,"ay":0.9375,"dur":1933,"impact":400,"pos":"feet"},"056_powerdown_3":{"w":484,"h":484,"ax":0.5,"ay":0.5248,"dur":1600,"impact":933,"pos":"center"},"058_absorb":{"w":820,"h":820,"ax":0.5,"ay":0.5,"dur":1200,"impact":400,"pos":"center"},"060_blind":{"w":616,"h":616,"ax":0.5,"ay":0.5,"dur":1133,"impact":133,"pos":"center"},"027_pierce_special_2":{"w":740,"h":728,"ax":0.4919,"ay":0.5,"dur":1467,"impact":133,"pos":"center"},"086_earth_one_1":{"w":680,"h":680,"ax":0.5,"ay":0.5,"dur":1333,"impact":333,"pos":"center"},"087_earth_one_2":{"w":728,"h":896,"ax":0.4835,"ay":0.4866,"dur":800,"impact":333,"pos":"center"},"088_earth_all_1":{"w":1088,"h":534,"ax":0.4743,"ay":0.5468,"dur":1333,"impact":333,"pos":"screen"},"097_light_one_2":{"w":828,"h":828,"ax":0.5,"ay":0.5,"dur":1000,"impact":400,"pos":"center"},"101_darkness_one_1":{"w":546,"h":546,"ax":0.5,"ay":0.5,"dur":1467,"impact":667,"pos":"center"},"102_darkness_one_2":{"w":614,"h":614,"ax":0.5,"ay":0.5,"dur":1067,"impact":133,"pos":"center"},"pxfx_dark_rahu_eclipse_back":{"w":400,"h":392,"ax":0.5,"ay":0.5,"dur":4433,"impact":3100,"pos":"center"},"pxfx_dark_rahu_eclipse_front":{"w":400,"h":392,"ax":0.5,"ay":0.5,"dur":4433,"impact":3100,"pos":"center"},"pxfx_dark_rahu_eclipse_light":{"w":400,"h":392,"ax":0.5,"ay":0.5,"dur":4433,"impact":3100,"pos":"center"}};
// sounds: page key → file, and its Forge path (matched by content hash against the Forge mirror, 2026-11-28)
const SFX = { teleport: ["sfx_teleport.ogg", "Sound/Soundboard/Stare.ogg"], slapA: ["sfx_slapA.wav", "Sound/Soundboard/SE_HITNIKUA.wav"], slapB: ["sfx_slapB.wav", "Sound/Soundboard/SE_HITNIKUB.wav"],
  slapC: ["sfx_slapC.wav", "Sound/Soundboard/SE_HITNIKUC.wav"], swing: ["sfx_swing.wav", "Sound/Soundboard/SE_SWINGA.wav"], manto: ["sfx_manto.wav", "Sound/Soundboard/SE_manto.wav"],
  evasion: ["sfx_evasion.ogg", "Sound/Soundboard/Evasion1.ogg"], down: ["sfx_down.ogg", "Sound/Soundboard/Down1.ogg"], launch: ["sfx_launch.ogg", "Sound/Soundboard/Launch.ogg"],
  wind: ["sfx_wind.ogg", "Sound/Soundboard/Wind7.ogg"], machine: ["sfx_machine.ogg", "Sound/Soundboard/Machine.ogg"], tick: ["sfx_tick.mp3", "Sound/System_Tick.mp3"],
  explode: ["sfx_explode.wav", "Sound/Soundboard/SE_EXPLODE2.wav"], explosion: ["sfx_explosion.ogg", "Sound/Soundboard/Explosion2.ogg"], crack: ["sfx_crack.ogg", "Sound/Soundboard/Parry.ogg"],
  break: ["sfx_break.ogg", "Sound/Soundboard/Break.ogg"], crash: ["sfx_crash.ogg", "Sound/Soundboard/Crash.ogg"], bell: ["sfx_bell.ogg", "Sound/Soundboard/Bell3.ogg"],
  blowA: ["sfx_blowA.ogg", "Sound/Soundboard/Blow1.ogg"], blowB: ["sfx_blowB.ogg", "Sound/Soundboard/Blow3.ogg"], blowL: ["sfx_blowL.ogg", "Sound/Soundboard/SE_BTL_HitBlowL.ogg"],
  earth: ["sfx_earth.ogg", "Sound/Soundboard/Earth5.ogg"], earth2: ["sfx_earth2.ogg", "Sound/Soundboard/Earth3.ogg"], flash2: ["sfx_flash2.ogg", "Sound/Soundboard/Flash2.ogg"],
  saint3: ["sfx_saint3.ogg", "Sound/Soundboard/Saint3.ogg"], dark: ["sfx_dark.ogg", "Sound/Soundboard/Darkness4.ogg"], dark5: ["sfx_dark5.ogg", "Sound/Soundboard/Darkness5.ogg"],
  absorb: ["sfx_absorb.ogg", "Sound/Soundboard/Absorb1.ogg"], blind: ["sfx_blind.ogg", "Sound/Soundboard/Blind.ogg"], powerup: ["sfx_powerup.ogg", "Sound/Soundboard/Powerup.ogg"],
  miss: ["sfx_miss.ogg", "Sound/Soundboard/Miss.ogg"], slow: ["sfx_slow.ogg", "Sound/Soundboard/Down2.ogg"], saint: ["sfx_saint.ogg", "Sound/Soundboard/Saint5.ogg"],
  reflection: ["sfx_reflection.ogg", "Sound/Soundboard/Reflection.ogg"], magic: ["sfx_magic.ogg", "Sound/Soundboard/Magic4.ogg"], up: ["sfx_up.ogg", "Sound/Soundboard/Up4.ogg"] };

// published path → source file
function assetFiles() {
  const f = {};
  const add = (name, src) => { if (!fs.existsSync(src)) throw new Error("missing asset " + src); f["assets/" + name] = src; return "assets/" + name; };
  const m = { sprites: {}, clips: {}, sfx: {}, sfxSrc: {} };
  m.sprites.tg_bg = add("valley_battlemap007.webp", path.join(MIRROR, "Campaign/The Legend of Dragonslayer/Image/Battlemap/Valley_Battlemap007.webp"));
  m.sprites.tg_depth = add("valley_battlemap007_depth.webp", DEPTH);
  m.sprites.deva = add("deva_battle_idle.webm", path.join(MIRROR, "Beastiary/Deva_Battle_Idle.webm"));
  m.sprites.deva_fury = add("deva_fury_battle_idle.webm", path.join(MIRROR, "Beastiary/Deva/Deva_Fury_Battle_Idle.webm"));
  m.sprites.deva_focus = add("deva_focus_battle_idle.webm", path.join(MIRROR, "Beastiary/Deva/Deva_Focus_Battle_Idle.webm"));
  m.sprites.icon_deva = add("icon_deva.png", path.join(SPRITES, "Deva_Standard.png"));
  m.sprites.icon_fury = add("icon_fury.png", path.join(SPRITES, "Deva_Fury.png"));
  m.sprites.icon_focus = add("icon_focus.png", path.join(SPRITES, "Deva_Focus.png"));
  m.sprites.fist = add("fist_red.png", path.join(ASSETS, "fist_red.png"));
  m.sprites.fist_blue = add("fist_blue.png", path.join(ASSETS, "fist_blue.png"));
  m.sprites.fistA = m.sprites.fistB = add("missile_fist_token.png", path.join(ASSETS, "fist_red_ccw.png"));
  for (const id of ["hina", "zarg", "keren", "blanche"]) m.sprites[id] = add("spr_" + id + ".webm", path.join(ASSETS, "spr_" + id + ".webm"));
  for (const id of ["zarg", "keren", "blanche"]) for (const p of ["hurt", "walkd", "walkdl", "walkul"]) m.sprites["pose_" + id + "_" + p] = add(`spr_pose_${id}_${p}.webm`, path.join(ASSETS, `spr_pose_${id}_${p}.webm`));
  m.sprites.pose_hina_hurt = add("spr_pose_hina_hurt.webm", path.join(ASSETS, "spr_pose_hina_hurt.webm"));
  for (const k of ["ggs_burst_anim01", "ggs_burst_anim05", "ggs_burst_anim07", "ggs_spark_anim01"]) m.sprites[k] = add(k + ".png", path.join(ASSETS, k + ".png"));
  for (const [k, c] of Object.entries(CLIPS)) m.clips[k] = { ...c, src: add(k + ".webm", path.join(ASSETS, k + ".webm")) };
  for (const [k, [file, forge]] of Object.entries(SFX)) { m.sfx[k] = add(file, path.join(ASSETS, file)); m.sfxSrc[k] = forge; }
  return { meta: m, files: f };
}

function build({ out, version = "test", publish = false } = {}) {
  const KITB = require(path.join(ANIM, "mockup-kit/kit-build.js"));
  let head = ME.pageHead();
  const rep = (a, b) => { if (typeof a === "string" ? !head.includes(a) : !a.test(head)) throw new Error("miss " + String(a).slice(0, 70)); head = head.replace(a, b); };
  rep("<title>Nox Legion Actions</title>", publish ? "<title>Deva Action Animations</title>" : "<title>Deva Action Animations (move-engine test)</title>");
  rep(/<div class="eyebrow">[^<]*<\/div>/, `<div class="eyebrow">Battle Director · Deva · animation mockup ${version} · move-engine</div>`);
  rep("<h1>Nox Legion Actions</h1>", "<h1>Deva · Action Animations</h1>");
  rep(/<p>Every active move[^]*?<\/p>/, `<p>Her whole kit, rebuilt on move-engine (the same move files the game builds from) in her own arena, Valley_Battlemap007, on the 3D battle stage with in-game battler sizes. She now faces the party. Thirteen moves are approved and frozen; v20 makes your Fury slider tuning the default on Fists of Fury and Fists of Focus. Approve each move, write a note, pause anywhere to comment on that moment, drag any slider, then press Send feedback.</p>`);
  rep("Valley_Battlemap004 · 3D stage", "Valley_Battlemap007 · 3D stage");
  rep(`<p class="muted" style="margin:0">Damage, heal and MP numbers are the game's own look. The real scripts won't draw text.</p>`,
    `<p class="muted" style="margin:0">Damage and MP numbers and the hit counter are the game's own look. The status tags (Shaken, Slow, Blind, Cursed, Miss) and the fuse pips are stand-ins; the real scripts won't draw text.</p>`);
  rep(/\.num \{[^\n]*\}\n\.num\.heal \{[^\n]*\}\n/, "");
  rep("</style>", ME.css(["dn"]) + "\n" + rd(path.join(PAGE, "page.css")) + "\n</style>");

  const { meta, files } = assetFiles();
  const stage = ME.stageScript({ preset: PRESET, actors: ACTORS, seed: 1109, roles: "{ caster: () => ACT.deva, target: (i = 0) => PARTY[i] || PARTY[0] }" });
  const parts = [ME.engine(), ME.common(), ME.fxMelee(), ME.moves(), ME.family("deva", "head"), ME.family("deva", "deva"), rd(path.join(PAGE, "part-ui.js"))];
  const js = KITB.wrap(parts.join("\n"), publish ? { page: "deva-anim", version } : { page: "deva-anim-me", version: "me-test" });
  let lower = rd(path.join(PAGE, "page-lower.html")).replace("{{VERSION}}", version);
  const html = head + "\n" + lower + "\n<script>\nwindow.META = " + JSON.stringify(meta) + ";\nwindow.HPBAR_T = " + ME.hpbarTiming() + ";\n" + stage + "\n</script>\n<script>\n" + js + "\n</script>\n";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  // the assets next to the page (the test opens it from disk; the publish sends them as artifact files)
  const outDir = path.dirname(out);
  for (const [pub, src] of Object.entries(files)) { const dst = path.join(outDir, pub); fs.mkdirSync(path.dirname(dst), { recursive: true }); if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst); }
  return { out, files: Object.keys(files) };
}

// the game side: can the move files build? (same check the README's `move-engine.js check` runs)
function gameCheck() { const GB = require("../../build/game-build.js"); return GB.checkMoveSource(["head", "deva"].map((f) => path.join(__dirname, f + ".js"))); }

module.exports = { build, gameCheck, ACTORS, PRESET, SFX };
if (require.main === module) {
  const a = process.argv.slice(2), pub = a.includes("--publish"), vi = a.indexOf("--version");
  const out = a.find((x) => !x.startsWith("--") && a[a.indexOf(x) - 1] !== "--version") || path.join(__dirname, "..", "..", "out", "deva", "deva-anim.html");
  const r = build({ out, publish: pub, version: vi >= 0 ? a[vi + 1] : pub ? "v20" : "test" });
  console.log("ok", r.out, (fs.statSync(r.out).size / 1e3).toFixed(0) + " KB +", r.files.length, "asset files");
}
