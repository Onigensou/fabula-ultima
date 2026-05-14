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
// If no valid neighbor exists in the configured direction the move is skipped
// and a warning is shown. The tile itself is never cleared after triggering —
// Force Move tiles are persistent traps/conveyors.
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

      // The force move tile's nodeId IS tileDoc.id — look it up directly.
      const forceMoveNode = graph.nodeMap.get(tileDoc.id);
      if (!forceMoveNode) { console.warn(TAG, "Tile node not found in graph:", tileDoc.id); return; }

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

      // Update direction tracking so subsequent tiles (e.g. Slippery) know where we came from.
      DP.Direction.lastEntryDirection = direction;

      // Override the bootstrap's forcedNodeId so the post-turn rebuild()
      // resolves currentNode to the destination, not the force-move tile.
      // Without this, rebuild() reads the old forcedNodeId (the tile the
      // player clicked) and the system thinks the token never moved.
      const _bState = globalThis.__ONI_DUNGEON_PATHING__?.state;
      if (_bState) _bState.forcedNodeId = destNode.nodeId;

      console.debug(TAG, `"${forceMoveNode.name}" → "${destNode.name}" (${DP.Direction.label(direction)} ×${steps})`);

      await DP.Movement.moveToNode(token, destNode);
    },
  });
})();
