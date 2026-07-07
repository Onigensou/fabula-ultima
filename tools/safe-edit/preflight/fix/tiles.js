"use strict";

/**
 * fix/tiles — repair dungeon tiles whose saved state is inert while the tile
 * clearly infers a real type (the "does nothing at runtime" bug).
 *
 * OFFLINE fix (game closed): tile state is a scene FLAG, not fragile embedded
 * data, so we write it through safe-edit's `safeEdit` — which backs up the whole
 * scenes collection, writes, reads back and hash-verifies, and journals the
 * change (reversible with `safe-edit rollback <entryId>`).
 *
 * Rules (mirrors the runtime resync + "don't un-consume" rule):
 *   - initialType  -> always corrected to the inferred type (setup intent).
 *   - currentType  -> corrected to the inferred type ONLY when it is currently
 *                     inert (blank/unknown/missing). A tile whose currentType is
 *                     a different REAL type may have been legitimately consumed
 *                     mid-session, so we never overwrite that.
 *   - missing entry -> created full (initial+current = inferred, initialTexture
 *                     from the tile) so the tile is deterministic on load.
 */

const { safeEdit } = require("../../lib/edit");
const {
  MODULE_ID, PATHING_ROOT_KEY, inferType, getTileStates, isDungeonScene,
} = require("../tile-type");

const ID = "tiles";
const INERT = new Set(["blank", "unknown"]);
const base = (sceneId) => `flags.${MODULE_ID}.${PATHING_ROOT_KEY}.tileStates`;

// Build the list of tile repairs needed across the world (offline).
function plan(world) {
  const actions = [];
  for (const scene of world.scenes) {
    if (!isDungeonScene(scene)) continue;
    const states = getTileStates(scene);
    for (const tile of scene.tiles || []) {
      const inferred = inferType(tile);
      if (INERT.has(inferred)) continue;           // can't confidently repair
      const st = states[tile._id];

      if (!st) {
        actions.push({
          kind: "create", sceneId: scene._id, sceneName: scene.name, tileId: tile._id,
          inferred, oldInitial: null, oldCurrent: null,
          newInitial: inferred, newCurrent: inferred,
          initialTexture: tile.texture?.src ?? null,
          targetIds: [scene._id, tile._id, scene.name],
        });
        continue;
      }

      // Only act on the STALE-CONFIG bug: the tile's setup capture (initialType)
      // disagrees with what its name/texture infers. If initialType is already
      // correct, we NEVER touch the tile — a real initialType with an inert
      // currentType is a legitimately CONSUMED tile (stepped on in play), and
      // un-consuming it would resurrect a treasure/battle the party already
      // cleared. (Mirrors the runtime "don't un-consume" rule.)
      const fixInitial = st.initialType !== inferred;
      if (!fixInitial) continue;

      // When we do repair the setup, also refresh currentType to the real type
      // if it's currently inert (this tile never worked, so it wasn't consumed).
      const fixCurrent = INERT.has(st.currentType) || st.currentType == null;
      actions.push({
        kind: "refresh", sceneId: scene._id, sceneName: scene.name, tileId: tile._id,
        inferred, oldInitial: st.initialType ?? null, oldCurrent: st.currentType ?? null,
        newInitial: inferred,
        newCurrent: fixCurrent ? inferred : st.currentType,   // keep a real consumed type
        targetIds: [scene._id, tile._id, scene.name],
      });
    }
  }
  return actions;
}

function describe(a) {
  const root = base();
  if (a.kind === "create") {
    return `Scene "${a.sceneName}" tile ${a.tileId}: CREATE state → initial/current="${a.inferred}"`;
  }
  const parts = [];
  if (a.oldInitial !== a.newInitial) parts.push(`initial "${a.oldInitial}"→"${a.newInitial}"`);
  if (a.oldCurrent !== a.newCurrent) parts.push(`current "${a.oldCurrent}"→"${a.newCurrent}"`);
  return `Scene "${a.sceneName}" tile ${a.tileId}: ${parts.join(", ")}`;
}

// Apply the repairs, one safeEdit per scene (all that scene's tiles in one
// patch = one backup + one journal entry). Returns [{ scene, entryId, tiles }].
async function apply(actions, { world, dryRun }) {
  const bySene = new Map();
  for (const a of actions) {
    if (!bySene.has(a.sceneId)) bySene.set(a.sceneId, []);
    bySene.get(a.sceneId).push(a);
  }
  const results = [];
  for (const [sceneId, group] of bySene) {
    const root = base();
    const patch = {};
    for (const a of group) {
      patch[`${root}.${a.tileId}.initialType`] = a.newInitial;
      patch[`${root}.${a.tileId}.currentType`] = a.newCurrent;
      if (a.kind === "create" && a.initialTexture) {
        patch[`${root}.${a.tileId}.initialTexture`] = a.initialTexture;
      }
    }
    const res = await safeEdit({
      uuid: `Scene.${sceneId}`,
      patch,
      note: `preflight fix tiles: ${group.length} tile(s) on "${group[0].sceneName}"`,
      dryRun,
      world,
    });
    results.push({ sceneId, sceneName: group[0].sceneName, tiles: group.length, entryId: res.entryId || null, dryRun });
  }
  return results;
}

module.exports = { id: ID, plan, describe, apply, mode: "offline" };
