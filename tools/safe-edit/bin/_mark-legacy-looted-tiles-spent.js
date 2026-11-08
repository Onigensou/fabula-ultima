"use strict";
// ============================================================================
// Mark loot tiles looted under the OLD treasure roulette as spent (2026-11-08).
//
// The old roulette only swapped the tile art to Blank_Tile.png and set its own
// `trTileConsumed` flag; DP's tileStates kept the loot type (item/gold/…), and
// no current code reads `trTileConsumed` — so those tiles pay out again when
// stepped on (and a dug Dirt→Treasure tile still offers Use).
//
// For every tile with flags.<mod>.trTileConsumed === true whose state is not
// blank, do what DP.TileState.clearTile does today:
//   · scene  flags.<mod>.dungeonPathing.tileStates.<id>.currentType = "blank"
//     (initialType / initialTexture untouched, so resetDungeon re-arms it)
//   · tile   flags.<mod>.dungeonPathing.consumed = true
// Texture is already Blank_Tile.png on all of them; it is not touched.
//
// Game must be closed. Dry run by default:
//   node tools/safe-edit/bin/_mark-legacy-looted-tiles-spent.js [--apply]
// ============================================================================

const path = require("node:path");
const LIB = path.join(__dirname, "..", "lib");
const { openCollection }     = require(LIB + "/db.js");
const { assertGameClosed }   = require(LIB + "/lock.js");
const { snapshotCollection } = require(LIB + "/backup.js");
const journal                = require(LIB + "/journal.js");
const { DEFAULT_WORLD }      = require(LIB + "/paths.js");

const MOD = "fabula-ultima-companion";
const APPLY = process.argv.includes("--apply");
const truthy = (v) => v === true || v === "true";

(async () => {
  assertGameClosed(DEFAULT_WORLD);

  // ── read ──
  const scenes = new Map();   // sceneId → { key, doc }
  const tiles = [];           // { key, sceneId, tileId, doc }
  {
    const db = await openCollection("scenes", DEFAULT_WORLD);
    try {
      for await (const [key, doc] of db.iterator()) {
        if (key.startsWith("!scenes!")) scenes.set(key.slice("!scenes!".length), { key, doc });
        else if (key.startsWith("!scenes.tiles!")) {
          const [sceneId, tileId] = key.slice("!scenes.tiles!".length).split(".");
          tiles.push({ key, sceneId, tileId, doc });
        }
      }
    } finally { await db.close(); }
  }

  // ── select ──
  const targets = [];
  for (const t of tiles) {
    const f = t.doc?.flags?.[MOD] ?? {};
    if (!truthy(f.trTileConsumed)) continue;
    const scene = scenes.get(t.sceneId);
    const st = scene?.doc?.flags?.[MOD]?.dungeonPathing?.tileStates?.[t.tileId];
    if (!st || st.currentType === "blank") continue;
    targets.push({ ...t, sceneName: scene.doc.name, from: st.currentType, consumedBefore: truthy(f.dungeonPathing?.consumed) });
  }
  const bySceneCount = {};
  for (const t of targets) bySceneCount[t.sceneName] = (bySceneCount[t.sceneName] ?? 0) + 1;
  console.log(`targets: ${targets.length}`, bySceneCount);
  for (const t of targets) console.log(`  ${t.sceneName} | ${t.tileId} | ${t.doc?.flags?.["monks-active-tiles"]?.name ?? ""} | ${t.from} → blank`);
  if (!APPLY) { console.log("\nDRY RUN — pass --apply to write."); return; }
  if (!targets.length) { console.log("nothing to do"); return; }

  // ── write ──
  const backupPath = snapshotCollection("scenes", DEFAULT_WORLD);
  console.log("backup:", backupPath);
  const now = Date.now();
  const touchedScenes = new Set(targets.map((t) => t.sceneId));
  const db = await openCollection("scenes", DEFAULT_WORLD);
  let ok = 0;
  try {
    const batch = db.batch();
    for (const sid of touchedScenes) {
      const s = scenes.get(sid).doc;
      const states = s.flags[MOD].dungeonPathing.tileStates;
      for (const t of targets.filter((x) => x.sceneId === sid)) states[t.tileId] = { ...states[t.tileId], currentType: "blank" };
      batch.put(scenes.get(sid).key, s);
    }
    for (const t of targets) {
      const d = t.doc;
      d.flags[MOD].dungeonPathing = { ...(d.flags[MOD].dungeonPathing ?? {}), consumed: true };
      d._stats = { ...(d._stats ?? {}), modifiedTime: now };
      batch.put(t.key, d);
    }
    await batch.write();

    // ── read back ──
    for (const t of targets) {
      const tile = await db.get(t.key);
      const scene = await db.get(scenes.get(t.sceneId).key);
      const cur = scene.flags[MOD].dungeonPathing.tileStates[t.tileId]?.currentType;
      if (cur === "blank" && tile.flags[MOD].dungeonPathing.consumed === true) ok++;
      else console.error("READ-BACK MISMATCH", t.sceneName, t.tileId, cur);
    }
  } finally { await db.close(); }

  journal.append({ uuid: `scenes:${targets.length} legacy-looted tiles`, collection: "scenes", key: "(batch)",
    beforeHash: "-", afterHash: "-", backupPath, patch: { tiles: targets.map((t) => `${t.sceneId}.${t.tileId}`) },
    note: "Mark tiles looted under the old roulette (trTileConsumed) as spent: currentType blank + consumed stamp" });
  console.log(`\nwritten + verified: ${ok}/${targets.length}`);
  if (ok !== targets.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
