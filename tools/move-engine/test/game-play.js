"use strict";
// Real PLAYBACK in the game: builds moves into animation scripts (build/game-build.js) and writes a snapshot-runner eval that
// plays each one through the Anim Studio preview (no combat, no damage) with Keren vs an enemy on a 3D Valley battle map, in
// the runner's throwaway world copy. With --shots, captures the board + timeline overlay at test/shots.json's moments.
//   node test/game-play.js [keys...] [--shots]   → out/eval-play.js   (default keys: the Gunblade pilot)
//   cd <Data>/tools/fvtt-playwright && FVTT_GPU=true node ../snapshot-runner/bin/run.mjs --snapshot snap-lionheart \
//      --port 30160 --canvas full --eval <worktree>/tools/move-engine/out/eval-play.js --dump <worktree>/tools/move-engine/out/play.json
//   node test/side-by-side.js        (after test/mockup-shots.js) → out/shots/side-by-side/*.png + index.html
const fs = require("fs");
const path = require("path");
const GB = require("../build/game-build.js");
const LF = require("./lib-files.js");

const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots");
const KEYS = argv.filter((a) => !a.startsWith("--")).length ? argv.filter((a) => !a.startsWith("--")) : LF.GUNBLADE_KEYS;
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, "shots.json"), "utf8")).moves;
const TUNE = { gb_sword: { roll: 1 }, gb_gun: { roll: 1 }, gb_tf: { dir: 0 }, sonicblow: { result: 1 }, sk_attack: { result: 1 } };
// assets: the family's committed map (Gunblade); the page's meta on E: for the comparison-only moves
let assets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "moves", "sonic-katar", "assets.json"), "utf8"));
if (KEYS.some((k) => !LF.GUNBLADE_KEYS.includes(k))) {
  const meta = JSON.parse(fs.readFileSync(LF.META, "utf8"));
  const all = LF.filesFor("sonicblow").map((f) => f.text).concat(GB.ORDER.map((p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8"))).join("\n");
  assets = GB.assetsFromMeta(meta, { only: all, sfxUrls: LF.SFX_URLS });
}
const SCRIPTS = {}, OUTCOMES = {}, SHOT_AT = {};
for (const k of KEYS) {
  const r = GB.buildScript({ key: k, name: "move-engine test " + k, files: LF.filesFor(k), assets: { clips: assets.clips, sfx: assets.sfx }, cfg: { partyFoot: 0.97, seed: 2611, trace: true, tune: TUNE[k] || {} } });
  if (!r.ok) { console.error(k, r.errors); process.exit(1); }
  SCRIPTS[k] = r.script; OUTCOMES[k] = SPEC[k] ? SPEC[k].gameOutcome : { hit: true, crit: false, total: null };
  if (SHOTS && SPEC[k]) SHOT_AT[k] = SPEC[k].shots.map((s, i) => ({ at: s.at, name: s.name, i }));
  console.log(k, r.chars, "chars");
}
const page = `
const SCRIPTS = ${JSON.stringify(SCRIPTS)};
const OUTCOMES = ${JSON.stringify(OUTCOMES)};
const SHOT_AT = ${JSON.stringify(SHOT_AT)};
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
// a frame of what the player sees on the board: the PIXI view (re-rendered now) + the timeline overlay, cropped to the two battlers
// at the mockup stage's framing (the two battlers 912 px apart on its 1682 x 788 stage)
function grab() {
  const app = canvas.app; app.renderer.render(app.stage); const v = app.view; const ov = document.querySelector(".oni-timeline-overlay");
  const k = v.width / v.clientWidth, wt = canvas.stage.worldTransform;
  const p1 = wt.apply(kt.object.center), p2 = wt.apply(ft.object.center);
  const span = Math.abs(p1.x - p2.x) * k * (1682 / 912), hgt = span * 788 / 1682;
  const cx = (p1.x + p2.x) / 2 * k, cy = (p1.y + p2.y) / 2 * k - hgt * 0.08;
  const full = document.createElement("canvas"); full.width = v.width; full.height = v.height; const fg = full.getContext("2d"); fg.drawImage(v, 0, 0);
  if (ov) { const r = ov.getBoundingClientRect(), vr = v.getBoundingClientRect(); fg.drawImage(ov, (r.left - vr.left) * k, (r.top - vr.top) * k, r.width * k, r.height * k); }
  const out = document.createElement("canvas"); out.width = 1400; out.height = Math.round(1400 * 788 / 1682); const og = out.getContext("2d");
  og.fillStyle = "#000"; og.fillRect(0, 0, out.width, out.height);
  og.drawImage(full, cx - span / 2, cy - hgt / 2, span, hgt, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.88);
}
let hits = []; const hh = Hooks.on("oni:hit", () => hits.push(performance.now()));
const base = canvas.stage.children.length;
const out = { scene: sc.name, stage3d: !!globalThis.__ONI_BATTLE_STAGE_3D__?.cameraLive?.(), caster: keren?.name, target: foe?.name, moves: {} };
globalThis.__MOVE_TRACE_ON = true;
for (const [k, script] of Object.entries(SCRIPTS)) {
  globalThis.__MOVE_LAST = null; globalThis.__oniTimelineLast = null; hits = []; const e0 = errs.length;
  const shots = (SHOT_AT[k] || []).map((s) => ({ ...s })); globalThis.__MOVE_SHOT_AT = shots; globalThis.__MOVE_SHOT = (s) => { try { s.data = grab(); } catch (e) { s.err = String(e?.message ?? e); } };
  const oc = OUTCOMES[k] ? [{ tokenUuid: ft.uuid, ...OUTCOMES[k] }] : null;
  const r = await FUCompanion.api.animStudio.preview({ script, casterTokenUuid: kt.uuid, targetTokenUuids: [ft.uuid], outcomes: oc });
  for (let i = 0; i < 200 && globalThis.__MOVE_LAST?.wallMs == null; i++) await wait(100);   // preview returns at the damage gate; wait for the end
  await wait(400);
  globalThis.__MOVE_SHOT_AT = null; globalThis.__MOVE_SHOT = null;
  const rep = globalThis.__MOVE_LAST, tl = globalThis.__oniTimelineLast;
  out.moves[k] = { preview: r, dryMs: rep?.dryMs, end: rep?.end, total: rep?.total, gate: rep?.gate, wallMs: rep?.wallMs, events: rep?.events, warnings: rep?.warnings, result: rep?.result,
    frames: tl?.frames, prerollMs: tl?.prerollMs, ranMs: tl?.ranMs, fps: tl?.ranMs ? Math.round(tl.frames / tl.ranMs * 1000) : null,
    // each oni.hit cue: when it fired on screen vs its planned ms
    hitCues: (() => { const plan = (rep?.trace || []).filter((e) => e.type === "hit").map((e) => e.at); return hits.map((h, i) => ({ planned: plan[i], shown: rep?.wall0 != null ? Math.round(h - rep.wall0) : null })); })(),
    shots: shots.map((s) => ({ at: s.at, shownAt: s.frameT, name: s.name, i: s.i, data: s.data || null, err: s.err || null })), errors: errs.slice(e0), trace: rep?.trace };
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
