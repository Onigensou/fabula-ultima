"use strict";
// move-engine parity: is the game playing what the mockup shows?
//   1. build the family's mockup page from the repo   2. play the moves there (trace, lag, frames at the moments)
//   3. the game runtime's dry run on the mockup's geometry, with the GAME's result (exact diff)
//   4. real playback in the snapshot runner (GPU): length, fps, stalls, cue timing, frames at the same moments
//   5. one report: PASS / FAIL per move, every difference named
const fs = require("fs");
const path = require("path");
const GB = require("../build/game-build.js");
const { runMockup } = require("./mockup-run.js");
const { dryRun, strikesFrom } = require("./game-dry.js");
const { runGame } = require("./game-play.js");
const { compareTraces } = require("./compare.js");
const { writeReport, png } = require("./report.js");
const ROOT = path.join(__dirname, "..");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function loadFamily(name) {
  const dir = path.join(ROOT, "moves", name);
  const fam = JSON.parse(rd(path.join(dir, "family.json")));
  const file = (f) => ({ name: "moves/" + name + "/" + f + ".js", text: rd(path.join(dir, f + ".js")) });
  // assets: the family's committed Forge map, topped up from the page's meta for moves the map does not cover
  let assets = fam.assets && fam.assets.map ? JSON.parse(rd(path.join(dir, fam.assets.map))) : { clips: {}, sfx: {} };
  assets = { clips: { ...assets.clips }, sfx: { ...assets.sfx } };
  if (fam.assets && fam.assets.metaFallback) {
    const page = require(path.join(dir, fam.page));
    if (page.META && fs.existsSync(page.META)) {
      const all = Object.values(fam.moves).flatMap((m) => m.files).map((f) => file(f).text).concat(GB.ORDER.map((p) => rd(path.join(ROOT, p)))).join("\n");
      const extra = GB.assetsFromMeta(JSON.parse(rd(page.META)), { only: all, sfxUrls: fam.assets.sfxUrls || {} });
      assets = { clips: { ...extra.clips, ...assets.clips }, sfx: { ...extra.sfx, ...assets.sfx } };
    }
  }
  return { fam, dir, file, assets };
}

