"use strict";

/**
 * suite: tiles — Dungeon Mode tile validity.
 *
 * Runtime behaviour is driven ENTIRELY by scene flag
 * `flags.<module>.dungeonPathing.tileStates.<tileId>.currentType` — the tile's
 * texture/name are only what the type was INFERRED from at setup. Two silent
 * failure modes bite at the table (see the "dungeon tiles stop working" notes):
 *
 *   1. A tile has NO state entry     -> it does nothing when stepped on.
 *   2. A tile was reconfigured but    -> its state still describes the OLD tile;
 *      its state wasn't refreshed         the name now infers a different type.
 *
 * Plus housekeeping: state entries left behind for tiles that were deleted.
 */

const { SEVERITY, finding } = require("../util");
const { MODULE_ID, PATHING_ROOT_KEY, VALID_TYPES, inferType, getTileStates, isDungeonScene } = require("../tile-type");

const ID = "tiles";
const TITLE = "Dungeon tile validity";

// Types that mean "the engine treats this tile as doing nothing".
const INERT = new Set(["blank", "unknown"]);

// Beneficial tiles get a Use button; forced ones (battle, trap, skill check,
// story, …) fire on Confirm. Decided 2026-11-12.
const LOOT_TYPES = ["gold", "consumable", "item", "weapon", "armor", "accessory", "treasure"];
const USABLE_TYPES = new Set(["camp", "dirt", "healing", "gathering", "fishing", ...LOOT_TYPES]);
// Loot / gathering drawn with the Blank texture are hidden surprises: forced.
const HIDDEN_OK = new Set(["gathering", ...LOOT_TYPES]);
// Come back after a rest (a new day).
const RESET_ON_REST_TYPES = new Set(["healing", "fishing"]);

function run(world) {
  const out = [];

  for (const scene of world.scenes) {
    if (!isDungeonScene(scene)) continue;
    const states = getTileStates(scene);
    const tiles = scene.tiles || [];
    const tileIds = new Set(tiles.map((t) => t._id));
    const byId = new Map(tiles.map((t) => [t._id, t]));

    // 1. Tiles with a real-looking type but NO state entry. The engine lazily
    //    ensures state on scene load, so this is a smell (verify it ensures),
    //    not a hard block — hence WARN, and only for tiles whose name/texture
    //    clearly infers a real type (decorative tiles legitimately have none).
    for (const tile of tiles) {
      if (states[tile._id]) continue;
      const inferred = inferType(tile);
      if (INERT.has(inferred)) continue;
      out.push(finding(ID, SEVERITY.WARN,
        `Scene "${scene.name}": tile ${tile._id} looks like a "${inferred}" tile but has NO saved state — confirm it gets ensured on load`,
        { doc: "scene", id: scene._id, extra: tile._id }));
    }

    // Beneficial tiles without the Usable flag (2026-11-12 rule): Confirm fires
    // them at once and there is no Use button, so the party can't walk across.
    // Judged on the tile's ORIGINAL type, so a spent tile that a reset will
    // re-arm is checked too. Hidden surprises (loot / gathering drawn with the
    // Blank texture) are forced on purpose and are left alone.
    for (const tile of tiles) {
      const st = states[tile._id];
      const type = st?.initialType || st?.currentType || inferType(tile);
      if (!USABLE_TYPES.has(type)) continue;
      const dp = tile.flags?.[MODULE_ID]?.[PATHING_ROOT_KEY] ?? {};
      const on = (v) => v === true || v === "true";
      const hidden = HIDDEN_OK.has(type) && /blank/i.test(String(tile.texture?.src ?? ""));
      if (!hidden && !on(dp.usable)) {
        out.push(finding(ID, SEVERITY.WARN,
          `Scene "${scene.name}": ${type} tile ${tile._id} is not Usable — no Use button, and Confirm sets it off`,
          { doc: "scene", id: scene._id, extra: tile._id }));
      }
      if (RESET_ON_REST_TYPES.has(type) && !on(dp.resetOnRest)) {
        out.push(finding(ID, SEVERITY.WARN,
          `Scene "${scene.name}": ${type} tile ${tile._id} has no "Reset on rest" — once used it never comes back`,
          { doc: "scene", id: scene._id, extra: tile._id }));
      }
    }

    // 2. Walk the state entries. Collapse harmless orphans into one summary.
    let orphans = 0;
    for (const [tileId, st] of Object.entries(states)) {
      // Orphan: state for a tile that no longer exists. Harmless leftover — the
      // tile is gone so it can't misbehave — but a sign of churn worth cleaning.
      if (!tileIds.has(tileId)) { orphans++; continue; }

      // Corrupt: currentType is not any known tile type. Unambiguously broken.
      if (st.currentType != null && !VALID_TYPES.has(st.currentType)) {
        out.push(finding(ID, SEVERITY.FAIL,
          `Scene "${scene.name}": tile ${tileId} has invalid currentType "${st.currentType}" — not a known tile type`,
          { doc: "scene", id: scene._id, extra: tileId }));
      }

      // Stale config — THE runtime bug. The tile's name/texture clearly infers a
      // REAL type, but its saved state disagrees (usually blank): the tile was
      // reconfigured after setup and its state was never refreshed, so at the
      // table it does nothing / the wrong thing. We only trust the inference
      // when it yields a real type — inferType returning "blank" for a tile that
      // wears Blank_Tile.png by design (hidden-loot) must NOT flag a real stored
      // type, so that (opposite) direction is intentionally ignored.
      const inferred = inferType(byId.get(tileId));
      const stored = st.initialType;
      if (!INERT.has(inferred) && stored && inferred !== stored) {
        const how = INERT.has(stored)
          ? `but its saved state is inert ("${stored}") — it will do NOTHING at runtime`
          : `but its saved state says "${stored}"`;
        out.push(finding(ID, SEVERITY.WARN,
          `Scene "${scene.name}": tile ${tileId} name/texture infers "${inferred}" ${how} (state not refreshed after reconfigure)`,
          { doc: "scene", id: scene._id, extra: tileId }));
      }
    }
    if (orphans) {
      out.push(finding(ID, SEVERITY.INFO,
        `Scene "${scene.name}": ${orphans} stale tileState entr${orphans === 1 ? "y" : "ies"} for deleted tiles (harmless leftovers; resetDungeon or clean up to declutter)`,
        { doc: "scene", id: scene._id }));
    }
  }

  return out;
}

module.exports = { id: ID, title: TITLE, run };
