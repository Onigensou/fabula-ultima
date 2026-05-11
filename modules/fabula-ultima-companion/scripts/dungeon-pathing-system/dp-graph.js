// ============================================================================
// Dungeon Pathing System — Graph Builder
// Builds the movement graph from scene tiles (nodes) and drawings (edges).
// Ported and refactored from the Pathfinder Prototype V2 macro.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Graph]";

  // ---------------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------------
  const N = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const round2 = n => { const m = 100; return Math.round(N(n) * m) / m; };
  const dist = (a, b) => Math.hypot(N(a?.x) - N(b?.x), N(a?.y) - N(b?.y));

  function getGridSize() {
    return Number(canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100) || 100;
  }

  function boundsForTile(placeable) {
    const d = placeable?.document ?? placeable;
    const b = placeable?.bounds;
    if (b && Number.isFinite(Number(b.x)) && Number.isFinite(Number(b.width))) {
      return { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height),
               left: round2(b.x), top: round2(b.y), right: round2(b.x + b.width), bottom: round2(b.y + b.height) };
    }
    const x = N(d?.x), y = N(d?.y);
    let w = N(d?.width) || N(placeable?.w, getGridSize());
    let h = N(d?.height) || N(placeable?.h, getGridSize());
    return { x: round2(x), y: round2(y), width: round2(w), height: round2(h),
             left: round2(x), top: round2(y), right: round2(x + w), bottom: round2(y + h) };
  }

  function centerOfBounds(b) {
    return { x: round2(N(b?.left ?? b?.x) + N(b?.width) / 2),
             y: round2(N(b?.top  ?? b?.y) + N(b?.height) / 2) };
  }

  function containsPoint(bounds, pt) {
    const px = N(pt?.x), py = N(pt?.y);
    return px >= N(bounds?.left) && px <= N(bounds?.right)
        && py >= N(bounds?.top)  && py <= N(bounds?.bottom);
  }

  function nearestNode(point, nodes, maxDist = null) {
    const threshold = maxDist ?? Math.max(80, getGridSize() * 0.75);
    let best = null;
    for (const n of nodes) {
      const d = dist(point, n.center);
      if (!best || d < best.d) best = { node: n, d };
    }
    if (!best) return null;
    return { node: best.node, distance: best.d, accepted: best.d <= threshold };
  }

  function normalizeDrawingPoints(points) {
    if (!Array.isArray(points)) return [];
    if (points.every(p => typeof p === "number")) {
      const out = [];
      for (let i = 0; i < points.length - 1; i += 2) out.push({ x: N(points[i]), y: N(points[i + 1]) });
      return out;
    }
    if (points.every(p => Array.isArray(p))) return points.filter(p => p.length >= 2).map(p => ({ x: N(p[0]), y: N(p[1]) }));
    if (points.every(p => p && typeof p === "object"))  return points.map(p => ({ x: N(p.x), y: N(p.y) }));
    return [];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  DP.Graph = {
    /** Extract all non-hidden tiles as graph nodes. */
    getTileNodes() {
      const scene      = canvas?.scene;
      const tileStates = scene?.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY]?.tileStates ?? {};
      return (canvas?.tiles?.placeables ?? [])
        .filter(t => t?.document && !t.document.hidden)
        .map((t, idx) => {
          const d = t.document;
          const b = boundsForTile(t);
          return {
            index:    idx,
            nodeId:   d.id,
            uuid:     d.uuid,
            name:     String(d.name || `Tile ${idx}`),
            tileType: scene ? (tileStates[d.id]?.currentType ?? null) : null,
            texture:  d.texture?.src ?? null,
            x: round2(d.x), y: round2(d.y),
            width: round2(d.width), height: round2(d.height),
            locked: !!d.locked, hidden: !!d.hidden,
            center: centerOfBounds(b),
            bounds: b
          };
        });
    },

    /** Extract drawing lines as potential edges. */
    getDrawingEdges() {
      return (canvas?.drawings?.placeables ?? [])
        .filter(dr => dr?.document && !dr.document.hidden)
        .map((dr, idx) => {
          const d     = dr.document;
          const shape = d.shape ?? {};
          const local = normalizeDrawingPoints(shape.points ?? d.points ?? []);
          const base  = { x: N(d.x), y: N(d.y) };
          const abs   = local.map(p => ({ x: round2(base.x + N(p.x)), y: round2(base.y + N(p.y)) }));
          const first = abs[0] ?? null;
          const last  = abs[abs.length - 1] ?? null;
          return { drawingId: d.id, name: String(d.text ?? d.name ?? `Drawing ${idx}`),
                   first, last, length: (first && last) ? round2(dist(first, last)) : 0, pointCount: abs.length };
        })
        .filter(r => r.pointCount >= 2 && r.length > 10);
    },

    /** Match drawing endpoints to nearest tile nodes to build edges. */
    buildEdges(nodes, drawingEdges) {
      const edges = [];
      const seen  = new Set();
      const threshold = Math.max(80, getGridSize() * 0.75);

      for (const line of drawingEdges) {
        const aHit = nearestNode(line.first, nodes, threshold);
        const bHit = nearestNode(line.last,  nodes, threshold);
        const a = aHit?.accepted ? aHit.node : null;
        const b = bHit?.accepted ? bHit.node : null;

        if (!a || !b || a.nodeId === b.nodeId) continue;

        const key = [a.nodeId, b.nodeId].sort().join("<>");
        if (seen.has(key)) continue;
        seen.add(key);

        edges.push({ fromNodeId: a.nodeId, toNodeId: b.nodeId, drawingId: line.drawingId });
      }
      return edges;
    },

    /** Build adjacency list from nodes + edges. */
    buildAdjacency(nodes, edges) {
      const map = new Map(nodes.map(n => [n.nodeId, { nodeId: n.nodeId, neighbors: [] }]));
      for (const e of edges) {
        map.get(e.fromNodeId)?.neighbors.push({ nodeId: e.toNodeId, drawingId: e.drawingId });
        map.get(e.toNodeId)?.neighbors.push({ nodeId: e.fromNodeId, drawingId: e.drawingId });
      }
      return Array.from(map.values());
    },

    /**
     * Full graph build.
     * Returns { nodes, edges, adjacency, nodeMap, adjacencyMap }
     */
    build() {
      const nodes     = this.getTileNodes();
      const drawings  = this.getDrawingEdges();
      const edges     = this.buildEdges(nodes, drawings);
      const adjacency = this.buildAdjacency(nodes, edges);

      const nodeMap     = new Map(nodes.map(n => [n.nodeId, n]));
      const adjacencyMap = new Map(adjacency.map(a => [a.nodeId, a]));

      return { nodes, drawings, edges, adjacency, nodeMap, adjacencyMap };
    },

    /**
     * Find which node a world-space point is on.
     * First checks containment, then nearest-within-threshold.
     */
    findNodeForPoint(point, nodes, threshold = null) {
      const containing = nodes.filter(n => containsPoint(n.bounds, point));
      if (containing.length) {
        containing.sort((a, b) => N(a.width) * N(a.height) - N(b.width) * N(b.height));
        return containing[0];
      }
      const t    = threshold ?? Math.max(120, getGridSize());
      const hit  = nearestNode(point, nodes, t);
      return hit?.accepted ? hit.node : null;
    },

    /** Get neighbour node objects for a given node ID. */
    getNeighbors(nodeId, graph) {
      const adj = graph.adjacencyMap.get(nodeId);
      if (!adj) return [];
      return adj.neighbors.map(n => graph.nodeMap.get(n.nodeId)).filter(Boolean);
    },

    /** Convert canvas client coords to world coords. */
    clientToWorld(clientX, clientY) {
      const renderer = canvas?.app?.renderer;
      const stage    = canvas?.stage;
      try {
        if (renderer?.events?.mapPositionToPoint) {
          const p = new PIXI.Point();
          renderer.events.mapPositionToPoint(p, clientX, clientY);
          return stage?.worldTransform?.applyInverse
            ? stage.worldTransform.applyInverse(p)
            : p;
        }
      } catch {}
      const view = canvas?.app?.view ?? document.querySelector("#board canvas");
      const rect = view?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
      const vw   = Number(view?.width  || rect.width  || 1) || 1;
      const vh   = Number(view?.height || rect.height || 1) || 1;
      const rp   = { x: ((clientX - rect.left) / rect.width) * vw, y: ((clientY - rect.top) / rect.height) * vh };
      try {
        return stage?.worldTransform?.applyInverse ? stage.worldTransform.applyInverse(rp) : rp;
      } catch { return rp; }
    },

    /** Resolve the party token via DB resolver, falling back to first controlled token. */
    async resolvePartyToken() {
      const api = window.FUCompanion?.api;
      if (api?.getCurrentGameDb) {
        try {
          const res    = await api.getCurrentGameDb();
          const actors = [res?.db, res?.source].filter(Boolean);
          for (const actor of actors) {
            const t = canvas.tokens?.placeables?.find(t => t.actor?.id === actor.id || t.name === actor.name);
            if (t) return t;
          }
        } catch (e) { console.warn(TAG, "DB resolver failed, falling back", e); }
      }
      return canvas.tokens?.controlled?.[0] ?? canvas.tokens?.placeables?.[0] ?? null;
    }
  };
})();
