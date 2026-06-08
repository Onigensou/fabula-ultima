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

  // Socket handler names (socketlib — used where timing allows)
  const HANDLERS = {
    CLEAR_TILE:             "dungeonPathing.clearTile",
    MUTATE_TILE:            "dungeonPathing.mutateTile",
    RESET_DUNGEON:          "dungeonPathing.resetDungeon",
    TRIGGER_TREASURE:       "dungeonPathing.triggerTreasure",
    MARK_VISITED:           "dungeonPathing.markVisited",
    UNMARK_VISITED:         "dungeonPathing.unmarkVisited",
    FAST_TRAVEL_TELEPORT:   "dungeonPathing.fastTravelTeleport",
  };

  // Raw game.socket channel — used for operations that must survive the socketlib.ready
  // timing race.  socketlib fires its ready hook before our module's ready hook, so
  // Hooks.once("socketlib.ready") registered inside installHooks() is always missed.
  // game.socket has no such race: it is available as soon as Hooks.once("ready") fires.
  const RAW_CH    = `module.${DP.MODULE_ID ?? "fabula-ultima-companion"}`;
  const MSG_MV    = "DP_MARK_VISITED";
  const MSG_AS    = "DP_ACTIVATE_SCENE";
  const MSG_TAE   = "DP_TICK_PARTY_AES";
  const MV_GUARD  = "__ONI_DP_MV_SOCKET__";

  DP.Socket = {
    _socket: null,

    /**
     * Install a raw game.socket listener for markVisited requests from player clients.
     * Called on Hooks.once("ready") — game.socket is guaranteed available by then.
     */
    setupRawListener() {
      if (window[MV_GUARD]) return;
      window[MV_GUARD] = true;

      game.socket.on(RAW_CH, async (msg) => {
        if (!game.user?.isGM) return;

        if (msg?.type === MSG_MV) {
          const { sceneId, tileId } = msg.payload ?? {};
          const scene = game.scenes.get(sceneId);
          if (!scene || !tileId) { console.warn(TAG, "raw markVisited: bad payload", msg.payload); return; }
          await DP.TileState.markVisited(scene, tileId)
            .catch(e => console.warn(TAG, "raw markVisited failed:", e));
          return;
        }

        if (msg?.type === MSG_AS) {
          const { sceneUuid } = msg.payload ?? {};
          if (!sceneUuid) { console.warn(TAG, "raw activateScene: missing sceneUuid"); return; }
          const campScene = await fromUuid(sceneUuid).catch(() => null);
          if (!campScene || !(campScene instanceof Scene)) {
            console.warn(TAG, "raw activateScene: scene not found for UUID", sceneUuid);
            return;
          }
          await campScene.activate()
            .catch(e => console.warn(TAG, "raw activateScene failed:", e));
          return;
        }

        if (msg?.type === MSG_TAE) {
          // Player client finished a dungeon turn — tick party AEs as GM.
          await DP.AELifecycle?.tickPartyAEs?.()
            .catch(e => console.warn(TAG, "raw tickPartyAEs failed:", e));
          return;
        }
      });

      console.debug(TAG, "Raw socket listener installed (markVisited, activateScene, tickPartyAEs).");
    },

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
          await FE.onDbEnterTile({ tileDocument: tileDoc, tokenDocument: tokenDoc, tileType, fromDungeonPathing: true });
          return { ok: true };
        } catch (e) {
          console.error(TAG, "triggerTreasure socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      socket.register(HANDLERS.MARK_VISITED, async ({ sceneId, tileId }) => {
        if (!game.user?.isGM) return { ok: false, error: "Not GM" };
        const scene = game.scenes.get(sceneId);
        if (!scene) return { ok: false, error: "Scene not found" };
        try {
          await DP.TileState.markVisited(scene, tileId);
          return { ok: true };
        } catch (e) {
          console.error(TAG, "markVisited socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      socket.register(HANDLERS.UNMARK_VISITED, async ({ sceneId, tileId }) => {
        if (!game.user?.isGM) return { ok: false, error: "Not GM" };
        const scene = game.scenes.get(sceneId);
        if (!scene) return { ok: false, error: "Scene not found" };
        try {
          await DP.TileState.unmarkVisited(scene, tileId);
          return { ok: true };
        } catch (e) {
          console.error(TAG, "unmarkVisited socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      socket.register(HANDLERS.FAST_TRAVEL_TELEPORT, async ({ sceneId, tokenId, x, y }) => {
        if (!game.user?.isGM) return { ok: false, error: "Not GM" };
        const scene = game.scenes.get(sceneId);
        if (!scene) return { ok: false, error: "Scene not found" };
        const tokenDoc = scene.tokens.get(tokenId);
        if (!tokenDoc) return { ok: false, error: "Token not found" };
        try {
          await tokenDoc.update({ x, y }, { dungeonPathing: true, animate: false });
          return { ok: true };
        } catch (e) {
          console.error(TAG, "fastTravelTeleport socket handler failed", e);
          return { ok: false, error: e?.message };
        }
      });

      console.debug(TAG, "Socketlib handlers registered.");
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

    async markVisited(scene, tileId) {
      if (game.user?.isGM) {
        return DP.TileState.markVisited(scene, tileId);
      }
      // Bypass socketlib — emit directly on game.socket so the GM's raw listener handles it.
      game.socket.emit(RAW_CH, { type: MSG_MV, payload: { sceneId: scene.id, tileId } });
    },

    async unmarkVisited(scene, tileId) {
      if (game.user?.isGM) {
        return DP.TileState.unmarkVisited(scene, tileId);
      }
      const socket = this._socket ?? window.FUCompanionSocket;
      if (!socket) { console.warn(TAG, "Socket not ready for unmarkVisited"); return; }
      return socket.executeAsGM(HANDLERS.UNMARK_VISITED, { sceneId: scene.id, tileId });
    },

    async fastTravelTeleport(scene, tokenId, x, y) {
      if (game.user?.isGM) {
        const tokenDoc = scene.tokens.get(tokenId);
        if (!tokenDoc) return { ok: false, error: "Token not found" };
        await tokenDoc.update({ x, y }, { dungeonPathing: true, animate: false });
        return { ok: true };
      }
      const socket = this._socket ?? window.FUCompanionSocket;
      if (!socket) { console.warn(TAG, "Socket not ready for fastTravelTeleport"); return; }
      return socket.executeAsGM(HANDLERS.FAST_TRAVEL_TELEPORT, { sceneId: scene.id, tokenId, x, y });
    },

    async activateScene(sceneUuid) {
      if (game.user?.isGM) {
        const campScene = await fromUuid(sceneUuid).catch(() => null);
        if (!campScene || !(campScene instanceof Scene)) return { ok: false, error: "Scene not found" };
        try {
          await campScene.activate();
          return { ok: true };
        } catch (e) {
          console.error(TAG, "activateScene (GM direct) failed", e);
          return { ok: false, error: e?.message };
        }
      }
      // Bypass socketlib — emit directly on game.socket so the GM's raw listener
      // handles it.  This avoids the socketlib.ready timing race (same fix as markVisited).
      game.socket.emit(RAW_CH, { type: MSG_AS, payload: { sceneUuid } });
      return { ok: true };
    },

    /**
     * Tick party AEs for a completed dungeon turn.
     * GM calls directly; player emits raw socket so the GM's listener handles it.
     * Same pattern as markVisited — bypasses socketlib to avoid the ready-hook race.
     */
    async tickPartyAEs() {
      if (game.user?.isGM) {
        return DP.AELifecycle?.tickPartyAEs?.();
      }
      game.socket.emit(RAW_CH, { type: MSG_TAE, payload: {} });
    },

    async triggerTreasure(scene, tileId, tokenId, tileType) {
      if (game.user?.isGM) {
        const FE = window["oni.TreasureRoulette.TileFrontEnd"];
        if (!FE?.onDbEnterTile) { console.warn(TAG, "TileFrontEnd not loaded"); return { ok: false, error: "TileFrontEnd not loaded" }; }
        const tileDoc  = scene.tiles.get(tileId);
        const tokenDoc = scene.tokens.get(tokenId);
        try {
          await FE.onDbEnterTile({ tileDocument: tileDoc, tokenDocument: tokenDoc, tileType, fromDungeonPathing: true });
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

  // Install the raw socket listener as soon as game.socket is available.
  Hooks.once("ready", () => {
    DP.Socket.setupRawListener();
  });
})();
