#!/usr/bin/env node
"use strict";

/**
 * world-pack — official Foundry-CLI pack/unpack for world collections.
 *
 * Thin wrapper over `@foundryvtt/foundryvtt-cli` (`fvtt package pack|unpack`),
 * which converts a collection's LevelDB <-> one-YAML-per-document SOURCE. The CLI
 * is Foundry's own code, so it round-trips CSB content (effect_table /
 * reaction_config_table) and embedded actor-items faithfully — verified
 * byte-identical. This is the engine for MERGE-REBUILD reconciliation:
 *
 *   conflict on worlds/<world>/data/<collection> (binary, unmergeable)
 *     -> unpack OURS and THEIRS to YAML
 *     -> 3-way merge the YAML (readable; git can help)
 *     -> pack the merged YAML back to a LevelDB
 *     -> install it into the live world (backed up, verified)
 *
 * vs the other tools: world-export = clean review diffs + loss tripwire/hook;
 * world-import = surgical single-doc reconcile via the bridge (game OPEN);
 * world-pack = whole-collection rebuild via the CLI (game CLOSED for `install`).
 *
 * Usage:
 *   node bin/world-pack.js unpack  --collection items [--ref <gitref>] [--out <dir>]
 *   node bin/world-pack.js pack    --collection items --in <yamlDir> [--out <dir>]
 *   node bin/world-pack.js install --collection items --from <packedLevelDbDir>
 *
 *   unpack  LevelDB -> YAML. Read-only; copies the live DB first (lock-safe), or
 *           materializes a git ref's committed shards with --ref.
 *   pack    YAML -> LevelDB into a fresh dir. Safe; never touches the live world.
 *   install Swap a packed LevelDB into the live world collection. GAME CLOSED;
 *           backs up the existing collection, verifies the new DB opens, and
 *           auto-rolls-back if it doesn't.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { ClassicLevel } = require("classic-level");
const { worldDataDir, collectionDir, backupRoot, REPO_ROOT, DEFAULT_WORLD } = require("../lib/paths");
const { assertGameClosed } = require("../lib/lock");

const CLI = path.join(__dirname, "..", "node_modules", "@foundryvtt", "foundryvtt-cli", "fvtt.mjs");
const AUTHORED = ["folders", "items", "actors"];

function mergeWorkDir(world) {
  return path.join(worldDataDir(world), "..", "_merge-work");
}

function fvtt(action, name, inDir, outDir) {
  if (!fs.existsSync(CLI)) {
    throw new Error(`Foundry CLI not installed. Run \`npm install\` in tools/safe-edit.`);
  }
  execFileSync(process.execPath, [CLI, "package", action, "-n", name,
    "--in", inDir, "--out", outDir, "--yaml"], { stdio: "inherit" });
}

// Repoint CURRENT to the highest MANIFEST actually present — a copied/extracted
// LevelDB can carry a stale pointer (a live game's on-disk CURRENT lags).
function repairCurrent(dbDir) {
  const manifests = fs.readdirSync(dbDir).filter((f) => /^MANIFEST-\d+$/.test(f)).sort();
  if (manifests.length) fs.writeFileSync(path.join(dbDir, "CURRENT"), manifests[manifests.length - 1] + "\n");
  for (const lock of ["LOCK"]) { const p = path.join(dbDir, lock); if (fs.existsSync(p)) try { fs.rmSync(p); } catch { /* ignore */ } }
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `world-pack-${tag}-`));
}

// Produce a CLI-readable { parent, name } for a collection's LevelDB, from the
// live world (copy) or a git ref (archive). Never reads the live DB in place.
function materializeSource(world, collection, ref) {
  const parent = tmpDir(collection);
  const dst = path.join(parent, collection);
  fs.mkdirSync(dst, { recursive: true });
  if (ref) {
    const rel = path.relative(REPO_ROOT, collectionDir(collection, world)).split(path.sep).join("/");
    // Stream the committed shards out of the ref into <parent>/<rel>.
    execFileSync("bash", ["-c",
      `git archive ${ref} -- '${rel}' | tar -x -C '${parent}'`], { cwd: REPO_ROOT });
    // extracted at <parent>/<rel>; relink to <parent>/<collection>
    const extracted = path.join(parent, ...rel.split("/"));
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(extracted, dst);
  } else {
    const src = collectionDir(collection, world);
    for (const f of fs.readdirSync(src)) {
      if (f === "LOCK") continue;
      try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch { /* skip busy */ }
    }
  }
  repairCurrent(dst);
  return { parent, name: collection };
}

function arg(argv, flag, def) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; }

