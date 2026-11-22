"use strict";
// Mockup side of a parity check: plays moves on a built page (headless Chromium) and returns, per move,
//   trace   the move's trace at virtual time (+ wall-clock "real"), from a clean run
//   lag     the largest wall-clock lag of that run (ms)
//   repeat  true when a second run gave the identical virtual timeline (the beat clock is deterministic)
//   shots   frames frozen at the given moments (the review kit's pausable clock), PNG files
// and the page's stage geometry (actors, preset) for the game's dry run.
const fs = require("fs");
const path = require("path");
const PW = process.env.PLAYWRIGHT || "C:/Users/Oni/AppData/Local/FoundryVTT/Data/tools/fvtt-playwright/node_modules/playwright";

async function runMockup({ page: pageFile, moves, gpu = true, shotsDir = null, actorKeys = ["keren", "orc"] }) {
  const { chromium } = require(PW);
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--enable-webgl", ...(gpu ? ["--use-angle=d3d11", "--enable-gpu-rasterization"] : ["--use-gl=swiftshader"])] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 300)); });
  await page.goto("file:///" + pageFile.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const out = { engine: await page.evaluate(() => window.__MOVE_ENGINE && window.__MOVE_ENGINE.version), moves: {}, errors };
  if (!out.engine) throw new Error("page has no move-engine: " + errors.join(" | "));
  out.actors = await page.evaluate((keys) => Object.fromEntries(keys.map((k) => { const a = ACT[k]; return [k, { x: a.x, y: a.y, hb: a.hb, wb: a.wb, s: a.s, kind: a.kind }]; })), actorKeys);
  out.preset = await page.evaluate(() => ({ horizon: TG.horizon, strength: TG.strength, refRow: TG.refRow, minScale: TG.minScale, maxScale: TG.maxScale }));

  const start = async (key, tune) => {
    await page.evaluate(([key, tune]) => { const sk = window.__LB.SK[key]; for (const [k, v] of Object.entries(tune || {})) sk.tune.find((x) => x.k === k).v = v;
      window.MOVE_PICK = null; sk.beats.forEach((b, i) => { if (!b.__orig) b.__orig = b.run; b.run = async (C) => { traceEv("beat", { i, name: b.name }); return b.__orig(C); }; });
      window.__LB.pickSkill(key); }, [key, tune]);
    await page.waitForTimeout(500);
    const run0 = await page.evaluate(() => window.__LB.state().RUN);
    await page.evaluate(() => { window.__LB.play(0); });   // not awaited: play() resolves only when the move has ENDED
    await page.waitForFunction((r0) => window.__LB.state().RUN > r0, run0);
  };
  const finish = async () => { await page.waitForFunction(() => { const s = window.__LB.state(); return s.TOTAL != null && s.BEAT === -1; }, null, { timeout: 30000 }).catch(() => {});
    const tr = await page.evaluate(() => window.__MOVE_ENGINE.TRACE.list.slice()); await page.waitForTimeout(900); return tr; };
  const sig = (tr) => tr.filter((e) => e.type !== "rumble").map((e) => e.at + ":" + e.type + ":" + (e.key || e.name || "") + ":" + (e.list ? e.list.join(" ") : "")).join("|");

  for (const m of moves) {
    // 1. a clean run: the trace and the wall-clock lag
    await start(m.key, m.tune); const trace = await finish();
    // 2. the same move again, frozen at each moment for a frame (pausing moves the wall clock, not the virtual one)
    await start(m.key, m.tune);
    const shots = [];
    for (let i = 0; i < (m.shots || []).length; i++) {
      const s = m.shots[i];
      const shownAt = await page.evaluate((at) => new Promise((res) => { const t0 = performance.now();
        const f = () => { const C = window.__MOVE_ENGINE.CLK; if (C.rid === RUN && (VT.now() - C.t0) >= at) { VT.pause(); res(Math.round(VT.now() - C.t0)); }
          else if (performance.now() - t0 > 15000) res(null); else requestAnimationFrame(f); }; f(); }), s.at);
      await page.waitForTimeout(120);
      let file = null;
      if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); file = path.join(shotsDir, m.key + "-" + i + ".png"); await page.locator("#stage").screenshot({ path: file }); }
      shots.push({ i, at: s.at, name: s.name, shownAt, file });
      await page.evaluate(() => VT.resume());
    }
    const trace2 = await finish();
    out.moves[m.key] = { trace, shots, repeat: sig(trace) === sig(trace2),
      lag: Math.max(0, ...trace.map((e) => (e.real != null ? Math.abs(e.real - e.at) : 0))) };
  }
  await browser.close();
  return out;
}
module.exports = { runMockup };
