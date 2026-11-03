#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// skill-regression — batch behavioral-regression harness for director skills.
//
// Drives the in-world director test harness over the whole roster of skills,
// captures a deterministic per-skill fingerprint (hit/miss, damage, affinity,
// heal amounts, roll, and — in simulate mode — writes + card HTML), and diffs
// it against a committed golden. Lets you refactor the engine and instantly see
// which skills changed behavior instead of eyeballing one skill at a time.
//
// Game must be OPEN (drives the test-bridge). COMPUTE mode is read-only and safe
// mid-session; SIMULATE mode is gated (see README).
//
//   node bin/skill-regression.js capture            # write goldens from current behavior
//   node bin/skill-regression.js check              # diff current vs goldens; exit 1 on change
//   node bin/skill-regression.js check --update     # accept current as the new goldens
//
// Options: --mode compute|simulate  --caster <ActorName>  --limit <N>
//          --scene <SceneName>  --goldens <path>  --json
// ───────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { evalGM, bridgeAlive } = require("../lib/bridge");
const { recordVerified } = require("../lib/engine-fingerprint");
// Sampled at process start, BEFORE anything runs, so an actor write that lands
// mid-run still reads as "changed" on the next gate evaluation.
const { dataWitness } = require("../lib/data-witness");
const { collectStructure } = require("../lib/collect-structure");
const { diffStructure } = require("../lib/structure-fingerprint");
const { runCensus } = require("../lib/census");
const { runFormulaAudit, selfTest: formulaSelfTest } = require("../lib/formula-audit");
const { checkPayloadParity, auditTriggerCoverage } = require("../lib/payload-parity");
const DATA_KEY = dataWitness().key;

const ROOT = path.resolve(__dirname, "..");
const COLLECT_SRC = fs.readFileSync(path.join(ROOT, "lib", "collect.js"), "utf8");
const BENCH_SRC = fs.readFileSync(path.join(ROOT, "lib", "build-bench.js"), "utf8");
const VERIFY_SRC = fs.readFileSync(path.join(ROOT, "lib", "verify.js"), "utf8");
const TEARDOWN_SRC = fs.readFileSync(path.join(ROOT, "lib", "teardown-bench.js"), "utf8");
const PLACE_FIXTURES_SRC = fs.readFileSync(path.join(ROOT, "lib", "place-fixtures.js"), "utf8");
const REMOVE_FIXTURES_SRC = fs.readFileSync(path.join(ROOT, "lib", "remove-fixtures.js"), "utf8");

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--update") a.update = true;
    else if (t === "--json") a.json = true;
    else if (t === "--no-skip") a["no-skip"] = true;
    else if (t === "--teardown") a.teardown = true;
    // Registered explicitly, not left to the generic fallback below: `--full`
    // followed by a non-flag value (e.g. a bare scene name) would otherwise
    // swallow it as this flag's value and silently drop the roster expansion.
    else if (t === "--full") a.full = true;
    else if (t === "--no-deps-reuse") a["no-deps-reuse"] = true;
    // Generic boolean fallback. Without it an unregistered flag swallows the
    // NEXT argument as its value — which is how a `--no-deps-reuse --goldens
    // <path>` run silently ate the --goldens and wrote a simulate capture over
    // the compute golden. A flag followed by another flag, or by nothing, is a
    // boolean whatever the list above says.
    else if (t.startsWith("--") && (i + 1 >= argv.length || String(argv[i + 1]).startsWith("--"))) a[t.slice(2)] = true;
    else if (t.startsWith("--")) a[t.slice(2)] = argv[++i];
    else a._.push(t);
  }
  return a;
}

function optsFrom(a) {
  const o = {};
  if (a.mode) o.mode = a.mode;
  if (a.caster) o.onlyCaster = a.caster;
  if (a.limit) o.limit = Number(a.limit);
  if (a.scene) o.sceneName = a.scene;
  if (a.dummy) o.dummy = a.dummy;
  // Which skill_types to collect. The default (Active/Spell) is the fast
  // everyday tripwire; the `wide` profile adds Attack/Item to reach monster
  // attacks and consumables. Passive/blank are deliberately NOT collectable —
  // they have no activation, so COMPUTE would only ever record ok:false, which
  // is noise rather than coverage. Their config is protected by `structure`
  // (1212 docs) and their behavior by the equip witness.
  if (a["include-types"]) o.includeTypes = String(a["include-types"]).split(",").map((s) => s.trim()).filter(Boolean);
  if (a.forceSimulate) o.forceSimulate = true;
  // pin Math.random per skill (collect.js seedRandom): random pools the forced dice do not cover
  if (a.seed !== undefined) o.seed = Number(a.seed);
  if (a["no-deps-reuse"]) o.noDepsReuse = true;
  // Per-skill guard (collect.js, default 12000). Simulate re-imports the ~660 KB
  // skill-effects.js several times per skill (engine `?cb=` imports), which costs
  // ~2.3 s each headless — as that file grew, 49 healthy skills crossed 12 s and
  // recorded as "timeout" (measured 2026-09-27: Hina / Iceberg completes ok in
  // 17.8 s with no dialog open). Raise it for simulate; pages shrink to match.
  if (a["per-skill-ms"]) o.perSkillMs = Number(a["per-skill-ms"]);
  if (a["page-size"]) o.pageSizeOverride = Number(a["page-size"]);
  // Auto-load the committed skip list (interactive skills that only ever
  // time out at COMPUTE) so capture + check stay fast AND identical. --no-skip
  // disables it (e.g. to re-measure which skills still time out).
  if (!a["no-skip"]) {
    const skipFile = path.join(ROOT, "skip.json");
    if (fs.existsSync(skipFile)) {
      try {
        const sj = JSON.parse(fs.readFileSync(skipFile, "utf8"));
        o.skip = sj.skip || [];
        // RESOLVE-only human gates: skipped in simulate, still fingerprinted in compute.
        if ((a.mode || "compute") === "simulate") o.skip = [...o.skip, ...(sj.skipSimulate || [])];
      } catch { /* ignore malformed */ }
    }
  }
  return o;
}

