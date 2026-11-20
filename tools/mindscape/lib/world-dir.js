"use strict";
//
// Mindscape — read another world's data instead of this repo's (`--world-dir <dir>`).
//
// Use it for a world that lives elsewhere, such as a test sandbox with a migration
// applied that the repo world does not have yet. <dir> is a world folder (holding
// data/) or its data/ folder. The collections Mindscape reads are COPIED to a temp
// folder first (LOCK skipped), so the source may be open in Foundry: nothing is
// ever opened in place, and a live LevelDB is never touched (opening one can rotate
// its MANIFEST).
//
// Must be required BEFORE anything that loads safe-edit's db.js: db.js takes
// collectionDir from paths.js when it loads, and this swaps that function first.
// Removes its own flag from process.argv so the CLI parsers never see it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const COLLECTIONS = ["actors", "items", "folders", "scenes", "tables"];

function takeFlag(argv) {
  const i = argv.indexOf("--world-dir");
  if (i < 0) return process.env.MINDSCAPE_WORLD_DIR || null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  if (!v) throw new Error("Mindscape: --world-dir needs a folder");
  return v;
}

function applyWorldDir(argv = process.argv) {
  const src = takeFlag(argv);
  if (!src) return null;
  let data = path.resolve(src);
  if (!fs.existsSync(path.join(data, "actors")) && fs.existsSync(path.join(data, "data", "actors"))) data = path.join(data, "data");
  if (!fs.existsSync(path.join(data, "actors"))) throw new Error(`Mindscape: no actors collection under ${src}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindscape-world-"));
  for (const c of COLLECTIONS) {
    const from = path.join(data, c);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, c), { recursive: true, filter: (p) => !/[\\/]LOCK$/.test(p) });
  }
  process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  const paths = require("../../safe-edit/lib/paths");
  paths.collectionDir = (collection) => path.join(tmp, collection);
  paths.worldDataDir = () => tmp;
  console.log(`⚠ WORLD FROM ${data} (copied, read-only)`);
  return data;
}

module.exports = { applyWorldDir };
