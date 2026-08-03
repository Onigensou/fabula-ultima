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
  if (a.forceSimulate) o.forceSimulate = true;
  // Auto-load the committed skip list (interactive skills that only ever
  // time out at COMPUTE) so capture + check stay fast AND identical. --no-skip
  // disables it (e.g. to re-measure which skills still time out).
  if (!a["no-skip"]) {
    const skipFile = path.join(ROOT, "skip.json");
    if (fs.existsSync(skipFile)) {
      try { o.skip = JSON.parse(fs.readFileSync(skipFile, "utf8")).skip || []; } catch { /* ignore malformed */ }
    }
  }
  return o;
}

// Auto-paged collect: each page is one evalGM under the bridge's 5-min cap; we
// walk offset → nextOffset until the collector says hasMore:false, merging the
// per-skill fingerprint maps. A single page (pageSize skills) is sized to finish
// comfortably inside the server timeout.
async function collect(opts, { pageSize = 30, onProgress } = {}) {
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
  merged.slowest.sort((a, b) => b.ms - a.ms);
  return {
    ok: true, mode: head.mode, scene: head.scene, casters: head.casters,
    enemyTarget: head.enemyTarget, total: head.total, count: merged.count,
    errorCount: merged.errors.length, engineVersion: head.engineVersion,
    override: head.override, force: head.force, tookMs: 0,
    slowest: merged.slowest.slice(0, 8), errors: merged.errors, skills: merged.skills,
  };
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
  return path.resolve(a.goldens ? a.goldens : path.join(ROOT, "goldens", "skills.json"));
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
  const cmd = a._[0] || "help";
  const opts = optsFrom(a);
  const file = goldenPath(a);

  const onProgress = a.json ? null : ({ done, total }) => process.stderr.write(`\r  collecting… ${done}/${total}   `);

  if (cmd === "capture") {
    const t0 = Date.now();
    const result = await collect(opts, { onProgress });
    result.tookMs = Date.now() - t0;
    if (onProgress) process.stderr.write("\r" + " ".repeat(40) + "\r");
    if (a.teardown) await teardownBench(a);
    writeGoldens(file, result);
    console.log(`✓ captured ${result.count} skills (${result.mode} mode, scene "${result.scene}", casters: ${result.casters.join(", ")}) in ${(result.tookMs / 1000).toFixed(1)}s`);
    console.log(`  engine ${result.engineVersion} · errors: ${result.errorCount} · wrote ${path.relative(process.cwd(), file)}`);
    if (result.errorCount) console.log(`  (errored skills are recorded as fingerprints too — a change in error is still a regression signal)`);
    return 0;
  }

  if (cmd === "check") {
    const result = await collect(opts, { onProgress });
    if (onProgress) process.stderr.write("\r" + " ".repeat(40) + "\r");
    // Tear down BEFORE reporting so the world is clean even if the diff exits 1.
    if (a.teardown) await teardownBench(a);
    if (a.update) {
      writeGoldens(file, result);
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
    if (a.json) {
      console.log(JSON.stringify({ partial, added, removed, changed, counts: { added: added.length, removed: removed.length, changed: changed.length, total: result.count } }, null, 2));
    } else {
      report(added, removed, changed, result, golden, partial);
    }
    return (added.length || removed.length || changed.length) ? 1 : 0;
  }

  if (cmd === "bench") {
    if (!bridgeAlive()) { console.error("✗ test-bridge is not alive (open the Foundry world first)."); return 2; }
    const bopts = {};
    if (a.scene) bopts.sceneName = a.scene;
    if (a.dummy) bopts.dummyActorId = a.dummy;
    const code = `const OPTS = ${JSON.stringify(bopts)};\n${BENCH_SRC}`;
    const r = await evalGM(code, { timeoutSecs: 285 });
    if (!r || r.ok !== true) { console.error("✗ bench build failed: " + (r?.error || JSON.stringify(r))); return 2; }
    console.log(`✓ Regression Bench "${r.scene}"${r.createdScene ? " (created)" : ""} — dummy target: ${r.dummy}`);
    if (r.collapsedDuplicates?.length) {
      console.log(`  ⚠ collapsed ${r.collapsedDuplicates.length} DUPLICATE bench scene(s) — a concurrent build raced; they would have shipped as world data`);
    }
    console.log(`  backbone: ${r.backboneActors} actors / ${r.skillTotal} skills  (${Object.entries(r.roleCounts).map(([k, v]) => `${k}:${v}`).join(", ")})`);
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
  --json                    machine-readable check output

Game must be OPEN. See README.md.`);
  return 0;
}

function report(added, removed, changed, result, golden, partial) {
  const engGolden = (JSON.parse(fs.existsSync(goldenPath({})) ? fs.readFileSync(goldenPath({}), "utf8") : "{}")._meta || {}).engineVersion;
  console.log(`skill-regression check — ${result.mode} mode, scene "${result.scene}", ${result.count} skills${partial ? " (partial run — 'removed' suppressed)" : ""}`);
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
