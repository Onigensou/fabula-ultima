// ============================================================================
// Dungeon Pathing — Tile Event: Story / Final Story
//
// The story itself is GM-narrated; this handler only marks the beat as played.
// On landing (or on "Use" for a usable tile) the tile goes EXPIRED: it swaps to
// the desaturated Expired_Story_Tile texture but keeps its story/final type.
//
// Does NOT clear the tile after triggering — like a JRPG, a played story spot
// stays on the map. A teleporter on the tile still fires on every visit: the
// Teleporter System hooks dungeonPathing.turnEnd, which runs after this handler
// and never looks at the tile's type or texture.
//
// Persistence: the expired marker lives in the scene tileStates entry and on the
// tile document (flag + texture), both captured by the save system's
// dungeonTileData / sceneTileVisibility extractors.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][story]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  async function expire(tileDoc, tokenDoc, scene) {
    if (!tileDoc || !scene) return;
    await DP.Socket.expireTile(scene, tileDoc.id);
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.STORY, {
    label:             "Story",
    clearAfterTrigger: false,
    handler:           expire,
  });

  DP.TileEventRegistry.register(DP.TILE_TYPES.FINAL, {
    label:             "Final Story",
    clearAfterTrigger: false,
    handler:           expire,
  });
})();
