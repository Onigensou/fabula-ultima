/**
 * TreasureRoulette — Tile Front-End (legacy entry point + tile-clear FX)
 * Foundry VTT v12
 * -----------------------------------------------------------------------------
 * WHAT THIS IS NOW
 *
 * The reward sequence lives in TR.Flow (treasureRoulette-flow.js). This file is
 * what's left after the v2 rewrite:
 *
 *   1. onDbEnterTile(context) — the Monk's Active Tile Triggers entry point.
 *      `[Macro] [Tile] Trigger Roulette.js` still calls this, and the Macros
 *      folder is seed-only (the world copy is authoritative), so this shim has
 *      to keep working. It resolves the tile/token out of whatever shape MATT
 *      hands over and forwards to TR.Flow.
 *
 *   2. playClearFx() — the smoke puff + door sound the tile plays when it is
 *      consumed. TR.Flow calls it after clearing the tile so the visual beat
 *      survives the rewrite.
 *
 * WHAT WAS REMOVED (v2)
 *
 * The chat card with the "Roll!" button, the claim-arbitration handshake
 * (ONI_TR_TILE_CLAIM / _RESULT), and the texture-swap tile clear. The reward is
 * announced on screen now, the Dungeon Pathing main controller decides instead
 * of "first click wins", and the tile is consumed through DP.TileState so DP's
 * own tileStates.currentType actually goes BLANK — the old path only swapped the
 * texture and left DP thinking a spent tile was still a loot tile.
 */

