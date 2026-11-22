"use strict";
// Game side, part 2: REAL playback. Builds each move into an animation script, writes a snapshot-runner eval that plays them
// through the Anim Studio preview (no combat, no damage) on the family's battle map, in the runner's throwaway world copy, and
// runs the runner (GPU). Per move: ran vs planned length, fps, slow frames (stalls) with their move time, each hit cue's
// on-screen time vs plan, and the board + timeline overlay at the given moments (JPEG data URLs).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const GB = require("../build/game-build.js");

const DATA = process.env.MOVE_ENGINE_DATA || "C:/Users/Oni/AppData/Local/FoundryVTT/Data";

function evalSource({ moves, stage }) {
  return `
const MOVES = ${JSON.stringify(moves)};
const STAGE = ${JSON.stringify(stage)};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 240 && !FUCompanion?.api?.animStudio?.preview; i++) await wait(250);
if (game.paused) await game.togglePause(false, true);
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.map((x) => String(x?.message ?? x)).join(" ").slice(0, 300)); oe.apply(console, a); };
window.addEventListener("error", (e) => errs.push("onerror " + e.message));
const sc = game.scenes.find((s) => s.name === STAGE.scene) || game.scenes.find((s) => s.name.includes(STAGE.scene));
await sc.view(); for (let i = 0; i < 80 && (!canvas.ready || canvas.scene?.id !== sc.id); i++) await wait(250); await wait(1500);
const caster = game.actors.getName(STAGE.caster), foe = game.actors.getName(STAGE.target);
const sr = canvas.dimensions.sceneRect, g = canvas.grid.size;
const mk = async (a, [fx, fy]) => { const td = await a.getTokenDocument({ x: Math.round(sr.x + sr.width * fx - g / 2), y: Math.round(sr.y + sr.height * fy - g / 2), hidden: false }); const [d] = await sc.createEmbeddedDocuments("Token", [td.toObject()]); return d; };
const kt = await mk(caster, STAGE.casterAt), ft = await mk(foe, STAGE.targetAt);
for (let i = 0; i < 40 && (!kt.object?.mesh || !ft.object?.mesh); i++) await wait(100); await wait(800);
canvas.animatePan({ x: (kt.object.center.x + ft.object.center.x) / 2, y: kt.object.center.y - g, scale: 0.9, duration: 0 }); await wait(600);
// the board as the player sees it (PIXI re-rendered now + the timeline overlay), cropped to the two battlers at the mockup
// stage's framing (they stand 912 px apart on its 1682 x 788 stage)
function grab() {
  const app = canvas.app; app.renderer.render(app.stage); const v = app.view; const ov = document.querySelector(".oni-timeline-overlay");
  const k = v.width / v.clientWidth, wt = canvas.stage.worldTransform, p1 = wt.apply(kt.object.center), p2 = wt.apply(ft.object.center);
  const span = Math.abs(p1.x - p2.x) * k * (1682 / 912), hgt = span * 788 / 1682, cx = (p1.x + p2.x) / 2 * k, cy = (p1.y + p2.y) / 2 * k - hgt * 0.08;
  const full = document.createElement("canvas"); full.width = v.width; full.height = v.height; const fg = full.getContext("2d"); fg.drawImage(v, 0, 0);
  if (ov) { const r = ov.getBoundingClientRect(), vr = v.getBoundingClientRect(); fg.drawImage(ov, (r.left - vr.left) * k, (r.top - vr.top) * k, r.width * k, r.height * k); }
  const out = document.createElement("canvas"); out.width = 1400; out.height = Math.round(1400 * 788 / 1682); const og = out.getContext("2d");
  og.fillStyle = "#000"; og.fillRect(0, 0, out.width, out.height); og.drawImage(full, cx - span / 2, cy - hgt / 2, span, hgt, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.88);
}
let hits = []; const hh = Hooks.on("oni:hit", () => hits.push(performance.now()));
const base = canvas.stage.children.length;
const out = { scene: sc.name, stage3d: !!globalThis.__ONI_BATTLE_STAGE_3D__?.cameraLive?.(), caster: caster?.name, target: foe?.name, moves: {} };
globalThis.__MOVE_TRACE_ON = true;
for (const m of MOVES) {
  globalThis.__MOVE_LAST = null; globalThis.__oniTimelineLast = null; hits = []; const e0 = errs.length; globalThis.__MOVE_PROBE = null;   // a test may fill it from inside the move
  const shots = (m.shots || []).map((s, i) => ({ ...s, i })); globalThis.__MOVE_SHOT_AT = shots; globalThis.__MOVE_SHOT = (s) => { try { s.data = grab(); } catch (e) { s.err = String(e?.message ?? e); } };
  // every frame's time, to find stalls (a frame over 40 ms) and where in the move they fall
  const frames = []; const tick = () => frames.push(performance.now()); canvas.app.ticker.add(tick);
  const oc = m.outcome ? [{ tokenUuid: ft.uuid, ...m.outcome }] : null;
  const strikes = m.strikes ? m.strikes.map((s) => ({ ...s, outcomes: s.outcomes.map((o) => ({ ...o, tokenUuid: ft.uuid })) })) : null;
  const r = await FUCompanion.api.animStudio.preview({ script: m.script, casterTokenUuid: kt.uuid, targetTokenUuids: [ft.uuid], outcomes: oc, strikes });
  for (let i = 0; i < 200 && globalThis.__MOVE_LAST?.wallMs == null; i++) await wait(100);   // preview returns at the damage gate; wait for the end
  await wait(400); canvas.app.ticker.remove(tick);
  globalThis.__MOVE_SHOT_AT = null; globalThis.__MOVE_SHOT = null;
  const rep = globalThis.__MOVE_LAST, tl = globalThis.__oniTimelineLast, w0 = rep?.wall0 ?? null;
  const inMove = w0 == null ? [] : frames.filter((f) => f >= w0 && f <= w0 + (rep?.total ?? 0) + 50);
  const stalls = []; for (let i = 1; i < inMove.length; i++) { const d = inMove[i] - inMove[i - 1]; if (d > 40) stalls.push({ at: Math.round(inMove[i - 1] - w0), ms: Math.round(d) }); }
  const plan = (rep?.trace || []).filter((e) => e.type === "hit").map((e) => e.at);
  out.moves[m.key] = { preview: r, end: rep?.end, total: rep?.total, gate: rep?.gate, wallMs: rep?.wallMs, result: rep?.result, warnings: rep?.warnings,
    frames: tl?.frames, ranMs: tl?.ranMs, prerollMs: tl?.prerollMs, fps: tl?.ranMs ? Math.round(tl.frames / tl.ranMs * 1000) : null, stalls,
    cues: hits.map((h, i) => ({ planned: plan[i] ?? null, shown: w0 != null ? Math.round(h - w0) : null })),
    shots: shots.map((s) => ({ i: s.i, at: s.at, name: s.name, shownAt: s.frameT ?? null, data: s.data || null, err: s.err || null })),
    errors: errs.slice(e0), probe: globalThis.__MOVE_PROBE ?? null, trace: rep?.trace || [] };
}
Hooks.off("oni:hit", hh);
const leftover = canvas.stage.children.length;
await sc.deleteEmbeddedDocuments("Token", [kt.id, ft.id]);
out.stageChildren = { before: base, after: leftover };
return out;
`;
}

