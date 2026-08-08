"use strict";

const { ClassicLevel } = require("classic-level");
const { collectionDir, DEFAULT_WORLD } = require("./paths");

// The skill-regression Stop-hook gate needs to know when actor data changed, and
// it cannot see it any other way: safe-edit runs game-CLOSED from Bash, so the
// PostToolUse Edit/Write trigger never fires for these writes. Report from the
// one chokepoint every writer goes through. Optional on purpose — safe-edit must
// keep working if the sibling tool is absent or broken.
let bumpLocal = null;
try { ({ bumpLocal } = require("../../skill-regression/lib/data-witness")); } catch { /* tool not present */ }

/** Wrap the mutating methods so the first write announces itself, once. */
function witnessed(db, label) {
  if (!bumpLocal) return db;
  let announced = false;
  const announce = () => { if (!announced) { announced = true; bumpLocal(label); } };
  for (const m of ["put", "del", "batch", "clear"]) {
    const orig = db[m];
    if (typeof orig !== "function") continue;
    db[m] = function (...args) { announce(); return orig.apply(this, args); };
  }
  return db;
}

async function openCollection(collection, world = DEFAULT_WORLD, opts = {}) {
  const dir = collectionDir(collection, world);
  const db = new ClassicLevel(dir, { valueEncoding: "json", ...opts });
  await db.open();
  // Only `actors` matters: that is where skills live, and it is the collection
  // the regression golden is built from. Read-only opens (world-export walks
  // every collection) never trip it — the wrapper fires on write, not on open.
  return collection === "actors" ? witnessed(db, `safe-edit ${collection}`) : db;
}

async function withCollection(collection, world, fn) {
  const db = await openCollection(collection, world);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function getByKey(collection, key, world = DEFAULT_WORLD) {
  return withCollection(collection, world, async (db) => {
    try {
      return await db.get(key);
    } catch (e) {
      if (e.code === "LEVEL_NOT_FOUND") return null;
      throw e;
    }
  });
}

async function putByKey(collection, key, value, world = DEFAULT_WORLD) {
  return withCollection(collection, world, async (db) => {
    await db.put(key, value);
  });
}

module.exports = { openCollection, withCollection, getByKey, putByKey };
