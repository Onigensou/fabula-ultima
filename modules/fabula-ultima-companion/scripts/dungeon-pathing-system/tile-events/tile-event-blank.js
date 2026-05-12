// ============================================================================
// Dungeon Pathing — Tile Event: Blank
// A cleared tile does nothing when stepped on.
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing;
  if (!DP?.TileEventRegistry) {
    console.warn("[DungeonPathing][TileEvent][blank] TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.BLANK, {
    label:             "Blank (No Event)",
    clearAfterTrigger: false,
    async handler(tileDoc, tokenDoc, scene) {
      // Blank tiles are already consumed — nothing happens.
    }
  });
})();
