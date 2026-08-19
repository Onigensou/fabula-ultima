#!/usr/bin/env node
"use strict";

/**
 * preflight — a pre-session checkup for the Fabula Ultima world.
 *
 * Runs a suite of semantic validity checks the night before a session, catching
 * the silent world-import regressions that manual testing keeps missing:
 *   - broken references (token -> deleted actor, note -> deleted journal)
 *   - dungeon tiles that will do nothing at runtime (missing/stale tileState)
 *   - action automation that landed on the folder copy, not the actor
 *   - blessed scenes that got rolled back (missing pre-placed token/note)
 *
 * Runs entirely OUTSIDE Foundry against the world's LevelDB on disk, so it has
 * ZERO in-game performance cost. Game MUST be closed (LevelDB LOCK) — same
 * constraint as world-export.
 *
 * Usage:
 *   node bin/preflight.js run   [--world W] [--html [path]] [--allow-locked]
 *   node bin/preflight.js bless <sceneNameOrId> [--world W] [--allow-locked]
 *   node bin/preflight.js list-scenes [--world W]     # ids/names to bless
 *
 * `run` exits 1 if any check FAILs (so it can gate a commit / CI).
 */

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_WORLD } = require("../lib/paths");
const { loadWorld } = require("../preflight/loader");
const { CHECKS } = require("../preflight/registry");
const { renderConsole, writeHtml, tally } = require("../preflight/report");
const { SEVERITY, finding } = require("../preflight/util");
const scenesCheck = require("../preflight/checks/scenes");

const FIXERS = {
  tiles: require("../preflight/fix/tiles"),
  scenes: require("../preflight/fix/scenes"),
  automation: require("../preflight/fix/automation"),
};

