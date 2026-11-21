"use strict";
// Beat-clock check on the approved Sonic Katar page, rebuilt on the move-engine package.
//   node test/assemble-sonic.js && node test/mockup-clock.js [page.html] [--runs 3] [--json out.json]
// Plays Sonic Blow (forced 8/8 Perfect) and Gunblade Sword (forced odd = fires) headless and reports, per run:
//   - the trace at VIRTUAL time (must be identical run to run: the beat clock), with the wall-clock drift beside it;
//   - against the approved page's measured timeline (spec/sonic-blow-mockup-timeline.json, old engine, wall clock).
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Oni/AppData/Local/FoundryVTT/Data/tools/fvtt-playwright/node_modules/playwright");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PAGE = args[0] && !args[0].startsWith("--") ? args[0] : path.join(__dirname, "..", "out", "sonic-katar-move-engine.html");
const RUNS = +opt("--runs", 3);
const SPEC = opt("--spec", "C:/Users/Oni/AppData/Local/FoundryVTT/worktrees/sonic-gunblade/spec/sonic-blow-mockup-timeline.json");

(async () => {
  // --gpu: the real GPU (ANGLE / D3D11), like a player's browser; default = SwiftShader (software, slow: wall-clock lag is the renderer)
  const GPU = args.includes("--gpu");
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--enable-webgl", ...(GPU ? ["--use-angle=d3d11", "--enable-gpu-rasterization"] : ["--use-gl=swiftshader"])] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 300)); });
  await page.goto("file:///" + PAGE.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const ver = await page.evaluate(() => window.__MOVE_ENGINE && window.__MOVE_ENGINE.version);
  if (!ver) throw new Error("page has no move-engine (window.__MOVE_ENGINE); page errors: " + errors.join(" | "));

  const play = async (key, tune) => page.evaluate(async ([key, tune]) => {
    const LB = window.__LB, sk = LB.SK[key];
    for (const [k, v] of Object.entries(tune)) sk.tune.find((x) => x.k === k).v = v;
    // beat markers into the trace (the page UI does not log them itself)
    sk.beats.forEach((b, i) => { if (!b.__orig) b.__orig = b.run; b.run = async (C) => { traceEv("beat", { i, name: b.name }); return b.__orig(C); }; });
    LB.pickSkill(key); const run0 = LB.state().RUN; LB.play(0);
    const t0 = Date.now(); while (Date.now() - t0 < 20000) { const st = LB.state(); if (st.RUN > run0 && st.TOTAL != null && st.BEAT === -1) break; await new Promise((r) => setTimeout(r, 20)); }
    return { trace: window.__MOVE_ENGINE.TRACE.list.slice(), state: LB.state() };
  }, [key, tune]);

  const out = { engine: ver, page: PAGE, runs: {} };
  for (const [key, tune] of [["sonicblow", { result: 1 }], ["gb_sword", { roll: 1 }]]) {
    const runs = [];
    for (let r = 0; r < RUNS; r++) runs.push(await play(key, tune));
    out.runs[key] = runs.map((x) => x.trace);
    const sig = (tr) => tr.map((e) => e.at + ":" + e.type + ":" + (e.key || e.name || "")).join("|");
    const same = runs.every((x) => sig(x.trace) === sig(runs[0].trace));
    const drift = runs.map((x) => Math.max(...x.trace.map((e) => Math.abs((e.real ?? e.at) - e.at))));
    console.log("\n== " + key + " · " + runs[0].trace.length + " events · virtual timeline identical across " + RUNS + " runs: " + (same ? "YES" : "NO") +
      " · max wall-clock lag per run (ms): " + drift.map((d) => d.toFixed(1)).join(", "));
    for (const e of runs[0].trace) if (["beat", "sfx", "gate", "clip"].includes(e.type))
      console.log("  " + String(e.at).padStart(7) + "  real " + String(e.real ?? "").padStart(7) + "  " + e.type.padEnd(5) + " " + (e.name || e.key || "") + (e.vol != null ? " @" + e.vol : "") + (e.scale != null ? " ×" + e.scale : ""));
  }

  // against the approved page (old engine, measured on the wall clock)
  if (fs.existsSync(SPEC)) {
    const spec = JSON.parse(fs.readFileSync(SPEC, "utf8")).summary["sonicblow-8of8"];
    const tr = out.runs.sonicblow[0];
    const b0 = tr.find((e) => e.type === "beat" && e.i === 0).at;
    const rows = [];
    spec.beats.forEach((b) => { const m = tr.find((e) => e.type === "beat" && e.i === b.i); rows.push(["beat " + b.i + " " + b.name, b.startMs, m ? m.at - b0 : null]); });
    const ss = spec.sfx.map((l) => { const m = l.match(/^([\d.]+) (\S+) @([\d.]+)/); return m && { at: +m[1], key: m[2], vol: +m[3] }; }).filter(Boolean);
    const ts = tr.filter((e) => e.type === "sfx");
    ss.forEach((s, i) => { const m = ts[i]; rows.push(["sfx " + s.key + (m && m.key !== s.key ? " (game: " + m.key + ")" : ""), s.at, m ? m.at - b0 : null]); });
    console.log("\n== Sonic Blow 8/8 vs the approved page (old engine, wall clock)   approved ms → beat-clock ms   (Δ)");
    for (const [n, a, b] of rows) console.log("  " + n.padEnd(40) + String(a).padStart(8) + " → " + String(b == null ? "—" : b.toFixed(1)).padStart(8) + "   (" + (b == null ? "?" : (b - a >= 0 ? "+" : "") + (b - a).toFixed(1)) + ")");
    out.vsApproved = rows;
  }
  const J = opt("--json", null); if (J) fs.writeFileSync(J, JSON.stringify(out, null, 1));
  console.log("\nerrors:", errors.length ? errors.join("\n") : "none");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
