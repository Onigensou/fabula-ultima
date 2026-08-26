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
 *   node bin/world-pack.js unpack  --collection items [--ref <gitref>] [--out <dir>] [--force]
 *   node bin/world-pack.js pack    --collection items --in <yamlDir> [--out <dir>] [--expect <keys>]
 *   node bin/world-pack.js install --collection items --from <packedLevelDbDir> [--allow-new]
 *
 *   unpack  LevelDB -> YAML. Read-only; copies the live DB first (lock-safe), or
 *           materializes a git ref's committed shards with --ref. OWNS its output
 *           dir: stale files are cleared (--force for a dir that isn't a prior
 *           unpack), because _merge-work/ scratch outlives sessions and a
 *           leftover .yml resurrects a deleted document.
 *   pack    YAML -> LevelDB into a fresh dir. Safe; never touches the live world.
 *           Diffs the result against the installed collection and names every
 *           added/removed doc; --expect hard-asserts a key count.
 *   install Swap a packed LevelDB into the live world collection. GAME CLOSED;
 *           backs up the existing collection, verifies the new DB opens, and
 *           auto-rolls-back if it doesn't. REFUSES a changed document set until
 *           you confirm with --allow-new.
 *
 *   The key count is the oracle: a merge that ADDS keys when neither side added
 *   a document is wrong by construction (bc1e3738 shipped 3 ghost actors as
 *   3138 keys where both legitimate sides had 3111).
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

// Probe a LevelDB dir: key count if it opens, null if it doesn't. `createIfMissing:
// false` so a broken manifest can never be papered over with a fresh empty DB.
async function tryKeyCount(dir) {
  let db = null;
  try {
    db = new ClassicLevel(dir, { valueEncoding: "json", createIfMissing: false });
    await db.open();
    let n = 0;
    for await (const _ of db.keys()) n++;
    return n;
  } catch { return null; }
  finally { if (db) try { await db.close(); } catch { /* ignore */ } }
}

// Point CURRENT at a manifest that ACTUALLY OPENS.
//
// A copied/extracted LevelDB can carry a stale pointer (a live game's on-disk
// CURRENT lags) — but it can just as easily carry a DEAD manifest with a HIGHER
// number than the live one, e.g. a merge commit that kept both sides' manifests.
// The old rule ("highest MANIFEST wins") then clobbered a CORRECT CURRENT with
// that dead manifest, and every unpack died LEVEL_ITERATOR_NOT_OPEN.
//
// Root-caused 2026-08-26 on 661d2ba2/actors: CURRENT named MANIFEST-000024,
// which opens 3138 keys; the higher-numbered MANIFEST-125380 sitting beside it
// references .ldb shards that are not in the tree, so it cannot open at all.
//
// So: TRY the declared CURRENT first, then the rest newest-first, and keep the
// first that opens. Manifest number is a tiebreak, never the authority.
async function repairCurrent(dbDir) {
  const currentPath = path.join(dbDir, "CURRENT");
  const lockPath = path.join(dbDir, "LOCK");
  if (fs.existsSync(lockPath)) try { fs.rmSync(lockPath); } catch { /* ignore */ }

  const manifests = fs.readdirSync(dbDir)
    .filter((f) => /^MANIFEST-\d+$/.test(f))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))); // numeric, newest first
  if (!manifests.length) throw new Error(`no MANIFEST-* present in ${dbDir}`);

  const declared = fs.existsSync(currentPath)
    ? fs.readFileSync(currentPath, "utf8").trim()
    : null;
  const candidates = declared && manifests.includes(declared)
    ? [declared, ...manifests.filter((m) => m !== declared)]
    : manifests;

  for (const m of candidates) {
    fs.writeFileSync(currentPath, m + "\n");
    const keys = await tryKeyCount(dbDir);
    if (keys !== null) {
      if (m !== declared) console.error(`  ! CURRENT repaired: ${declared || "<missing>"} -> ${m} (${keys} keys)`);
      if (manifests.length > 1) {
        console.error(`  note: ${manifests.length} manifests present, using ${m} (${keys} keys); `
          + `unused: ${manifests.filter((x) => x !== m).join(", ")}`);
      }
      return keys;
    }
  }
  throw new Error(`no usable MANIFEST in ${dbDir} — tried ${candidates.join(", ")}`);
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `world-pack-${tag}-`));
}

// Produce a CLI-readable { parent, name } for a collection's LevelDB, from the
// live world (copy) or a git ref (archive). Never reads the live DB in place.
async function materializeSource(world, collection, ref) {
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
  const keys = await repairCurrent(dst);
  return { parent, name: collection, keys };
}

function arg(argv, flag, def) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; }

