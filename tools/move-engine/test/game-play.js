"use strict";
// Real PLAYBACK in the game: builds the approved Sonic Katar / Gunblade moves into animation scripts (build/game-build.js)
// and writes a snapshot-runner eval that plays each one through the Anim Studio preview (no combat, no damage) with
// Keren vs an enemy on a 3D Valley battle map, in the runner's throwaway world copy.
//   node test/game-play.js [keys...]        → out/eval-play.js
//   cd <Data>/tools/fvtt-playwright && FVTT_GPU=true node ../snapshot-runner/bin/run.mjs --snapshot snap-lionheart \
//      --port 30160 --canvas full --eval <worktree>/tools/move-engine/out/eval-play.js --dump <worktree>/tools/move-engine/out/play.json
const fs = require("fs");
const path = require("path");
const GB = require("../build/game-build.js");

const KEYS = process.argv.slice(2).length ? process.argv.slice(2) : ["gb_sword", "gb_gun", "gb_tf", "sk_attack", "sonicblow"];
const TUNE = { gb_sword: { roll: 1 }, gb_gun: { roll: 1 }, gb_tf: { dir: 0 }, sonicblow: { result: 1 }, sk_attack: { result: 1 } };
const FX = path.join(__dirname, "fixtures", "sonic-katar");
let head = fs.readFileSync(path.join(FX, "part-sonic-head.js"), "utf8").replace(/\r\n/g, "\n");
for (const [a, b] of [["const ORC = ACT.orc;", "const ORC = TARGET;"], ["const WA = () => ACT[WIELD];", "const WA = () => CASTER;"], ['WIELD = "keren";', ""]]) { if (head.split(a).length !== 2) throw new Error(a); head = head.replace(a, b); }
const moves = fs.readFileSync(path.join(FX, "part-sonic.js"), "utf8").replace(/\r\n/g, "\n");
const files = [{ name: "part-sonic-head.game.js", text: head }, { name: "part-sonic.js", text: moves }, { name: "test-dice.js", text: "PDICE.caster = PDICE.keren;" }];
const meta = JSON.parse(fs.readFileSync("E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation/Sonic Katar/src/assets/meta.json", "utf8"));
const all = files.map((f) => f.text).concat(GB.ORDER.map((p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8"))).join("\n");
// the RO sounds the Sonic Katar build uploaded to Forge (feat/sonic-gunblade, tools/anim-studio/lib/sonic-signatures.js)
const RO = "Sound/Ragnarok Online/";
const assets = GB.assetsFromMeta(meta, { only: all, sfxUrls: { ro_sonicblow: RO + "ro_sonicblow.wav", ro_katar: RO + "ro_attack_katar.wav", ro_katar2: RO + "ro_attack_katar2.wav", ro_hitdagger: RO + "ro_hit_dagger.wav" } });
if (assets.missing.length) console.log("assets without a Forge URL (skipped):", assets.missing.join(", "));
const SCRIPTS = {};
for (const k of KEYS) {
  const r = GB.buildScript({ key: k, name: "move-engine test " + k, files, assets: { clips: assets.clips, sfx: assets.sfx }, cfg: { partyFoot: 0.97, seed: 2611, trace: true, tune: TUNE[k] || {} } });
  if (!r.ok) { console.error(k, r.errors); process.exit(1); }
  SCRIPTS[k] = r.script; console.log(k, r.chars, "chars", r.warnings.length ? "· " + r.warnings.length + " warnings" : "");
}
const page = `
const SCRIPTS = ${JSON.stringify(SCRIPTS)};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 240 && !FUCompanion?.api?.animStudio?.preview; i++) await wait(250);
if (game.paused) await game.togglePause(false, true);
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.map((x) => String(x?.message ?? x)).join(" ").slice(0, 300)); oe.apply(console, a); };
window.addEventListener("error", (e) => errs.push("onerror " + e.message));
const sc = game.scenes.find((s) => /Valley_Battlemap001/i.test(s.name)) || game.scenes.find((s) => /Valley_Battlemap/i.test(s.name)) || game.scenes.getName("Training Ground");
await sc.view(); for (let i = 0; i < 80 && (!canvas.ready || canvas.scene?.id !== sc.id); i++) await wait(250); await wait(1500);
const keren = game.actors.getName("Keren"); const foe = game.actors.getName("Test Target Enemy") || game.actors.find((a) => a.type !== "character" && !a.hasPlayerOwner);
const sr = canvas.dimensions.sceneRect, g = canvas.grid.size;
const mk = async (a, fx, fy) => { const td = await a.getTokenDocument({ x: Math.round(sr.x + sr.width * fx - g / 2), y: Math.round(sr.y + sr.height * fy - g / 2), hidden: false }); const [d] = await sc.createEmbeddedDocuments("Token", [td.toObject()]); return d; };
const kt = await mk(keren, 0.72, 0.62), ft = await mk(foe, 0.30, 0.60);
for (let i = 0; i < 40 && (!kt.object?.mesh || !ft.object?.mesh); i++) await wait(100); await wait(800);
canvas.animatePan({ x: (kt.object.center.x + ft.object.center.x) / 2, y: kt.object.center.y - g, scale: 0.9, duration: 0 }); await wait(600);
let hits = []; const hh = Hooks.on("oni:hit", () => hits.push(performance.now()));
const base = canvas.stage.children.length;
const out = { scene: sc.name, stage3d: !!globalThis.__ONI_BATTLE_STAGE_3D__?.cameraLive?.(), caster: keren?.name, target: foe?.name, moves: {} };
globalThis.__MOVE_TRACE_ON = true;
for (const [k, script] of Object.entries(SCRIPTS)) {
  globalThis.__MOVE_LAST = null; globalThis.__oniTimelineLast = null; hits = []; const e0 = errs.length;
  const r = await FUCompanion.api.animStudio.preview({ script, casterTokenUuid: kt.uuid, targetTokenUuids: [ft.uuid], outcomes: [{ tokenUuid: ft.uuid, hit: true, crit: false }] });
  for (let i = 0; i < 200 && globalThis.__MOVE_LAST?.wallMs == null; i++) await wait(100);   // preview returns at the damage gate; wait for the end
  await wait(400);
  const rep = globalThis.__MOVE_LAST, tl = globalThis.__oniTimelineLast;
  out.moves[k] = { preview: r, dryMs: rep?.dryMs, end: rep?.end, total: rep?.total, gate: rep?.gate, wallMs: rep?.wallMs, events: rep?.events, warnings: rep?.warnings,
    frames: tl?.frames, prerollMs: tl?.prerollMs, ranMs: tl?.ranMs, fps: tl?.ranMs ? Math.round(tl.frames / tl.ranMs * 1000) : null,
    // each oni.hit cue: when it fired on screen vs its planned ms
    hitCues: (() => { const plan = (rep?.trace || []).filter((e) => e.type === "hit").map((e) => e.at); return hits.map((h, i) => ({ planned: plan[i], shown: rep?.wall0 != null ? Math.round(h - rep.wall0) : null })); })(), errors: errs.slice(e0), trace: rep?.trace };
}
Hooks.off("oni:hit", hh);
const leftover = canvas.stage.children.length;
await sc.deleteEmbeddedDocuments("Token", [kt.id, ft.id]);
out.stageChildren = { before: base, after: leftover };
return out;
`;
const OUT = path.join(__dirname, "..", "out", "eval-play.js");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page);
console.log("wrote", OUT);
