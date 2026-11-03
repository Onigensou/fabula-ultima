// warm — the warm Snapshot Runner: ONE runner page stays open and takes test after test, so a
// test stops paying the ~20 s boot that every run.mjs run pays.
//
//   node ../snapshot-runner/bin/warm.mjs start --snapshot <dir> --port <n> [--profile <p>] [--fast]
//        [--bench [--full]] [--no-auto-sync] [--idle-exit <min>]     (the daemon; leave it running)
//   node ../snapshot-runner/bin/warm.mjs <command> --port <n> [...]  (a request to it)
//
// Commands:
//   status                     what the page holds, and what is pending
//   collect [collector flags]  the skill-regression collector, as run.mjs runs it:
//       --mode compute|simulate --skills "A,B" (names, uuids or "Caster / Skill") --caster <name>
//       --scene <name> --dummy <name> --limit <n> --seed <n> --per-skill-ms <ms> --include-types <csv>
//       --collector-opts <file>   --collect <out.json>   --compare <ref.json>  (only the keys run)
//   eval <file> [--dump <out>]  run a check file in the page (as run.mjs --eval)
//   battle [--dump <out>] [--sim-opts <json>]   checks/sim-battle.js
//   sync      re-read the world from disk and push only the changed documents into the page
//   reset     put the world back to the baseline now (every test does this first anyway)
//   verify    diff EVERY document against the baseline (the reset's own check)
//   reload    reload the page (what a code change does by itself)
//   stop      close the page and the server
//
// What happens before every test (collect / eval / battle):
//   - our module's code changed on disk  -> the page reloads (~20 s; a code change needs a fresh
//     module graph, and only a real navigation gives one)
//   - the world's data changed on disk   -> sync (only the changed documents go in)
//   - then reset: the documents the last test wrote to go back to the baseline (www/warm.js).
//
// The control port is the runner port + 1000. Run from tools/fvtt-playwright, like run.mjs.
import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve, extname } from "node:path";
import { readFileSync, writeFileSync, existsSync, statSync, watch } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { applyCanvasMode } from "./canvas-mode.mjs";
import { applyTimeWarp, skipList, runCollector, buildBench, compareFingerprints } from "../lib/page-tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
const CFG = JSON.parse(readFileSync(resolve(TOOL, "runner.config.json"), "utf8"));
const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); const v = i > 0 ? argv[i + 1] : undefined; return v && !v.startsWith("--") ? v : d; };
const PORT = Number(val("--port", CFG.port));
const CTL = PORT + 1000;

if (cmd === "start") await daemon();
else if (cmd) await client(cmd);
else { console.error("usage: warm.mjs start|status|collect|eval|battle|sync|reset|verify|reload|stop [--port n]"); process.exit(2); }

