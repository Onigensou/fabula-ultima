// ============================================================================
// Dungeon Pathing — Tile Events: Loot Tiles
// Registers all treasure-roulette tile types and routes the trigger to the GM
// client via DP.Socket.triggerTreasure so that isAuthorityClient() passes.
//
// clearAfterTrigger: false — TreasureRoulette manages its own tile clearing
// (blanks the tile when the player clicks Roll!, NOT when they step on it).
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][loot]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // All loot tile types share the same handler — type detection is done
  // inside TreasureRoulette's detectTileType() via the tile's texture.src.
  async function lootHandler(tileDoc, tokenDoc, scene) {
    const FE = window["oni.TreasureRoulette.TileFrontEnd"];
    if (!FE?.onDbEnterTile) {
      console.warn(TAG, "TreasureRoulette TileFrontEnd not found. Showing fallback.");
      await ChatMessage.create({
        speaker: { alias: "System" },
        content: `<div style="text-align:center;font-size:1.4rem;padding:8px;">
          🎁 <b>Treasure!</b> (TreasureRoulette not loaded)
        </div>`
      });
      return;
    }

    // Route to GM — isAuthorityClient() inside onDbEnterTile requires GM.
    const result = await DP.Socket.triggerTreasure(scene, tileDoc.id, tokenDoc.id);
    if (result && !result.ok) {
      console.warn(TAG, "triggerTreasure returned not-ok:", result.error);
    }
  }

  const LOOT_TYPES = [
    { key: DP.TILE_TYPES.TREASURE,   label: "Treasure"   },
    { key: DP.TILE_TYPES.GOLD,       label: "Zenit"      },
    { key: DP.TILE_TYPES.WEAPON,     label: "Weapon"     },
    { key: DP.TILE_TYPES.ARMOR,      label: "Armor"      },
    { key: DP.TILE_TYPES.ACCESSORY,  label: "Accessory"  },
    { key: DP.TILE_TYPES.CONSUMABLE, label: "Consumable" },
    { key: DP.TILE_TYPES.ITEM,       label: "Item (IP)"  },
  ];

  for (const { key, label } of LOOT_TYPES) {
    DP.TileEventRegistry.register(key, {
      label,
      clearAfterTrigger: false,
      handler: lootHandler,
    });
  }
})();
