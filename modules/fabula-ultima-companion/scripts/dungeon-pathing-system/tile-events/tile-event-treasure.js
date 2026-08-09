// ============================================================================
// Dungeon Pathing — Tile Events: Loot Tiles
//
// Registers every treasure-roulette tile type and hands the landing to
// TR.Flow, which owns the whole reward sequence (spin -> reveal -> who gets it
// -> grant -> equip?).
//
// The handler AWAITS that sequence. DP's processArrivalAt() awaits the
// registry dispatch, so the dungeon turn stays blocked until the reward has
// actually been handed out — that's what makes the flow feel like one
// continuous beat instead of a chat card fired into the void.
//
// clearAfterTrigger: false — TR.Flow consumes the tile itself (through
// DP.TileState.clearTile) as soon as the winner is locked.
//
// GM routing: the flow must run on the primary GM. A player landing emits
// DP_TRIGGER_TREASURE and then waits for DP_TREASURE_DONE so their own
// controller blocks for the same duration the GM's does.
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing;
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEvent][loot]";
  const SOCKET_CH = `module.${MODULE_ID}`;

  const MSG_TRIGGER = "DP_TRIGGER_TREASURE";
  const MSG_DONE    = "DP_TREASURE_DONE";

  // Hard ceiling on how long a player client will block waiting for the GM's
  // flow. The flow's own budgets (60s recipient + 45s equip + spin) sit under
  // this; if it is ever hit, something is wrong GM-side and freeing the player's
  // turn is better than freezing the party.
  const PLAYER_WAIT_TIMEOUT_MS = 180000;

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  const getFlow = () => window["oni.TreasureRoulette.Flow"] ?? null;

  // requestKey -> resolve fn, for player clients awaiting the GM's DONE.
  const _waiting = new Map();

  function waitKey(sceneId, tileId) {
    return `${sceneId}:${tileId}`;
  }

  // ── Socket ─────────────────────────────────────────────────────────────────
  function setupSocketListener() {
    const GUARD = "__ONI_DP_TREASURE_SOCKET__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (!msg?.type) return;

      // ── Primary GM: run the flow, then release the waiting player ─────────
      if (msg.type === MSG_TRIGGER) {
        if (!game.user?.isGM) return;
        // Two GM clients both receive this; only the host may run it or the
        // tile rolls and awards twice.
        if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;

        const { sceneId, tileId, tokenId, dpTypeKey, controllerUserId } = msg.payload ?? {};
        const scene    = game.scenes.get(sceneId);
        const tileDoc  = scene?.tiles.get(tileId);
        const tokenDoc = scene?.tokens.get(tokenId);

        if (!scene || !tileDoc) {
          console.warn(TAG, "DP_TRIGGER_TREASURE: could not resolve scene/tile", { sceneId, tileId });
          game.socket.emit(SOCKET_CH, { type: MSG_DONE, payload: { sceneId, tileId } });
          return;
        }

        const flow = getFlow();
        if (!flow?.run) {
          console.warn(TAG, "DP_TRIGGER_TREASURE: TR.Flow not loaded on GM");
          game.socket.emit(SOCKET_CH, { type: MSG_DONE, payload: { sceneId, tileId } });
          return;
        }

        try {
          await flow.run({ tileDoc, tokenDoc, scene, dpTypeKey, controllerUserId });
        } catch (e) {
          console.error(TAG, "TR.Flow.run (socket) failed:", e);
        } finally {
          game.socket.emit(SOCKET_CH, { type: MSG_DONE, payload: { sceneId, tileId } });
        }
        return;
      }

      // ── Triggering player: unblock the turn ───────────────────────────────
      if (msg.type === MSG_DONE) {
        const { sceneId, tileId } = msg.payload ?? {};
        const key = waitKey(sceneId, tileId);
        const resolve = _waiting.get(key);
        if (resolve) {
          _waiting.delete(key);
          resolve();
        }
        return;
      }
    });

    console.debug(TAG, "socket listener installed.");
  }

  // ── Loot handler factory ────────────────────────────────────────────────────
  function makeLootHandler(dpTypeKey) {
    return async function lootHandler(tileDoc, tokenDoc, scene) {
      const flow = getFlow();

      if (!flow?.run) {
        console.warn(TAG, "TR.Flow not found. Showing fallback.");
        await ChatMessage.create({
          speaker: { alias: "System" },
          content: `<div style="text-align:center;font-size:1.4rem;padding:8px;">
            🎁 <b>Treasure!</b> (TreasureRoulette not loaded)
          </div>`
        });
        return;
      }

      // Primary GM: run it here and await it directly. Pass no controller — the
      // flow resolves the Movement Control main controller itself. Using the GM's
      // own id here would hand the screens to the GM even when a player is
      // driving the party (which is the normal case, and is also how the dirt
      // tile's "strike gold" transform reaches this handler GM-side).
      if (game.user?.isGM && (!DP.isPrimaryGM || DP.isPrimaryGM())) {
        await flow.run({ tileDoc, tokenDoc, scene, dpTypeKey, controllerUserId: null });
        return;
      }

      // Secondary GM: the primary owns the flow. Nothing to await locally — the
      // screens arrive by broadcast.
      if (game.user?.isGM) return;

      // Player: ask the GM to run it, and block until they say it's done so the
      // dungeon turn doesn't advance underneath the reward screens.
      const key = waitKey(scene?.id, tileDoc?.id);

      const done = new Promise((resolve) => {
        _waiting.set(key, resolve);
        setTimeout(() => {
          if (_waiting.has(key)) {
            _waiting.delete(key);
            console.warn(TAG, "timed out waiting for GM to finish the loot flow.");
            resolve();
          }
        }, PLAYER_WAIT_TIMEOUT_MS);
      });

      game.socket.emit(SOCKET_CH, {
        type:    MSG_TRIGGER,
        payload: {
          sceneId: scene.id,
          tileId:  tileDoc.id,
          tokenId: tokenDoc?.id ?? null,
          dpTypeKey,
          controllerUserId,
        },
      });

      await done;
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

  Hooks.once("ready", () => { setupSocketListener(); });
})();
