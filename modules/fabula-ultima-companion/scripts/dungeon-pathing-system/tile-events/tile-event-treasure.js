// ============================================================================
// Dungeon Pathing — Tile Event: Treasure
// Delegates to the existing TreasureRoulette TileFrontEnd if available,
// otherwise shows a fallback notification.
//
// Clears the tile after triggering (treasure is consumed on pickup).
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][treasure]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.TREASURE, {
    label:             "Treasure",
    clearAfterTrigger: true,

    async handler(tileDoc, tokenDoc, scene) {
      const FE = window["oni.TreasureRoulette.TileFrontEnd"];

      if (FE?.onDbEnterTile) {
        // Hand off to the existing TreasureRoulette frontend
        await FE.onDbEnterTile({
          tileDocument:  tileDoc,
          tokenDocument: tokenDoc,
        });
        return;
      }

      // Fallback: no TreasureRoulette loaded
      console.warn(TAG, "TreasureRoulette TileFrontEnd not found. Showing generic treasure notification.");
      await ChatMessage.create({
        speaker: { alias: "System" },
        content: `<div style="text-align:center;font-size:1.4rem;padding:8px;">
          🎁 <b>Treasure!</b> (TreasureRoulette not loaded)
        </div>`
      });
    }
  });
})();