// ======================================================================= client
async function client(cmd) {
  const body = { cmd };
  if (cmd === "collect") {
    const mode = val("--mode") === "simulate" ? "simulate" : "compute";
    const opts = { mode, skip: skipList(mode), perSkillMs: Number(val("--per-skill-ms", mode === "simulate" ? 30000 : 12000)) };
    if (val("--scene")) opts.sceneName = val("--scene");
    if (val("--dummy")) opts.dummy = val("--dummy");
    if (val("--caster")) opts.onlyCaster = val("--caster");
    if (val("--skills")) opts.onlySkills = val("--skills").split(",").map((s) => s.trim()).filter(Boolean);
    if (val("--limit")) opts.limit = Number(val("--limit"));
    if (val("--seed") !== undefined) opts.seed = Number(val("--seed"));
    if (val("--include-types")) opts.includeTypes = val("--include-types").split(",").map((x) => x.trim()).filter(Boolean);
    if (val("--collector-opts")) Object.assign(opts, JSON.parse(readFileSync(resolve(process.cwd(), val("--collector-opts")), "utf8")));
    // scene / dummy default to the reference's, as in run.mjs
    const refFile = val("--compare");
    const ref = refFile ? JSON.parse(readFileSync(resolve(process.cwd(), refFile), "utf8")) : null;
    const refScene = ref ? (ref.scene ?? ref._meta?.scene) : null;
    if (ref) {
      opts.sceneName ??= refScene; opts.dummy ??= ref.enemyTarget ?? ref._meta?.enemyTarget;
      const refMode = ref.mode ?? ref._meta?.mode ?? "compute";
      if (refMode !== mode) throw new Error(`the reference is a ${refMode} capture and this run is ${mode}: pass --mode ${refMode}`);
    }
    body.opts = opts;
    // a run that covers only part of the reference (a filter, or another scene's roster) is compared on what it ran
    const partial = !!(opts.onlySkills || opts.onlyCaster || opts.limit || (refScene && opts.sceneName !== refScene));
    const t0 = Date.now();
    const r = await call(body);
    if (!r.ok) return fail(r);
    const mine = r.result;
    if (val("--collect")) writeFileSync(resolve(process.cwd(), val("--collect")), JSON.stringify(mine, null, 1));
    const line = { ok: mine.ok, error: mine.error ?? null, mode: mine.mode, count: mine.count, errorCount: mine.errorCount, collectMs: r.ms, requestMs: Date.now() - t0, before: r.before };
    if (ref) {
      const { diffs, ...counts } = compareFingerprints(ref, mine, { only: partial ? new Set(Object.keys(mine.skills ?? {})) : null });
      line.compare = counts;
      for (const d of diffs.slice(0, 8)) console.log("  ≠", d.key, d.only ? `(only in ${d.only})` : d.fields.join(","));
      if (counts.different) process.exitCode = 1;
    } else if (!val("--collect")) for (const [k, fp] of Object.entries(mine.skills ?? {})) console.log(" ", k, JSON.stringify(fp).slice(0, 400));
    console.log("[warm] collect", JSON.stringify(line));
    return;
  }
  if (cmd === "eval" || cmd === "battle") {
    const file = cmd === "battle" ? resolve(TOOL, "checks/sim-battle.js") : resolve(process.cwd(), argv[1] ?? "");
    if (!existsSync(file)) throw new Error(`no check file ${file}`);
    let code = readFileSync(file, "utf8");
    // Always set: the page outlives the request, so a previous battle's options would still be there
    // (a seed-2 control once turned the next default battle into seed 2).
    if (cmd === "battle") code = `globalThis.__SIM_OPTS = ${val("--sim-opts", "undefined")};\n${code}`;
    body.code = code;
    const r = await call(body);
    if (!r.ok) return fail(r);
    const dump = val("--dump");
    if (dump) { writeFileSync(resolve(process.cwd(), dump), JSON.stringify(r.result)); console.log(`[warm] ${cmd} -> ${dump}`); }
    else console.log(JSON.stringify(r.result, null, 1).slice(0, 20000));
    console.log(`[warm] ${cmd} took ${(r.ms / 1000).toFixed(1)} s`, JSON.stringify({ before: r.before }));
    return;
  }
  const r = await call(body);
  if (!r.ok) return fail(r);
  console.log(`[warm] ${cmd}`, JSON.stringify(r.result ?? r, null, 1));
}