// Auto-paged collect: each page is one evalGM under the bridge's 5-min cap; we
// walk offset → nextOffset until the collector says hasMore:false, merging the
// per-skill fingerprint maps. A single page (pageSize skills) is sized to finish
// comfortably inside the server timeout.
async function collect(opts, { pageSize, onProgress } = {}) {
  // A page is one evalGM under the bridge's 285 s cap. At the default 12 s guard
  // 30 skills fit; a longer guard needs a smaller page, or one slow page can
  // blow the bridge cap and lose the whole page.
  pageSize ??= opts.pageSizeOverride
    || ((opts.perSkillMs ?? 12000) > 12000 ? Math.max(5, Math.floor(240000 / opts.perSkillMs)) : 30);
  if (!bridgeAlive()) {
    throw new Error("test-bridge is not alive (game closed, or heartbeat stale). Open the Foundry world first.");
  }
  const merged = { skills: {}, errors: [], count: 0, slowest: [] };
  let offset = 0;
  let head = null;
  for (;;) {
    const pageOpts = { ...opts, offset, pageSize };
    const code = `const OPTS = ${JSON.stringify(pageOpts)};\n${COLLECT_SRC}`;
    const page = await evalGM(code, { timeoutSecs: 285 });
    if (!page || page.ok !== true) {
      throw new Error("collector failed: " + (page?.error || JSON.stringify(page)));
    }
    if (!head) head = page; // keep first page's provenance header
    Object.assign(merged.skills, page.skills);
    merged.errors.push(...(page.errors || []));
    merged.count += page.count;
    merged.slowest.push(...(page.slowest || []));
    if (onProgress) onProgress({ done: page.nextOffset, total: page.total, pageMs: page.tookMs });
    if (!page.hasMore || page.count === 0) break;
    offset = page.nextOffset;
  }
  // A fingerprint map is only a tripwire if every task it ran is IN it. `count`
  // sums tasks processed, so count > keys means two tasks produced the same key
  // and one overwrote the other — silent lost coverage, and the survivor depends
  // on iteration order. This shipped once (780 keys under a 783 header) because
  // nothing compared the two. Fail loudly instead of writing a short golden.
  const keyCount = Object.keys(merged.skills).length;
  if (keyCount !== merged.count) {
    throw new Error(
      `collector key collision: ran ${merged.count} task(s) but produced ${keyCount} key(s) — ` +
      `${merged.count - keyCount} fingerprint(s) were overwritten. The disambiguation suffix is ` +
      `not unique for some (caster, skill) pair; do NOT trust or write this golden.`);
  }
  merged.slowest.sort((a, b) => b.ms - a.ms);
  return {
    ok: true, mode: head.mode, scene: head.scene, casters: head.casters,
    enemyTarget: head.enemyTarget, total: head.total, count: merged.count,
    errorCount: merged.errors.length, engineVersion: head.engineVersion,
    override: head.override, force: head.force, tookMs: 0,
    slowest: merged.slowest.slice(0, 8), errors: merged.errors, skills: merged.skills,
  };
}

