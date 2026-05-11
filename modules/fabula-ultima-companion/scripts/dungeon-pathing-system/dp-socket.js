// ============================================================================
// Dungeon Pathing System — Socket Handlers
// Registers GM-side socket operations so player clients can request:
//   - Tile state mutations (clear, mutate)
//   - Dungeon reset
// All socket calls are handled by the GM since scene flag writes require GM.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Socket]";

  // Socket handler names
  const HANDLERS = {
    CLEAR_TILE:       "dungeonPathing.clearTile",
    MUTATE_TILE:      "dungeonPathing.mutateTile",
    RESET_DUNGEON:    "dungeonPathing.resetDungeon",
    TRIGGER_TREASURE: "dungeonPathing.triggerTreasure",
  };

  DP.Socket = {
    _socket: null,

    /** Called from dp-bootstrap once socketlib is ready. */
    register(socket) {
      this._socket = socket;

      socket.register(HANDLERS.CLEAR_TILE, async ({ sceneId, tileId, updateTexture = true }) => {
        if (!game.user?.isGM) return { ok: false, error: "Not GM" };
        const scene = game.scenes.get(sceneId);
        if (!scene) return { ok: false, error: "Scene not found" };
        try {
          await DP.TileState.clearTile(scene, tileId, { updateTexture });
          return { ok: true };
        } catch (e) {
          console.error(TAG, "clearTile socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      socket.register(HANDLERS.MUTATE_TILE, async ({ sceneId, tileId, newType, newTexture }) => {
        if (!game.user?.isGM) return { ok: false, error: "Not GM" };
        const scene = game.scenes.get(sceneId);
        if (!scene) return { ok: false, error: "Scene not found" };
        try {
          await DP.TileState.mutateTile(scene, tileId, newType, newTexture ?? null);
          return { ok: true };
        } catch (e) {
          console.error(TAG, "mutateTile socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      socket.register(HANDLERS.RESET_DUNGEON, async ({ sceneId }) => {
        if (!game.user?.isGM) return { ok: false, error: "Not GM" };
        const scene = game.scenes.get(sceneId);
        if (!scene) return { ok: false, error: "Scene not found" };
        try {
          await DP.TileState.resetDungeon(scene);
          return { ok: true };
        } catch (e) {
          console.error(TAG, "resetDungeon socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      socket.register(HANDLERS.TRIGGER_TREASURE, async ({ sceneId, tileId, tokenId, tileType }) => {
        if (!game.user?.isGM) return { ok: false, error: "Not GM" };
        const scene = game.scenes.get(sceneId);
        if (!scene) return { ok: false, error: "Scene not found" };
        const tileDoc  = scene.tiles.get(tileId);
        const tokenDoc = scene.tokens.get(tokenId);
        if (!tileDoc)  return { ok: false, error: "Tile not found" };
        if (!tokenDoc) return { ok: false, error: "Token not found" };
        const FE = window["oni.TreasureRoulette.TileFrontEnd"];
        if (!FE?.onDbEnterTile) return { ok: false, error: "TileFrontEnd not loaded" };
        try {
          await FE.onDbEnterTile({ tileDocument: tileDoc, tokenDocument: tokenDoc, tileType });
          return { ok: true };
        } catch (e) {
          console.error(TAG, "triggerTreasure socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      console.debug(TAG, "Socket handlers registered.");
    },

    // ----- Client-side helpers (non-GM clients call these) -------------------

    async clearTile(scene, tileId, { updateTexture = true } = {}) {
      if (game.user?.isGM) {
        return DP.TileState.clearTile(scene, tileId, { updateTexture });
      }
      const socket = this._socket ?? window.FUCompanionSocket;
      if (!socket) { console.warn(TAG, "Socket not ready for clearTile"); return; }
      return socket.executeAsGM(HANDLERS.CLEAR_TILE, { sceneId: scene.id, tileId, updateTexture });
    },

    async mutateTile(scene, tileId, newType, newTexture = null) {
      if (game.user?.isGM) {
        return DP.TileState.mutateTile(scene, tileId, newType, newTexture);
      }
      const socket = this._socket ?? window.FUCompanionSocket;
      if (!socket) { console.warn(TAG, "Socket not ready for mutateTile"); return; }
      return socket.executeAsGM(HANDLERS.MUTATE_TILE, { sceneId: scene.id, tileId, newType, newTexture });
    },

    async resetDungeon(scene) {
      if (game.user?.isGM) {
        return DP.TileState.resetDungeon(scene);
      }
      const socket = this._socket ?? window.FUCompanionSocket;
      if (!socket) { console.warn(TAG, "Socket not ready for resetDungeon"); return; }
      return socket.executeAsGM(HANDLERS.RESET_DUNGEON, { sceneId: scene.id });
    },

    async triggerTreasure(scene, tileId, tokenId, tileType) {
      if (game.user?.isGM) {
        const FE = window["oni.TreasureRoulette.TileFrontEnd"];
        if (!FE?.onDbEnterTile) { console.warn(TAG, "TileFrontEnd not loaded"); return { ok: false, error: "TileFrontEnd not loaded" }; }
        const tileDoc  = scene.tiles.get(tileId);
        const tokenDoc = scene.tokens.get(tokenId);
        try {
          await FE.onDbEnterTile({ tileDocument: tileDoc, tokenDocument: tokenDoc, tileType });
          return { ok: true };
        } catch (e) {
          console.error(TAG, "triggerTreasure failed", e);
          return { ok: false, error: e?.message };
        }
      }
      const socket = this._socket ?? window.FUCompanionSocket;
      if (!socket) { console.warn(TAG, "Socket not ready for triggerTreasure"); return { ok: false, error: "Socket not ready" }; }
      return socket.executeAsGM(HANDLERS.TRIGGER_TREASURE, { sceneId: scene.id, tileId, tokenId, tileType });
    }
  };
})();
