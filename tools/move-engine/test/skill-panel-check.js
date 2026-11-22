"use strict";
// The page's skill panel (mockup/skill-panel.js): builds a test page, then through the real UI (skill buttons, sliders)
// checks the panel shows the right block per move, follows a slider live, marks the change and offers it for the review.
//   node test/skill-panel-check.js
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Oni/AppData/Local/FoundryVTT/Data/tools/fvtt-playwright/node_modules/playwright");
const OUT = path.join(__dirname, "..", "out", "skill-panel-check.html");
require("../moves/sonic-katar/page.js").build({ out: OUT });
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("file:///" + OUT.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const panel = () => page.evaluate(() => { const s = document.getElementById("me-skill"); return s ? { text: s.textContent, hl: s.querySelectorAll("tr.hl").length, copy: !document.getElementById("me-skill-copy")?.disabled } : null; });
  const pick = (name) => page.evaluate((name) => { const b = [...document.querySelectorAll("#skills button.skill")].find((x) => x.innerText.includes(name)); b.click(); }, name);
  const slide = (k, v) => page.evaluate(([k, v]) => { const el = document.getElementById("tn-" + CUR + "-" + k); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, [k, v]);

  await pick("Sonic Blow"); await page.waitForTimeout(400);
  let p = await panel();
  assert.ok(p, "panel on the page");
  assert.match(p.text, /Sonic Blow/); assert.match(p.text, /props\.cost/); assert.match(p.text, /30 MP/); assert.equal(p.hl, 0); assert.equal(p.copy, false);
  console.log("Sonic Blow, approved:     ok (cost 30 MP, nothing marked)");
  assert.match(p.text, /In the game · 3 real battles/); assert.match(p.text, /81/); assert.doesNotMatch(p.text, /from before your slider change/);
  console.log("Game numbers:             ok (3 battles from the pack, not stale)");

  await slide("mp", 40); await page.waitForTimeout(200);
  p = await panel();
  assert.match(p.text, /40 MP/); assert.equal(p.hl, 1); assert.equal(p.copy, true); assert.match(p.text, /1 field\(s\) changed/);
  assert.match(p.text, /Measured at mp = 30/);
  console.log("MP slider → 40:           ok (row follows live, 1 change marked, Copy enabled)");  console.log("Pack after the change:    ok (flagged as measured at mp = 30)");
  await slide("mp", 30); await page.waitForTimeout(200);
  p = await panel(); assert.equal(p.hl, 0);
  console.log("MP slider back → 30:      ok (mark cleared)");

  await pick("Sword"); await page.waitForTimeout(400);
  p = await panel(); assert.match(p.text, /Gunblade \(Passive\)/); assert.match(p.text, /effects\.gb_fire_plus\.damage_amount/);
  console.log("Gunblade Sword:           ok (Gunblade (Passive) block, fire bonus bound)");

  await pick("Transform"); await page.waitForTimeout(400);
  p = await panel(); assert.match(p.text, /has no skill block/);
  console.log("Transform:                ok (no block → says so)");
  assert.deepEqual(errors, []);
  console.log("page errors: none");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