async function parity(family, keys, { gpu = true, game = true, code = null, out = null, log = console.log } = {}) {
  const { fam, dir, file, assets } = loadFamily(family);
  keys = keys && keys.length ? keys : Object.keys(fam.moves);
  for (const k of keys) if (!fam.moves[k]) throw new Error("no move " + k + " in " + family + "/family.json");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = out || path.join(ROOT, "out", "parity", family, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  log("1/4 building the mockup page from the repo");
  const built = require(path.join(dir, fam.page)).build({ out: path.join(outDir, "page.html") });
  const page = typeof built === "string" ? built : built.out;   // a page builder may return { out, files }
  log("2/4 playing " + keys.length + " move(s) on the page");
  const actorKeys = [...new Set([fam.mockupActors.caster, fam.mockupActors.target, ...(fam.mockupActors.targets || []),
    ...Object.values(fam.moves).flatMap((m) => m.dryActors ? [m.dryActors.caster, ...(m.dryActors.targets || [])] : [])].filter(Boolean))];
  const mock = await runMockup({ page, gpu, shotsDir: path.join(outDir, "mockup-frames"), actorKeys,
    moves: keys.map((k) => ({ key: k, tune: fam.moves[k].pageTune, shots: fam.moves[k].shots })) });
  log("3/4 game runtime dry runs (exact)");
  const actorsFor = (m) => { const d = m.dryActors || {}; const tk = d.targets || fam.mockupActors.targets || [fam.mockupActors.target];
    return { caster: mock.actors[d.caster || fam.mockupActors.caster], target: mock.actors[tk[0]], targets: tk.map((k) => mock.actors[k]) }; };
  const moves = [];
  for (const k of keys) {
    const m = fam.moves[k], files = m.files.map(file);
    const rep = await dryRun({ key: k, files, actors: actorsFor(m), preset: mock.preset, assets, tune: m.pageTune, outcome: m.gameOutcome || null, strikes: m.gameStrikes ? strikesFrom(m.gameStrikes) : null, ...(fam.seed != null ? { seed: fam.seed } : {}) });   // the page's MOVE_SEED
    const cmp = compareTraces(mock.moves[k].trace, rep.trace);
    moves.push({ key: k, label: m.label, files: m.files, mock: { repeat: mock.moves[k].repeat, lag: mock.moves[k].lag },
      dry: { ...cmp, warnings: rep.check.warnings, errors: rep.check.errors, gate: rep.gate, end: rep.end } });
  }
  let gameRes = null;
  if (game) {
    log("4/4 real playback in the snapshot runner (" + (gpu ? "GPU" : "software GL") + ", " + fam.game.snapshot + ")");
    gameRes = runGame({ outDir, code, gpu, assets, stage: fam.game,
      moves: keys.map((k) => ({ key: k, files: fam.moves[k].files.map(file), tune: fam.moves[k].pageTune, outcome: fam.moves[k].gameOutcome || null,
        strikes: fam.moves[k].gameStrikes ? strikesFrom(fam.moves[k].gameStrikes) : null, shots: fam.moves[k].shots })) });
  } else log("4/4 skipped (--no-game)");

  for (const m of moves) {
    const p = gameRes && gameRes.moves[m.key];
    const reasons = [];
    if (!m.dry.ok) reasons.push(m.dry.bad + " event(s) differ from the mockup");
    if (m.dry.errors.length) reasons.push("build: " + m.dry.errors.join("; "));
    if (!mock.moves[m.key].repeat) reasons.push("the mockup's timeline changed between two runs");
    if (p) {
      const lag = p.cues.filter((c) => c.planned != null && c.shown != null).map((c) => c.shown - c.planned);
      const bigStall = p.stalls.filter((s) => s.ms >= 100);
      p.ok = !!(p.preview && p.preview.ok) && p.ranMs != null && p.ranMs - p.total <= 100 && lag.every((x) => Math.abs(x) <= 50) && !bigStall.length && !p.errors.length;
      if (!(p.preview && p.preview.ok)) reasons.push("the game preview failed");
      if (p.ranMs != null && p.ranMs - p.total > 100) reasons.push("ran " + p.ranMs + " ms for a planned " + p.total + " ms");
      const late = lag.filter((x) => Math.abs(x) > 50); if (late.length) reasons.push(late.length + " hit cue(s) more than 50 ms off");
      if (bigStall.length) reasons.push("stall(s): " + bigStall.map((s) => s.ms + " ms at " + s.at + " ms").join(", "));
      if (p.errors.length) reasons.push(p.errors.length + " error(s) in the game");
      m.play = p;
    }
    m.verdict = { ok: !reasons.length, reasons };
    const shotsMock = mock.moves[m.key].shots || [];
    m.shots = (fam.moves[m.key].shots || []).map((s, i) => { const a = shotsMock[i] || {}, b = p ? (p.shots || []).find((x) => x.i === i) || {} : {};
      return { at: s.at, name: s.name, mockAt: a.shownAt, gameAt: b.shownAt, mock: png(a.file), game: b.data || null }; });
    if (p) { delete p.shots; delete p.trace; }
  }
  // what the game actually ships for these moves: built with which engine version? (a parity run builds from the CURRENT repo)
  if (fam.shipped && fam.shipped.module) {
    const modFile = path.join(ROOT, "..", "..", fam.shipped.module);
    const text = fs.existsSync(modFile) ? rd(modFile) : "";
    for (const m of moves) { const exp = fam.shipped.moves && fam.shipped.moves[m.key]; if (!exp) continue;
      const head = "export const " + exp + " = ", line = text.split("\n").find((l) => l.startsWith(head));
      const script = line ? JSON.parse(line.slice(head.length).replace(/;\s*$/, "")) : "";
      const ver = /MOVE_ENGINE_VERSION = \\"([0-9.]+)\\"/.exec(script);
      m.shipped = { module: fam.shipped.module, export: exp, engine: ver ? ver[1] : null, current: mock.engine, stale: !!ver && ver[1] !== mock.engine, rebuild: fam.shipped.rebuild || null }; }
  }
  const R = { family, when: new Date().toLocaleString(), engine: mock.engine, code, moves, mockErrors: mock.errors,
    game: gameRes ? { scene: gameRes.scene, stage3d: gameRes.stage3d, caster: gameRes.caster, target: gameRes.target, stageChildren: gameRes.stageChildren, runner: gameRes.runnerLog } : null };
  const reportFile = writeReport(R, outDir);
  return { report: reportFile, ok: moves.every((m) => m.verdict.ok), moves: moves.map((m) => ({ key: m.key, ok: m.verdict.ok, reasons: m.verdict.reasons })) };
}
module.exports = { parity, loadFamily };
