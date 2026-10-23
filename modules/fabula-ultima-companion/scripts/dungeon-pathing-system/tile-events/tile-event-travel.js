// ============================================================================
// Dungeon Pathing — Tile Event: Travel (world-map travel day)
// ----------------------------------------------------------------------------
// One Travel tile = one Fabula Ultima travel day (Core p.106).
//
// The travel ROLL happens here, on the client that walked the turn, through
// TravelRoll.performRoll — so the Wayfarer passives apply and the Cartography
// reroll prompt reaches the player who owns it. The OUTCOME (day counter,
// danger / discovery, GM choice) resolves GM-side in dp-travel.js.
//
// Does NOT clear the tile — walking back over it rolls again.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][travel]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.TRAVEL, {
    label:             "Travel",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      const TR = globalThis.TravelRoll;
      if (!TR?.performRoll) { console.warn(TAG, "TravelRoll API not loaded"); return; }

      let roll = null;
      try {
        roll = await TR.performRoll(scene, { level: DP.Travel?.threatFor?.(tileDoc, scene) });
      } catch (e) {
        // A throw here would strand the player's turn — let it end normally.
        console.error(TAG, "travel roll failed:", e);
        return;
      }

      let res = null;
      try {
        res = await DP.Socket.requestTravel(scene, tileDoc?.id, tokenDoc?.id,
                                            { outcome: roll.outcome, level: roll.level });
      } catch (e) {
        console.error(TAG, "requestTravel failed:", e);
        return;
      }
      if (!res?.ok) console.warn(TAG, "travel outcome not resolved:", res?.error ?? "(no reason given)");

      // Same as a Random Battle tile: a launching battle tears the canvas down,
      // so the turn loop must skip its closing graph rebuild.
      if (res?.launched) {
        const st = globalThis.__ONI_DUNGEON_PATHING__?.state;
        if (st) st.battleLaunching = true;
      }
    }
  });
})();
