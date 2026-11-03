// run — boot the real Foundry client against the runner server and (optionally) run the
// skill-regression collector there, then diff it against a reference.
//
//   node tools/snapshot-runner/bin/run.mjs                 # boot + report
//   node tools/snapshot-runner/bin/run.mjs --compare       # + collector, diff vs capture/oracle.json (the real engine)
//   --collect <file>    run the collector and save its results (the "A" side of an A/B)
//   --compare <file>    diff against such a file instead (A/B of code: no world involved).
//                       A skill-regression golden ({ _meta, skills }) works too.
//   --code <gitref>     run OUR module as it was at that commit (the server serves it)
//   --control affinity|dice|hp   negative controls (see below)
//   --eval <file> [--dump <out>]   run code in the booted page
//   --world-setting ns.key=<json>  override a world setting for this boot (repeatable)
//   --keep <min>        leave the browser open (debug)
//
// Collector knobs (same meaning as skill-regression's; scene / dummy default to the reference's):
//   --mode compute|simulate   simulate = COMPUTE then RESOLVE with every write captured (nothing commits)
//   --scene <name>  --dummy <name>  --caster <name>  --limit <n>  --per-skill-ms <ms>  --include-types <csv>
//   --seed <n>      pin Math.random per skill (random AE pools are not covered by the forced dice)
//   --collector-opts <file>   a JSON object laid over the collector OPTS built from the flags above
//                   (skill-regression --runner passes its own OPTS this way, so both run the same)
//   --bench [--full]          build the Regression Bench in the page first (skill-regression's own
//                   lib/build-bench.js), as the live gate does before its check
//
// Isolation, so two sessions can share the tool without swapping each other's world:
//   --snapshot <dir>    the snapshot to serve (default "snapshot"; build-snapshot --snapshot <dir>).
//                       Reports (run-report, compare*, results-*) then go to that dir, not the tool root.
//   --port <n>          the runner server's port (default: runner.config.json's).
//
// Drawing: --canvas full|low|off (default off; see bin/canvas-mode.mjs). off = no canvas drawing
// at all, for logic-only tests; full = as the game draws, for visual checks.
//
// Time warp: --time-warp <F> runs the page's timers F times faster (setTimeout / setInterval
// delays divided by F) from game-ready on, so a test stops paying for waits: animation
// holds, fixed pauses, poll intervals, reaction-window grace periods. --warp-clocks also
// speeds performance.now / Date.now up by F, for code that waits until a clock has moved.
// Boot is never warped. A rule that depends on timing shows up as a different battle in
// bin/compare-battle.mjs, which is the point of checking a warped run against the referee.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { applyCanvasMode } from "./canvas-mode.mjs";
import { applyTimeWarp, skipList, runCollector, buildBench, compareFingerprints } from "../lib/page-tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
const CFG = JSON.parse(readFileSync(resolve(TOOL, "runner.config.json"), "utf8"));
const has = (k) => process.argv.includes(k);
// --fast: the logic-test preset, each part refereed on a seeded battle (2026-11-03):
// no canvas drawing + timers x20 + an 800x450 page. 641 s -> 17.7 s, same battle as the Staging World.
if (process.argv.includes("--fast")) {
  const add = (k, v) => { if (!process.argv.includes(k)) process.argv.push(k, ...(v === undefined ? [] : [v])); };
  add("--canvas", "off"); add("--time-warp", "20"); add("--viewport", "800x450");
}
const val = (k) => { const i = process.argv.indexOf(k); const v = i > 0 ? process.argv[i + 1] : undefined; return v && !v.startsWith("--") ? v : undefined; };
const PORT = Number(val("--port") ?? CFG.port);
const BASE = `http://localhost:${PORT}`;
const SNAPSHOT = val("--snapshot") ?? "snapshot";
const OUT = SNAPSHOT === "snapshot" ? TOOL : resolve(TOOL, SNAPSHOT);
const COMPARE = has("--compare");
const REF_FILE = val("--compare");
const COLLECT_FILE = val("--collect");
const CODE_REF = val("--code") ?? null;
const MODE = val("--mode") === "simulate" ? "simulate" : "compute";
// Negative controls: deliberately change something, so a 100% match can be shown to
// be able to fail. "affinity" edits data (the dummy turns vulnerable to everything,
// written through the stand-in server); "dice" changes the forced roll; "hp" halves the
// dummy's current HP, which moves only what RESOLVE writes (the HP patch), not what
// COMPUTE reports: the control for the simulate-only part of a fingerprint.
const CONTROL = val("--control") ?? null;
const CANVAS = val("--canvas") ?? "off";