// Read a collection DB as { keys, docs } — total LevelDB keys plus a map of
// TOP-LEVEL document id -> name. Embedded rows (`!actors.items!a.b`) count as
// keys but are not documents, so both numbers matter: keys catch a smuggled
// embedded skill, docs name the actor it rode in on.
async function dbRead(dir, collection) {
  const db = new ClassicLevel(dir, { valueEncoding: "json", createIfMissing: false });
  await db.open();
  const re = new RegExp("^!" + collection + "!([^!.]+)$");
  const docs = new Map();
  let keys = 0;
  try {
    for await (const [k, v] of db.iterator()) {
      keys++;
      const m = re.exec(k);
      if (m) docs.set(m[1], (v && v.name) || "(unnamed)");
    }
  } finally { await db.close(); }
  return { keys, docs };
}

async function dbKeyCount(dir) {
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  let n = 0;
  try { for await (const _ of db.iterator()) n++; } finally { await db.close(); }
  return n;
}

// Read the LIVE collection WITHOUT touching it.
//
// Opening a LevelDB read-write ROTATES ITS MANIFEST, which lands in git as
// world-data churn (a modified CURRENT + a new MANIFEST-*) even though not one
// document changed. That is noise in exactly the review surface world-export
// exists to keep clean, and it breaks this file's own rule that the live store
// is never opened in place. So snapshot to temp and read the copy.
async function dbReadLive(world, collection) {
  const src = collectionDir(collection, world);
  const parent = tmpDir(`read-${collection}`);
  const dst = path.join(parent, collection);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f === "LOCK") continue;
    try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch { /* skip busy */ }
  }
  try {
    await repairCurrent(dst);
    return await dbRead(dst, collection);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

// Doc-level delta between two collection reads. The oracle from the bc1e3738
// post-mortem: every legitimate side had 3111 actor keys, the contaminated merge
// had 3138. A rebuild that ADDS documents neither side added is wrong by
// construction — so name the added/removed docs rather than just counting keys.
function docDelta(before, after) {
  const added = [...after.docs].filter(([id]) => !before.docs.has(id));
  const removed = [...before.docs].filter(([id]) => !after.docs.has(id));
  return { added, removed, keyDelta: after.keys - before.keys };
}

function printDelta(label, before, after, d) {
  console.log(`  keys: ${after.keys} vs ${before.keys} ${label} (Δ ${d.keyDelta >= 0 ? "+" : ""}${d.keyDelta})`);
  console.log(`  docs: ${after.docs.size} vs ${before.docs.size} ${label} (+${d.added.length} / -${d.removed.length})`);
  for (const [id, name] of d.added) console.log(`    + ${name}  [${id}]`);
  for (const [id, name] of d.removed) console.log(`    - ${name}  [${id}]`);
}

// An unpack OWNS its output directory.
//
// The Foundry CLI writes into its --out WITHOUT clearing it, and the default
// --out lives in `_merge-work/`, which is gitignored scratch that survives
// across sessions. So a document deleted from the world weeks ago keeps its
// .yml there, and a merge tree built by copying that dir resurrects it with
// nothing in any diff to say where it came from.
//
// 2026-08-26 post-mortem: exactly this shipped 3 ghost actors in bc1e3738, two
// of them the "Hellhound (Reanimated)" pair the co-dev had already filed a
// report asking us to stop shipping (purged in a3a23a2c, undone by the merge,
// re-fixed in 5b50867c). Clearing is therefore the default, not an option.
function prepareOutDir(out, force) {
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length) {
      const allYaml = entries.every((f) => /[.]ya?ml$/i.test(f)
        && fs.statSync(path.join(out, f)).isFile());
      if (!allYaml && !force) {
        throw new Error(`--out ${out} is not empty and does not look like a prior unpack `
          + `(${entries.length} entries, some not .yml). Refusing to clear it; `
          + `pass --force if you really mean to wipe that directory.`);
      }
      fs.rmSync(out, { recursive: true, force: true });
      console.error(`  ! cleared ${entries.length} stale file(s) from ${out}`);
    }
  }
  fs.mkdirSync(out, { recursive: true });
}

