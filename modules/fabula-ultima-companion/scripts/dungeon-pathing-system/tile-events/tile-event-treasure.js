// ============================================================================
// Dungeon Pathing — Tile Events: Loot Tiles
// Registers all treasure-roulette tile types and routes the trigger to the GM
// client so isAuthorityClient() inside onDbEnterTile passes.
//
// Routing uses game.socket directly (same pattern as TreasureRoulette's own
// claim arbitration) rather than socketlib, to avoid registration-timing issues.
//
// clearAfterTrigger: false — TreasureRoulette manages its own tile clearing
// when the player clicks Roll!, NOT when they step on the tile.
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing;
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEvent][loot]";
  const MSG_TYPE  = "DP_TRIGGER_TREASURE";
  const SOCKET_CH = `module.${MODULE_ID}`;

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // ── GM-side socket listener ─────────────────────────────────────────────────
  // Installed once on all clients; only GM actually handles the message.
  function setupSocketListener() {
    const GUARD = "__ONI_DP_TREASURE_SOCKET__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (msg?.type !== MSG_TYPE) return;
      if (!game.user?.isGM) return;

      const { sceneId, tileId, tokenId, dpTypeKey } = msg.payload ?? {};
      const scene    = game.scenes.get(sceneId);
      const tileDoc  = scene?.tiles.get(tileId);
      const tokenDoc = scene?.tokens.get(tokenId);

      if (!scene || !tileDoc || !tokenDoc) {
        console.warn(TAG, "DP_TRIGGER_TREASURE: could not resolve scene/tile/token",
          { sceneId, tileId, tokenId });
        return;
      }

      const FE = window["oni.TreasureRoulette.TileFrontEnd"];
      if (!FE?.onDbEnterTile) {
        console.warn(TAG, "DP_TRIGGER_TREASURE: TileFrontEnd not loaded on GM");
        return;
      }

      await FE.onDbEnterTile({
        tileDocument:      tileDoc,
        tokenDocument:     tokenDoc,
        tileType:          dpTypeKey,
        fromDungeonPathing: true,
      }).catch(e => console.error(TAG, "onDbEnterTile (socket) failed:", e));
    });

    console.debug(TAG, "GM socket listener installed.");
  }

  // ── Loot handler factory ────────────────────────────────────────────────────
  function makeLootHandler(dpTypeKey) {
    return async function lootHandler(tileDoc, tokenDoc, scene) {
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

      if (game.user?.isGM) {
        // GM can call onDbEnterTile directly (no routing needed).
        await FE.onDbEnterTile({
          tileDocument:      tileDoc,
          tokenDocument:     tokenDoc,
          tileType:          dpTypeKey,
          fromDungeonPathing: true,
        });
      } else {
        // Player: emit to the module socket channel — GM's listener picks it up.
        // Fire-and-forget; the Roll! prompt appears in chat for everyone.
        game.socket.emit(SOCKET_CH, {
          type:    MSG_TYPE,
          payload: {
            sceneId:   scene.id,
            tileId:    tileDoc.id,
            tokenId:   tokenDoc.id,
            dpTypeKey,
          },
        });
      }
    };
  }

  // ── Registry registrations ──────────────────────────────────────────────────
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
      handler: makeLootHandler(key),
    });
  }

  // Install listener after Foundry is ready (game.socket available).
  Hooks.once("ready", () => { setupSocketListener(); });
})();