async function dbKeyCount(dir) {
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  let n = 0;
  try { for await (const _ of db.iterator()) n++; } finally { await db.close(); }
  return n;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const world = arg(argv, "--world", DEFAULT_WORLD);
  const collection = arg(argv, "--collection", null);
  if (!["unpack", "pack", "install"].includes(cmd) || !collection) {
    console.error("Usage: world-pack.js unpack|pack|install --collection <c> [...]  (c ∈ " + AUTHORED.join("/") + ")");
    process.exit(2);
  }

  if (cmd === "unpack") {
    const ref = arg(argv, "--ref", null);
    const out = arg(argv, "--out", path.join(mergeWorkDir(world), `${collection}__${ref ? ref.replace(/[^\w.-]/g, "_") : "live"}`));
    const { parent, name } = materializeSource(world, collection, ref);
    fs.mkdirSync(out, { recursive: true });
    fvtt("unpack", name, parent, out);
    fs.rmSync(parent, { recursive: true, force: true });
    console.log(`\n✓ unpacked ${collection}${ref ? ` @ ${ref}` : " (live)"} -> ${path.relative(REPO_ROOT, out)} (${fs.readdirSync(out).length} files)`);
    return;
  }

  if (cmd === "pack") {
    const inDir = arg(argv, "--in", null);
    if (!inDir || !fs.existsSync(inDir)) { console.error("pack needs --in <yamlDir>"); process.exit(2); }
    const out = arg(argv, "--out", path.join(mergeWorkDir(world), `${collection}__packed`));
    const parent = tmpDir(`pack-${collection}`);
    fvtt("pack", collection, inDir, parent);
    const packed = path.join(parent, collection);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.cpSync(packed, out, { recursive: true }); // copy, not rename (OS temp may be a different drive)
    fs.rmSync(parent, { recursive: true, force: true });
    const keys = await dbKeyCount(out);
    console.log(`\n✓ packed ${path.relative(REPO_ROOT, inDir)} -> ${path.relative(REPO_ROOT, out)} (LevelDB opens, ${keys} keys)`);
    console.log(`  Install into the live world (game CLOSED) with:`);
    console.log(`    node tools/safe-edit/bin/world-pack.js install --collection ${collection} --from ${path.relative(REPO_ROOT, out)}`);
    return;
  }

  if (cmd === "install") {
    const from = arg(argv, "--from", null);
    if (!from || !fs.existsSync(from)) { console.error("install needs --from <packedLevelDbDir>"); process.exit(2); }
    assertGameClosed(world); // refuses if Foundry holds a LOCK
    // Verify the source DB is valid BEFORE touching the live world.
    const srcKeys = await dbKeyCount(path.isAbsolute(from) ? from : path.join(REPO_ROOT, from));
    if (!srcKeys) throw new Error(`packed DB at ${from} has 0 keys — refusing to install.`);
    const live = collectionDir(collection, world);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(backupRoot(), `world-pack-${collection}-${stamp}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const f of fs.readdirSync(live)) fs.copyFileSync(path.join(live, f), path.join(backup, f));
    // Swap: clear live shard files, copy packed in.
    for (const f of fs.readdirSync(live)) if (/\.(ldb|log)$|^MANIFEST-|^CURRENT$/.test(f)) fs.rmSync(path.join(live, f));
    const fromAbs = path.isAbsolute(from) ? from : path.join(REPO_ROOT, from);
    for (const f of fs.readdirSync(fromAbs)) fs.copyFileSync(path.join(fromAbs, f), path.join(live, f));
    // Verify the live collection now opens with the expected key count; rollback if not.
    try {
      const liveKeys = await dbKeyCount(live);
      if (liveKeys !== srcKeys) throw new Error(`post-install key count ${liveKeys} != ${srcKeys}`);
      console.log(`\n✓ installed ${collection} (${liveKeys} keys). Backup: ${path.relative(REPO_ROOT, backup)}`);
      console.log(`  Re-open Foundry to confirm, then close + \`world-export report\` before committing.`);
    } catch (e) {
      for (const f of fs.readdirSync(live)) if (/\.(ldb|log)$|^MANIFEST-|^CURRENT$/.test(f)) fs.rmSync(path.join(live, f));
      for (const f of fs.readdirSync(backup)) fs.copyFileSync(path.join(backup, f), path.join(live, f));
      throw new Error(`install verification failed (${e.message}); ROLLED BACK from ${path.relative(REPO_ROOT, backup)}`);
    }
    return;
  }
}

main().catch((e) => { console.error(`world-pack failed: ${e.message}`); process.exit(1); });
