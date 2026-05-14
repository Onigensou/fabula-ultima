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
      const dbg  = DP.Debug;

      console.debug(TAG, "handler ENTER | tile:", tileDoc?.id, tileDoc?.name);
      dbg?.log("force_move", `ENTER | tile="${tileDoc?.name}" id=${tileDoc?.id}`);

      const direction = tileDoc?.getFlag(MOD, `${ROOT}.forceMoveDirection`) ?? null;
      const steps     = Math.max(1, Number(tileDoc?.getFlag(MOD, `${ROOT}.forceMoveSteps`) ?? 1));

      console.debug(TAG, `config | direction="${direction}" steps=${steps}`);
      dbg?.log("force_move", `config | direction="${direction}" steps=${steps}`);

      if (!direction || !DP.Direction?.DIRS?.[direction]) {
        ui.notifications?.warn(
          `Force Move | "${tileDoc?.name}" has no direction configured. ` +
          "Open Tile Config → Fabula Configuration → Dungeon → Force Move Settings."
        );
        console.warn(TAG, "Abort: no valid direction flag. direction=", direction, "DIRS=", DP.Direction?.DIRS);
        dbg?.warn("force_move", `ABORT: invalid direction="${direction}"`);
        dbg?.dump?.();
        return;
      }

      const graph = globalThis.__ONI_DUNGEON_PATHING__?.graph;
      const graphInfo = graph ? `${graph.nodes?.length} nodes` : "NOT FOUND";
      console.debug(TAG, "graph:", graphInfo);
      dbg?.log("force_move", `graph: ${graphInfo}`);
      if (!graph) { console.warn(TAG, "Graph not available."); dbg?.warn("force_move", "ABORT: graph missing"); dbg?.dump?.(); return; }

      // The force move tile's nodeId IS tileDoc.id — look it up directly.
      const forceMoveNode = graph.nodeMap.get(tileDoc.id);
      console.debug(TAG, "forceMoveNode:", forceMoveNode?.name ?? "NOT FOUND", "| id:", tileDoc.id);
      dbg?.log("force_move", `forceMoveNode="${forceMoveNode?.name ?? "NOT FOUND"}" id=${tileDoc.id}`);
      if (!forceMoveNode) {
        console.warn(TAG, "Tile node not found in graph:", tileDoc.id);
        dbg?.warn("force_move", `ABORT: tile ${tileDoc.id} not in graph`);
        dbg?.dump?.();
        return;
      }

      // Log all neighbours so we can verify connectivity
      const neighbours = DP.Graph.getNeighbors(forceMoveNode.nodeId, graph);
      const neighbourInfo = neighbours.map(n => {
        const angle = Math.round(Math.atan2(
          n.center.y - forceMoveNode.center.y,
          n.center.x - forceMoveNode.center.x) * 180 / Math.PI);
        return `"${n.name}" ${angle}°`;
      }).join(", ") || "(none)";
      console.debug(TAG, `neighbours (${neighbours.length}):`, neighbourInfo);
      dbg?.log("force_move", `neighbours (${neighbours.length}): ${neighbourInfo}`);

      const destNode = DP.Direction.getNodeNStepsInDirection(forceMoveNode, direction, steps, graph);
      const destInfo = destNode ? `"${destNode.name}" id=${destNode.nodeId}` : "null";
      console.debug(TAG, `destination | ${steps}×${direction} → ${destInfo}`);
      dbg?.log("force_move", `destination | ${steps}×${direction} → ${destInfo}`);

      if (!destNode || destNode.nodeId === forceMoveNode.nodeId) {
        ui.notifications?.warn(
          `Force Move | No valid path ${steps} step(s) ${DP.Direction.label(direction)} ` +
          `from "${forceMoveNode.name}". Is the destination tile connected in the graph?`
        );
        console.warn(TAG, "Abort: no reachable destination in direction", direction);
        dbg?.warn("force_move", `ABORT: no reachable node ${steps}×${direction} from "${forceMoveNode.name}"`);
        dbg?.dump?.();
        return;
      }

      const token = canvas.tokens?.get(tokenDoc.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === tokenDoc.id);
      console.debug(TAG, "token placeable:", token ? `found (${token.name})` : "NOT FOUND");
      dbg?.log("force_move", `token: ${token ? `found "${token.name}"` : "NOT FOUND"}`);
      if (!token) {
        console.warn(TAG, "Token placeable not found for:", tokenDoc.id);
        dbg?.warn("force_move", `ABORT: token not found id=${tokenDoc.id}`);
        dbg?.dump?.();
        return;
      }

      // Update direction tracking so subsequent tiles (e.g. Slippery) know where we came from.
      DP.Direction.lastEntryDirection = direction;

      console.debug(TAG, `MOVING | "${forceMoveNode.name}" → "${destNode.name}" (${DP.Direction.label(direction)} ×${steps})`);
      dbg?.log("force_move", `MOVING | "${forceMoveNode.name}" → "${destNode.name}" (${direction} ×${steps})`);

      await DP.Movement.moveToNode(token, destNode);

      console.debug(TAG, "handler EXIT");
      dbg?.log("force_move", "EXIT | move complete");
      dbg?.dump?.();
    },
  });
})();
