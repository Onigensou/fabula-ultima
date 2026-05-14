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

      console.debug(TAG, "handler ENTER | tile:", tileDoc?.id, tileDoc?.name);

      const direction = tileDoc?.getFlag(MOD, `${ROOT}.forceMoveDirection`) ?? null;
      const steps     = Math.max(1, Number(tileDoc?.getFlag(MOD, `${ROOT}.forceMoveSteps`) ?? 1));

      console.debug(TAG, `config | direction="${direction}" steps=${steps}`);

      if (!direction || !DP.Direction?.DIRS?.[direction]) {
        ui.notifications?.warn(
          `Force Move | "${tileDoc?.name}" has no direction configured. ` +
          "Open Tile Config → Fabula Configuration → Dungeon → Force Move Settings."
        );
        console.warn(TAG, "Abort: no valid direction flag. direction=", direction, "DIRS=", DP.Direction?.DIRS);
        return;
      }

      const graph = globalThis.__ONI_DUNGEON_PATHING__?.graph;
      console.debug(TAG, "graph:", graph ? `${graph.nodes?.length} nodes` : "NOT FOUND");
      if (!graph) { console.warn(TAG, "Graph not available."); return; }

      // The force move tile's nodeId IS tileDoc.id — look it up directly.
      const forceMoveNode = graph.nodeMap.get(tileDoc.id);
      console.debug(TAG, "forceMoveNode:", forceMoveNode?.name ?? "NOT FOUND", "| id:", tileDoc.id);
      if (!forceMoveNode) { console.warn(TAG, "Tile node not found in graph:", tileDoc.id); return; }

      // Log all neighbours so we can verify connectivity
      const neighbours = DP.Graph.getNeighbors(forceMoveNode.nodeId, graph);
      console.debug(TAG, `neighbours (${neighbours.length}):`,
        neighbours.map(n => `"${n.name}" angle=${Math.round(Math.atan2(
          n.center.y - forceMoveNode.center.y,
          n.center.x - forceMoveNode.center.x) * 180 / Math.PI)}°`).join(", ") || "(none)");

      const destNode = DP.Direction.getNodeNStepsInDirection(forceMoveNode, direction, steps, graph);
      console.debug(TAG, `destination | ${steps}×${direction} → "${destNode?.name ?? "null"}" (id: ${destNode?.nodeId ?? "—"})`);

      if (!destNode || destNode.nodeId === forceMoveNode.nodeId) {
        ui.notifications?.warn(
          `Force Move | No valid path ${steps} step(s) ${DP.Direction.label(direction)} ` +
          `from "${forceMoveNode.name}". Is the destination tile connected in the graph?`
        );
        console.warn(TAG, "Abort: no reachable destination in direction", direction);
        return;
      }

      const token = canvas.tokens?.get(tokenDoc.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === tokenDoc.id);
      console.debug(TAG, "token placeable:", token ? `found (${token.name})` : "NOT FOUND");
      if (!token) { console.warn(TAG, "Token placeable not found for:", tokenDoc.id); return; }

      // Update direction tracking so subsequent tiles (e.g. Slippery) know where we came from.
      DP.Direction.lastEntryDirection = direction;

      console.debug(TAG, `MOVING | "${forceMoveNode.name}" → "${destNode.name}" (${DP.Direction.label(direction)} ×${steps})`);

      await DP.Movement.moveToNode(token, destNode);

      console.debug(TAG, "handler EXIT");
    },
  });
})();