async function call(body) {
  let res;
  try {
    res = await fetch(`http://localhost:${CTL}/`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  } catch (e) { return { ok: false, error: `no warm runner on :${CTL} (start one: warm.mjs start --port ${PORT}): ${e.cause?.code ?? e.message}` }; }
  return res.json();
}
function fail(r) { console.error("[warm] ✗", r.error); process.exitCode = 1; }

// ======================================================================= daemon
async function daemon() {
  const SNAPSHOT = val("--snapshot", "snapshot");
  const PROFILE = val("--profile", null);
  const SNAP_DIR = resolve(TOOL, SNAPSHOT);
  const FAST = has("--fast");
  const CANVAS = val("--canvas", "off");
  const WARP = Number(val("--time-warp", FAST ? "20" : "0"));
  const VIEWPORT = val("--viewport", FAST ? "800x450" : null);
  const AUTO_SYNC = !has("--no-auto-sync");
  const IDLE_MIN = Number(val("--idle-exit", "0"));
  const BENCH = has("--bench");
  const MOD_DIR = resolve(DATA, "modules/fabula-ultima-companion");
  const WORLD_DIR = resolve(DATA, "worlds", CFG.sourceWorld ?? "fabula-ultima-2", "data");
  const CODE_EXT = new Set([".js", ".mjs", ".css", ".json", ".hbs", ".html"]);
  const log = (...a) => console.log(`[warm ${new Date().toISOString().slice(11, 19)}]`, ...a);

  if (!existsSync(resolve(SNAP_DIR, "world.json"))) throw new Error(`no snapshot at ${SNAP_DIR}: build-snapshot --snapshot ${SNAPSHOT}${PROFILE ? ` --profile ${PROFILE}` : ""} first`);

  // ---- the control server, up FIRST: one request at a time, in arrival order. It listens before
  // the page even starts and every request waits for the boot, so a caller that finds the daemon
  // starting waits for it instead of starting a second headless client (skill-regression's Stop hook).
  // Between requests the page is QUIET: its PIXI tickers and CSS animations stopped (www/warm.js
  // quiet / wake) and the page frozen (Chrome's page lifecycle: no timers). Idle, an open runner
  // page otherwise burned ~75% of a core (measured 2026-11-03), ~10% quiet: too much for a daemon
  // the Stop hook leaves running. --no-freeze keeps it live.
  const FREEZE = !has("--no-freeze");
  let cdp = null;   // set once the page exists
  const lifecycle = async (state) => {
    if (!FREEZE || !cdp) return;
    try {
      if (state === "frozen") { await page.evaluate(() => window.__warm?.quiet()); await cdp.send("Page.setWebLifecycleState", { state }); }
      else { await cdp.send("Page.setWebLifecycleState", { state }); await page.evaluate(() => window.__warm?.wake()); }
    } catch (e) { log("lifecycle", state, e.message); }
  };
  let openPage;
  let queue = new Promise((r) => { openPage = r; }).then(() => boot()).then(() => lifecycle("frozen")).catch((e) => { log("✗ boot failed:", e.message); setTimeout(shutdown, 50); });
  let lastRequestAt = Date.now();
  const ctl = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastRequestAt = Date.now();
      queue = queue.then(async () => {
        let out;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          const live = body.cmd !== "status" && body.cmd !== "stop";
          if (live) await lifecycle("active");
          try { out = { ok: true, ...(await handle(body)) }; } finally { if (live) await lifecycle("frozen"); }
          if (body.cmd !== "status") log(body.cmd, out.ms != null ? `${out.ms} ms` : "", out.before ? JSON.stringify({ reload: !!out.before.reload, sync: out.before.sync?.docs ?? out.before.sync?.summary ?? null, reset: { roots: out.before.reset.roots, pushed: out.before.reset.pushed, ms: out.before.reset.ms } }) : "");
        } catch (e) { out = { ok: false, error: String(e?.stack ?? e?.message ?? e).split("\n").slice(0, 4).join(" | ") }; log("✗", out.error); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
  });
  ctl.listen(CTL, () => log(`warm runner: page :${PORT}, requests :${CTL} (snapshot ${SNAPSHOT}${PROFILE ? `, profile ${PROFILE}` : ""}${FAST ? ", fast" : ""})`));

  // ---- the runner server (same as run.mjs)
  const status = async () => { try { const r = await fetch(`http://localhost:${PORT}/api/status`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; } };
  if (await status()) throw new Error(`something already serves :${PORT}; pick another --port`);
  const server = spawn(process.execPath, [resolve(HERE, "server.mjs"), "--port", String(PORT), "--snapshot", SNAPSHOT], { stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 120 && !(await status()); i++) await new Promise((r) => setTimeout(r, 250));

  // ---- what changed on disk since the page booted / last synced
  const pending = { code: [], world: false };
  const watchers = [];
  watchers.push(watch(MOD_DIR, { recursive: true }, (_e, f) => { if (f && CODE_EXT.has(extname(String(f)).toLowerCase()) && !String(f).includes("node_modules")) pending.code.push(String(f)); }));
  if (existsSync(WORLD_DIR)) watchers.push(watch(WORLD_DIR, { recursive: true }, () => { pending.world = true; }));
  let lastWorld = JSON.parse(readFileSync(resolve(SNAP_DIR, "world.json"), "utf8"));

  // ---- the page
  const { launch, loadConfig } = await import(pathToFileURL(resolve(DATA, "tools/fvtt-playwright/lib/foundry.js")).href);
  const { browser, page } = await launch({ ...loadConfig(), headless: true });
  const errors = { page: [], console: [] };
  page.on("pageerror", (e) => errors.page.push(String(e.stack ?? e.message).split("\n").slice(0, 4).join(" | ").slice(0, 600)));
  page.on("console", (m) => { if (m.type() === "error") errors.console.push(m.text().slice(0, 300)); });
  const S = { boots: 0, bootId: null, bootMs: null, baseline: null, bench: null, tests: 0, lastBefore: null, startedAt: new Date().toISOString() };

  const codeEdits = () => [...new Set(pending.code)].filter((f) => { try { return statSync(resolve(MOD_DIR, f)).mtimeMs > S.bootStartedAt; } catch { return true; } });   // deleted counts

  async function boot() {
    const t0 = Date.now();
    S.bootStartedAt = t0;
    pending.code = [];
    await page.goto(`http://localhost:${PORT}/game`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120000 });
    await page.waitForFunction(() => globalThis.canvas?.ready === true, null, { timeout: 60000 }).catch(() => {});
    if (VIEWPORT) { const [w, h] = VIEWPORT.split("x").map(Number); await page.setViewportSize({ width: w, height: h }); }
    await applyCanvasMode(page, CANVAS);
    if (WARP > 0) await applyTimeWarp(page, WARP, false);
    await page.addScriptTag({ url: "/runner/warm.js" });
    if (BENCH) {
      const { ok, ...b } = await buildBench(page, has("--full") ? { fullRoster: true } : {});
      if (!ok) throw new Error(`bench build failed: ${b.error}`);
      S.bench = b;
      // the collector views the bench; make it the baseline's scene, so a reset does not flip back
      await page.evaluate((n) => game.scenes.getName(n)?.view(), b.scene);
    }
    S.baseline = await page.evaluate(() => window.__warm.takeBaseline());
    S.boots++; S.bootId = `warm-${Date.now()}`; S.bootMs = Date.now() - t0;
    log(`page ready in ${(S.bootMs / 1000).toFixed(1)} s (boot #${S.boots})`, JSON.stringify(S.baseline));
  }

  async function sync() {
    const t0 = Date.now();
    pending.world = false;
    execFileSync(process.execPath, [resolve(HERE, "build-snapshot.mjs"), "--snapshot", SNAPSHOT, ...(PROFILE ? ["--profile", PROFILE] : [])], { stdio: ["ignore", "ignore", "inherit"] });
    const next = JSON.parse(readFileSync(resolve(SNAP_DIR, "world.json"), "utf8"));
    const changed = {}, removed = {}, other = [];
    let n = 0;
    for (const key of new Set([...Object.keys(lastWorld), ...Object.keys(next)])) {
      const a = lastWorld[key], b = next[key];
      const isColl = Array.isArray(a ?? b) && (a ?? b).every((d) => d && typeof d === "object" && "_id" in d);
      if (!isColl) { if (JSON.stringify(a) !== JSON.stringify(b)) other.push(key); continue; }
      const before = new Map((a ?? []).map((d) => [d._id, JSON.stringify(d)]));
      const after = new Map((b ?? []).map((d) => [d._id, d]));
      for (const [id, d] of after) if (before.get(id) !== JSON.stringify(d)) { (changed[key] ??= []).push(d); n++; }
      for (const id of before.keys()) if (!after.has(id)) { (removed[key] ??= []).push(id); n++; }
    }
    lastWorld = next;
    const readMs = Date.now() - t0;
    // anything outside the document collections (modules, the system, packs) needs a fresh page
    if (other.length) { log(`world changed outside the documents (${other.join(", ")}): reloading`); await boot(); return { reloaded: true, other, readMs }; }
    if (!n) return { docs: 0, readMs };
    const applied = await page.evaluate((w) => window.__warm.applyWorld(w), { changed, removed });
    const summary = Object.fromEntries([...new Set([...Object.keys(changed), ...Object.keys(removed)])].map((k) => [k, { changed: changed[k]?.length ?? 0, removed: removed[k]?.length ?? 0 }]));
    log("synced", JSON.stringify(summary), JSON.stringify(applied));
    return { readMs, summary, ...applied };
  }

  /** Before a test: fresh code, fresh world data, and a world put back to the baseline. */
  async function prepare() {
    const before = {};
    // Windows reports a file the page merely READ as changed, so only a newer mtime counts
    const edited = codeEdits();
    if (edited.length) { before.reload = edited.slice(0, 5); await boot(); }
    else if (AUTO_SYNC && pending.world) before.sync = await sync();
    before.reset = await page.evaluate(() => window.__warm.reset());
    if (before.reset.residue?.length) log("⚠ reset left residue", JSON.stringify(before.reset.residue.slice(0, 8)));
    S.lastBefore = before;
    return before;
  }

  async function handle(body) {
    const t0 = Date.now();
    switch (body.cmd) {
      case "status":
        return { result: { ...S, port: PORT, snapshot: SNAPSHOT, profile: PROFILE, bench: BENCH, frozenWhenIdle: FREEZE, canvas: CANVAS, timeWarp: WARP, fast: FAST, idleExitMin: IDLE_MIN, pending: { code: codeEdits().slice(0, 10), world: pending.world }, errors: { page: errors.page.length, console: errors.console.length, lastPage: errors.page.slice(-3) } } };
      case "collect": {
        const before = await prepare();
        const t1 = Date.now();
        const result = await runCollector(page, { ...body.opts, depsToken: S.bootId });
        S.tests++;
        return { result, before, ms: Date.now() - t1 };
      }
      case "eval": {
        const before = await prepare();
        const t1 = Date.now();
        const result = await page.evaluate(`(async () => { ${body.code}\n})()`).catch((e) => ({ evalError: e.message }));
        S.tests++;
        return { result, before, ms: Date.now() - t1 };
      }
      case "battle": return handle({ ...body, cmd: "eval" });
      case "sync": return { result: await sync(), ms: Date.now() - t0 };
      case "reset": return { result: await page.evaluate(() => window.__warm.reset()), ms: Date.now() - t0 };
      case "verify": return { result: await page.evaluate(() => window.__warm.verify()), ms: Date.now() - t0 };
      case "reload": await boot(); return { result: { bootMs: S.bootMs, boots: S.boots } };
      case "stop": setTimeout(shutdown, 50); return { result: "stopping" };
      default: return { ok: false, error: `unknown command ${body.cmd}` };
    }
  }

  async function shutdown() {
    log("stopping");
    for (const w of watchers) try { w.close(); } catch {}
    try { await browser.close(); } catch {}
    try { server.kill(); } catch {}
    ctl.close();
    process.exit(0);
  }

  cdp = await page.context().newCDPSession(page);
  openPage();   // requests that came in while the page was starting now run, the boot first
  // --idle-exit <min>: a daemon started for someone else (the Stop hook) leaves when nobody uses it
  if (IDLE_MIN > 0) setInterval(() => { if (Date.now() - lastRequestAt > IDLE_MIN * 60000) { log(`idle for ${IDLE_MIN} min: exiting`); shutdown(); } }, 30000).unref();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
