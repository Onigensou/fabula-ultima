// ============================================================================
// Dungeon Pathing — Tile Event: Force Move
//
// Automatically pushes the party token N steps in a configured direction when
// the token lands on this tile. Direction and step count are set per-tile in
// the tile config panel (Fabula Configuration → Dungeon → Force Move Settings).
//
// Flags (on tileDoc):
//   flags.fabula-ultima-companion.dungeonPathing.forceMoveDirection  — e.g. "SE"
//   flags.fabula-ultima-companion.dungeonPathing.forceMoveSteps      — e.g. 2
//
// After moving the token, the handler calls bootstrap.processArrivalAt() so
// the destination tile is processed exactly as if the player had walked there:
// confirm dialog (or skip), event dispatch, tile clear — including chained
// Force Moves, random battles, or any other tile type. No bespoke chain logic
// needed here.
//
// Deadend guard: getNodeNStepsInDirection returns the furthest reachable node
// if the full step count is blocked. Only a fully-blocked first step cancels
// the move; partial paths (fewer steps than configured) move as far as possible.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][force_move]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.FORCE_MOVE, {
    label:             "Force Move",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      const MOD  = DP.MODULE_ID;
      const ROOT = DP.PATHING_ROOT_KEY;

      const direction = tileDoc?.getFlag(MOD, `${ROOT}.forceMoveDirection`) ?? null;
      const steps     = Math.max(1, Number(tileDoc?.getFlag(MOD, `${ROOT}.forceMoveSteps`) ?? 1));

      if (!direction || !DP.Direction?.DIRS?.[direction]) {
        ui.notifications?.warn(
          `Force Move | "${tileDoc?.name}" has no direction configured. ` +
          "Open Tile Config → Fabula Configuration → Dungeon → Force Move Settings."
        );
        return;
      }

      const graph = globalThis.__ONI_DUNGEON_PATHING__?.graph;
      if (!graph) { console.warn(TAG, "Graph not available."); return; }

      const forceMoveNode = graph.nodeMap.get(tileDoc.id);
      if (!forceMoveNode) { console.warn(TAG, "Tile node not found in graph:", tileDoc.id); return; }

      // getNodeNStepsInDirection returns the furthest reachable node — it may
      // stop short if the path is blocked. null means even the first step is
      // blocked, in which case we cancel with a warning.
      const destNode = DP.Direction.getNodeNStepsInDirection(forceMoveNode, direction, steps, graph);
      if (!destNode || destNode.nodeId === forceMoveNode.nodeId) {
        ui.notifications?.warn(
          `Force Move | No valid path ${steps} step(s) ${DP.Direction.label(direction)} ` +
          `from "${forceMoveNode.name}". Is the destination tile connected in the graph?`
        );
        return;
      }

      const token = canvas.tokens?.get(tokenDoc.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === tokenDoc.id);
      if (!token) { console.warn(TAG, "Token placeable not found for:", tokenDoc.id); return; }

      // Track direction for subsequent tiles (e.g. Slippery).
      DP.Direction.lastEntryDirection = direction;

      // Sync the bootstrap's fast-path node pointer so rebuild() after the
      // full turn resolves currentNode to the final destination.
      const _bState = globalThis.__ONI_DUNGEON_PATHING__?.state;
      if (_bState) _bState.forcedNodeId = destNode.nodeId;

      console.debug(TAG, `"${forceMoveNode.name}" → "${destNode.name}" (${DP.Direction.label(direction)} ×${steps})`);

      await DP.Movement.moveToNode(token, destNode);

      // Hand off to the bootstrap's arrival processor — this runs the full
      // confirm → event dispatch → clear cycle for the destination tile,
      // exactly as if the player had clicked it. If destNode is itself a
      // Force Move tile (or any other tile type), it fires naturally from here.
      //
      // If this force move tile has disableGoBack set, pass allowRevert:false so
      // the Go Back button is suppressed on the destination — the force move tile
      // is "blocking" the undo, not the destination tile itself.
      const _disableGoBackFlag = tileDoc?.getFlag(MOD, `${ROOT}.disableGoBack`);
      const _allowRevert = !(_disableGoBackFlag === true || _disableGoBackFlag === "true");

      const bootstrap = globalThis.__ONI_DUNGEON_PATHING__;
      if (bootstrap?.processArrivalAt) {
        await bootstrap.processArrivalAt(destNode, token, scene, forceMoveNode, { allowRevert: _allowRevert });
      }
    },
  });
})();
