// referee-staging — capture the REAL engine's fingerprints for a runner profile, from the Staging World.
//
// The runner is only as trustworthy as its referee. capture/oracle.json is the real engine
// in COMPUTE mode, captured from the live world. For a new kind of test (simulate / RESOLVE)
// the real engine has to answer it once too, and the Staging World is a real Foundry server
// running a disposable copy of the live world (tools/staging-world, :30001): the live world is
// never launched, never written.
//
// It stages the same fight as the runner profile (linked tokens of the named actors on the
// scene; the lab's Training Ground starts empty like the live one) and runs the same collector.
//
//   node ../staging-world/bin/staging-world.mjs stop && node ../staging-world/bin/staging-world.mjs build && node ../staging-world/bin/staging-world.mjs start
//   node ../snapshot-runner/bin/referee-staging.mjs --mode simulate --out ../snapshot-runner/capture/oracle-simulate-duel.json
//   options: --scene "Training Ground"  --dummy "Test Target Enemy"  --actors "Hina,Keren,Blanche,Zarg,Test Target Enemy"
//            --per-skill-ms <ms>  --caster <name>  --limit <n>  --seed <n>
// Run from tools/fvtt-playwright. Lab only: it writes tokens onto the lab's scene.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { applyCanvasMode } from "./canvas-mode.mjs";

process.env.FVTT_STAGING = "1";
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
const val = (k, d) => { const i = process.argv.indexOf(k); const v = i > 0 ? process.argv[i + 1] : undefined; return v && !v.startsWith("--") ? v : d; };
const MODE = val("--mode", "compute") === "simulate" ? "simulate" : "compute";
const OUT = resolve(process.cwd(), val("--out", resolve(TOOL, "capture", `oracle-${MODE}-lab.json`)));
const SCENE = val("--scene", "Training Ground");
const DUMMY = val("--dummy", "Test Target Enemy");
const ACTORS = val("--actors", "Hina,Keren,Blanche,Zarg,Test Target Enemy").split(",").map((s) => s.trim()).filter(Boolean);

const lab = await fetch("http://localhost:30001/api/status", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
if (!lab?.active) throw new Error("the Staging World is not running: node ../staging-world/bin/staging-world.mjs start");
const manifestFile = resolve(DATA, "worlds/staging-world/STAGING-MANIFEST.json");
const labBuiltAt = existsSync(manifestFile) ? statSync(manifestFile).mtime.toISOString() : null;

const collectSrc = readFileSync(resolve(DATA, "tools/skill-regression/lib/collect.js"), "utf8");
const sj = JSON.parse(readFileSync(resolve(DATA, "tools/skill-regression/skip.json"), "utf8"));
const opts = {
  mode: MODE, sceneName: SCENE, dummy: DUMMY,
  skip: [...(sj.skip ?? []), ...(MODE === "simulate" ? sj.skipSimulate ?? [] : [])],
  perSkillMs: Number(val("--per-skill-ms", MODE === "simulate" ? 30000 : 12000)),
};
if (val("--seed") !== undefined) opts.seed = Number(val("--seed"));
if (val("--caster")) opts.onlyCaster = val("--caster");
if (val("--limit")) opts.limit = Number(val("--limit"));

const { connect } = await import(pathToFileURL(resolve(DATA, "tools/fvtt-playwright/lib/foundry.js")).href);
const fvtt = await connect();
// --canvas full|low|off (default off): how much this headless client draws (bin/canvas-mode.mjs)
const canvasMode = await applyCanvasMode(fvtt.page, val("--canvas", "off"));
console.log("[referee-staging] canvas", JSON.stringify(canvasMode));
try {
  // --eval <file>: run a runner check (checks/*.js) in the lab page instead, dumped to --out —
  // the real engine's answer to a test the runner runs with run.mjs --eval.
  if (val("--eval")) {
    const code = readFileSync(resolve(process.cwd(), val("--eval")), "utf8");
    const t0 = Date.now();
    const r = await fvtt.page.evaluate(`(async () => { ${code}\n})()`).catch((e) => ({ evalError: e.message }));
    writeFileSync(OUT, JSON.stringify({ ...r, code: "real engine (Staging World)", labBuiltAt }, null, 1));
    console.log(`[referee-staging] eval ${val("--eval")}: ${Math.round((Date.now() - t0) / 1000)} s -> ${OUT}`);
    process.exitCode = r?.evalError ? 1 : 0;
  } else {
  const staged = await fvtt.page.evaluate(async ({ SCENE, ACTORS }) => {
    const scene = game.scenes.getName(SCENE);
    if (!scene) return { error: `no scene ${SCENE} in the lab` };
    if (scene.getFlag("fabula-ultima-companion", "directorState")) await scene.unsetFlag("fabula-ultima-companion", "directorState");
    const g = scene.grid?.size ?? 100, made = [], missing = [];
    let ally = 0, foe = 0;
    for (const name of ACTORS) {
      const a = game.actors.getName(name);
      if (!a) { missing.push(name); continue; }
      if (scene.tokens.some((t) => t.actorId === a.id)) continue;
      const enemy = (a.prototypeToken?.disposition ?? 0) < 0;
      const td = (await a.getTokenDocument({ x: g * (2 + 2 * (enemy ? foe++ : ally++)), y: g * (enemy ? 6 : 2) })).toObject();
      td.actorLink = true;   // the runner's staged tokens are the bench's linked ones
      made.push(name);
      await scene.createEmbeddedDocuments("Token", [td]);
    }
    return { made, missing, tokens: scene.tokens.map((t) => t.actor?.name) };
  }, { SCENE, ACTORS });
  console.log("[referee-staging] staged", JSON.stringify(staged));
  if (staged.error || staged.missing?.length) throw new Error(staged.error ?? `actors not in the lab: ${staged.missing.join(", ")}`);
  const t0 = Date.now();
  const r = await fvtt.page.evaluate(`(async () => { const OPTS = ${JSON.stringify(opts)};\n${collectSrc}\n})()`);
  if (!r?.ok) throw new Error("collector failed: " + (r?.error ?? JSON.stringify(r)));
  const out = { ...r, code: "real engine (Staging World)", labBuiltAt, capturedAt: new Date().toISOString(), tookMs: Date.now() - t0 };
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`[referee-staging] ${MODE}: ${Object.keys(r.skills).length} skills, ${r.errorCount} errors, engine ${r.engineVersion}, ${Math.round((Date.now() - t0) / 1000)} s -> ${OUT}`);
  }
} finally { await fvtt.close(); }
