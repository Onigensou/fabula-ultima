"use strict";

/**
 * preflight/loader — read the world's LevelDB collections into an in-memory
 * model that the checks run against.
 *
 * WHY this exists separately from world-export's reader: world-export only ever
 * loads folders/items/actors and deliberately ignores scenes. The preflight
 * checkup NEEDS scenes (pre-placed tokens, dungeon tile state, links). This
 * loader reuses the exact same key-assembly trick — embedded documents live in
 * their OWN LevelDB keys (`!scenes.tiles!<sceneId>.<tileId>`), and the inline
 * arrays stored on the parent doc are stale/corrupt stubs (the Fafnir lesson).
 * So we strip the inline arrays and rebuild every embedded collection from its
 * own keys.
 *
 * Game MUST be closed (LevelDB single-process LOCK) — same constraint as
 * world-export. Runs entirely outside Foundry: zero in-game performance cost.
 */

const { ClassicLevel } = require("classic-level");
const { collectionDir, DEFAULT_WORLD } = require("../lib/paths");
const { collectionLocked } = require("../lib/lock");

// Field names that are EMBEDDED sub-collections (rebuilt from their own keys).
// Superset across actors/items/scenes/journal so the generic assembler strips
// the stale inline copies before reattaching the authoritative ones.
const EMBEDDED_FIELDS = new Set([
  "items", "effects",                                  // actors / items
  "tiles", "tokens", "walls", "lights", "notes",       // scenes
  "regions", "behaviors", "drawings", "sounds",
  "templates", "delta",
  "pages",                                             // journal
  "results", "cards",                                  // tables / cards
]);

// `!scenes.tiles!SCENEID.TILEID` -> { pathSegs:["scenes","tiles"], idSegs:[...] }
function parseKey(key) {
  const m = /^!([^!]+)!(.+)$/s.exec(key);
  if (!m) return null;
  return { pathSegs: m[1].split("."), idSegs: m[2].split(".") };
}

// Rebuild the document tree for one collection from its raw key/value entries.
// Identical strategy to world-export.assemble(), generalized to any depth so it
// handles scenes.tokens.delta.items etc.
function assemble(entries) {
  const tops = new Map(); // id -> top-level doc
  const embedded = [];
  for (const e of entries) {
    for (const f of EMBEDDED_FIELDS) delete e.value[f]; // drop stale inline stubs
    if (e.pathSegs.length === 1) tops.set(e.idSegs[0], e.value);
    else embedded.push(e);
  }
  // Shallowest first so a parent exists before its children attach.
  embedded.sort((a, b) => a.pathSegs.length - b.pathSegs.length);
  for (const e of embedded) {
    const field = e.pathSegs[e.pathSegs.length - 1];
    let parent = tops.get(e.idSegs[0]);
    for (let d = 1; parent && d < e.pathSegs.length - 1; d++) {
      const arr = parent[e.pathSegs[d]] || [];
      parent = Array.isArray(arr) ? arr.find((x) => x._id === e.idSegs[d]) : undefined;
    }
    if (!parent) continue; // orphaned embedded doc — skip
    (parent[field] = parent[field] || []).push(e.value);
  }
  return [...tops.values()];
}

async function readCollection(collection, world, allowLocked) {
  if (!allowLocked && collectionLocked(collection, world)) {
    throw Object.assign(
      new Error(
        `Collection "${collection}" is LOCKED (Foundry is running). Close the world first.`
      ),
      { code: "GAME_RUNNING" }
    );
  }
  const db = new ClassicLevel(collectionDir(collection, world), { valueEncoding: "json" });
  await db.open();
  const entries = [];
  try {
    for await (const [key, value] of db.iterator()) {
      const parsed = parseKey(key);
      if (parsed) entries.push({ ...parsed, value });
    }
  } finally {
    await db.close();
  }
  return assemble(entries);
}

/**
 * Load the world into an in-memory model + id indices the checks share.
 * Returns { world, actors, items, folders, scenes, journal, byId, has }.
 */
async function loadWorld({ world = DEFAULT_WORLD, allowLocked = false } = {}) {
  const COLLECTIONS = ["folders", "items", "actors", "scenes", "journal", "tables"];
  const model = { world };
  const byId = {};
  for (const c of COLLECTIONS) {
    let docs = [];
    try {
      docs = await readCollection(c, world, allowLocked);
    } catch (e) {
      if (e.code === "GAME_RUNNING") throw e;
      // A collection that doesn't exist yet (e.g. no journal) is not fatal.
      docs = [];
    }
    model[c] = docs;
    byId[c] = new Map(docs.map((d) => [d._id, d]));
  }
  model.byId = byId;
  // Convenience: does collection C contain id? (used by ref checks)
  model.has = (c, id) => byId[c]?.has(id) ?? false;
  return model;
}

module.exports = { loadWorld, assemble, parseKey };
