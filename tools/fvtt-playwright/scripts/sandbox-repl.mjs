// sandbox-repl.mjs — keep a GM (headless) and a player (visible GPU) client joined to a sandbox server, and run
// commands dropped into <dir>/cmd-<n>.json: { who: "gm" | "pl", js: "<async function body>" } or { who, shot: "name" }
// or { quit: true }. Each result lands in <dir>/res-<n>.json. Console lines of interest go to <dir>/console.jsonl.
//   FVTT_BASE_URL=http://localhost:30152 node scripts/sandbox-repl.mjs --dir <dir> [--player Blumairwen]
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, launch, waitReady } from "../lib/foundry.js";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DIR = arg("--dir"); mkdirSync(DIR, { recursive: true });
const PLAYER = arg("--player") ?? "Blumairwen";
const base = loadConfig();
const t0 = Date.now();
const CON = join(DIR, "console.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function joinAs(cfg, label) {
  const { browser, page } = await launch(cfg);
  page.on("console", (m) => { const tx = m.text(); if (m.type() === "error" || /Sonic Blow|Gunblade|Chain 8|Perfect|transform|carrier|Opportunity|applied \d+ dmg|DataMigration|Equipment|turn_end/i.test(tx)) appendFileSync(CON, JSON.stringify({ t: Date.now() - t0, who: label, type: m.type(), text: tx.slice(0, 600) }) + "\n"); });
  page.on("pageerror", (e) => appendFileSync(CON, JSON.stringify({ t: Date.now() - t0, who: label, type: "pageerror", text: String(e.message).slice(0, 600) }) + "\n"));
  await page.goto(cfg.baseURL, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate(() => (document.querySelector('select[name="userid"]') ? "join" : (globalThis.game?.ready ? "game" : "other"))).catch(() => "other");
    if (s === "join") { await page.locator('select[name="userid"]').selectOption({ label: cfg.user }); await page.locator('button[name="join"]').click(); break; }
    if (s === "game") break; await sleep(1000);
  }
  await waitReady(page, cfg);
  return { browser, page };
}
const C = {};
try {
  C.gm = await joinAs({ ...base, headless: true, canvas: "off", gpu: false }, "gm");
  C.pl = await joinAs({ ...base, user: PLAYER, headless: false, gpu: true }, "pl");
  writeFileSync(join(DIR, "ready.json"), JSON.stringify({ t: Date.now() - t0, gmPid: C.gm.browser?.process?.()?.pid ?? null }));
  const done = new Set();
  for (;;) {
    const cmds = readdirSync(DIR).filter((f) => /^cmd-\d+\.json$/.test(f) && !done.has(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    for (const f of cmds) {
      done.add(f);
      const n = f.match(/\d+/)[0];
      let c; try { c = JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch (e) { writeFileSync(join(DIR, `res-${n}.json`), JSON.stringify({ error: "bad json " + e.message })); continue; }
      if (c.quit) { writeFileSync(join(DIR, `res-${n}.json`), JSON.stringify({ ok: true, quit: true })); throw "quit"; }
      const P = C[c.who ?? "gm"].page;
      let res;
      try {
        if (c.shot) { await P.screenshot({ path: join(DIR, c.shot + ".png") }); res = { ok: true, shot: c.shot }; }
        else res = { ok: true, value: await P.evaluate(`(async () => { ${c.js}\n})()`) };
      } catch (e) { res = { ok: false, error: String(e.message).slice(0, 1500) }; }
      writeFileSync(join(DIR, `res-${n}.json`), JSON.stringify({ t: Date.now() - t0, ...res }, null, 1));
    }
    await sleep(250);
  }
} catch (e) { if (e !== "quit") appendFileSync(CON, JSON.stringify({ fatal: String(e.stack ?? e) }) + "\n"); }
finally { try { await C.pl?.browser?.close(); } catch {} try { await C.gm?.browser?.close(); } catch {} }