// moves: [{ key, files, tune, outcome, strikes, shots }]; returns the eval's result object
function runGame({ moves, stage, assets, outDir, code = null, port = 30162, gpu = true }) {
  const built = moves.map((m) => {
    const r = GB.buildScript({ key: m.key, name: "move-engine parity " + m.key, files: m.files, assets, cfg: { partyFoot: 0.97, seed: 2611, trace: true, tune: m.tune || {} } });
    if (!r.ok) throw new Error(m.key + ": " + r.errors.join("; "));
    return { key: m.key, script: r.script, outcome: m.outcome || null, strikes: m.strikes || null, shots: m.shots || [] };
  });
  fs.mkdirSync(outDir, { recursive: true });
  const evalFile = path.join(outDir, "game-eval.js"), dump = path.join(outDir, "game.json");
  fs.writeFileSync(evalFile, evalSource({ moves: built, stage }));
  const args = ["../snapshot-runner/bin/run.mjs", "--snapshot", stage.snapshot, "--port", String(port), "--canvas", "full", "--eval", evalFile, "--dump", dump, ...(code ? ["--code", code] : [])];
  const r = spawnSync(process.execPath, args, { cwd: path.join(DATA, "tools", "fvtt-playwright"), env: { ...process.env, ...(gpu ? { FVTT_GPU: "true" } : {}) }, encoding: "utf8", timeout: 900000 });
  const log = (r.stdout || "") + (r.stderr || "");
  if (!fs.existsSync(dump)) throw new Error("the snapshot runner wrote no result:\n" + log.slice(-2000));
  const res = JSON.parse(fs.readFileSync(dump, "utf8"));
  return { ...(res.result || res), runnerLog: log.split("\n").filter((l) => /^\[run\]/.test(l)).slice(-4) };
}
module.exports = { runGame, evalSource };
