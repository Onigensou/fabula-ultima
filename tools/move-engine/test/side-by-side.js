"use strict";
// Side-by-sides: the mockup frame (test/mockup-shots.js) next to the game frame (test/game-play.js --shots, play.json) for
// every moment of test/shots.json.  → out/shots/side-by-side/<move>-<n>.png + one contact sheet (all.png)
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Oni/AppData/Local/FoundryVTT/Data/tools/fvtt-playwright/node_modules/playwright");
const OUT = path.join(__dirname, "..", "out", "shots");
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, "shots.json"), "utf8")).moves;
const MOCK = JSON.parse(fs.readFileSync(path.join(OUT, "mockup.json"), "utf8"));
const PLAY = JSON.parse(fs.readFileSync(path.join(OUT, "..", "play.json"), "utf8"));
const SBS = path.join(OUT, "side-by-side"); fs.mkdirSync(SBS, { recursive: true });
const uri = (f) => "data:image/png;base64," + fs.readFileSync(f).toString("base64");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1840, height: 520 } });
  const rows = [];
  for (const [key, m] of Object.entries(SPEC)) {
    const g = (PLAY.moves[key] || {}).shots || [];
    m.shots.forEach((s, i) => {
      const mk = (MOCK[key] || [])[i], gm = g.find((x) => x.i === i);
      if (!mk || !gm || !gm.data) { console.log("missing", key, i); return; }
      rows.push({ key, i, label: m.label, name: s.name, at: s.at, mAt: mk.shownAt, gAt: gm.shownAt, mImg: uri(mk.file), gImg: gm.data });
    });
  }
  const cell = (r) => `<div class="row"><div class="cap"><b>${r.label}</b> · ${r.name} · planned ${r.at} ms</div>
    <div class="pair"><figure><img src="${r.mImg}"><figcaption>MOCKUP (approved page, repo move files) · frame at ${r.mAt} ms</figcaption></figure>
    <figure><img src="${r.gImg}"><figcaption>GAME (Valley_Battlemap001, 3D live board) · frame at ${r.gAt} ms</figcaption></figure></div></div>`;
  const css = `body{margin:0;background:#15131a;color:#e8e4f0;font:13px Segoe UI,Arial,sans-serif} .row{padding:8px 10px} .cap{margin:0 0 6px} .pair{display:flex;gap:10px}
    figure{margin:0;flex:1} img{width:100%;display:block;border:1px solid #3a3446} figcaption{color:#a59fb4;font-size:12px;margin-top:3px}`;
  for (const r of rows) {
    await page.setContent(`<style>${css}</style>${cell(r)}`);
    await page.waitForTimeout(150);
    const h = await page.evaluate(() => document.body.scrollHeight); await page.setViewportSize({ width: 1840, height: h });
    await page.screenshot({ path: path.join(SBS, r.key + "-" + r.i + ".png") });
  }
  await page.setViewportSize({ width: 1840, height: 520 });
  await page.setContent(`<style>${css}</style>${rows.map(cell).join("")}`); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SBS, "all.png"), fullPage: true });
  console.log(rows.length, "side-by-sides →", SBS);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
