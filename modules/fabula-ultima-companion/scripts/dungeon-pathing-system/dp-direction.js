// ============================================================================
// Dungeon Pathing System — Direction Utilities
//
// 8-directional movement logic used by Force Move tiles, Slippery tiles,
// and any future directional effects.
//
// Coordinate system: screen space (Y increases downward).
//   0° = East, 90° = South, 180°/-180° = West, -90° = North
//
// Public API:
//   DP.Direction.computeDirection(fromNode, toNode)
//     → direction key (e.g. "SE") or null if same position
//
//   DP.Direction.getNeighborInDirection(fromNode, direction, graph)
//     → nearest connected neighbor within a ±45° cone, or null
//
//   DP.Direction.getNodeNStepsInDirection(startNode, direction, steps, graph)
//     → node reached after N steps; may stop early if path is blocked
//
//   DP.Direction.label(direction)
//     → human-readable label, e.g. "South-East ↘"
//
//   DP.Direction.lastEntryDirection
//     → direction of the most recent player-initiated move (set by bootstrap)
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  // Target angle (degrees) per direction; 0=East, clockwise positive (screen coords)
  const _ANGLE = {
    E:     0,
    SE:   45,
    S:    90,
    SW:  135,
    W:   180,
    NW: -135,
    N:   -90,
    NE:  -45,
  };

  const _LABEL = {
    N:  "North ↑",
    NE: "North-East ↗",
    E:  "East →",
    SE: "South-East ↘",
    S:  "South ↓",
    SW: "South-West ↙",
    W:  "West ←",
    NW: "North-West ↖",
  };

  /** Smallest signed angular difference in degrees, handling the ±180° wrap. */
  function _angleDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  DP.Direction = {
    // ── Constants ─────────────────────────────────────────────────────────────
    DIRS: DP.DIRECTIONS, // alias for convenience

    /** The direction the token entered the most recent tile (set by bootstrap). */
    lastEntryDirection: null,

    // ── Core API ──────────────────────────────────────────────────────────────

    /**
     * Compute the closest 8-sector direction from fromNode.center to toNode.center.
     * @param {object} fromNode - Graph node with a `center: {x, y}` property.
     * @param {object} toNode   - Graph node with a `center: {x, y}` property.
     * @returns {string|null} Direction key (e.g. "SE") or null if positions are identical.
     */
    computeDirection(fromNode, toNode) {
      const dx = toNode.center.x - fromNode.center.x;
      const dy = toNode.center.y - fromNode.center.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;

      const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
      let best = null, bestDiff = Infinity;
      for (const [dir, target] of Object.entries(_ANGLE)) {
        const diff = _angleDiff(angleDeg, target);
        if (diff < bestDiff) { bestDiff = diff; best = dir; }
      }
      return best;
    },

    /**
     * From startNode, find the connected graph neighbor whose center lies
     * closest to the given direction, within a strict ±45° cone.
     * If multiple neighbors fall in the cone the one with the smallest angular
     * deviation wins (i.e. the most on-axis neighbor).
     *
     * @param {object} startNode - Current graph node.
     * @param {string} direction - One of DP.DIRECTIONS (e.g. "SE").
     * @param {object} graph     - Full graph object from DP.Graph.build().
     * @returns {object|null} Matching neighbor node, or null.
     */
    getNeighborInDirection(startNode, direction, graph) {
      const targetAngle = _ANGLE[direction];
      if (targetAngle === undefined) return null;

      const neighbors = DP.Graph.getNeighbors(startNode.nodeId, graph);
      let best = null, bestDiff = Infinity;

      for (const neighbor of neighbors) {
        const dx = neighbor.center.x - startNode.center.x;
        const dy = neighbor.center.y - startNode.center.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

        const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        const diff     = _angleDiff(angleDeg, targetAngle);

        if (diff <= 45 && diff < bestDiff) { bestDiff = diff; best = neighbor; }
      }
      return best;
    },

    /**
     * Like getNeighborInDirection but returns ALL connected neighbors whose
     * center falls within a ±45° cone of the given direction (not just the
     * most-on-axis one).  Used by Slippery tiles for random path selection.
     *
     * @param {object} startNode - Current graph node.
     * @param {string} direction - One of DP.DIRECTIONS (not SLIPPERY).
     * @param {object} graph     - Full graph object.
     * @returns {object[]} All matching neighbor nodes (may be empty).
     */
    getNeighborsInDirection(startNode, direction, graph) {
      const targetAngle = _ANGLE[direction];
      if (targetAngle === undefined) return [];

      const neighbors = DP.Graph.getNeighbors(startNode.nodeId, graph);
      const result = [];

      for (const neighbor of neighbors) {
        const dx = neighbor.center.x - startNode.center.x;
        const dy = neighbor.center.y - startNode.center.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

        const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        if (_angleDiff(angleDeg, targetAngle) <= 45) result.push(neighbor);
      }
      return result;
    },

    /**
     * Follow `steps` hops from startNode in the given direction.
     * Returns the furthest reachable node (may be fewer than `steps` if the
     * path is blocked). Returns null if the very first step is blocked.
     *
     * @param {object} startNode - Starting graph node.
     * @param {string} direction - One of DP.DIRECTIONS.
     * @param {number} steps     - Number of hops to attempt.
     * @param {object} graph     - Full graph object.
     * @returns {object|null} Destination node or null.
     */
    getNodeNStepsInDirection(startNode, direction, steps, graph) {
      let node = startNode;
      for (let i = 0; i < steps; i++) {
        const next = this.getNeighborInDirection(node, direction, graph);
        if (!next) return i === 0 ? null : node;
        node = next;
      }
      return node;
    },

    /**
     * Human-readable label for a direction key.
     * @param {string} direction - e.g. "NW"
     * @returns {string} e.g. "North-West ↖"
     */
    label(direction) {
      return _LABEL[direction] ?? direction;
    },
  };
})();
