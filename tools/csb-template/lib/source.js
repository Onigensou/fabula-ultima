"use strict";

// Loading / saving CSB template documents, in both game states:
//   - GAME CLOSED: read & write the world LevelDB directly via the safe-edit lib
//     (sibling tool; reuses its classic-level dependency).
//   - GAME OPEN:   read & write through the test-bridge (see bridge.js).
//   - FILE:        read a template JSON snapshot (e.g. _template-backups/*.json
//     or the module's Game Object/Template/*.json placeholders) for pure
//     offline lint / inspection with no DB at all.
//
// A "doc" here is the whole document object: { _id, name, type, system, ... }.

const fs = require("fs");
const path = require("path");

// safe-edit lib lives next door; its node_modules (classic-level) resolve from
// its own dir, so requiring it from here works regardless of our cwd.
let safeEditLib = null;
function getSafeEdit() {
  if (!safeEditLib) safeEditLib = require("../../safe-edit/lib");
  return safeEditLib;
}

const DEFAULT_WORLD = "fabula-ultima-2";

// Resolve a "Item.<id>" / bare id / file path into a load descriptor.
function classify(ref) {
  if (typeof ref !== "string") throw new Error("source ref must be a string");
  if (ref.includes("/") || ref.includes("\\") || ref.toLowerCase().endsWith(".json")) {
    return { kind: "file", value: ref };
  }
  if (/^(Item|Actor)\./.test(ref)) return { kind: "uuid", value: ref };
  // bare id -> assume Item
  return { kind: "uuid", value: `Item.${ref}` };
}

// GAME CLOSED — read straight from the LevelDB.
async function loadFromDb(ref, world = DEFAULT_WORLD) {
  const { getDoc } = getSafeEdit();
  const { value: uuid } = classify(ref);
  const doc = await getDoc(uuid, world);
  if (!doc) throw new Error(`template not found in world "${world}": ${uuid}`);
  return { doc, uuid, source: "leveldb" };
}

// FILE — read a JSON snapshot.
function loadFromFile(file) {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, "utf8");
  const doc = JSON.parse(raw);
  const uuid = doc._id ? `Item.${doc._id}` : null;
  return { doc, uuid, source: abs };
}

// Convenience dispatcher for read-only paths (lint / show). Files and LevelDB
// only — the bridge read lives in bridge.js to keep this DB-only.
async function load(ref, { world = DEFAULT_WORLD } = {}) {
  const c = classify(ref);
  if (c.kind === "file") return loadFromFile(c.value);
  return loadFromDb(ref, world);
}

// GAME CLOSED — persist a patch via safe-edit (creates a backup + journal entry).
async function saveToDb(uuid, patch, { note, world = DEFAULT_WORLD, dryRun = false } = {}) {
  const { safeEdit } = getSafeEdit();
  return safeEdit({ uuid, patch, note: note || "csb-template edit", world, dryRun });
}

module.exports = {
  DEFAULT_WORLD,
  classify,
  load,
  loadFromDb,
  loadFromFile,
  saveToDb,
};
