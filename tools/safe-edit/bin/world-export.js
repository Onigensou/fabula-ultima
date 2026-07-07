#!/usr/bin/env node
"use strict";

/**
 * world-export — reviewable, per-document JSON export of authored world content.
 *
 * WHY: the delivery channel commits raw LevelDB shards (.ldb / MANIFEST-* /
 * CURRENT). Git treats those as opaque binary, so a `git diff` reveals NOTHING
 * about which actors/items/skills changed — content loss (e.g. the Fafnir wipe
 * that silently rolled 11 skills -> 9 shells) is invisible until someone
 * notices in-game. This tool exports each authored document to its own
 * human-readable JSON file under `worlds/<world>/_authored-export/`, so:
 *   - every change is reviewable in the PR diff,
 *   - a removed skill shows up as a deleted file / array entry,
 *   - `report` / `check` give a categorized changelog BEFORE you push.
 *
 * This is a COMPANION layer: the LevelDB shards are still the artifact Foundry
 * loads. The JSON is a review + tripwire surface, not (yet) re-imported.
 *
 * Game MUST be closed (LevelDB single-process LOCK) — same constraint as
 * committing worlds/. Run it right before `git add worlds/ && git commit`.
 *
 * Usage:
 *   node bin/world-export.js export   [--world W] [--allow-locked]
 *   node bin/world-export.js report   [--world W] [--since-baseline]
 *   node bin/world-export.js check    [--world W] [--since-baseline]
 *   node bin/world-export.js baseline [--world W] [--allow-locked]
 *
 * report/check diff the freshly-exported tree against a baseline and print
 * (or exit-1 on) a categorized changelog. Two baselines:
 *   - default = HEAD: "everything different from what the co-dev last got" —
 *     the SUBMIT GATE. Run before `git add worlds/ && commit`.
 *   - --since-baseline = a local checkpoint you set with the `baseline` command:
 *     "what changed since I last reviewed" — for tracking a long fix session
 *     with many concurrent edits without re-reviewing the whole pile each time.
 *
 * `baseline` exports, then snapshots the export tree to `_authored-export/.baseline/`
 * (gitignored). Run it after you've reviewed the current state to mark it "seen".
 *
 * --allow-locked: open the DB even if a LOCK is held (only safe against a COPY;
 *                 used for testing the exporter while the live game runs).
 * --no-export:    (report/check only) skip the re-export and diff the existing
 *                 export tree — for re-reviewing or a pre-commit hook.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ClassicLevel } = require("classic-level");
const { collectionDir, worldDataDir, REPO_ROOT, DEFAULT_WORLD } = require("../lib/paths");
const { collectionLocked } = require("../lib/lock");

// Collections that hold AUTHORED content (skills, NPCs, organization, loot
// tables, music). Deliberately excludes volatile session churn (scenes are
// handled by preflight's per-scene golden; combats/messages/fog are ignored).
const COLLECTIONS = ["folders", "items", "actors", "tables", "playlists"];

// Embedded sub-collection fields, rebuilt from their own LevelDB keys.
//   items/effects → actors & items;  results → RollTables;  sounds → Playlists.
const EMBEDDED_FIELDS = new Set(["items", "effects", "results", "sounds"]);

// CSB-derived sheet fields under `system` — pure noise, stripped for clean diffs.
const DERIVED_SYSTEM_FIELDS = ["body", "display", "header", "modifiers", "hidden", "attributeBar"];

// Volatile metadata that churns every session — stripped for diff stability.
const VOLATILE_STATS = ["modifiedTime", "lastModifiedBy"];

// Playback state on playlists/sounds churns constantly — strip so the diff
// reflects the authored playlist (which sounds it contains), not what's playing.
const VOLATILE_PLAYBACK = ["playing", "pausedTime", "timeSerial"];

function exportDir(world) {
  return path.join(worldDataDir(world), "..", "_authored-export");
}

function baselineDir(world) {
  return path.join(exportDir(world), ".baseline");
}

// --- key parsing -----------------------------------------------------------
// `!actors.items!ACTORID.ITEMID` -> { pathSegs:["actors","items"], idSegs:[...] }
function parseKey(key) {
  const m = /^!([^!]+)!(.+)$/s.exec(key);
  if (!m) return null;
  return { pathSegs: m[1].split("."), idSegs: m[2].split(".") };
}

// --- document tree assembly ------------------------------------------------
async function readCollectionTree(collection, world, allowLocked) {
  if (!allowLocked && collectionLocked(collection, world)) {
    throw new Error(
      `Collection "${collection}" is LOCKED (Foundry is running). Close the world first, ` +
      `or pass --allow-locked when running against a copy.`
    );
  }
  const dir = collectionDir(collection, world);
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  const entries = [];
  try {
    for await (const [key, value] of db.iterator()) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      entries.push({ ...parsed, value });
    }
  } finally {
    await db.close();
  }
  return assemble(entries);
}

function assemble(entries) {
  const tops = new Map(); // id -> doc
  const embedded = [];
  for (const e of entries) {
    // Strip embedded-collection fields up front; rebuilt from their own keys.
    // (Inline arrays in the stored doc are stale/corrupt stubs — see Fafnir notes.)
    for (const f of EMBEDDED_FIELDS) delete e.value[f];
    if (e.pathSegs.length === 1) tops.set(e.idSegs[0], e.value);
    else embedded.push(e);
  }
  // Shallow depth first so a parent exists before its children attach.
  embedded.sort((a, b) => a.pathSegs.length - b.pathSegs.length);
  for (const e of embedded) {
    const field = e.pathSegs[e.pathSegs.length - 1]; // "items" | "effects"
    let parent = tops.get(e.idSegs[0]);
    // Walk intermediate embedded levels (e.g. actors.items.effects -> the item).
    for (let d = 1; parent && d < e.pathSegs.length - 1; d++) {
      const arr = parent[e.pathSegs[d]] || [];
      parent = arr.find((x) => x._id === e.idSegs[d]);
    }
    if (!parent) continue; // orphaned embedded doc — skip
    (parent[field] = parent[field] || []).push(e.value);
  }
  // Stable ordering of embedded arrays by _id.
  for (const doc of tops.values()) sortEmbedded(doc);
  return [...tops.values()];
}

function sortEmbedded(doc) {
  for (const f of EMBEDDED_FIELDS) {
    if (Array.isArray(doc[f])) {
      doc[f].sort((a, b) => String(a._id).localeCompare(String(b._id)));
      for (const child of doc[f]) sortEmbedded(child);
    }
  }
}

// --- sanitization + stable serialization -----------------------------------
function sanitize(doc) {
  if (doc && typeof doc.system === "object" && doc.system) {
    for (const k of DERIVED_SYSTEM_FIELDS) delete doc.system[k];
  }
  if (doc && typeof doc._stats === "object" && doc._stats) {
    for (const k of VOLATILE_STATS) delete doc._stats[k];
  }
  for (const k of VOLATILE_PLAYBACK) if (k in doc) delete doc[k];
  for (const f of EMBEDDED_FIELDS) {
    if (Array.isArray(doc[f])) for (const child of doc[f]) sanitize(child);
  }
  return doc;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function serialize(doc) {
  return JSON.stringify(sortKeys(sanitize(doc)), null, 2) + "\n";
}

// --- write -----------------------------------------------------------------
function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function runExport(world, allowLocked) {
  const root = exportDir(world);
  const manifest = { generatedFromWorld: world, collections: {} };
  for (const collection of COLLECTIONS) {
    const docs = await readCollectionTree(collection, world, allowLocked);
    const outDir = path.join(root, collection);
    rmrf(outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const summary = [];
    for (const doc of docs) {
      fs.writeFileSync(path.join(outDir, `${doc._id}.json`), serialize(doc));
      summary.push(summarize(collection, doc));
    }
    summary.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    manifest.collections[collection] = summary;
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  return root;
}

function summarize(collection, doc) {
  const base = { id: doc._id, name: doc.name, type: doc.type };
  if (collection === "actors") {
    base.items = (doc.items || [])
      .map((it) => ({ id: it._id, name: it.name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    base.effects = (doc.effects || []).length;
  } else if (collection === "items") {
    base.effects = (doc.effects || []).length;
  } else if (collection === "folders") {
    base.parent = doc.folder || null;
  } else if (collection === "tables") {
    base.results = (doc.results || []).length;
  } else if (collection === "playlists") {
    base.sounds = (doc.sounds || []).length;
  }
  return base;
}

// --- baseline snapshot -----------------------------------------------------
function snapshotBaseline(world) {
  const root = exportDir(world);
  const base = baselineDir(world);
  rmrf(base);
  fs.mkdirSync(base, { recursive: true });
  // Copy each child of the export root individually — copying the root into its
  // own .baseline child would trip cpSync's "subdirectory of self" guard.
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.name === ".baseline") continue;
    const src = path.join(root, ent.name);
    const dst = path.join(base, ent.name);
    if (ent.isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
}

// --- diff providers --------------------------------------------------------
function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function relFromRepo(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

// Walk a tree, return repo-relative posix paths of .json files, skipping .baseline.
function walkJson(absDir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === ".baseline") continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".json")) out.push(relFromRepo(p));
    }
  };
  walk(absDir);
  return out;
}

// vs HEAD: one `git status` classifies the whole tree (N files = 1 subprocess).
function gitPrior(world) {
  const relRoot = relFromRepo(exportDir(world));
  return {
    label: "HEAD (last commit / last delivered to co-dev)",
    classify() {
      const added = [], removed = [], modified = [];
      let out;
      // -uall: list every untracked file individually. Without it git collapses
      // a wholly-untracked dir (the first export) into one entry and we'd miss it.
      try { out = git(["status", "--porcelain=v1", "--untracked-files=all", "--", relRoot]); }
      catch { return { added, removed, modified }; }
      for (const line of out.split("\n")) {
        if (!line) continue;
        const code = line.slice(0, 2);
        let p = line.slice(3).trim();
        if (p.includes(" -> ")) p = p.split(" -> ")[1];
        if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p);
        if (!p.endsWith(".json") || p.includes("/.baseline/")) continue;
        if (code === "??" || code.includes("A")) added.push(p);
        else if (code.includes("D")) removed.push(p);
        else if (code.includes("M") || code.includes("R")) modified.push(p);
      }
      return { added, removed, modified };
    },
    get(repoRel) {
      try { return git(["show", `HEAD:${repoRel}`]); } catch { return null; }
    },
  };
}

// vs local checkpoint: compare the export tree against the .baseline copy.
function baselinePrior(world) {
  const root = exportDir(world);
  const base = baselineDir(world);
  const relRoot = relFromRepo(root);
  const relBase = relFromRepo(base);
  const toBase = (repoRel) => repoRel.replace(`${relRoot}/`, `${relBase}/`);
  return {
    label: "local baseline checkpoint (last reviewed)",
    classify() {
      if (!fs.existsSync(base)) {
        throw new Error(`No baseline found at ${relBase}. Run \`baseline\` first.`);
      }
      const cur = new Set(walkJson(root));
      const prev = walkJson(base).map((p) => p.replace(`${relBase}/`, `${relRoot}/`));
      const prevSet = new Set(prev);
      const added = [...cur].filter((f) => !prevSet.has(f));
      const removed = [...prevSet].filter((f) => !cur.has(f));
      const modified = [...cur].filter((f) =>
        prevSet.has(f) &&
        fs.readFileSync(path.join(REPO_ROOT, f), "utf8") !==
          fs.readFileSync(path.join(REPO_ROOT, toBase(f)), "utf8"));
      return { added, removed, modified };
    },
    get(repoRel) {
      const p = path.join(REPO_ROOT, toBase(repoRel));
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    },
  };
}

// Compare an embedded array by id; surfaces silent within-document loss (a
// skill vanishing from an actor, a result row vanishing from a loot table).
function embeddedDelta(priorJson, currentJson, field, labelFn) {
  const setOf = (txt) => {
    try {
      const d = JSON.parse(txt);
      return new Map((d[field] || []).map((x) => [x._id, labelFn(x)]));
    } catch { return new Map(); }
  };
  const a = setOf(priorJson), b = setOf(currentJson);
  const removed = [...a].filter(([id]) => !b.has(id)).map(([, n]) => n);
  const added = [...b].filter(([id]) => !a.has(id)).map(([, n]) => n);
  return { removed, added };
}

// Which embedded array to watch for within-doc loss, per collection path.
function embeddedSpec(file) {
  if (file.includes("/actors/")) return { field: "items", label: (x) => x.name };
  if (file.includes("/tables/")) return { field: "results", label: (x) => x.text || (Array.isArray(x.range) ? x.range.join("-") : x._id) };
  return null;
}

function report(world, prior) {
  const relRoot = relFromRepo(exportDir(world));
  const { added, removed, modified } = prior.classify();

  // Within-document losses on modified files (the silent class — file survives
  // but a skill/result vanished from its embedded list).
  const losses = [];
  for (const f of modified) {
    const spec = embeddedSpec(f);
    if (!spec) continue;
    const delta = embeddedDelta(prior.get(f) || "{}", fs.readFileSync(path.join(REPO_ROOT, f), "utf8"), spec.field, spec.label);
    if (delta.removed.length) losses.push({ file: f, removed: delta.removed, added: delta.added });
  }

  const docName = (f) => path.basename(f, ".json");
  const short = (f) => f.split("/_authored-export/")[1];
  const lines = [];
  lines.push(`\n=== world-export report (${world}) ===`);
  lines.push(`baseline:   ${prior.label}`);
  lines.push(`export dir: ${relRoot}`);
  lines.push("");
  lines.push(`  added docs:    ${added.length}`);
  lines.push(`  removed docs:  ${removed.length}`);
  lines.push(`  modified docs: ${modified.length}`);

  if (removed.length) {
    lines.push("\n  ⚠ REMOVED documents (these will be DELETED for the co-dev):");
    for (const f of removed) lines.push(`     - ${short(f)}  [${docName(f)}]`);
  }
  if (losses.length) {
    lines.push("\n  ⚠ Embedded docs REMOVED from existing documents (skills from actors, result rows from tables):");
    for (const l of losses) {
      lines.push(`     - ${short(l.file)}`);
      lines.push(`         removed: ${l.removed.join(", ")}`);
      if (l.added.length) lines.push(`         added:   ${l.added.join(", ")}`);
    }
  }
  if (!removed.length && !losses.length) {
    lines.push("\n  ✓ No removals detected — safe to submit.");
  } else {
    lines.push("\n  Review the removals above before committing worlds/. If unexpected, you are");
    lines.push("  about to clobber co-dev content — STOP and reconcile first.");
  }
  console.log(lines.join("\n"));
  return { hasLosses: removed.length > 0 || losses.length > 0 };
}

// --- cli -------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "report";
  const world = (() => {
    const i = argv.indexOf("--world");
    return i >= 0 ? argv[i + 1] : DEFAULT_WORLD;
  })();
  const allowLocked = argv.includes("--allow-locked");
  const noExport = argv.includes("--no-export");
  const sinceBaseline = argv.includes("--since-baseline");

  if (!["export", "report", "check", "baseline"].includes(cmd)) {
    console.error(`Unknown command "${cmd}". Use: export | report | check | baseline`);
    process.exit(2);
  }

  if (!(noExport && cmd !== "export")) {
    const root = await runExport(world, allowLocked);
    console.log(`exported authored world content -> ${relFromRepo(root)}`);
  }

  if (cmd === "export") return;
  if (cmd === "baseline") {
    snapshotBaseline(world);
    console.log(`baseline checkpoint saved -> ${relFromRepo(baselineDir(world))}`);
    console.log("`report --since-baseline` will now show changes made after this point.");
    return;
  }

  const prior = sinceBaseline ? baselinePrior(world) : gitPrior(world);
  const { hasLosses } = report(world, prior);
  if (cmd === "check" && hasLosses) process.exit(1);
}

main().catch((e) => {
  console.error(`world-export failed: ${e.message}`);
  // Distinct code 3 = DB locked (game running) so callers/hooks can tell that
  // apart from a real content-loss failure (exit 1).
  process.exit(/LOCKED/.test(e.message) ? 3 : 1);
});
