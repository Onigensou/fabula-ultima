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
// Chaining: if the destination tile is itself a Force Move tile, it fires
// automatically (up to MAX_CHAIN_DEPTH hops) so conveyor belts and trap
// sequences work without extra turn clicks.
//
// Deadend guard: getNodeNStepsInDirection already returns the furthest
// reachable node if the path is shorter than requested. If the very first
// step is blocked the move is cancelled with a warning; partial progress
// (fewer steps than configured) moves the token as far as possible.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][force_move]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  const MAX_CHAIN_DEPTH = 10;

  /**
   * Core force-move logic — moves `token` from `fromNode` using the flags on
   * `tileDoc`. Recursively chains if the destination is also a Force Move tile.
   * `depth` guards against infinite loops.
   */
  async function _applyForceMove(tileDoc, token, tokenDoc, scene, graph, _bState, depth) {
    if (depth > MAX_CHAIN_DEPTH) {
      console.warn(TAG, `Chain depth limit (${MAX_CHAIN_DEPTH}) reached — stopping.`);
      return;
    }

    const MOD  = DP.MODULE_ID;
    const ROOT = DP.PATHING_ROOT_KEY;

    const direction = tileDoc?.getFlag(MOD, `${ROOT}.forceMoveDirection`) ?? null;
    const steps     = Math.max(1, Number(tileDoc?.getFlag(MOD, `${ROOT}.forceMoveSteps`) ?? 1));

    if (!direction || !DP.Direction?.DIRS?.[direction]) {
      if (depth === 0) {
        ui.notifications?.warn(
          `Force Move | "${tileDoc?.name}" has no direction configured. ` +
          "Open Tile Config → Fabula Configuration → Dungeon → Force Move Settings."
        );
      }
      return;
    }

    const fromNode = graph.nodeMap.get(tileDoc.id);
    if (!fromNode) { console.warn(TAG, "Tile node not found in graph:", tileDoc.id); return; }

    // getNodeNStepsInDirection returns the furthest reachable node.
    // null means the very first step is blocked — abort with a warning.
    // A node identical to fromNode (same id) also means no movement is possible.
    const destNode = DP.Direction.getNodeNStepsInDirection(fromNode, direction, steps, graph);
    if (!destNode || destNode.nodeId === fromNode.nodeId) {
      if (depth === 0) {
        ui.notifications?.warn(
          `Force Move | No valid path ${steps} step(s) ${DP.Direction.label(direction)} ` +
          `from "${fromNode.name}". Is the destination tile connected in the graph?`
        );
      } else {
        console.debug(TAG, `Chain stopped at "${fromNode.name}" — no neighbor ${DP.Direction.label(direction)}.`);
      }
      return;
    }

    // Track the entry direction for subsequent tile logic (e.g. Slippery).
    DP.Direction.lastEntryDirection = direction;

    // Sync the bootstrap's fast-path node pointer to the destination so
    // rebuild() after the turn resolves currentNode correctly.
    if (_bState) _bState.forcedNodeId = destNode.nodeId;

    console.debug(TAG,
      `[chain ${depth}] "${fromNode.name}" → "${destNode.name}"` +
      ` (${DP.Direction.label(direction)} ×${steps})`
    );

    await DP.Movement.moveToNode(token, destNode);

    // ── Chain check ──────────────────────────────────────────────────────────
    // If the destination tile also has a forceMoveDirection flag configured,
    // treat it as a Force Move tile and apply the effect immediately.
    const destTileDoc = scene?.tiles?.get(destNode.nodeId);
    const destDir     = destTileDoc?.getFlag(MOD, `${ROOT}.forceMoveDirection`) ?? "";
    if (destTileDoc && destDir && DP.Direction?.DIRS?.[destDir]) {
      await _applyForceMove(destTileDoc, token, tokenDoc, scene, graph, _bState, depth + 1);
    }
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.FORCE_MOVE, {
    label:             "Force Move",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      const graph = globalThis.__ONI_DUNGEON_PATHING__?.graph;
      if (!graph) { console.warn(TAG, "Graph not available."); return; }

      const token = canvas.tokens?.get(tokenDoc.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === tokenDoc.id);
      if (!token) { console.warn(TAG, "Token placeable not found for:", tokenDoc.id); return; }

      const _bState = globalThis.__ONI_DUNGEON_PATHING__?.state;

      await _applyForceMove(tileDoc, token, tokenDoc, scene, graph, _bState, 0);
    },
  });
})();
