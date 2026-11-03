// profile-boot — where does a RUNNER boot spend its time? Same instrumentation as
// tools/staging-world/profile-boot.mjs (phase marks, hook timings, CPU profile split by phase),
// pointed at the runner page. Run from tools/fvtt-playwright:
//   node ../snapshot-runner/bin/profile-boot.mjs <outDir>
import { pathToFileURL, fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
const SCFG = JSON.parse(readFileSync(resolve(TOOL, "runner.config.json"), "utf8"));
const BASE = `http://localhost:${SCFG.port}`;
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const INIT = `(() => {
  try { performance.setResourceTimingBufferSize(20000); } catch {}
  const T = window.__boot = { marks: {}, hooks: {}, handlers: {}, ws: [], wsSend: [], longtasks: [] };
  const mark = (k) => { if (!(k in T.marks)) T.marks[k] = performance.now(); };
  document.addEventListener("DOMContentLoaded", () => mark("DOMContentLoaded"));
  window.addEventListener("load", () => mark("load"));
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) T.longtasks.push([e.startTime, e.duration]); })
        .observe({ type: "longtask", buffered: true }); } catch {}
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(...a) {
      super(...a);
      this.addEventListener("message", (e) => {
        const d = e.data; const n = typeof d === "string" ? d.length : (d.byteLength ?? d.size ?? 0);
        if (n > 20000) T.ws.push({ at: performance.now(), chars: n, head: typeof d === "string" ? d.slice(0, 40) : "bin" });
      });
    }
    send(d) {
      if (typeof d === "string" && d.length < 400) T.wsSend.push({ at: performance.now(), head: d.slice(0, 60) });
      return super.send(d);
    }
  };
  const LIFE = new Set(["init","i18nInit","setup","ready","canvasConfig","canvasInit","canvasReady","renderSidebar","getSceneControlButtons"]);
  const hint = (fn) => { try { return (fn.name || "anon") + " :: " + fn.toString().replace(/\\s+/g, " ").slice(0, 90); } catch { return "?"; } };
  const iv = setInterval(() => {
    if (globalThis.game?.ready) { mark("gameReady"); }
    if (globalThis.canvas?.ready) { mark("canvasReadyFlag"); }
    if (T.marks.gameReady && T.marks.canvasReadyFlag) clearInterval(iv);
    if (T.wrapped || typeof Hooks === "undefined") return;
    T.wrapped = true; mark("HooksDefined");
    const wrap = (orig) => function (hook, ...args) {
      const t0 = performance.now();
      if (LIFE.has(hook)) {
        mark(hook + ":start");
        for (const e of (Hooks.events?.[hook] ?? [])) {
          if (e.__t) continue; e.__t = true;
          const fn = e.fn, label = hint(fn);
          e.fn = function (...a) { const s = performance.now(); try { return fn.apply(this, a); }
            finally { (T.handlers[hook] ??= []).push({ label, ms: +(performance.now() - s).toFixed(1) }); } };
        }
      }
      try { return orig.call(this, hook, ...args); }
      finally { const h = T.hooks[hook] ??= { n: 0, ms: 0 }; h.n++; h.ms += performance.now() - t0; if (LIFE.has(hook)) mark(hook + ":end"); }
    };
    Hooks.callAll = wrap(Hooks.callAll); Hooks.call = wrap(Hooks.call);
  }, 1);
})();`;

function bucketOf(url) {
  if (!url) return "(native/anon)";
  let p; try { p = new URL(url).pathname; } catch { return "other:" + url.slice(0, 40); }
  if (!/^https?:\/\/localhost/.test(url)) return "external";
  let m;
  if ((m = p.match(/^\/modules\/fabula-ultima-companion\/scripts\/([^/]+)(\/)?/))) return "FUC/" + (m[2] ? m[1] + "/" : m[1]);
  if ((m = p.match(/^\/modules\/([^/]+)\//))) return "mod:" + m[1];
  if ((m = p.match(/^\/systems\/([^/]+)\//))) return "sys:" + m[1];
  if (p.startsWith("/scripts/") || p.startsWith("/common/")) return "core" + p.replace(/\?.*/, "").replace(/^\/(scripts|common)/, "");
  if (p.startsWith("/worlds/")) return "world-assets";
  return "other:" + p.split("/").slice(0, 3).join("/");
}
const top = (obj, n = 25) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(0)]);

async function collect(page) {
  return page.evaluate(() => {
    const T = window.__boot;
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    const buckets = {};
    for (const r of res) {
      let b; try {
        const u = new URL(r.name);
        if (u.hostname !== location.hostname) b = "external:" + u.hostname;
        else if (u.pathname.startsWith("/modules/fabula-ultima-companion/")) b = /\.m?js$/.test(u.pathname) ? "FUC js" : "FUC asset";
        else if (u.pathname.startsWith("/modules/")) b = "other modules";
        else if (u.pathname.startsWith("/systems/")) b = "systems";
        else if (u.pathname.startsWith("/scripts/") || u.pathname.startsWith("/common/")) b = "core";
        else if (u.pathname.startsWith("/worlds/")) b = "world assets";
        else b = "other local";
      } catch { b = "?"; }
      const x = buckets[b] ??= { n: 0, kb: 0, first: 1e12, last: 0 };
      x.n++; x.kb += (r.encodedBodySize || 0) / 1024; x.first = Math.min(x.first, r.startTime); x.last = Math.max(x.last, r.responseEnd);
    }
    for (const x of Object.values(buckets)) { x.kb = Math.round(x.kb); x.first = Math.round(x.first); x.last = Math.round(x.last); }
    const lt = T.longtasks;
    const sizes = {};
    for (const k of Object.keys(game.data ?? {})) {
      const v = game.data[k];
      if (Array.isArray(v)) { try { sizes[k] = { n: v.length, mb: +(JSON.stringify(v).length / 1048576).toFixed(2) }; } catch { sizes[k] = { n: v.length, mb: "?" }; } }
    }
    const handlers = {};
    for (const [h, list] of Object.entries(T.handlers)) handlers[h] = { totalMs: Math.round(list.reduce((s, x) => s + x.ms, 0)), n: list.length, top: [...list].sort((a, b) => b.ms - a.ms).slice(0, 12) };
    return {
      timeOrigin: performance.timeOrigin,
      marks: Object.fromEntries(Object.entries(T.marks).map(([k, v]) => [k, Math.round(v)])),
      nav: nav && { responseEnd: Math.round(nav.responseEnd), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) },
      hooksTop: Object.entries(T.hooks).sort((a, b) => b[1].ms - a[1].ms).slice(0, 25).map(([k, v]) => [k, v.n, Math.round(v.ms)]),
      handlers, ws: T.ws.map((w) => ({ ...w, at: Math.round(w.at), kb: Math.round(w.chars / 1024) })), wsSend: T.wsSend.filter((s) => /world|session|scene/i.test(s.head)).map((s) => ({ ...s, at: Math.round(s.at) })),
      longtaskTotalMs: Math.round(lt.reduce((s, [, d]) => s + d, 0)), longtaskCount: lt.length,
      longtasksBig: lt.filter(([, d]) => d > 300).map(([s, d]) => [Math.round(s), Math.round(d)]),
      resources: buckets, resourceCount: res.length,
      scene: canvas?.scene?.name, counts: { actors: game.actors.size, items: game.items.size, scenes: game.scenes.size, journal: game.journal.size, macros: game.macros.size, tables: game.tables.size },
      dataSizes: sizes,
      heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
      activeModules: game.modules.filter((m) => m.active).map((m) => m.id),
    };
  });
}

async function anchor(page) {
  return page.evaluate(() => {
    // Named busy-loop: lets us find this instant in the CPU profile and align clocks.
    const t = performance.now();
    (function __PROFILE_ANCHOR__() { const e = performance.now() + 40; while (performance.now() < e); })();
    return t;
  });
}

function analyzeProfile(profile, anchorPageMs, marks) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let t = profile.startTime; const times = new Array(profile.samples.length);
  for (let i = 0; i < profile.samples.length; i++) { t += profile.timeDeltas[i]; times[i] = t; }
  let anchorProf = null;
  for (let i = 0; i < profile.samples.length; i++) if (byId.get(profile.samples[i])?.callFrame.functionName === "__PROFILE_ANCHOR__") { anchorProf = times[i]; break; }
  const toPage = (us) => anchorProf == null ? null : (us - anchorProf) / 1000 + anchorPageMs;
  // phases on the page clock
  const P = [["0 nav→DOMContentLoaded", 0, marks.DOMContentLoaded], ["1 DCL→init", marks.DOMContentLoaded, marks["init:start"]],
    ["2 init hook", marks["init:start"], marks["init:end"]], ["3 init→setup", marks["init:end"], marks["setup:start"]],
    ["4 setup hook", marks["setup:start"], marks["setup:end"]], ["5 setup→canvasReady", marks["setup:end"], marks["canvasReady:end"]],
    ["6 canvasReady→ready", marks["canvasReady:end"], marks["ready:start"]], ["7 ready hook", marks["ready:start"], marks["ready:end"]],
    ["8 ready→+settle", marks["ready:end"], anchorPageMs]].filter(([, a, b]) => a != null && b != null);
  const overall = {}; const phase = Object.fromEntries(P.map(([k]) => [k, { wallMs: 0, cpu: {} }]));
  for (const [k, a, b] of P) phase[k].wallMs = Math.round(b - a);
  const fnSelf = {}; const fucFile = {};
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]); const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    const fn = n.callFrame.functionName; const url = n.callFrame.url;
    const b = fn.startsWith("(") ? fn : bucketOf(url);
    overall[b] = (overall[b] ?? 0) + dt;
    if (!fn.startsWith("(")) { const key = `${fn || "anon"} ${url.replace(/^.*?\/\/[^/]+/, "")}:${n.callFrame.lineNumber + 1}`; fnSelf[key] = (fnSelf[key] ?? 0) + dt; }
    if (url.includes("/fabula-ultima-companion/")) { const f = url.replace(/^.*\/fabula-ultima-companion\//, "").replace(/\?.*/, ""); fucFile[f] = (fucFile[f] ?? 0) + dt; }
    const pt = toPage(times[i]);
    if (pt != null) for (const [k, a, bb] of P) if (pt >= a && pt < bb) { phase[k].cpu[b] = (phase[k].cpu[b] ?? 0) + dt; break; }
  }
  for (const k of Object.keys(phase)) phase[k].cpu = top(phase[k].cpu, 8);
  return { anchored: anchorProf != null, overall: top(overall, 30), phases: phase, topFunctions: top(fnSelf, 40), topFucFiles: top(fucFile, 30) };
}


const up = async () => { try { return (await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
let child = null;
if (!(await up())) {
  child = spawn(process.execPath, [resolve(HERE, "server.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
}
const { launch, loadConfig } = await import(pathToFileURL(resolve(DATA, "tools/fvtt-playwright/lib/foundry.js")).href);
const { browser, page, client } = await launch({ ...loadConfig(), headless: true, noThrottle: true });
const result = { runs: [] };
try {
  await page.addInitScript(INIT);
  // RUNNER_SETTINGS='{"ns.key": value}' overrides world settings (see fake-io.js)
  if (process.env.RUNNER_SETTINGS) await page.addInitScript((o) => { window.__RUNNER_SETTINGS = o; }, JSON.parse(process.env.RUNNER_SETTINGS));
  const NO_CPU = !!process.env.NO_CPU;
  // run 1 warms the browser's code cache; run 2 is profiled (a reload, like the lab numbers)
  for (const withProfile of [false, true]) {
    if (withProfile && !NO_CPU) {
      await client.send("Profiler.enable");
      await client.send("Profiler.setSamplingInterval", { interval: 1000 });
      await client.send("Profiler.start");
    }
    const t0 = Date.now();
    if (!withProfile) await page.goto(`${BASE}/game`, { waitUntil: "domcontentloaded" });
    else await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => globalThis.game?.ready === true && globalThis.canvas?.ready, null, { timeout: 180000 });
    const readyWall = Date.now() - t0;
    await page.waitForTimeout(5000);
    const anchorMs = await anchor(page);
    const data = await collect(page);
    const run = { withProfile, readyWallMs: readyWall, ...data, runner: await page.evaluate(() => ({ worldLoadedMs: __runner.worldLoadedMs, events: __runner.events })) };
    if (withProfile && !NO_CPU) {
      const { profile } = await client.send("Profiler.stop");
      writeFileSync(resolve(OUT, "boot.cpuprofile"), JSON.stringify(profile));
      run.profile = analyzeProfile(profile, anchorMs, data.marks);
    }
    result.runs.push(run);
    console.log(`[profile] ${withProfile ? "reload (profiled)" : "first load"}: ready in ${readyWall} ms`);
  }
} finally {
  writeFileSync(resolve(OUT, "boot-profile.json"), JSON.stringify(result, null, 2));
  await browser.close();
  if (child) child.kill();
}