function fixplanDir() {
  return path.join(__dirname, "..", "preflight", "fixplans");
}
function savePlan(suite, world, actions) {
  fs.mkdirSync(fixplanDir(), { recursive: true });
  const p = path.join(fixplanDir(), `${suite}.json`);
  fs.writeFileSync(p, JSON.stringify({ suite, world, generatedAt: new Date().toISOString(), actions }, null, 2));
  return p;
}
function loadPlan(suite) {
  const p = path.join(fixplanDir(), `${suite}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function filterOnly(actions, only) {
  if (!only) return actions;
  const needle = only.toLowerCase();
  return actions.filter((a) => (a.targetIds || []).some((id) =>
    String(id).toLowerCase() === needle || String(id).toLowerCase().includes(needle)));
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function cmdRun(argv, world, allowLocked) {
  const wantHtml = argv.includes("--html");
  const htmlPath = wantHtml ? arg(argv, "--html") : null; // optional path after --html
  const opts = { showDrift: argv.includes("--show-drift") };
  const only = arg(argv, "--only");
  const model = await loadWorld({ world, allowLocked });

  // Isolate each suite. A check that throws used to take the WHOLE run with it —
  // the four healthy suites never reported, so a crash in one looked like a
  // broken validator rather than one broken check. A thrown suite now degrades
  // to a FAIL finding of its own, which is both visible and non-zero-exit.
  let results = CHECKS.map((c) => {
    try {
      return { id: c.id, title: c.title, findings: c.run(model, opts) };
    } catch (e) {
      return {
        id: c.id,
        title: c.title,
        findings: [finding(c.id, SEVERITY.FAIL,
          `check "${c.id}" threw and was skipped: ${e.message}`,
          { doc: "preflight", id: c.id })],
      };
    }
  });
  if (only) {
    const needle = only.toLowerCase();
    const hit = (f) => String(f.ref?.id ?? "").toLowerCase() === needle
      || String(f.ref?.extra ?? "").toLowerCase() === needle
      || f.message.toLowerCase().includes(needle);
    results = results.map((r) => ({ ...r, findings: r.findings.filter(hit) }));
  }
  console.log(renderConsole(results, model));

  if (wantHtml) {
    const dest = writeHtml(results, model, htmlPath && !htmlPath.startsWith("--") ? htmlPath : null);
    console.log(`\nHTML dashboard -> ${dest}`);
  }

  const t = tally(results);
  if (t.FAIL > 0) process.exit(1);
}

// Collect positional args (scene ids/names) — everything after the command that
// isn't a flag or the value belonging to a value-taking flag.
function positionals(argv, valueFlags = ["--world", "--match", "--folder", "--only", "--html"]) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) continue;
    if (valueFlags.includes(argv[i - 1])) continue;
    out.push(a);
  }
  return out;
}

// A scene folder + all its descendant scene folders (dungeons nest their maps).
function descendantFolderIds(folders, rootIds) {
  const byParent = new Map();
  for (const f of folders) {
    const p = f.folder || null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(f._id);
  }
  const out = new Set(rootIds);
  const stack = [...rootIds];
  while (stack.length) {
    for (const c of byParent.get(stack.pop()) || []) if (!out.has(c)) { out.add(c); stack.push(c); }
  }
  return out;
}

async function cmdBless(argv, world, allowLocked) {
  const match = arg(argv, "--match");
  const folderName = arg(argv, "--folder");
  const all = argv.includes("--all");
  const targets = positionals(argv);

  if (!targets.length && !match && !folderName && !all) {
    console.error("bless: name what to bless —\n" +
      "  preflight bless <id|name> [<id|name> …]   one or more scenes\n" +
      "  preflight bless --match Wyrmwood_Map        every scene whose name contains this\n" +
      "  preflight bless --folder \"The Wyrmwood\"     every scene in this scene folder (nested too)\n" +
      "  preflight bless --all                       every scene (staged ones only — WIP scenes will show drift)");
    process.exit(2);
  }

  const model = await loadWorld({ world, allowLocked });
  const chosen = new Map(); // sceneId -> scene (dedup across selectors)

  const add = (s) => { if (s) chosen.set(s._id, s); };
  if (all) for (const s of model.scenes) add(s);
  if (match) {
    const n = match.toLowerCase();
    for (const s of model.scenes) if (String(s.name).toLowerCase().includes(n)) add(s);
  }
  if (folderName) {
    const n = folderName.toLowerCase();
    const roots = model.folders.filter((f) => f.type === "Scene" && String(f.name).toLowerCase().includes(n)).map((f) => f._id);
    if (!roots.length) { console.error(`bless: no scene folder matching "${folderName}".`); process.exit(2); }
    const ids = descendantFolderIds(model.folders, roots);
    for (const s of model.scenes) if (ids.has(s.folder)) add(s);
  }
  for (const t of targets) {
    const s = model.byId.scenes.get(t)
      || model.scenes.find((x) => x.name === t)
      || model.scenes.find((x) => x.name?.toLowerCase() === t.toLowerCase());
    if (!s) { console.error(`bless: no scene matching "${t}". Try \`preflight list-scenes\`.`); process.exit(2); }
    add(s);
  }

  if (!chosen.size) { console.error("bless: nothing matched."); process.exit(2); }

  const dir = scenesCheck.expectationsDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const scene of chosen.values()) {
    const snap = scenesCheck.snapshotScene(scene);
    fs.writeFileSync(path.join(dir, `${scene._id}.json`), JSON.stringify(snap, null, 2) + "\n");
    console.log(`  ✓ blessed "${scene.name}" (${scene._id}) — ${snap.tokens.length} token(s), ${snap.notes.length} note(s), ${snap.tileCount} tile(s)`);
  }
  console.log(`\nblessed ${chosen.size} scene(s) → ${path.relative(process.cwd(), dir)}`);
  console.log("commit the expectations/ files so your co-dev shares the same guards; re-bless after intentional changes.");
}

async function cmdListScenes(argv, world, allowLocked) {
  const model = await loadWorld({ world, allowLocked });
  const folderName = (id) => model.byId.folders.get(id)?.name || "—";
  const filter = arg(argv, "--match")?.toLowerCase();
  const rows = model.scenes
    .filter((s) => !filter || String(s.name).toLowerCase().includes(filter))
    .map((s) => ({ id: s._id, name: s.name, folder: folderName(s.folder), tokens: (s.tokens || []).length, tiles: (s.tiles || []).length }))
    .sort((a, b) => String(a.folder).localeCompare(String(b.folder)) || String(a.name).localeCompare(String(b.name)));
  for (const r of rows) console.log(`${r.id}  tok:${String(r.tokens).padStart(3)}  tile:${String(r.tiles).padStart(3)}  [${r.folder}]  ${r.name}`);
  console.log(`\n${rows.length} scene(s). Bless a dungeon in one go: \`preflight bless --folder "<folder>"\` or \`--match <name-prefix>\`.`);
}

