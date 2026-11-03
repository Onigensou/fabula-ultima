// capture — take what the runner needs from a REAL running world, in one client session:
//   1. the server-rendered /game page (script + style tags for every module, inline globals)
//   2. the world data the server sends on connect (game.data) — the runner "server" replays it
//   3. the referee: the skill-regression collector run by the real engine (compute mode)
//
// Usage (from tools/fvtt-playwright so Playwright resolves):
//   node ../snapshot-runner/bin/capture.mjs [--scene "Regression Bench"] [--dummy "Test Target Enemy"] [--no-oracle]
// Read-only on the world: compute mode never writes; the collector only views the scene.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
const OUT = resolve(TOOL, "capture");
mkdirSync(OUT, { recursive: true });

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCENE = arg("--scene", "Regression Bench");
const DUMMY = arg("--dummy", "Test Target Enemy");
const ORACLE = !process.argv.includes("--no-oracle");

const { connect } = await import(pathToFileURL(resolve(DATA, "tools/fvtt-playwright/lib/foundry.js")).href);
const t0 = Date.now();
const fvtt = await connect();
const { page } = fvtt;
console.log(`[capture] connected in ${Date.now() - t0} ms`);
try {
  // 1. the /game page exactly as the server renders it
  const html = await page.evaluate(async () => (await fetch(location.pathname, { credentials: "include" })).text());
  writeFileSync(resolve(OUT, "game.html"), html);

  // 2. world data EXACTLY as the server sent it. game.data is not it: building documents
  //    cleans their source objects in place, which strips non-schema fields such as
  //    package `availability`. So reload once with a tap on the raw socket frame.
  await page.addInitScript(() => {
    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", (e) => {
          if (typeof e.data === "string" && e.data.length > 1e6 && /^43\d*\[\{"userId"/.test(e.data.slice(0, 40)) && !globalThis.__rawWorld) globalThis.__rawWorld = e.data;
        });
      }
    };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.game?.ready === true && !!globalThis.__rawWorld, null, { timeout: 180000 });
  const meta = await page.evaluate(() => {
    globalThis.__cap = __rawWorld.slice(__rawWorld.indexOf("["));
    delete globalThis.__rawWorld;
    return { len: __cap.length, userId: game.userId, world: game.world.id, version: game.modules.get("fabula-ultima-companion")?.version };
  });
  const CH = 16 * 1024 * 1024;
  let s = "";
  for (let i = 0; i < meta.len; i += CH) s += await page.evaluate(([a, b]) => __cap.slice(a, b), [i, i + CH]);
  await page.evaluate(() => { delete globalThis.__cap; });
  const world = JSON.parse(s)[0];      // socket.io ack frame: 43<id>[payload]
  writeFileSync(resolve(OUT, "world-full.json"), JSON.stringify(world));
  console.log(`[capture] world data ${(meta.len / 1048576).toFixed(1)} MB (${meta.world}, user ${meta.userId}, module ${meta.version})`);

  // 3. referee fingerprints from the real engine
  if (ORACLE) {
    const collectSrc = readFileSync(resolve(DATA, "tools/skill-regression/lib/collect.js"), "utf8");
    const skipFile = resolve(DATA, "tools/skill-regression/skip.json");
    const skip = existsSync(skipFile) ? JSON.parse(readFileSync(skipFile, "utf8")).skip ?? [] : [];
    const opts = { sceneName: SCENE, dummy: DUMMY, skip };
    const t1 = Date.now();
    const oracle = await page.evaluate(`(async () => { const OPTS = ${JSON.stringify(opts)};\n${collectSrc}\n})()`);
    oracle.capturedAt = new Date().toISOString();
    writeFileSync(resolve(OUT, "oracle.json"), JSON.stringify(oracle, null, 1));
    console.log(`[capture] oracle: ${oracle.ok ? Object.keys(oracle.skills).length + " skills" : "FAILED " + oracle.error} in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  }
  writeFileSync(resolve(OUT, "capture-meta.json"), JSON.stringify({ ...meta, scene: SCENE, dummy: DUMMY, at: new Date().toISOString() }, null, 2));
} finally {
  await fvtt.close();
}
