// ============================================================================
// Dungeon Pathing System — Tile Transformation API
//
// Generic "an effect turns a tile into a different type mid-play" helper.
// Wraps the existing tracked-state mutation (DP.TileState.mutateTile) and,
// optionally, immediately fires the new type's handler so the transformed
// tile resolves without the party re-entering it.
//
// Developer API:
//   DungeonPathing.TileTransform.transform(scene, tileId, newType, opts)
//     opts.texture    {string|null}  optional new tile image (else unchanged)
//     opts.triggerNow {boolean}      immediately dispatch newType's handler
//     opts.tokenDoc   {TokenDocument|null}  token passed to the re-trigger
//
// GM-only — mutating tracked state and dispatching handlers want GM authority.
// The dungeon tile events that call this already run GM-side (socket-routed),
// mirroring tile-event-treasure.js.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][TileTransform]";

  DP.TileTransform = {
    /**
     * Transform a tile into another registered type.
     * @returns {Promise<{ok:boolean, triggered:boolean, cleared?:boolean}>}
     */
    async transform(scene, tileId, newType, { texture = null, triggerNow = false, tokenDoc = null } = {}) {
      if (!game.user?.isGM) {
        console.warn(TAG, "transform() must run on the GM client.");
        return { ok: false, triggered: false };
      }
      if (!scene || !tileId || !newType) {
        console.warn(TAG, "transform() requires scene, tileId and newType.");
        return { ok: false, triggered: false };
      }

      // 1. Mutate the tracked state (currentType + optional texture). Single-tile
      //    flag write — avoids broadcasting the whole tileStates object.
      await DP.TileState.mutateTile(scene, tileId, newType, texture)
        .catch(e => console.warn(TAG, "mutateTile failed:", e));

      if (!triggerNow) return { ok: true, triggered: false };

      // 2. Re-resolve the (possibly texture-updated) tile and dispatch the new
      //    type's handler immediately — no re-entry, no extra confirmation.
      const tileDoc = scene.tiles.get(tileId);
      if (!tileDoc) {
        console.warn(TAG, "tileDoc not found after mutate:", tileId);
        return { ok: true, triggered: false };
      }

      const { ok, cleared } = await DP.TileEventRegistry.dispatch(newType, tileDoc, tokenDoc, scene);

      // 3. Honour the same clear semantics as the turn loop (dp-bootstrap.js):
      //    respect the dispatched type's clearAfterTrigger and the per-tile
      //    persistAfterTrigger override.
      const MOD         = DP.MODULE_ID;
      const persistFlag = tileDoc.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.persistAfterTrigger`);
      const shouldClear = (persistFlag === true || persistFlag === "true") ? false : cleared;
      if (shouldClear) {
        await DP.Socket.clearTile(scene, tileId).catch(e => console.warn(TAG, "clearTile failed:", e));
      }

      return { ok, triggered: true, cleared: shouldClear };
    },
  };

  console.debug(TAG, "ready.");
})();