Hooks.once("ready", () => {
  const KEY = "oni.TreasureRoulette.TileFrontEnd";
  if (window[KEY]) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_TILE_FX = "ONI_TR_TILE_FX";

  const CLEAR_FX_WEBM =
    "modules/JB2A_DnD5e/Library/Generic/Smoke/SmokePuffRing01_02_Regular_White_400x400.webm";
  const CLEAR_SFX_OGG =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Door1.ogg";

  const log  = (...a) => console.log("[TR TileFE]", ...a);
  const warn = (...a) => console.warn("[TR TileFE]", ...a);

  // ---------------------------------------------------------------------------
  // DB token check (only needed for the manual/MATT path — DP validates its own
  // party token before dispatching)
  // ---------------------------------------------------------------------------
  const getDbUuids = async () => {
    const api = window.FUCompanion?.api;
    if (!api?.getCurrentGameDb) return { dbActorUuid: null, sourceActorUuid: null };
    const { db, dbUuid, source } = await api.getCurrentGameDb();
    return {
      dbActorUuid: dbUuid || db?.uuid || null,
      sourceActorUuid: source?.uuid || null,
    };
  };

  const isDbToken = async (tokenDoc) => {
    if (!tokenDoc) return false;
    const { dbActorUuid, sourceActorUuid } = await getDbUuids();
    const actorUuid = tokenDoc?.actor?.uuid || tokenDoc?.actorUuid || null;
    return actorUuid === dbActorUuid || actorUuid === sourceActorUuid;
  };

  // ---------------------------------------------------------------------------
  // MATT hands context over in several shapes depending on how the action is
  // configured; normalise to { tileDoc, tokenDoc }.
  // ---------------------------------------------------------------------------
  const resolveTileAndTokenFromContext = (context) => {
    let tileDoc = null;
    let tokenDoc = null;

    const maybeTile =
      context?.tile?.document || context?.tileDocument || context?.tile ||
      globalThis.tile?.document || globalThis.tile || null;

    const maybeToken =
      context?.token?.document || context?.tokenDocument || context?.token ||
      globalThis.token?.document || globalThis.token || null;

    if (maybeTile?.documentName === "Tile") tileDoc = maybeTile;
    if (maybeTile?.document?.documentName === "Tile") tileDoc = maybeTile.document;

    if (maybeToken?.documentName === "Token") tokenDoc = maybeToken;
    if (maybeToken?.document?.documentName === "Token") tokenDoc = maybeToken.document;

    if (!tileDoc) {
      const tileId = context?.tileId || context?.tile_id || context?.tile?.id || null;
      if (tileId) tileDoc = canvas.tiles?.get(tileId)?.document || null;
    }
    if (!tokenDoc) {
      const tokenId = context?.tokenId || context?.token_id || context?.token?.id || null;
      if (tokenId) tokenDoc = canvas.tokens?.get(tokenId)?.document || null;
    }

    if (!tileDoc) {
      const tileUuid = context?.tileUuid || context?.tile_uuid || null;
      if (tileUuid && tileUuid.includes(".Tile.")) {
        const parts = tileUuid.split(".");
        tileDoc = canvas.tiles?.get(parts[parts.length - 1])?.document || null;
      }
    }
    if (!tokenDoc) {
      const tokenUuid = context?.tokenUuid || context?.token_uuid || null;
      if (tokenUuid && tokenUuid.includes(".Token.")) {
        const parts = tokenUuid.split(".");
        tokenDoc = canvas.tokens?.get(parts[parts.length - 1])?.document || null;
      }
    }

    return { tileDoc, tokenDoc };
  };

  // ---------------------------------------------------------------------------
  // Tile-clear FX — broadcast so every client sees the puff, not just the GM.
  // ---------------------------------------------------------------------------
  const playClearFxLocal = (sceneId, tileId) => {
    try {
      if (!canvas?.scene || (sceneId && canvas.scene.id !== sceneId)) return;
      const tileObj = canvas.tiles?.get(tileId);
      if (!tileObj || !globalThis.Sequence) return;

      new Sequence()
        .effect().file(CLEAR_FX_WEBM).atLocation(tileObj)
        .sound().file(CLEAR_SFX_OGG).volume(0.9)
        .play();
    } catch (e) {
      warn("Tile FX error:", e);
    }
  };

  const playClearFx = (sceneId, tileId) => {
    playClearFxLocal(sceneId, tileId);
    try {
      game.socket.emit(SOCKET_CHANNEL, { type: MSG_TILE_FX, payload: { sceneId, tileId } });
    } catch {}
  };

  const ensureSocketListener = () => {
    const GUARD = "__ONI_TR_TILEFE_SOCKET_LISTENER__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CHANNEL, (msg) => {
      if (msg?.type !== MSG_TILE_FX) return;
      const { sceneId, tileId } = msg.payload ?? {};
      playClearFxLocal(sceneId, tileId);
    });
  };

  // ---------------------------------------------------------------------------
  // Legacy entry point — forwards to TR.Flow
  // ---------------------------------------------------------------------------
  const onDbEnterTile = async (context = {}) => {
    try {
      const flow = window["oni.TreasureRoulette.Flow"];
      if (!flow?.run) {
        ui.notifications?.error?.("[TreasureRoulette] TR.Flow not installed.");
        return;
      }

      // The flow is GM-authoritative; a player invoking the macro directly is a
      // no-op rather than a silent half-run.
      if (!game.user?.isGM) {
        warn("onDbEnterTile called on a player client — the flow is GM-only. Ignored.");
        return;
      }
      if (globalThis.FUCompanion?.isPrimaryGM && !globalThis.FUCompanion.isPrimaryGM()) return;

      const { tileDoc, tokenDoc } = resolveTileAndTokenFromContext(context);
      if (!tileDoc || !tokenDoc) {
        warn("No tile/token context received. If testing manually: select ONE token (DB token) and ONE tile, then run the trigger macro.", context);
        return;
      }

      // DP already validated the party token before dispatching.
      if (!context.fromDungeonPathing) {
        const okDb = await isDbToken(tokenDoc);
        if (!okDb) {
          log("Trigger ignored: token is not the DB token.");
          return;
        }
      }

      const dpTypeKey = context?.tileType || null;
      if (!dpTypeKey || !flow.DP_TYPE_CONFIG?.[dpTypeKey]) {
        log("Trigger ignored: unrecognized or missing tileType in context", { dpTypeKey });
        return;
      }

      await flow.run({
        tileDoc,
        tokenDoc,
        scene: tileDoc.parent ?? canvas.scene,
        dpTypeKey,
        controllerUserId: context?.controllerUserId ?? game.user?.id ?? null,
      });
    } catch (e) {
      warn("onDbEnterTile failed:", e);
    }
  };

  ensureSocketListener();

  window[KEY] = {
    onDbEnterTile,
    playClearFx,
    _debug: { resolveTileAndTokenFromContext, isDbToken },
  };

  log("Installed (v2 shim).");
});