// ── --runner: the same collector, game CLOSED ──────────────────────────────
// tools/snapshot-runner runs the real Foundry client + CSB + our module with the
// server faked and the world read from the LevelDB on disk (a temp copy — the
// world's files are never opened). The bench is built IN that page with this
// tool's own build-bench.js, exactly as the live gate builds it, so a bench torn
// down on disk does not matter. Referee: 487/487 identical to the real engine's
// capture AND to goldens/skills.json (2026-11-03), ~45 s for the whole catalog.
// It has its own snapshot dir + port, so a session using the runner by hand is
// never disturbed. Nothing it does reaches the world.
const RUNNER = path.resolve(ROOT, "..", "snapshot-runner");
const PLAYWRIGHT = path.resolve(ROOT, "..", "fvtt-playwright");
const RUNNER_SNAP = "snap-regression";
const RUNNER_PORT = Number(process.env.SKILL_REGRESSION_RUNNER_PORT || 30103);
function runnerAvailable() {
  return fs.existsSync(path.join(RUNNER, "bin", "run.mjs")) && fs.existsSync(path.join(RUNNER, "runner.regression.json"))
    && fs.existsSync(path.join(PLAYWRIGHT, "node_modules"))
    && (!!process.env.FVTT_APP || fs.existsSync(path.join(PLAYWRIGHT, "config.local.json")));
}
// ── the WARM runner (snapshot-runner/bin/warm.mjs): one page that stays open ──
// A cold run boots a fresh page and builds the bench every time (~40 s). The warm
// runner keeps both, resets the world between checks, re-reads world data that
// changed on disk and reloads the page itself when module code changed, so a check
// costs ~1 s, or ~5 s / ~30 s after a data / code edit. The first cold run starts one
// in the background (it leaves after WARM_IDLE_MIN unused minutes); later checks use
// it. It runs WITHOUT time warp: the collector's per-skill guard is a timer, and a
// warped 12 s guard (0.6 s) could time a slow skill out and report false drift.
// SKILL_REGRESSION_WARM=0 turns it off (every check is a cold run again).
const WARM_CTL = RUNNER_PORT + 1000;
const WARM_IDLE_MIN = Number(process.env.SKILL_REGRESSION_WARM_IDLE_MIN || 30);
const warmEnabled = () => process.env.SKILL_REGRESSION_WARM !== "0";
async function warmCall(body, timeoutMs) {
  const r = await fetch(`http://localhost:${WARM_CTL}/`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  return r.json();
}
// Status waits for a daemon that is still booting (its first request waits for the boot).
async function warmStatus() { try { const r = await warmCall({ cmd: "status" }, 90 * 1000); return r.ok ? r.result : null; } catch { return null; } }
function startWarm() {
  const { spawn } = require("child_process");
  const log = fs.openSync(path.join(ROOT, ".state", "warm-runner.log"), "a");
  const child = spawn(process.execPath, [path.join(RUNNER, "bin", "warm.mjs"), "start", "--snapshot", RUNNER_SNAP, "--port", String(RUNNER_PORT),
    "--profile", "regression", "--bench", "--canvas", "off", "--viewport", "800x450", "--idle-exit", String(WARM_IDLE_MIN)],
  { cwd: PLAYWRIGHT, detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  return child.pid;
}
const shapeResult = (r) => ({
  ok: true, mode: r.mode, scene: r.scene, casters: r.casters, enemyTarget: r.enemyTarget, total: r.total, count: r.count,
  errorCount: r.errorCount, engineVersion: r.engineVersion, override: r.override, force: r.force, tookMs: 0,
  slowest: (r.slowest || []).slice(0, 8), errors: r.errors || [], skills: r.skills, engine: "runner",
});
function checkKeys(r) {
  const keyCount = Object.keys(r.skills || {}).length;
  if (keyCount !== r.count) throw new Error(`collector key collision: ran ${r.count} task(s) but produced ${keyCount} key(s); do NOT trust this run`);
}

async function collectRunner(opts, { full = false, say = (s) => process.stderr.write(s + "\n") } = {}) {
  const { spawnSync } = require("child_process");
  if (!runnerAvailable()) throw new Error(`snapshot-runner not found at ${RUNNER} (or not set up: see its README, "Setup on a new machine")`);
  const { pageSizeOverride: _p, ...copts0 } = opts;
  // The opts a cold run.mjs --collector-opts run ends up with: its own defaults (the reference
  // capture's scene + dummy, the skip list, the per-skill guard) with ours laid over them.
  const mode = copts0.mode === "simulate" ? "simulate" : "compute";
  let ref = {}; try { ref = JSON.parse(fs.readFileSync(path.join(RUNNER, "capture", "oracle.json"), "utf8")); } catch {}
  let sj = {}; try { sj = JSON.parse(fs.readFileSync(path.join(ROOT, "skip.json"), "utf8")); } catch {}
  const wopts = {
    mode, sceneName: ref.scene ?? ref._meta?.scene, dummy: ref.enemyTarget ?? ref._meta?.enemyTarget,
    skip: [...(sj.skip ?? []), ...(mode === "simulate" ? sj.skipSimulate ?? [] : [])], perSkillMs: mode === "simulate" ? 30000 : 12000,
    ...copts0,
  };
  let st = null;
  if (!full && warmEnabled()) {
    st = await warmStatus();
    if (st && st.profile === "regression" && st.bench && !st.timeWarp) {
      const t0 = Date.now();
      let r = null;
      try { r = await warmCall({ cmd: "collect", opts: wopts }, 15 * 60 * 1000); } catch (e) { r = { ok: false, error: e.message }; }
      if (r.ok && r.result?.ok === true) {
        checkKeys(r.result);
        const b = r.before ?? {};
        const why = b.reload ? `reloaded for code edits (${b.reload.slice(0, 2).join(", ")})` : b.sync ? `pushed ${b.sync.docs ?? 0} changed world document(s)` : "no reload needed";
        say(`· runner (warm): game closed, so the check ran on the warm Snapshot Runner, ${((Date.now() - t0) / 1000).toFixed(1)} s; ${why}`);
        return shapeResult(r.result);
      }
      say(`· runner (warm) failed (${r.error ?? r.result?.error ?? "no result"}); falling back to a cold run`);
    } else if (st) say(`· a warm runner is up on :${WARM_CTL} but not a regression bench one (${st.profile}${st.bench ? "" : ", no bench"}${st.timeWarp ? ", time-warped" : ""}); cold run`);
  }
  const state = path.join(ROOT, ".state");
  fs.mkdirSync(state, { recursive: true });
  // One runner regression run at a time: two sessions' Stop hooks can fire together,
  // and the port + snapshot dir are shared by design. A stale lock (dead pid) is taken over.
  const lock = path.join(state, "runner.lock");
  try {
    const held = JSON.parse(fs.readFileSync(lock, "utf8"));
    let alive = false; try { process.kill(held.pid, 0); alive = true; } catch {}
    if (alive && held.pid !== process.pid) throw new Error(`another runner regression run holds the lock (pid ${held.pid}, since ${held.at})`);
  } catch (e) { if (!/ENOENT|Unexpected|JSON/.test(e.message)) throw e; }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const t0 = Date.now();
    const build = spawnSync(process.execPath, [path.join(RUNNER, "bin", "build-snapshot.mjs"), "--profile", "regression", "--snapshot", RUNNER_SNAP],
      { cwd: PLAYWRIGHT, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    if (build.status !== 0) throw new Error("runner snapshot build failed: " + ((build.stderr || build.stdout || "").trim().split("\n").pop() || `exit ${build.status}`));
    const { pageSizeOverride, ...copts } = opts;   // no paging: no bridge cap in the runner
    const optsFile = path.join(state, "runner-opts.json");
    const outFile = path.join(state, "runner-result.json");
    fs.writeFileSync(optsFile, JSON.stringify(copts));
    try { fs.unlinkSync(outFile); } catch {}
    const args = [path.join(RUNNER, "bin", "run.mjs"), "--snapshot", RUNNER_SNAP, "--port", String(RUNNER_PORT), "--bench", "--canvas", "off",   // logic only: drawing is ~all of a headless run (snapshot-runner/bin/canvas-mode.mjs)
     
      ...(full ? ["--full"] : []), ...(copts.mode === "simulate" ? ["--mode", "simulate"] : []),
      "--collector-opts", optsFile, "--collect", outFile];
    const run = spawnSync(process.execPath, args, { cwd: PLAYWRIGHT, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
    if (!fs.existsSync(outFile)) {
      const tail = ((run.stderr || "") + (run.stdout || "")).trim().split("\n").filter(Boolean).slice(-3).join(" | ");
      throw new Error(`runner run produced no result (${run.error ? run.error.message : `exit ${run.status}`}): ${tail}`);
    }
    const r = JSON.parse(fs.readFileSync(outFile, "utf8"));
    if (!r || r.ok !== true) throw new Error("collector failed in the runner: " + (r?.error || JSON.stringify(r).slice(0, 300)));
    checkKeys(r);
    let report = {};
    try { report = JSON.parse(fs.readFileSync(path.join(RUNNER, RUNNER_SNAP, "run-report.json"), "utf8")); } catch {}
    say(`· runner: game closed, so the check ran on the Snapshot Runner (real engine, world read from disk), ${((Date.now() - t0) / 1000).toFixed(0)} s`
      + (report.pageErrors?.length ? ` — ${report.pageErrors.length} page error(s), see tools/snapshot-runner/${RUNNER_SNAP}/run-report.json` : ""));
    // The cold run is done and its page closed, so this is never a second headless client.
    if (!full && warmEnabled() && !st) {
      try { say(`· started a warm runner for the next checks (pid ${startWarm()}, leaves after ${WARM_IDLE_MIN} idle min; log .state/warm-runner.log)`); }
      catch (e) { say(`· could not start a warm runner: ${e.message}`); }
    }
    return shapeResult(r);
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

// Stable stringify: sort object keys recursively so goldens diff cleanly in git.
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
    return o;
  }
  return v;
}

function goldenPath(a) {
  // A RELATIVE --goldens resolves against the tool root, not the shell's CWD.
  // The README's examples (`--goldens goldens/skills-simulate.json`) assume you
  // ran `cd tools/skill-regression`; run the same command from the repo root and
  // path.resolve() silently created a stray `goldens/` directory THERE, so the
  // capture landed outside the tool and the next `check` compared against a
  // different file. Anchoring relative paths to ROOT makes the documented form
  // work from anywhere; an absolute path or an explicit ./ prefix still wins.
  if (a.goldens) {
    const g = String(a.goldens);
    if (path.isAbsolute(g) || g.startsWith("./") || g.startsWith("../")
        || g.startsWith(".\\") || g.startsWith("..\\")) return path.resolve(g);
    return path.resolve(path.join(ROOT, g));
  }
  // The two modes have SEPARATE goldens, and the default has to follow the mode.
  // It used to be skills.json unconditionally, so `capture --mode simulate` with
  // the documented `--goldens goldens/skills-simulate.json` merely forgotten (or
  // eaten by a mis-parsed flag) overwrote the compute golden with a simulate
  // capture — silently, and the compute baseline is the one the Stop-hook gate
  // and every `check` depend on.
  const name = a.mode === "simulate" ? "skills-simulate.json" : "skills.json";
  return path.resolve(path.join(ROOT, "goldens", name));
}

function writeGoldens(file, result) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Persist the skills map (sorted) + a small provenance header. The header's
  // volatile fields (tookMs, timestamps) are deliberately NOT stored — only the
  // reproducible knobs, so the golden file itself is stable across captures.
  const payload = {
    _meta: {
      mode: result.mode,
      scene: result.scene,
      casters: result.casters,
      enemyTarget: result.enemyTarget,
      count: result.count,
      engineVersion: result.engineVersion,
      override: result.override,
      force: result.force,
    },
    skills: stable(sortedMap(result.skills)),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
}

function sortedMap(obj) {
  const o = {};
  for (const k of Object.keys(obj).sort()) o[k] = obj[k];
  return o;
}

// Deep field-level diff between two fingerprints; returns array of "path: a → b".
// Recurses into both objects and arrays (by index) so the report pinpoints the
// exact field that moved (e.g. `perTarget.0.damage`). Values are key-sorted for
// display so member-order differences never show as noise.
function diffFp(golden, current, prefix = "") {
  const out = [];
  if (JSON.stringify(stable(golden)) === JSON.stringify(stable(current))) return out;
  const bothArr = Array.isArray(golden) && Array.isArray(current);
  const bothObj = golden && current && typeof golden === "object" && typeof current === "object" && !Array.isArray(golden) && !Array.isArray(current);
  if (bothArr) {
    const n = Math.max(golden.length, current.length);
    for (let i = 0; i < n; i++) out.push(...diffFp(golden[i], current[i], `${prefix}.${i}`));
    return out;
  }
  if (bothObj) {
    const keys = new Set([...Object.keys(golden), ...Object.keys(current)]);
    for (const k of keys) out.push(...diffFp(golden[k], current[k], prefix ? `${prefix}.${k}` : k));
    return out;
  }
  out.push(`${prefix}: ${JSON.stringify(stable(golden))} → ${JSON.stringify(stable(current))}`);
  return out;
}

// Delete the bench scene. Shared by the `teardown` command and the `--teardown`
// flag on capture/check, so an ephemeral run leaves NOTHING in the world: a world
// commit is a wholesale binary dump, and a resident bench scene would ship to the
// co-dev. Safe to re-run — a missing bench is a no-op, not an error.
async function teardownBench(a) {
  // Status goes to stderr under --json: stdout is the machine-readable verdict the
  // Stop-hook gate parses, and a stray human line there breaks JSON.parse (which
  // the gate reports as "could not evaluate drift" — a silent loss of the tripwire).
  const say = a.json ? (s) => process.stderr.write(s + "\n") : (s) => console.log(s);
  const topts = {};
  if (a.scene) topts.sceneName = a.scene;
  const code = `const OPTS = ${JSON.stringify(topts)};\n${TEARDOWN_SRC}`;
  const r = await evalGM(code, { timeoutSecs: 120 });
  if (!r || r.ok !== true) { console.error("✗ teardown failed: " + (r?.error || JSON.stringify(r))); return 2; }
  if (!r.removed) { say(`· ${r.note}`); return 0; }
  if (r.stillPresent) { console.error(`✗ teardown reported success but a "${r.scene}" scene is still present`); return 2; }
  // Surface a duplicate sweep loudly — it means build-bench raced (see its
  // header). Silent cleanup would hide a recurring leak.
  const dupNote = r.duplicatesFound > 1
    ? ` — ⚠ swept ${r.removed} DUPLICATE bench scenes (a concurrent \`bench\` race; they would have shipped as world data)`
    : "";
  say(`✓ torn down "${r.scene}" (${r.tokensRemoved} token(s)) — world holds no bench scaffolding${dupNote}`);
  if (r.note) say(`  · ${r.note}`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  if (a.sandbox) a.runner = true;   // --sandbox: the Snapshot Runner's name until 2026-11-03
  const cmd = a._[0] || "help";
  const opts = optsFrom(a);
  const file = goldenPath(a);
  // Only a run against the compute golden the Stop-hook gate checks may record its verdict:
  // the gate reads it as "this engine was checked, N drifted". A check against another file
  // (a simulate golden, a perturbed copy used as a control) recorded drift for the gate too,
  // and the next turn then reported drift that the gate golden never had (2026-11-03).
  const gateGolden = file === goldenPath({}) && (a.mode || "compute") === "compute";

  const onProgress = a.json ? null : ({ done, total }) => process.stderr.write(`\r  collecting… ${done}/${total}   `);

  if (cmd === "capture") {
    const t0 = Date.now();
    const result = await (a.runner ? collectRunner(opts, { full: !!a.full }) : collect(opts, { onProgress }));
    result.tookMs = Date.now() - t0;
    if (onProgress) process.stderr.write("\r" + " ".repeat(40) + "\r");
    if (a.teardown && !a.runner) await teardownBench(a);
    writeGoldens(file, result);
    // A full capture makes current == golden by definition, so it establishes a
    // verdict for this engine source just as a clean check does — tell the
    // Stop-hook gate, or it re-sweeps 22 min for a state we just baselined.
    if (!a.caster && !a.limit && gateGolden) recordVerified({ total: result.count, drift: 0, by: a.runner ? "capture --runner" : "capture", dataKey: DATA_KEY });
    console.log(`✓ captured ${result.count} skills (${result.mode} mode, scene "${result.scene}", casters: ${result.casters.join(", ")}) in ${(result.tookMs / 1000).toFixed(1)}s`);
    console.log(`  engine ${result.engineVersion} · errors: ${result.errorCount} · wrote ${path.relative(process.cwd(), file)}`);
    if (result.errorCount) console.log(`  (errored skills are recorded as fingerprints too — a change in error is still a regression signal)`);
    return 0;
  }

  if (cmd === "check") {
    const result = await (a.runner ? collectRunner(opts, { full: !!a.full }) : collect(opts, { onProgress }));
    if (onProgress) process.stderr.write("\r" + " ".repeat(40) + "\r");
    // Tear down BEFORE reporting so the world is clean even if the diff exits 1.
    if (a.teardown && !a.runner) await teardownBench(a);
    if (a.update) {
      writeGoldens(file, result);
      if (!a.caster && !a.limit && gateGolden) recordVerified({ total: result.count, drift: 0, by: a.runner ? "check --update --runner" : "check --update", dataKey: DATA_KEY });
      console.log(`✓ goldens updated to current behavior (${result.count} skills).`);
      return 0;
    }
    if (!fs.existsSync(file)) {
      console.error(`✗ no golden at ${path.relative(process.cwd(), file)} — run \`capture\` first.`);
      return 2;
    }
    const golden = JSON.parse(fs.readFileSync(file, "utf8")).skills || {};
    const current = sortedMap(result.skills);
    const gKeys = new Set(Object.keys(golden));
    const cKeys = new Set(Object.keys(current));
    // A partial run (--caster / --limit) only exercises a subset, so golden
    // entries it didn't run are NOT regressions — suppress "removed" for them.
    const partial = !!(a.caster || a.limit);
    const added = [...cKeys].filter((k) => !gKeys.has(k));
    const removed = partial ? [] : [...gKeys].filter((k) => !cKeys.has(k));
    const changed = [];
    for (const k of [...cKeys].filter((x) => gKeys.has(x))) {
      const d = diffFp(golden[k], current[k]);
      if (d.length) changed.push({ key: k, diffs: d });
    }
    // Only a FULL run licenses the gate's skip — a --caster/--limit subset says
    // nothing about the rest of the catalog.
    if (!partial && gateGolden) recordVerified({ total: result.count, drift: added.length + removed.length + changed.length, by: a.runner ? "check --runner" : "check", dataKey: DATA_KEY });
    if (a.json) {
      console.log(JSON.stringify({ partial, added, removed, changed, counts: { added: added.length, removed: removed.length, changed: changed.length, total: result.count } }, null, 2));
    } else {
      report(added, removed, changed, result, golden, partial);
    }
    return (added.length || removed.length || changed.length) ? 1 : 0;
  }

  // ── parity ───────────────────────────────────────────────────────────────
  // Does the TEST RIG supply every action-level identifier the LIVE dispatch
  // supplies? Static source comparison — no game, milliseconds.
  if (cmd === "parity") {
    const r = checkPayloadParity();
    if (r.error) {
      console.log(`✗ parity: ${r.error}`);
      return 1;
    }
    // One line per SCAN SHAPE. A single roll-up line would let a second trigger
    // be added and then silently drop out of the report.
    for (const t of r.triggers ?? []) {
      console.log(`parity — live ${t.live} key(s) · harness ${t.harness} key(s)  [${t.trigger}]` +
        (t.missing.length ? `  ⚠ ${t.missing.length} missing` : ""));
      if (t.extra.length) {
        console.log(`  note: harness-only key(s) (live never sends these): ${t.extra.join(", ")}`);
      }
    }
    // COVERAGE, before any verdict. The old green line ("the harness supplies
    // every action-level field the live dispatch does") reads as total while
    // TRIGGERS hardcodes two shapes out of fifteen. A checker that reports PASS
    // for the part it looked at, in language that sounds like it looked at
    // everything, is the same silent-permissive failure parity exists to catch.
    const cov = auditTriggerCoverage();
    const c = cov.counts ?? {};
    console.log(`\ncoverage — ${c.checked ?? 0} shape(s) field-compared, ` +
      `${c["caller-supplied"] ?? 0} caller-supplied (parity is BLIND), ` +
      `${c["unchecked-harness-built"] ?? 0} harness-built but unchecked, ` +
      `${c["live-only"] ?? 0} not harness-reachable.`);
    if (!cov.ok) {
      console.log(`\n✗ ${cov.error}`);
      return 1;
    }
    if ((c["caller-supplied"] ?? 0) > 0) {
      console.log("  caller-supplied: " +
        cov.rows.filter((x) => x.cls === "caller-supplied").map((x) => x.trigger).join(", "));
      if (cov.genericCallerDispatch) {
        console.log("  ↳ runDirectorPassiveTriggerTest forwards `trigger: args.trigger` with");
        console.log("    `payload: args.payload ?? {}`, so these are dispatchable from a test with a");
        console.log("    HAND-WRITTEN payload. An omitted payload is {} — every identifier a gate");
        console.log("    reads folds to 0, which for a `== 0` gate is the permissive answer, so such");
        console.log("    a test passes by construction. Parity cannot see it: there is no harness");
        console.log("    literal to diff. Assert the field your gate reads, per guideline I4b.");
      }
    }
    if (r.ok) {
      console.log("\n✓ for the shapes it compares, the harness supplies every action-level field");
      console.log("  the live dispatch does. This is NOT a statement about the shapes above.");
      return 0;
    }
    console.log(`\n⚠ HARNESS IS MISSING ${r.missing.length} LIVE FIELD(S): ${r.missing.join(", ")}`);
    console.log("\nA missing identifier resolves to 0/blank, and for a `== 0` gate that is the");
    console.log("PERMISSIVE answer — the gate PASSES under test and refuses in play. Add each");
    console.log("to `harnessActionBase` in _test-harness-director.js, or list it in");
    console.log("HARNESS_EXEMPT (lib/payload-parity.js) with the reason it cannot apply.");
    return 1;
  }

  // ── formulas ─────────────────────────────────────────────────────────────
  // Do the authored GATE formulas actually mean anything? Game-CLOSED. Catches
  // the two silent failure modes the evaluator has: unparseable text (which
  // returns the caller's fallback — skill-picker passes 1, so the gate simply
  // does not apply) and a typo'd identifier (which folds to 0, permanently
  // blocking the skill while showing its authored reason, indistinguishable
  // from working correctly).
  if (cmd === "formulas") {
    if (a["self-test"]) {
      const t = formulaSelfTest();
      for (const x of t) console.log(`  ${x.pass ? "PASS" : "FAIL"}  ${x.name}${x.detail ? "  " + x.detail : ""}`);
      const bad = t.filter((x) => !x.pass).length;
      console.log(bad
        ? `\n${bad} self-test(s) FAILING — the audit cannot be trusted`
        : "\n✓ self-test: the audit catches what it claims to catch");
      return bad ? 1 : 0;
    }
    const t0 = Date.now();
    const r = runFormulaAudit();
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.engineMissing) { console.log("✗ formulas: skill-formulas.js not found."); return 1; }
    if (r.exportMissing) { console.log("✗ formulas: no authored export — run `world-export export` first."); return 1; }
    if (a.json) { console.log(JSON.stringify(r, null, 1)); return (r.unparseable.length || r.unknown.length) ? 1 : 0; }

    console.log(`formulas — ${r.formulaCount} authored gate formula(s) vs ${r.vocabSize} identifiers ` +
                `+ ${r.prefixCount} dynamic prefixes, ${took}s`);
    for (const u of r.unparseable) {
      console.log(`  ✗ UNPARSEABLE  ${u.where} · ${u.field}`);
      console.log(`      "${u.formula}"  — ${u.problems.join("; ")}`);
      console.log(`      evaluateFormula returns the CALLER's fallback; skill-picker passes 1, so this gate is INERT.`);
    }
    for (const u of r.unknown) {
      console.log(`  ✗ UNKNOWN IDENTIFIER  ${u.id}  (${u.uses.length} use${u.uses.length === 1 ? "" : "s"})`);
      for (const use of u.uses.slice(0, 4)) console.log(`      ${use.where} · ${use.field}: "${use.formula}"`);
      if (u.uses.length > 4) console.log(`      … and ${u.uses.length - 4} more`);
      console.log(`      resolves to 0 — a ">= N" gate is then permanently FALSE and the skill stays greyed out.`);
    }
    if (!r.unparseable.length && !r.unknown.length) {
      console.log("✓ every authored gate formula parses and every identifier resolves.");
      return 0;
    }
    return 1;
  }

  // ── census ───────────────────────────────────────────────────────────────
  // Coverage audit for the config golden: which props does the ENGINE read that
  // the golden does NOT watch? Game-CLOSED (reads the authored export), so it
  // costs nothing and runs while Foundry is shut for a commit.
  //
  // Under a denylist the blind list should be EMPTY; a hit means the churn list
  // ate real content. Exits 1 on a blind spot so it can gate.
  if (cmd === "census") {
    const t0 = Date.now();
    const { docCount, rows, blind, acknowledged, staleAck, exportMissing } = runCensus();
    const took = ((Date.now() - t0) / 1000).toFixed(1);

    if (exportMissing) {
      console.log("✗ census: no authored export found — run `world-export export` first (game closed).");
      return 1;
    }
    if (a.json) {
      console.log(JSON.stringify({ docCount, blind, rows }, null, 1));
      return blind.length ? 1 : 0;
    }

    const watched = rows.filter((r) => r.watched).length;
    console.log(`census — ${rows.length} distinct prop key(s) across ${docCount} skill-shaped doc(s), ${took}s`);
    console.log(`  watched by the config golden: ${watched}   classified churn: ${rows.length - watched}\n`);

    if (a.all) {
      console.log("=== every key (docs · distinct values · watched · engine readers) ===");
      for (const r of rows) {
        console.log(
          `${String(r.docs).padStart(5)} ${String(r.distinct).padStart(4)}v  ` +
          `${r.watched ? "WATCH" : "churn"}  ${r.key}` +
          (r.readers.length ? `   ← ${r.readers.slice(0, 3).join(", ")}` : "   (no engine reader)")
        );
      }
      console.log();
    }

    if (acknowledged.length) {
      console.log(`  ${acknowledged.length} engine-read churn prop(s) reviewed + acknowledged: ${acknowledged.map((r) => r.key).join(", ")}`);
    }
    if (staleAck.length) {
      console.log(`  ⚠ stale acknowledgement(s) protecting nothing (key gone, or now watched): ${staleAck.join(", ")}`);
      console.log(`    drop them from ACKNOWLEDGED in lib/census.js.`);
    }
    if (!blind.length) {
      console.log("\n✓ no blind spots — every engine-read prop is either watched or acknowledged.");
      if (!a.all) console.log("  (pass --all to list every key, or --json for the full table)");
      return 0;
    }
    console.log(`⚠ BLIND SPOTS — ${blind.length} prop(s) the engine READS but the golden treats as churn:`);
    for (const r of blind) {
      console.log(`  ${String(r.docs).padStart(5)} docs  ${r.key}   ← read by ${r.readers.slice(0, 3).join(", ")}`);
      if (r.sample) console.log(`            e.g. ${r.sample}`);
    }
    console.log("\nEither the prop is real content (remove it from CHURN_PROPS in");
    console.log("lib/structure-fingerprint.js, then `structure --update`), or the read is");
    console.log("incidental (leave it, and say why in the CHURN_PROPS comment).");
    return 1;
  }

  // ── structure ────────────────────────────────────────────────────────────
  // The CONFIG half. Diffs the authored shape of every skill-shaped doc, so a
  // change COMPUTE cannot observe (a lost `skill_tags`, an ungated AE change
  // value, a dropped `target_eligibility`) is still a regression signal — and
  // so docs the behavioral roster drops (Passive skills, skip.json entries)
  // stay watched instead of silently leaving coverage.
  if (cmd === "structure") {
    const sFile = path.resolve(path.join(ROOT, "goldens", "structure.json"));
    const t0 = Date.now();
    const result = await collectStructure({});
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    if (a.update || !fs.existsSync(sFile)) {
      const fresh = !fs.existsSync(sFile);
      fs.mkdirSync(path.dirname(sFile), { recursive: true });
      fs.writeFileSync(sFile, JSON.stringify({ capturedAt: new Date().toISOString(), count: result.count, structure: result.structure }, null, 1));
      console.log(`${fresh && !a.update ? "✓ no structure golden existed — captured" : "✓ structure golden updated"}: ${result.count} configured doc(s) of ${result.docs} scanned, ${took}s`);
      console.log(`  wrote ${path.relative(process.cwd(), sFile)}`);
      return 0;
    }
    const golden = JSON.parse(fs.readFileSync(sFile, "utf8")).structure || {};
    const cur = result.structure;
    const gK = new Set(Object.keys(golden)), cK = new Set(Object.keys(cur));
    const added = [...cK].filter((k) => !gK.has(k));
    const removed = [...gK].filter((k) => !cK.has(k));
    const changed = [];
    for (const k of [...cK].filter((x) => gK.has(x))) {
      const d = diffStructure(golden[k], cur[k]);
      if (d.length) changed.push({ key: k, diffs: d });
    }
    if (a.json) {
      console.log(JSON.stringify({ added, removed, changed, counts: { added: added.length, removed: removed.length, changed: changed.length, total: result.count } }, null, 2));
    } else if (!added.length && !removed.length && !changed.length) {
      console.log(`✓ structure unchanged — ${result.count} configured doc(s), ${took}s`);
    } else {
      console.log(`Structure drift (${changed.length} changed, ${added.length} new, ${removed.length} removed) of ${result.count} doc(s):`);
      for (const c of changed) {
        console.log(`    ~ ${c.key}`);
        for (const d of c.diffs.slice(0, 12)) console.log(`        ${d}`);
        if (c.diffs.length > 12) console.log(`        …and ${c.diffs.length - 12} more`);
      }
      for (const k of added) console.log(`    + NEW ${k}`);
      for (const k of removed) console.log(`    - REMOVED ${k}`);
      console.log(`If intended, re-baseline:  node ${path.relative(process.cwd(), __filename)} structure --update`);
    }
    return (added.length || removed.length || changed.length) ? 1 : 0;
  }

  if (cmd === "bench") {
    if (!bridgeAlive()) { console.error("✗ test-bridge is not alive (open the Foundry world first)."); return 2; }
    const bopts = {};
    if (a.scene) bopts.sceneName = a.scene;
    if (a.dummy) bopts.dummyActorId = a.dummy;
    // Keep the bench roster and the collector's filter in lock-step — see the
    // INCLUDE_TYPES note in build-bench.js. Passing --include-types to `bench`
    // but not to `capture`/`check` (or vice versa) silently under-covers.
    if (a["include-types"]) bopts.includeTypes = String(a["include-types"]).split(",").map((s) => s.trim()).filter(Boolean);
    if (a.full) bopts.fullRoster = true;
    const code = `const OPTS = ${JSON.stringify(bopts)};\n${BENCH_SRC}`;
    const r = await evalGM(code, { timeoutSecs: 285 });
    if (!r || r.ok !== true) { console.error("✗ bench build failed: " + (r?.error || JSON.stringify(r))); return 2; }
    console.log(`✓ Regression Bench "${r.scene}"${r.createdScene ? " (created)" : ""} — dummy target: ${r.dummy}`);
    if (r.collapsedDuplicates?.length) {
      console.log(`  ⚠ collapsed ${r.collapsedDuplicates.length} DUPLICATE bench scene(s) — a concurrent build raced; they would have shipped as world data`);
    }
    console.log(`  ${r.fullRoster ? "FULL roster" : "backbone"}: ${r.backboneActors} actors / ${r.skillTotal} skills  (${Object.entries(r.roleCounts).map(([k, v]) => `${k}:${v}`).join(", ")})`);
    if (r.includeTypes) console.log(`  includeTypes: ${r.includeTypes.join(", ")} — pass the SAME --include-types to capture/check`);
    console.log(`  placed ${r.created.length} new token(s)${r.alreadyPlaced ? `, ${r.alreadyPlaced} already present` : ""}.`);
    if (a.json) console.log(JSON.stringify(r.roster, null, 2));
    else console.log(`  (pass --json to list the full roster.)  Now: capture --scene "${r.scene}" --dummy "${r.dummy}"`);
    return 0;
  }

  if (cmd === "teardown") {
    if (!bridgeAlive()) { console.error("✗ test-bridge is not alive (open the Foundry world first)."); return 2; }
    const code = await teardownBench(a);
    return code;
  }

  if (cmd === "verify") {
    if (!bridgeAlive()) { console.error("✗ test-bridge is not alive (open the Foundry world first)."); return 2; }
    const specDir = path.join(ROOT, "expectations");
    if (!fs.existsSync(specDir)) { console.error(`✗ no expectations/ dir at ${specDir}`); return 2; }
    const specs = fs.readdirSync(specDir).filter((f) => f.endsWith(".json"))
      .flatMap((f) => { try { return JSON.parse(fs.readFileSync(path.join(specDir, f), "utf8")); } catch (e) { console.error(`  ! skipping ${f}: ${e.message}`); return []; } });
    if (!specs.length) { console.error("✗ no scenario specs found in expectations/*.json"); return 2; }
    // Under --json, stdout is the machine-readable verdict the Stop-hook gate
    // parses — status lines must go to stderr or JSON.parse breaks.
    const say = a.json ? (s) => process.stderr.write(s + "\n") : (s) => console.log(s);
    // EPHEMERAL fixtures: place what the run needs, then ALWAYS remove exactly
    // what we placed. Test scaffolding must never be left resident in the user's
    // world — a world commit is a wholesale binary dump, so leftovers ship to the
    // co-dev, and a permanently-populated Training Ground is the user's game, not
    // ours. Mirrors the bench's build/teardown contract.
    const FIXTURE_ACTORS = ["Test Caster", "Test Target Ally", "Test Target Enemy"];
    const specCasters = [...new Set(specs.map((s) => s && s.caster).filter(Boolean))];
    const needed = [...new Set([...FIXTURE_ACTORS, ...specCasters])];

    const placeCode = `const OPTS = ${JSON.stringify({ actorNames: needed })};\n${PLACE_FIXTURES_SRC}`;
    const placed = await evalGM(placeCode, { timeoutSecs: 120 });
    if (!placed || placed.ok !== true) {
      console.error("✗ could not place verify fixtures: " + (placed?.error || JSON.stringify(placed)));
      return 2;
    }
    if (placed.notFound?.length) console.error(`  ! no such actor(s), skipped: ${placed.notFound.join(", ")}`);
    if (placed.created.length) {
      say(`· placed ${placed.created.length} ephemeral fixture token(s) on "${placed.sceneName}" — removed after the run`);
    }

    const removeFixtures = async () => {
      if (!placed.created.length) return;
      const rmCode = `const OPTS = ${JSON.stringify({ created: placed.created, sceneId: placed.sceneId })};\n${REMOVE_FIXTURES_SRC}`;
      const rm = await evalGM(rmCode, { timeoutSecs: 120 }).catch((e) => ({ ok: false, error: String(e) }));
      if (!rm || rm.ok !== true) {
        console.error(`✗ FIXTURE CLEANUP FAILED — ${placed.created.length} token(s) may remain on "${placed.sceneName}": ` +
          (rm?.error || JSON.stringify(rm)));
        console.error("  token ids: " + placed.created.map((c) => `${c.tokenId} (${c.name})`).join(", "));
        return;
      }
      if (rm.stillPresent) console.error(`✗ cleanup reported success but ${rm.stillPresent} token(s) still present`);
      else say(`· removed ${rm.removed} ephemeral fixture token(s) — world holds no verify scaffolding`);
    };

    const code = `const OPTS = ${JSON.stringify({ specs })};\n${VERIFY_SRC}`;
    let r;
    try {
      r = await evalGM(code, { timeoutSecs: 285 });
    } finally {
      await removeFixtures();
    }
    if (!r || r.ok !== true) { console.error("✗ verify failed: " + (r?.error || JSON.stringify(r))); return 2; }
    if (a.json) { console.log(JSON.stringify(r, null, 2)); return r.fail ? 1 : 0; }
    console.log(`skill-regression verify — ${r.total} scenarios, ${r.pass} pass, ${r.fail} fail\n`);
    for (const res of r.results) {
      console.log(`  ${res.pass ? "✓" : "✗"} ${res.name}`);
      if (!res.pass) for (const fl of res.failures || []) console.log(`      ${fl}`);
    }
    console.log(r.fail ? `\n✗ ${r.fail} scenario(s) failed expectations. (exit 1)` : "\n✓ all scenarios met their expectations.");
    return r.fail ? 1 : 0;
  }

  console.log(`skill-regression — behavioral regression harness for director skills

  node bin/skill-regression.js bench   [opts]   build/refresh the local Regression Bench scene (game open)
  node bin/skill-regression.js capture [opts]   write goldens from current behavior
  node bin/skill-regression.js check   [opts]   diff current vs goldens (exit 1 on change)
  node bin/skill-regression.js structure       diff authored CONFIG vs goldens/structure.json
  node bin/skill-regression.js structure --update   re-baseline the config golden

Game-CLOSED audits (no bridge; run them while Foundry is shut for a commit):
  node bin/skill-regression.js census  [--all]  props the ENGINE reads that the golden does NOT watch
  node bin/skill-regression.js parity          fields the LIVE dispatch sends that the TEST RIG does not
  node bin/skill-regression.js check --update    accept current as new goldens
  node bin/skill-regression.js verify  [opts]   assert expected-value scenarios (exit 1 on mismatch)
  node bin/skill-regression.js teardown [opts]  delete the bench scene (game open; no-op if absent)

Ephemeral run — leaves NO scaffolding in the world (a world commit is a wholesale
binary dump, so a resident bench scene would ship to the co-dev):
  bench && check --scene "Regression Bench" --dummy "Test Target Enemy" --teardown
Goldens are keyed "<Actor> / <Skill>", never by scene or token id, so tearing the
bench down and rebuilding it later still diffs against the same golden.

Options:
  --mode compute|simulate   compute (default, read-only, safe mid-battle) | simulate (writes+card)
  --caster <ActorName>      restrict to one caster
  --limit <N>               cap total skills (smoke test)
  --scene <SceneName>       roster scene (default: active scene / Training Ground; bench: "Regression Bench")
  --dummy <ActorId|Name>    BENCH mode: single target dummy; every other token becomes a caster
  --goldens <path>          golden file (default: goldens/skills.json)
  --full                    BENCH: place EVERY actor owning a collectable item,
                            not just the backbone (adds ordinary monsters/NPCs)
  --include-types <csv>     skill_types to collect (default Active,Spell).
                            Pass the SAME value to bench AND capture/check.
  --json                    machine-readable check output
  --runner                 capture/check with the game CLOSED: runs the collector on
                            tools/snapshot-runner (real engine, world read from disk,
                            bench built in-page). 487/487 = real engine. ~45 s compute
  --seed <n>                pin Math.random per skill (random AE pools; dice are forced)
  --per-skill-ms <ms>       per-skill timeout guard (default 12000). Use 30000 for
                            simulate: RESOLVE re-imports skill-effects.js per call
  --page-size <N>           skills per bridge page (default 30; auto-shrinks when
                            --per-skill-ms is raised so a page fits the 285 s cap)

Game must be OPEN (or pass --runner to capture/check). See README.md.`);
  return 0;
}

function report(added, removed, changed, result, golden, partial) {
  const engGolden = (JSON.parse(fs.existsSync(goldenPath({})) ? fs.readFileSync(goldenPath({}), "utf8") : "{}")._meta || {}).engineVersion;
  console.log(`skill-regression check — ${result.mode} mode${result.engine === "runner" ? " (Snapshot Runner, game closed)" : ""}, scene "${result.scene}", ${result.count} skills${partial ? " (partial run — 'removed' suppressed)" : ""}`);
  console.log(`  engine now ${result.engineVersion}${engGolden && engGolden !== result.engineVersion ? ` (golden captured on ${engGolden})` : ""}\n`);
  if (!added.length && !removed.length && !changed.length) {
    console.log("✓ no behavioral changes — all skills match golden.");
    return;
  }
  if (removed.length) {
    console.log(`⚠ REMOVED (${removed.length}) — in golden, absent now (skill deleted, or caster/roster changed):`);
    for (const k of removed) console.log(`    - ${k}`);
    console.log("");
  }
  if (added.length) {
    console.log(`+ NEW (${added.length}) — present now, not in golden:`);
    for (const k of added) console.log(`    + ${k}`);
    console.log("");
  }
  if (changed.length) {
    console.log(`~ CHANGED (${changed.length}) — behavior differs from golden:`);
    for (const c of changed) {
      console.log(`    ~ ${c.key}`);
      for (const d of c.diffs) console.log(`        ${d}`);
    }
    console.log("");
  }
  console.log(`Summary: ${changed.length} changed, ${added.length} new, ${removed.length} removed. (exit 1)`);
  console.log(`If these changes are intended, re-baseline with:  check --update`);
}

main().then((code) => process.exit(code)).catch((e) => { console.error("✗ " + e.message); process.exit(2); });
