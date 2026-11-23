#!/usr/bin/env node
"use strict";

/**
 * storediff — document-level diff of EVERY world store (data/* + packs/*),
 * live world on disk vs a git ref (default HEAD).
 *
 * WHY: `world-export report` only covers authored content (actors, items,
 * folders, tables, playlists). It is blind to settings, messages and users,
 * which hold real session state: camp phase, save choice, dungeon trip, the
 * chat log, and the data-migration ledger. On 2026-11-23 two co-dev pulls read
 * "report 0/0/0" as "local world changes are disposable", ran
 * `git reset --hard origin/main`, and wiped the 11-21 session's camp state,
 * 88 chat messages and the migration ledger (restored in 517617cf).
 *
 * RULE: run this before ANY reset / checkout / discard of world files.
 *   exit 0  = live == ref in every store (truly disposable churn)
 *   exit 1  = real differences: commit them first (`git add -A worlds/<w>`)
 *
 * SAFE TO RUN ANY TIME: it never opens the live LevelDB (opening rotates the
 * MANIFEST, see the manifest-rotation trap). It copies the live stores and
 * `git archive`s the ref into a temp dir and reads only those copies.
 * With Foundry running, the copy may miss unflushed writes; close it first
 * for a definitive answer (a warning is printed).
 *
 * Usage:
 *   node tools/safe-edit/bin/storediff.js [--ref HEAD] [--world fabula-ultima-2] [--verbose]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { ClassicLevel } = require("classic-level");
const { REPO_ROOT, WORLDS_DIR, DEFAULT_WORLD } = require("../lib/paths");
const { gameRunning } = require("../lib/lock");

// Values that change on every world open and carry no game state.
const VOLATILE_SETTINGS = new Set(["theripper-premium-hub.lastGitCheck"]);

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function stableHash(doc) {
  // Drop _stats (timestamps) so a re-save with no content change is not a diff.
  const strip = (o) => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === "object") {
      const out = {};
      for (const k of Object.keys(o).sort()) if (k !== "_stats") out[k] = strip(o[k]);
      return out;
    }
    return o;
  };
  let parsed;
  try { parsed = JSON.parse(doc); } catch { return crypto.createHash("sha1").update(doc).digest("hex"); }
  return crypto.createHash("sha1").update(JSON.stringify(strip(parsed))).digest("hex");
}

async function readStore(dir) {
  const m = new Map();
  const db = new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "utf8" });
  try {
    for await (const [k, v] of db.iterator()) m.set(k, v);
  } finally {
    await db.close();
  }
  return m;
}

function storesIn(worldDir) {
  const out = [];
  for (const grp of ["data", "packs"]) {
    const g = path.join(worldDir, grp);
    if (!fs.existsSync(g)) continue;
    for (const s of fs.readdirSync(g)) {
      if (fs.existsSync(path.join(g, s, "CURRENT"))) out.push(`${grp}/${s}`);
    }
  }
  return out;
}

function label(store, key, raw) {
  try {
    const d = JSON.parse(raw);
    if (store === "data/settings") return d.key ?? key;
    if (d.name) return `${key} (${d.name})`;
  } catch { /* fall through */ }
  return key;
}

async function main() {
  const world = arg("--world", DEFAULT_WORLD);
  const ref = arg("--ref", "HEAD");
  const verbose = process.argv.includes("--verbose");
  const rel = `worlds/${world}`;
  const liveWorld = path.join(WORLDS_DIR, world);

  if (gameRunning(world).running) {
    console.warn("⚠ Foundry appears to be running: unflushed writes may be missing from the copy. Close it for a definitive diff.");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "storediff-"));
  try {
    // Live copy (never open the real stores).
    const liveCopy = path.join(tmp, "live");
    for (const grp of ["data", "packs"]) {
      const src = path.join(liveWorld, grp);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(liveCopy, grp), { recursive: true });
    }
    // Ref copy via git archive | tar.
    const refDir = path.join(tmp, "ref");
    fs.mkdirSync(refDir);
    const tarFile = path.join(tmp, "ref.tar");
    execFileSync("git", ["archive", "-o", tarFile, ref, `${rel}/data`, `${rel}/packs`], { cwd: REPO_ROOT });
    // Relative paths + cwd: GNU tar (Git for Windows) reads "C:\..." as a remote host.
    execFileSync("tar", ["-xf", path.join("..", "ref.tar")], { cwd: refDir });
    const refWorld = path.join(refDir, rel);

    const stores = [...new Set([...storesIn(liveCopy), ...storesIn(refWorld)])].sort();
    let total = 0;
    for (const store of stores) {
      const a = fs.existsSync(path.join(refWorld, store, "CURRENT")) ? await readStore(path.join(refWorld, store)) : new Map();
      const b = fs.existsSync(path.join(liveCopy, store, "CURRENT")) ? await readStore(path.join(liveCopy, store)) : new Map();
      const added = [], removed = [], changed = [];
      for (const [k, v] of b) {
        if (store === "data/settings") { try { if (VOLATILE_SETTINGS.has(JSON.parse(v).key)) continue; } catch { /* keep */ } }
        if (!a.has(k)) added.push(label(store, k, v));
        else if (stableHash(a.get(k)) !== stableHash(v)) changed.push(label(store, k, v));
      }
      for (const [k, v] of a) if (!b.has(k)) removed.push(label(store, k, v));
      const n = added.length + removed.length + changed.length;
      if (!n) continue;
      total += n;
      console.log(`${store}: +${added.length} -${removed.length} ~${changed.length}`);
      const show = (sign, list) => {
        const lim = verbose ? list.length : 8;
        for (const x of list.slice(0, lim)) console.log(`    ${sign} ${x}`);
        if (list.length > lim) console.log(`    … ${list.length - lim} more (--verbose)`);
      };
      show("+", added); show("-", removed); show("~", changed);
    }

    if (!total) {
      console.log(`✓ live world == ${ref} in every store (only rotation churn). Safe to discard.`);
      return 0;
    }
    console.log(`\n⛔ live world has ${total} real document change(s) vs ${ref} (+ = only live, - = only in ${ref}).`);
    console.log(`  Do NOT reset/discard. Commit them first: close Foundry, flush WALs, git add -A ${rel}/data ${rel}/packs.`);
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