// Belt-and-braces on the above: after the CLI runs, every file in the output dir
// must have been written BY THIS RUN. Anything older was not rewritten, which
// means it is a ghost the clear missed.
function assertNoGhosts(out, startedAt) {
  const stale = fs.readdirSync(out)
    .filter((f) => fs.statSync(path.join(out, f)).mtimeMs < startedAt);
  if (stale.length) {
    console.error(`\n⚠  ${stale.length} file(s) in ${out} predate this unpack — GHOSTS, do not merge them:`);
    for (const f of stale.slice(0, 20)) console.error(`    ${f}`);
    if (stale.length > 20) console.error(`    ... and ${stale.length - 20} more`);
    throw new Error(`${stale.length} stale file(s) survived the unpack`);
  }
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
    const startedAt = Date.now();
    const { parent, name, keys: srcKeys } = await materializeSource(world, collection, ref);
    prepareOutDir(out, argv.includes("--force"));
    fvtt("unpack", name, parent, out);
    fs.rmSync(parent, { recursive: true, force: true });
    assertNoGhosts(out, startedAt);
    console.log(`\n✓ unpacked ${collection}${ref ? ` @ ${ref}` : " (live)"} -> ${path.relative(REPO_ROOT, out)} `
      + `(${fs.readdirSync(out).length} files, ${srcKeys} source keys)`);
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
    const packedRead = await dbRead(out, collection);
    console.log(`\n✓ packed ${path.relative(REPO_ROOT, inDir)} -> ${path.relative(REPO_ROOT, out)} `
      + `(LevelDB opens, ${packedRead.keys} keys, ${packedRead.docs.size} docs)`);

    // Ghost check: compare against the collection currently installed. Growth is
    // legal (the co-dev added content) but must be SEEN, because the failure mode
    // this tool shipped once is growth nobody looked at.
    const expect = arg(argv, "--expect", null);
    if (expect !== null && Number(expect) !== packedRead.keys) {
      throw new Error(`--expect ${expect} keys but packed DB has ${packedRead.keys}`);
    }
    try {
      const liveRead = await dbReadLive(world, collection);
      const d = docDelta(liveRead, packedRead);
      console.log(`\n  vs the installed ${collection} collection:`);
      printDelta("live", liveRead, packedRead, d);
      if (d.added.length) {
        console.log(`\n⚠  ${d.added.length} document(s) above are NOT in the live world.`);
        console.log(`  Confirm each is genuinely new content from the other side — a stale`);
        console.log(`  _merge-work/ .yml looks EXACTLY like this and re-ships deleted docs.`);
      }
    } catch (e) {
      console.log(`\n  (could not compare against the live collection: ${e.message})`);
    }
    console.log(`  Install into the live world (game CLOSED) with:`);
    console.log(`    node tools/safe-edit/bin/world-pack.js install --collection ${collection} --from ${path.relative(REPO_ROOT, out)}`);
    return;
  }

  if (cmd === "install") {
    const from = arg(argv, "--from", null);
    if (!from || !fs.existsSync(from)) { console.error("install needs --from <packedLevelDbDir>"); process.exit(2); }
    assertGameClosed(world); // refuses if Foundry holds a LOCK
    // Verify the source DB is valid BEFORE touching the live world.
    const fromDir = path.isAbsolute(from) ? from : path.join(REPO_ROOT, from);
    const incoming = await dbRead(fromDir, collection);
    const srcKeys = incoming.keys;
    if (!srcKeys) throw new Error(`packed DB at ${from} has 0 keys — refusing to install.`);
    const live = collectionDir(collection, world);

    // The gate the ghost-actor incident needed. An install REPLACES the whole
    // collection, so a document present here and absent from the live world is
    // either real new content or a resurrected ghost — and the two are
    // indistinguishable without looking. Make the operator look.
    const liveRead = await dbReadLive(world, collection);
    const d = docDelta(liveRead, incoming);
    console.log(`\nInstalling ${collection}:`);
    printDelta("live", liveRead, incoming, d);
    const acked = argv.includes("--allow-new");
    if ((d.added.length || d.removed.length) && !acked) {
      throw new Error(`this install changes the document set `
        + `(+${d.added.length} / -${d.removed.length}, listed above). Review each line — `
        + `an added doc that neither side authored is a stale _merge-work/ ghost — `
        + `then re-run with --allow-new to confirm.`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(backupRoot(), `world-pack-${collection}-${stamp}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const f of fs.readdirSync(live)) fs.copyFileSync(path.join(live, f), path.join(backup, f));
    // Swap: clear live shard files, copy packed in.
    for (const f of fs.readdirSync(live)) if (/\.(ldb|log)$|^MANIFEST-|^CURRENT$/.test(f)) fs.rmSync(path.join(live, f));
    for (const f of fs.readdirSync(fromDir)) fs.copyFileSync(path.join(fromDir, f), path.join(live, f));
    // Verify the live collection now opens with the expected key count; rollback if not.
    try {
      const liveKeys = await dbKeyCount(live);
      if (liveKeys !== srcKeys) throw new Error(`post-install key count ${liveKeys} != ${srcKeys}`);
      // A wholesale collection swap bypasses lib/db.js entirely (it moves shard
      // FILES), so announce it by hand or the regression gate would never learn
      // that every actor just changed. After the rollback branch, not before —
      // a rolled-back install changed nothing.
      if (collection === "actors") {
        try { require("../../skill-regression/lib/data-witness").bumpLocal("world-pack install actors"); } catch {}
      }
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
