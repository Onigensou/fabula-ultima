// sandbox-boot-log.mjs — boot a sandbox Foundry (its own dataPath / port) as the GM and keep the WHOLE boot console.
// The console listener is attached before the page navigates, so the GM-boot data migrations' lines are all kept
// (the module's in-page console tap only keeps 500). Then optionally runs an eval file and keeps the page open
// for --hold seconds (a player client can join meanwhile).
//
//   FVTT_BASE_URL=http://localhost:30152 FVTT_DATA_PATH=<sandbox> FVTT_HEADLESS=true \
//     node scripts/sandbox-boot-log.mjs --out <log.json> [--eval <file>] [--hold <s>]
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, launch, waitReady } from "../lib/foundry.js";
import { ensureServerUp } from "../lib/server.js";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out") ?? "sandbox-boot.json";
const cfg = loadConfig();
const t0 = Date.now();
const lines = [];
const R = { baseURL: cfg.baseURL, dataPath: cfg.dataPath, lines, pageErrors: [] };
try {
  const up = await ensureServerUp(cfg);
  R.server = { started: up.started, pid: up.pid ?? null };
  const { browser, page } = await launch(cfg);
  R.browserPid = browser?.process?.()?.pid ?? null;
  page.on("console", (m) => lines.push({ t: Date.now() - t0, type: m.type(), text: m.text().slice(0, 2000) }));
  page.on("pageerror", (e) => R.pageErrors.push(String(e.stack ?? e.message).slice(0, 1200)));
  await page.goto(cfg.baseURL, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 40; i++) {
    const screen = await page.evaluate(() => (document.querySelector('select[name="userid"]') ? "join" : (globalThis.game?.ready ? "game" : (document.querySelector("li.package") ? "setup" : "other"))));
    if (screen === "join") {
      await page.locator('select[name="userid"]').selectOption({ label: cfg.user });
      if (cfg.password) await page.locator('input[name="password"]').fill(cfg.password);
      await page.locator('button[name="join"]').click();
      break;
    }
    if (screen === "game") break;
    await page.waitForTimeout(1000);
  }
  await waitReady(page, cfg);
  R.readyMs = Date.now() - t0;
  // let the GM-boot migrations finish (the runner writes its ledger when done)
  R.ledger = await page.evaluate(async () => {
    const ns = "fabula-ultima-companion";
    for (let i = 0; i < 240; i++) {
      try { const l = game.settings.get(ns, "appliedMigrations"); const o = typeof l === "string" ? JSON.parse(l) : l; const keys = Array.isArray(o) ? o.map((x) => x?.key ?? x) : Object.keys(o ?? {});
        if (keys.includes("2026-11-21-sonic-gunblade")) return { n: keys.length, has: true, entry: Array.isArray(o) ? o.find((x) => (x?.key ?? x) === "2026-11-21-sonic-gunblade") : o["2026-11-21-sonic-gunblade"] }; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return { has: false };
  });
  const ev = arg("--eval");
  if (ev) R.eval = await page.evaluate(`(async () => { ${readFileSync(resolve(ev), "utf8")}\n})()`).catch((e) => ({ evalError: e.message }));
  const hold = Number(arg("--hold") ?? 0);
  if (hold > 0) { R.heldS = hold; await page.waitForTimeout(hold * 1000); }
  await browser.close();
} catch (e) { R.error = String(e.stack ?? e.message); }
R.totalMs = Date.now() - t0;
writeFileSync(OUT, JSON.stringify(R, null, 1));
console.log(`[sandbox-boot] ready ${R.readyMs} ms, ${lines.length} console lines, ledger ${JSON.stringify(R.ledger)}, error ${R.error ?? "none"} -> ${OUT}`);