// The reference fingerprints: the real engine's capture, or an earlier runner run.
const REF_PATH = REF_FILE ? resolve(process.cwd(), REF_FILE) : resolve(TOOL, "capture", "oracle.json");
const ref = (COMPARE || COLLECT_FILE) && existsSync(REF_PATH) ? JSON.parse(readFileSync(REF_PATH, "utf8")) : null;
if (COMPARE && !ref) throw new Error(`no reference at ${REF_PATH}`);
const refScene = ref?.scene ?? ref?._meta?.scene, refDummy = ref?.enemyTarget ?? ref?._meta?.enemyTarget;
const refMode = ref?.mode ?? ref?._meta?.mode ?? "compute";
if (COMPARE && refMode !== MODE) throw new Error(`the reference is a ${refMode} capture and this run is ${MODE}: pass --mode ${refMode}`);

const status = async () => { try { const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; } };
let child = null;
const running = await status();
if (running) {
  // A server that is already up must serve the code and the snapshot this run asked for.
  const want = CODE_REF ? execSync(`git rev-parse --verify "${CODE_REF}^{commit}"`, { cwd: DATA }).toString().trim() : "working-tree";
  if ((running.code ?? "working-tree") !== want) throw new Error(`the runner server on :${PORT} serves code ${running.code}, this run wants ${want}: stop it first`);
  if ((running.snapshot ?? "snapshot") !== SNAPSHOT) throw new Error(`the runner server on :${PORT} serves snapshot "${running.snapshot ?? "snapshot"}", this run wants "${SNAPSHOT}": pass another --port, or wait for it`);
} else {
  child = spawn(process.execPath, [resolve(HERE, "server.mjs"), "--port", String(PORT), "--snapshot", SNAPSHOT, ...(CODE_REF ? ["--code", CODE_REF] : [])], { stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 240 && !(await status()); i++) await new Promise((r) => setTimeout(r, 250));   // first --code extract takes a few s
}

const { launch, loadConfig } = await import(pathToFileURL(resolve(DATA, "tools/fvtt-playwright/lib/foundry.js")).href);
const { browser, page } = await launch({ ...loadConfig(), headless: true });
const R = { code: CODE_REF ?? "working-tree", snapshot: SNAPSHOT, mode: MODE, pageErrors: [], consoleErrors: [], timings: {} };
const overrides = {};
process.argv.forEach((a, i) => {
  if (a !== "--world-setting") return;
  const [k, ...v] = process.argv[i + 1].split("="); const raw = v.join("=");
  try { overrides[k] = JSON.parse(raw); } catch { overrides[k] = raw; }
});
if (Object.keys(overrides).length) { await page.addInitScript((o) => { window.__RUNNER_SETTINGS = o; }, overrides); R.worldSettings = overrides; }
page.on("pageerror", (e) => R.pageErrors.push(String(e.stack ?? e.message).split("\n").slice(0, 6).join(" | ").slice(0, 900)));
page.on("console", (m) => { if (m.type() === "error") R.consoleErrors.push(m.text().slice(0, 400)); });

try {
  const t0 = Date.now();
  await page.goto(`${BASE}/game`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120000 });
    R.timings.readyMs = Date.now() - t0;
    await page.waitForFunction(() => globalThis.canvas?.ready === true, null, { timeout: 60000 }).catch(() => {});
    R.timings.canvasMs = Date.now() - t0;
    // --viewport WxH: a smaller page has less to paint. With the canvas off, painting the HTML UI
    // in software is most of what is left of a headless run (measured below as main-thread task time).
    if (val("--viewport")) { const [w, h] = val("--viewport").split("x").map(Number); await page.setViewportSize({ width: w, height: h }); R.viewport = { w, h }; }
    R.canvas = await applyCanvasMode(page, CANVAS);
    if (val("--time-warp")) {
      R.timeWarp = await applyTimeWarp(page, Number(val("--time-warp")), has("--warp-clocks"));
      console.log("[run] time warp", JSON.stringify(R.timeWarp));
    }
  } catch (e) { R.bootError = e.message.split("\n")[0]; }
  R.state = await page.evaluate(() => ({
    ready: !!game?.ready, world: game?.world?.id, user: game?.user?.name, isGM: game?.user?.isGM,
    module: game?.modules?.get("fabula-ultima-companion")?.version,
    actors: game?.actors?.size, items: game?.items?.size, scene: globalThis.canvas?.scene?.name, canvasReady: !!globalThis.canvas?.ready,
    api: !!globalThis.FUCompanion?.api?.test?.runDirectorSkillCompute,
    runner: { ...window.__runner, writes: window.__runner?.writes?.length, writeKinds: [...new Set((window.__runner?.writes ?? []).map((w) => w.type + "." + w.action))] },
  }));
  console.log("[run] boot", JSON.stringify({ code: R.code, snapshot: SNAPSHOT, canvas: R.canvas?.mode, ...R.timings, bootError: R.bootError }), JSON.stringify(R.state));

  const ei = process.argv.indexOf("--eval");
  if (ei > 0) {
    const code = readFileSync(resolve(process.cwd(), process.argv[ei + 1]), "utf8");
    // Main-thread busy time over the eval (CDP Performance metrics): busy vs waiting, in real seconds.
    const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const m0 = await metrics();
    const tEval = Date.now();
    R.eval = await page.evaluate(`(async () => { ${code}
})()`).catch((e) => ({ evalError: e.message }));
    R.timings.evalMs = Date.now() - tEval;   // node clock: real time even under --warp-clocks
    const m1 = await metrics(), d = (k) => +((m1[k] ?? 0) - (m0[k] ?? 0)).toFixed(2);
    R.mainThread = { taskS: d("TaskDuration"), scriptS: d("ScriptDuration"), styleLayoutS: +(d("RecalcStyleDuration") + d("LayoutDuration")).toFixed(2), wallS: +(R.timings.evalMs / 1000).toFixed(1) };
    console.log("[run] main thread", JSON.stringify(R.mainThread));
    console.log(`[run] eval took ${(R.timings.evalMs / 1000).toFixed(1)} s`);
    const dump = val("--dump");
    if (dump) { writeFileSync(resolve(process.cwd(), dump), JSON.stringify(R.eval)); console.log(`[run] eval -> ${dump}`); R.eval = "(dumped)"; }
    else console.log("[run] eval", JSON.stringify(R.eval, null, 1));
  }

  const wantCollect = COMPARE || COLLECT_FILE;
  if (wantCollect && !R.state.api) R.collectError = "director test harness not registered";
  if (wantCollect && R.state.api) {
    const skip = skipList(MODE);
    const opts = { mode: MODE, sceneName: val("--scene") ?? refScene, dummy: val("--dummy") ?? refDummy, skip };
    if (val("--caster")) opts.onlyCaster = val("--caster");
    if (val("--limit")) opts.limit = Number(val("--limit"));
    if (val("--include-types")) opts.includeTypes = val("--include-types").split(",").map((x) => x.trim()).filter(Boolean);
    // RESOLVE re-imports skill-effects.js per call, so the 12 s compute guard is too short for it
    opts.perSkillMs = Number(val("--per-skill-ms") ?? (MODE === "simulate" ? 30000 : 12000));
    if (val("--seed") !== undefined) opts.seed = Number(val("--seed"));   // pin Math.random per skill (collect.js)
    if (val("--collector-opts")) Object.assign(opts, JSON.parse(readFileSync(resolve(process.cwd(), val("--collector-opts")), "utf8")));
    if (has("--bench")) {
      const bopts = { ...(opts.includeTypes ? { includeTypes: opts.includeTypes } : {}), ...(has("--full") ? { fullRoster: true } : {}) };
      const { ok: benchOk, ...bench } = await buildBench(page, bopts);
      R.bench = bench;
      console.log("[run] bench", JSON.stringify(R.bench));
      if (!benchOk) throw new Error(`bench build failed: ${R.bench.error}`);
    }
    if (CONTROL === "dice") opts.force = { rA: 1, rB: 1 };
    if (CONTROL === "affinity" || CONTROL === "hp") {
      R.control = await page.evaluate(async ({ sceneName, dummyName, control }) => {
        const scene = game.scenes.getName(sceneName);
        const tok = scene.tokens.find((t) => t.actor?.name === dummyName);
        const upd = {};
        if (control === "affinity") for (let i = 1; i <= 9; i++) upd[`system.props.affinity_${i}`] = "VU";
        else upd["system.props.current_hp"] = Math.max(1, Math.floor(Number(tok.actor.system.props.current_hp) / 2));
        await tok.actor.update(upd);
        return { control, linked: tok.actorLink, after: Object.fromEntries(Object.entries(tok.actor.system.props).filter(([k]) => /^affinity_\d$|^current_hp$/.test(k))) };
      }, { sceneName: opts.sceneName, dummyName: opts.dummy, control: CONTROL });
      console.log(`[run] control ${CONTROL}`, JSON.stringify(R.control));
    }
    const t1 = Date.now();
    const mine = await runCollector(page, opts);
    R.timings.collectMs = Date.now() - t1;
    Object.assign(mine, { code: R.code });
    R.collect = { ok: mine.ok, error: mine.error ?? null, mode: mine.mode, scene: mine.scene, total: mine.total, count: mine.count, errorCount: mine.errorCount, slowest: mine.slowest };
    if (!CONTROL) writeFileSync(resolve(OUT, MODE === "simulate" ? "results-runner-simulate.json" : "results-runner.json"), JSON.stringify(mine, null, 1));
    if (COLLECT_FILE) { writeFileSync(resolve(process.cwd(), COLLECT_FILE), JSON.stringify(mine, null, 1)); console.log(`[run] collector results -> ${COLLECT_FILE} (${Object.keys(mine.skills ?? {}).length} skills, ${MODE})`); }

    if (COMPARE) {
      const { diffs, ...counts } = compareFingerprints(ref, mine);
      R.compare = { mode: MODE, reference: REF_FILE ?? "capture/oracle.json", referenceCode: ref.code ?? ref._meta?.engineVersion ?? "real engine", ...counts, collectorOk: mine.ok, collectorError: mine.error ?? null };
      const tag = (MODE === "simulate" ? "-simulate" : "") + (CONTROL ? `-control-${CONTROL}` : "");
      writeFileSync(resolve(OUT, `compare${tag}.json`), JSON.stringify({ summary: R.compare, diffs }, null, 1));
      console.log("[run] compare", JSON.stringify(R.compare), `collector ${R.timings.collectMs} ms`);
    }
  }
  const keep = Number(val("--keep")) || 0;
  if (keep) await page.waitForTimeout(keep * 60000);
} finally {
  R.runnerEnd = await page.evaluate(() => ({ unknown: window.__runner?.unknown, errors: window.__runner?.errors, writes: window.__runner?.writes?.length })).catch(() => null);
  writeFileSync(resolve(OUT, "run-report.json"), JSON.stringify(R, null, 1));
  await browser.close();
  if (child) child.kill();
}
console.log(`[run] pageErrors ${R.pageErrors.length}, consoleErrors ${R.consoleErrors.length}, unanswered server events ${JSON.stringify(R.runnerEnd?.unknown ?? {})} (${resolve(OUT, "run-report.json").slice(TOOL.length + 1)})`);
