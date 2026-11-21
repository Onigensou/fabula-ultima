"use strict";
// Mockup frames for the side-by-sides: plays each move on the rebuilt page (test/assemble-sonic.js) and, at each moment of
// test/shots.json, freezes the page (the review kit's pausable clock) and screenshots the stage.
//   node test/mockup-shots.js [--gpu]   → out/shots/mockup/<move>-<n>.png + out/shots/mockup.json
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Oni/AppData/Local/FoundryVTT/Data/tools/fvtt-playwright/node_modules/playwright");
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, "shots.json"), "utf8"));
const PAGE = path.join(__dirname, "..", "out", "sonic-katar-move-engine.html");
const DIR = path.join(__dirname, "..", "out", "shots", "mockup");
const GPU = process.argv.includes("--gpu");

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--enable-webgl", ...(GPU ? ["--use-angle=d3d11", "--enable-gpu-rasterization"] : ["--use-gl=swiftshader"])] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("file:///" + PAGE.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const out = {};
  for (const [key, m] of Object.entries(SPEC.moves)) {
    await page.evaluate(([key, tune]) => { const sk = window.__LB.SK[key]; for (const [k, v] of Object.entries(tune)) sk.tune.find((x) => x.k === k).v = v; window.__LB.pickSkill(key); }, [key, m.pageTune]);
    await page.waitForTimeout(600);
    const run0 = await page.evaluate(() => window.__LB.state().RUN);
    await page.evaluate(() => { window.__LB.play(0); });   // not awaited: play() resolves when the move has ENDED
    await page.waitForFunction((r0) => window.__LB.state().RUN > r0, run0);
    out[key] = [];
    for (let i = 0; i < m.shots.length; i++) {
      const s = m.shots[i];
      // freeze from inside the page, on the first frame past the moment (a Playwright round trip costs 10-50 ms)
      const vt = await page.evaluate((at) => new Promise((res) => { const t0 = performance.now();
        const f = () => { const C = window.__MOVE_ENGINE.CLK; if (C.rid === RUN && (VT.now() - C.t0) >= at) { VT.pause(); res(Math.round(VT.now() - C.t0)); }
          else if (performance.now() - t0 > 15000) res(null); else requestAnimationFrame(f); }; f(); }), s.at);
      await page.waitForTimeout(120);
      const file = path.join(DIR, key + "-" + i + ".png");
      await page.locator("#stage").screenshot({ path: file });
      out[key].push({ at: s.at, shownAt: vt, name: s.name, file });
      await page.evaluate(() => VT.resume());
    }
    await page.waitForFunction(() => window.__LB.state().BEAT === -1, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
  }
  fs.writeFileSync(path.join(DIR, "..", "mockup.json"), JSON.stringify(out, null, 1));
  for (const [k, v] of Object.entries(out)) console.log(k, v.map((s) => s.at + "→" + s.shownAt).join("  "));
  console.log("errors:", errors.length ? errors.join(" | ") : "none");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