// Apply a BRIDGE-mode fix (game OPEN) from the plan saved during a game-closed
// preview. Planning can't run now (LevelDB is locked), so we consume the plan.
async function applyBridgeFromPlan(suite, only, world) {
  const fx = FIXERS[suite];
  const plan = loadPlan(suite);
  if (!plan) {
    console.error(`No saved plan for "${suite}". Run \`preflight fix --suite ${suite}\` first (game closed) to generate and review one.`);
    process.exit(2);
  }
  const actions = filterOnly(plan.actions, only);
  if (!actions.length) { console.log(`Nothing to apply for "${suite}"${only ? ` matching "${only}"` : ""}.`); return; }

  console.log(`\n=== applying ${suite} fix via bridge (${actions.length} action(s), plan from ${plan.generatedAt}) ===`);
  console.log("  ⚠ This writes to the LIVE world through the test-bridge. Make sure you have committed a git safety-point first.");
  const res = await fx.apply(actions, { world });
  const done = res.results || res;
  console.log(`  ✓ applied ${Array.isArray(done) ? done.length : "?"} change(s).`);
  if (res.skipped?.length) console.log(`  skipped (need re-bless): ${res.skipped.join(", ")}`);
}

async function cmdFix(argv, world, allowLocked) {
  const suite = arg(argv, "--suite");
  const only = arg(argv, "--only");
  const apply = argv.includes("--apply");

  if (suite && !FIXERS[suite]) {
    console.error(`Unknown --suite "${suite}". Choose: ${Object.keys(FIXERS).join(", ")}`);
    process.exit(2);
  }
  if (apply && !suite) {
    console.error("Refusing to --apply across all suites at once. Pass --suite <tiles|scenes|automation> to apply one domain.");
    process.exit(2);
  }

  // BRIDGE apply runs against the OPEN game from the saved plan.
  if (apply && FIXERS[suite].mode === "bridge") {
    return applyBridgeFromPlan(suite, only, world);
  }

  // Planning + preview + offline apply all read the world offline (game closed).
  const chosen = suite ? [suite] : Object.keys(FIXERS);
  const model = await loadWorld({ world, allowLocked });
  let planned = 0;

  for (const s of chosen) {
    const fx = FIXERS[s];
    const actions = filterOnly(fx.plan(model), only);
    console.log(`\n── fix:${s} [${fx.mode}] — ${actions.length} action(s)${only ? ` matching "${only}"` : ""}`);
    for (const a of actions) console.log(`   • ${fx.describe(a)}`);
    planned += actions.length;
    if (actions.length) savePlan(s, world, actions);

    if (apply && fx.mode === "offline" && actions.length) {
      console.log("  applying (offline, backed up + journaled — reversible via `safe-edit rollback <entryId>`)…");
      const res = await fx.apply(actions, { world, dryRun: false });
      for (const r of res) console.log(`   ✓ ${r.sceneName}: ${r.tiles} tile(s) fixed  [entry ${r.entryId}]`);
    }
  }

  if (!apply) {
    console.log(`\nPREVIEW only — nothing was written (${planned} action(s) planned).`);
    const bridgeSuites = chosen.filter((s) => FIXERS[s].mode === "bridge" && filterOnly(FIXERS[s].plan(model), only).length);
    if (chosen.includes("tiles")) {
      console.log("  • tiles: offline fix — apply with `preflight fix --suite tiles --apply` (game closed).");
    }
    if (bridgeSuites.length) {
      console.log(`  • ${bridgeSuites.join(", ")}: game-open fix — a plan was saved. Commit a git safety-point, open Foundry + the bridge, then\n    \`preflight fix --suite <name> --apply\` to execute it.`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "run";
  const world = arg(argv, "--world") || DEFAULT_WORLD;
  const allowLocked = argv.includes("--allow-locked");

  try {
    if (cmd === "run") return await cmdRun(argv, world, allowLocked);
    if (cmd === "fix") return await cmdFix(argv, world, allowLocked);
    if (cmd === "bless") return await cmdBless(argv, world, allowLocked);
    if (cmd === "list-scenes") return await cmdListScenes(argv, world, allowLocked);
    console.error(`Unknown command "${cmd}". Use: run | fix | bless | list-scenes`);
    process.exit(2);
  } catch (e) {
    console.error(`preflight failed: ${e.message}`);
    process.exit(e.code === "GAME_RUNNING" ? 3 : 1);
  }
}

main();
