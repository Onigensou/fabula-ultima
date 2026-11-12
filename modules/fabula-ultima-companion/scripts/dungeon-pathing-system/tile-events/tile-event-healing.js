// ============================================================================
// Dungeon Pathing — Tile Event: Healing (2026-11-12)
// The heal itself runs in dp-tile-effect-engine.js (it heals each member 35%
// of their max HP, see dp-heal-rules.js) from the tile's effectConfig, right
// after this handler. Registering the type is what makes the tile go spent
// after use: before this, "healing" had no handler, the dispatch never said
// "cleared", and the tile healed on every landing. A spent Healing tile comes
// back after a rest when its "Reset on rest" box is ticked.
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing;
  if (!DP?.TileEventRegistry) {
    console.warn("[DungeonPathing][TileEvent][healing] TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.HEALING, {
    label:             "Healing",
    clearAfterTrigger: true,
    async handler() {
      // Nothing here: the effect engine heals after dispatch.
    }
  });
})();
