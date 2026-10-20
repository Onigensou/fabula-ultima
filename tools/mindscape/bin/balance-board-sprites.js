#!/usr/bin/env node
"use strict";
//
// Mindscape — fetch the token sprites the Balance Board shows, into a git-ignored cache.
//
//   node bin/balance-board-sprites.js
//
// Reads each monster's (and the party's) prototype token image + scale from a COPY of
// the world, downloads Forge-hosted art or copies world-local art into
// balance-board/.sprites/, and writes balance-board/.sprites/manifest.json. The art is
// the game's own and never goes into git (memory: game assets stay out of the repo).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { withCollection } = require("../../safe-edit/lib/db");
const { DEFAULT_WORLD, REPO_ROOT } = require("../../safe-edit/lib/paths");
const { snapshotWorld } = require("./encounter-matrix");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "balance-board", ".sprites");
const slug = (x) => String(x).toLowerCase().normalize("NFKD").replace(/^⭐️?\s*/u, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const PARTY_EXTRA = ["Hina", "Zarg", "Keren", "Blanche", "King Gorger"];

async function main() {
  const audit = JSON.parse(fs.readFileSync(path.join(ROOT, "expectations", "monster-audit.json"), "utf8"));
  const want = new Set([...audit.cards.map((c) => c.name), ...PARTY_EXTRA]);
  const copyDir = path.join(os.tmpdir(), "fu-board-sprites");
  const world = snapshotWorld(DEFAULT_WORLD, copyDir);
  const found = {};
  try {
    await withCollection("actors", world, async (db) => {
      for await (const [k, v] of db.iterator()) {
        if (!k.startsWith("!actors!") || !want.has(v.name) || found[v.name]) continue;
        const src = v.prototypeToken?.texture?.src || v.img;
        if (src) found[v.name] = { src, scale: Number(v.prototypeToken?.texture?.scaleX) || 1 };
      }
    });
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = {};
  for (const [name, { src, scale }] of Object.entries(found)) {
    const id = slug(name);
    const ext = (path.extname(decodeURIComponent(src.split("?")[0])) || ".png").toLowerCase();
    const file = `${id}${ext}`;
    try {
      if (/^https?:\/\//.test(src)) {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(path.join(OUT, file), Buffer.from(await res.arrayBuffer()));
      } else {
        fs.copyFileSync(path.join(REPO_ROOT, decodeURIComponent(src)), path.join(OUT, file));
      }
      manifest[id] = { name, file, scale, party: PARTY_EXTRA.includes(name) };
    } catch (e) {
      console.warn(`  skipped ${name}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${Object.keys(manifest).length}/${want.size} sprites → ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(`balance-board-sprites failed: ${e.stack || e.message}`); process.exit(1); });
