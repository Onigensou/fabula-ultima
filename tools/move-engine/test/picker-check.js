"use strict";
// The page's result picker drives the moves: each case sets window.MOVE_PICK, plays a move whose own slider says otherwise,
// and reads the "result" trace event + what the move drew.   node test/picker-check.js [--gpu]
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Oni/AppData/Local/FoundryVTT/Data/tools/fvtt-playwright/node_modules/playwright");
const PAGE = path.join(__dirname, "..", "out", "sonic-katar-move-engine.html");
const GPU = process.argv.includes("--gpu");
const CASES = [
  ["gb_sword", { roll: 2 }, { check: "odd", chain: null }, "odd total → fires (slider says even)"],
  ["gb_sword", { roll: 1 }, { check: "even", chain: null }, "even total → physical (slider says odd)"],
  ["gb_sword", { roll: 1 }, { check: "crit", chain: null }, "crit → fires"],
  ["gb_sword", { roll: 1 }, { check: "fumble", chain: null }, "fumble → miss"],
  ["gb_sword", { roll: 2 }, { check: null, chain: null }, "picker off → the move's slider (even → physical)"],
  ["sonicblow", { result: 1 }, { check: null, chain: 0.5 }, "half land → no Perfect (slider says 8/8)"],
  ["sonicblow", { result: 5 }, { check: null, chain: "all" }, "all land → Perfect (slider says 0/8)"],
];
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--enable-webgl", ...(GPU ? ["--use-angle=d3d11"] : ["--use-gl=swiftshader"])] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("file:///" + PAGE.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.waitForTimeout(2500);
  console.log("picker on page:", await page.evaluate(() => !!document.getElementById("me-pick")));
  for (const [key, tune, pick, label] of CASES) {
    const r = await page.evaluate(async ([key, tune, pick]) => {
      const LB = window.__LB, sk = LB.SK[key]; for (const [k, v] of Object.entries(tune)) sk.tune.find((x) => x.k === k).v = v;
      window.MOVE_PICK = pick; LB.pickSkill(key); await new Promise((r) => setTimeout(r, 300)); const run0 = LB.state().RUN; LB.play(0);
      const t0 = Date.now(); while (Date.now() - t0 < 20000) { const st = LB.state(); if (st.RUN > run0 && st.TOTAL != null && st.BEAT === -1) break; await new Promise((r) => setTimeout(r, 30)); }
      const tr = window.__MOVE_ENGINE.TRACE.list;
      const res = tr.find((e) => e.type === "result");
      return { result: res && res.list.join(" "), fire: tr.some((e) => e.key === "008_slash_fire"), phys: tr.some((e) => e.key === "006_slash_physical"),
        perfect: tr.some((e) => e.type === "clip" && e.key === "ro_sonicblow" && e.filter), misses: tr.filter((e) => e.type === "sfx" && e.key === "ro_hitdagger").length };
    }, [key, tune, pick]);
    console.log(label.padEnd(48), JSON.stringify(r));
  }
  console.log("errors:", errors.length ? errors.join(" | ") : "none");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
