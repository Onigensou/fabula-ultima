// ============================================================================
// Dungeon Pathing — Tile Event: Force Move
//
// Automatically pushes the party token when the token lands on this tile.
// Behaviour is determined by the Direction flag in Tile Config:
//
//   Fixed direction (N/NE/E/…):
//     Pushes the token N steps in the configured direction.
//     getNodeNStepsInDirection returns the furthest reachable node if the
//     full step count is blocked (partial progress). Only a fully-blocked
//     first step cancels the move.
//
//   SLIPPERY:
//     Continues the token in whichever direction it entered from.
//     If multiple graph neighbors fall within the ±45° entry cone,
//     one is chosen at random (supports branching/forking paths).
//     If no entry direction is known (first tile of the session) the
//     move is skipped with a warning.
//
// After moving, hands off to bootstrap.processArrivalAt() so the
// destination tile fires exactly like a player-initiated move:
// confirm dialog (or skip), event dispatch, tile clear.
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

      const token = canvas.tokens?.get(tokenDoc.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === tokenDoc.id);
      if (!token) { console.warn(TAG, "Token placeable not found for:", tokenDoc.id); return; }

      // ── Resolve destination ───────────────────────────────────────────────
      let destNode;

      if (direction === DP.DIRECTIONS.RANDOM) {
        // Random: pick any connected neighbor at each hop (ignores direction).
        let node = forceMoveNode;
        let lastHopDir = null;
        for (let i = 0; i < steps; i++) {
          const neighbors = DP.Graph.getNeighbors(node.nodeId, graph);
          if (!neighbors.length) break;
          const prev = node;
          node = neighbors[Math.floor(Math.random() * neighbors.length)];
          lastHopDir = DP.Direction.computeDirection(prev, node);
        }
        if (node.nodeId === forceMoveNode.nodeId) {
          console.debug(TAG, `Random | "${forceMoveNode.name}" — no neighbors, token stays.`);
          return;
        }
        destNode = node;
        // Update entry direction to the direction of the last hop so any
        // chained Slippery tile knows which way the token was travelling.
        DP.Direction.lastEntryDirection = lastHopDir;
        console.debug(TAG, `Random | "${forceMoveNode.name}" → "${destNode.name}"`);
      } else if (direction === DP.DIRECTIONS.SLIPPERY) {
        // Slippery: continue in the direction the token entered from.
        const entryDir = DP.Direction.lastEntryDirection;
        if (!entryDir || !DP.Direction.DIRS[entryDir]) {
          ui.notifications?.warn(
            `Slippery | "${forceMoveNode.name}": no entry direction known. ` +
            "Was the token moved via the dungeon system?"
          );
          return;
        }

        // Walk `steps` hops. At each hop, gather ALL neighbors in the entry
        // cone and pick one at random (handles branching paths).
        let node = forceMoveNode;
        for (let i = 0; i < steps; i++) {
          const candidates = DP.Direction.getNeighborsInDirection(node, entryDir, graph);
          if (!candidates.length) break;
          node = candidates[Math.floor(Math.random() * candidates.length)];
        }

        if (node.nodeId === forceMoveNode.nodeId) {
          console.debug(TAG, `Slippery | "${forceMoveNode.name}" — no neighbor ${DP.Direction.label(entryDir)}, token stays.`);
          return;
        }
        destNode = node;
        console.debug(TAG, `Slippery | "${forceMoveNode.name}" → "${destNode.name}" (${DP.Direction.label(entryDir)} ×${steps})`);
      } else {
        // Fixed direction: move up to `steps` hops, stopping early if blocked.
        destNode = DP.Direction.getNodeNStepsInDirection(forceMoveNode, direction, steps, graph);
        if (!destNode || destNode.nodeId === forceMoveNode.nodeId) {
          ui.notifications?.warn(
            `Force Move | No valid path ${steps} step(s) ${DP.Direction.label(direction)} ` +
            `from "${forceMoveNode.name}". Is the destination tile connected in the graph?`
          );
          return;
        }
        console.debug(TAG, `"${forceMoveNode.name}" → "${destNode.name}" (${DP.Direction.label(direction)} ×${steps})`);
      }

      // ── Move ──────────────────────────────────────────────────────────────
      // Track direction for subsequent tiles (e.g. chained Slippery).
      // RANDOM and SLIPPERY already set lastEntryDirection during resolution;
      // for fixed directions, set it now.
      if (direction !== DP.DIRECTIONS.RANDOM && direction !== DP.DIRECTIONS.SLIPPERY) {
        DP.Direction.lastEntryDirection = direction;
      }

      // Sync the bootstrap's fast-path node pointer so rebuild() after the
      // full turn resolves currentNode to the final destination.
      const _bState = globalThis.__ONI_DUNGEON_PATHING__?.state;
      if (_bState) _bState.forcedNodeId = destNode.nodeId;

      await DP.Movement.moveToNode(token, destNode);

      // Hand off to the bootstrap's arrival processor — runs the full
      // confirm → event dispatch → clear cycle for the destination tile.
      // blockGoBack / disableGoBack flags are read from the tile docs by
      // the bootstrap; no need to pass them here.
      const bootstrap = globalThis.__ONI_DUNGEON_PATHING__;
      if (bootstrap?.processArrivalAt) {
        await bootstrap.processArrivalAt(destNode, token, scene, forceMoveNode);
      }
    },
  });
})();
