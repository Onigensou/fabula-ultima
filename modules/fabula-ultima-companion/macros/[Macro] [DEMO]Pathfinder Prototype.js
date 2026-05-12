// ============================================================================
// ONI Pathfinder Movement Prototype V2 - Pseudo Movement
// Foundry VTT V12
//
// Board model:
// - Tile placeables = movement nodes
// - Drawing lines = node connections
// - DB Actor / party token = board piece
//
// V2 changes:
// - Uses game.ONI.pseudo.play(...) for visual movement.
// - Updates the real token document only ONCE near the end of movement.
// - Forces the destination node as the next current node after landing.
//
// Stop command:
//   window.__ONI_PATHFINDER_MOVE_TEST__?.stop()
// ============================================================================

(async () => {
  const TAG = "[ONI][PathMovePseudoV2]";
  const DEBUG = true;

  // Stop older probes / movement tools so clicks do not double-fire.
  try { window.__ONI_PATHFINDER_PROBE__?.stopClickProbe?.(); } catch (_) {}
  try { window.__ONI_PATH_GRAPH_PROBE__?.stop?.(); } catch (_) {}
  try { window.__ONI_PATHFINDER_MOVE_TEST__?.stop?.(); } catch (_) {}

  const HIGHLIGHT = {
    current: 0x4aa3ff,
    neighbor: 0x42ff8a,
    invalid: 0xff4a4a,
    line: 0xffffff
  };

  const MOVE_MS = 650;
  const REAL_UPDATE_BEFORE_END_MS = 90;
  const REBUILD_AFTER_MOVE_MS = 180;

  const state = {
    active: true,
    busy: false,
    graph: null,
    partyToken: null,
    currentNode: null,
    neighborIds: new Set(),
    overlay: null,
    clickHandler: null,

    // Used to prevent the “still detects previous tile” issue.
    pendingCurrentNodeId: null,
    lastLandedNodeId: null
  };

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const err = (...a) => DEBUG && console.error(TAG, ...a);

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const round = (n, p = 2) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    const m = Math.pow(10, p);
    return Math.round(x * m) / m;
  };

  const S = (v, d = "") => {
    const s = String(v ?? "").trim();
    return s.length ? s : d;
  };

  const N = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  const dist = (a, b) => Math.hypot(
    N(a?.x) - N(b?.x),
    N(a?.y) - N(b?.y)
  );

  function getGridSize() {
    return Number(canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100) || 100;
  }

  function getCanvasView() {
    return (
      canvas?.app?.view ??
      canvas?.app?.renderer?.view ??
      document.querySelector("#board canvas") ??
      document.querySelector("canvas")
    );
  }

  function clientToCanvasPoint(clientX, clientY) {
    const view = getCanvasView();
    const renderer = canvas?.app?.renderer;
    const stage = canvas?.stage;

    let rendererPoint = null;

    try {
      if (globalThis.PIXI?.Point) {
        const p = new PIXI.Point();

        if (renderer?.events?.mapPositionToPoint) {
          renderer.events.mapPositionToPoint(p, clientX, clientY);
          rendererPoint = p;
        } else if (renderer?.plugins?.interaction?.mapPositionToPoint) {
          renderer.plugins.interaction.mapPositionToPoint(p, clientX, clientY);
          rendererPoint = p;
        }
      }
    } catch (_) {}

    if (!rendererPoint) {
      const rect = view?.getBoundingClientRect?.();
      const viewWidth = Number(view?.width ?? rect?.width ?? 1) || 1;
      const viewHeight = Number(view?.height ?? rect?.height ?? 1) || 1;

      rendererPoint = {
        x: ((clientX - rect.left) / rect.width) * viewWidth,
        y: ((clientY - rect.top) / rect.height) * viewHeight
      };
    }

    let worldPoint = rendererPoint;

    try {
      if (stage?.worldTransform?.applyInverse) {
        worldPoint = stage.worldTransform.applyInverse(rendererPoint);
      }
    } catch (_) {}

    return {
      x: round(worldPoint.x),
      y: round(worldPoint.y)
    };
  }

  function boundsForPlaceable(placeable) {
    const d = placeable?.document ?? placeable;

    const b = placeable?.bounds;
    if (
      b &&
      Number.isFinite(Number(b.x)) &&
      Number.isFinite(Number(b.y)) &&
      Number.isFinite(Number(b.width)) &&
      Number.isFinite(Number(b.height))
    ) {
      return {
        x: round(b.x),
        y: round(b.y),
        width: round(b.width),
        height: round(b.height),
        left: round(b.x),
        top: round(b.y),
        right: round(b.x + b.width),
        bottom: round(b.y + b.height),
        source: "placeable.bounds"
      };
    }

    const x = N(d?.x);
    const y = N(d?.y);
    let w = N(d?.width);
    let h = N(d?.height);

    if (d?.documentName === "Token" || d?.constructor?.name === "TokenDocument") {
      const g = getGridSize();
      w = w * g;
      h = h * g;
    }

    if (!w) w = N(placeable?.w ?? placeable?.width, getGridSize());
    if (!h) h = N(placeable?.h ?? placeable?.height, getGridSize());

    return {
      x: round(x),
      y: round(y),
      width: round(w),
      height: round(h),
      left: round(x),
      top: round(y),
      right: round(x + w),
      bottom: round(y + h),
      source: "document"
    };
  }

  function centerOfBounds(b) {
    return {
      x: round(N(b?.left ?? b?.x) + N(b?.width) / 2),
      y: round(N(b?.top ?? b?.y) + N(b?.height) / 2)
    };
  }

  function containsPoint(bounds, point) {
    const x = N(point?.x);
    const y = N(point?.y);

    return (
      x >= N(bounds?.left) &&
      x <= N(bounds?.right) &&
      y >= N(bounds?.top) &&
      y <= N(bounds?.bottom)
    );
  }

  function fileBase(path = "") {
    try {
      const clean = decodeURIComponent(String(path).split("?")[0]);
      return clean.split("/").pop() || "";
    } catch {
      return String(path ?? "");
    }
  }

  function inferTileKind(tileDoc) {
    const name = S(tileDoc?.name);
    const texture = S(tileDoc?.texture?.src);
    const raw = `${name} ${fileBase(texture)}`.toLowerCase();

    const known = [
      "gold",
      "blank",
      "stealth",
      "chaos",
      "advantage",
      "event",
      "final",
      "story",
      "fishing",
      "freeze",
      "gathering",
      "hazard",
      "healing",
      "jump",
      "poison",
      "recipe",
      "settlement",
      "obstacle",
      "skillcheck",
      "skill check",
      "slippery",
      "trap",
      "camp",
      "alert",
      "door",
      "treasure",
      "item",
      "weapon",
      "armor",
      "accessory",
      "consumable",
      "left",
      "right",
      "up",
      "down"
    ];

    const hit = known.find(k => raw.includes(k));
    return hit ? hit.replace(/\s+/g, "_") : "unknown";
  }

  function getTileNodes() {
    const tiles = canvas?.tiles?.placeables ?? [];

    return tiles
      .filter(t => t?.document && !t.document.hidden)
      .map((t, index) => {
        const d = t.document;
        const b = boundsForPlaceable(t);
        const center = centerOfBounds(b);

        return {
          index,
          nodeId: d.id,
          uuid: d.uuid,
          name: S(d.name, `(Tile ${index})`),
          kind: inferTileKind(d),
          texture: d.texture?.src ?? null,

          x: round(d.x),
          y: round(d.y),
          width: round(d.width),
          height: round(d.height),
          sort: d.sort ?? null,
          elevation: d.elevation ?? null,
          locked: !!d.locked,
          hidden: !!d.hidden,

          center,
          bounds: b
        };
      });
  }

  function normalizePointsArray(points) {
    if (!Array.isArray(points)) return [];

    if (points.every(p => typeof p === "number")) {
      const out = [];
      for (let i = 0; i < points.length - 1; i += 2) {
        out.push({ x: N(points[i]), y: N(points[i + 1]) });
      }
      return out;
    }

    if (points.every(p => Array.isArray(p))) {
      return points
        .filter(p => p.length >= 2)
        .map(p => ({ x: N(p[0]), y: N(p[1]) }));
    }

    if (points.every(p => p && typeof p === "object")) {
      return points.map(p => ({ x: N(p.x), y: N(p.y) }));
    }

    return [];
  }

  function getDrawingLineRows() {
    const drawings = canvas?.drawings?.placeables ?? [];

    return drawings
      .filter(dr => dr?.document && !dr.document.hidden)
      .map((dr, index) => {
        const d = dr.document;
        const shape = d.shape ?? {};
        const localPoints = normalizePointsArray(shape.points ?? d.points ?? []);
        const baseX = N(d.x);
        const baseY = N(d.y);

        const absolutePoints = localPoints.map(p => ({
          x: round(baseX + N(p.x)),
          y: round(baseY + N(p.y))
        }));

        const first = absolutePoints[0] ?? null;
        const last = absolutePoints[absolutePoints.length - 1] ?? null;
        const length = first && last ? dist(first, last) : 0;

        return {
          index,
          drawingId: d.id,
          uuid: d.uuid,
          name: S(d.text ?? d.name, `(Drawing ${index})`),
          shapeType: shape.type ?? d.type ?? null,
          x: round(d.x),
          y: round(d.y),
          strokeColor: S(d.strokeColor ?? shape.strokeColor),
          strokeWidth: N(d.strokeWidth ?? shape.strokeWidth, 0),
          strokeAlpha: N(d.strokeAlpha ?? shape.strokeAlpha, 1),
          pointsCount: absolutePoints.length,
          first,
          last,
          length: round(length),
          absolutePoints,
          hidden: !!d.hidden,
          locked: !!d.locked
        };
      })
      .filter(row => row.pointsCount >= 2 && row.length > 10);
  }

  function nearestNode(point, nodes, maxDistance = null) {
    const threshold = maxDistance ?? Math.max(80, getGridSize() * 0.75);

    let best = null;
    for (const n of nodes) {
      const d = dist(point, n.center);
      if (!best || d < best.distance) {
        best = { node: n, distance: d };
      }
    }

    if (!best) return null;

    return {
      ...best,
      accepted: best.distance <= threshold,
      threshold
    };
  }

  function makeEdgeKey(a, b) {
    return [String(a), String(b)].sort().join(" <-> ");
  }

  function buildEdgesFromDrawings(nodes, drawingLines) {
    const edges = [];
    const seen = new Set();

    for (const line of drawingLines) {
      const aHit = nearestNode(line.first, nodes);
      const bHit = nearestNode(line.last, nodes);

      const a = aHit?.accepted ? aHit.node : null;
      const b = bHit?.accepted ? bHit.node : null;

      if (!a || !b || a.nodeId === b.nodeId) {
        edges.push({
          ok: false,
          reason: !a || !b ? "endpoint_not_near_two_nodes" : "same_node",
          drawingId: line.drawingId,
          drawingName: line.name,
          aNearest: aHit ? {
            nodeId: aHit.node.nodeId,
            name: aHit.node.name,
            distance: round(aHit.distance),
            accepted: aHit.accepted
          } : null,
          bNearest: bHit ? {
            nodeId: bHit.node.nodeId,
            name: bHit.node.name,
            distance: round(bHit.distance),
            accepted: bHit.accepted
          } : null
        });
        continue;
      }

      const key = makeEdgeKey(a.nodeId, b.nodeId);
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        ok: true,
        edgeKey: key,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
        fromName: a.name,
        toName: b.name,
        drawingId: line.drawingId,
        drawingName: line.name,
        length: round(dist(a.center, b.center))
      });
    }

    return edges;
  }

  function buildAdjacency(nodes, edges) {
    const map = new Map();

    for (const n of nodes) {
      map.set(n.nodeId, {
        nodeId: n.nodeId,
        name: n.name,
        kind: n.kind,
        center: n.center,
        neighbors: []
      });
    }

    for (const e of edges.filter(e => e.ok)) {
      map.get(e.fromNodeId)?.neighbors.push({
        nodeId: e.toNodeId,
        name: e.toName,
        viaDrawingId: e.drawingId
      });

      map.get(e.toNodeId)?.neighbors.push({
        nodeId: e.fromNodeId,
        name: e.fromName,
        viaDrawingId: e.drawingId
      });
    }

    return Array.from(map.values());
  }

  async function resolvePartyToken() {
    const result = {
      hasDbResolver: !!window.FUCompanion?.api?.getCurrentGameDb,
      dbName: null,
      dbUuid: null,
      sourceName: null,
      sourceUuid: null,
      token: null,
      tokenName: null,
      tokenUuid: null,
      reason: "not_found"
    };

    let db = null;
    let source = null;

    try {
      if (window.FUCompanion?.api?.getCurrentGameDb) {
        const resolved = await window.FUCompanion.api.getCurrentGameDb();
        db = resolved?.db ?? null;
        source = resolved?.source ?? resolved?.db ?? null;

        result.dbName = db?.name ?? null;
        result.dbUuid = db?.uuid ?? null;
        result.sourceName = source?.name ?? null;
        result.sourceUuid = source?.uuid ?? null;
      }
    } catch (e) {
      warn("DB Resolver failed. Falling back to selected token.", e);
    }

    const actors = [source, db].filter(Boolean);

    for (const actor of actors) {
      const token = canvas.tokens?.placeables?.find(t => {
        return t.actor?.id === actor.id || t.actor?.uuid === actor.uuid;
      });

      if (token) {
        result.token = token;
        result.tokenName = token.name;
        result.tokenUuid = token.document?.uuid ?? null;
        result.reason = "matched_actor_id";
        return result;
      }
    }

    for (const actor of actors) {
      const token = canvas.tokens?.placeables?.find(t => {
        return t.name === actor.name || t.actor?.name === actor.name;
      });

      if (token) {
        result.token = token;
        result.tokenName = token.name;
        result.tokenUuid = token.document?.uuid ?? null;
        result.reason = "matched_name";
        return result;
      }
    }

    const selected = canvas.tokens?.controlled?.[0] ?? null;
    if (selected) {
      result.token = selected;
      result.tokenName = selected.name;
      result.tokenUuid = selected.document?.uuid ?? null;
      result.reason = "fallback_selected_token";
      return result;
    }

    return result;
  }

  function findNodeForPoint(point, nodes, options = {}) {
    const containing = nodes.filter(n => containsPoint(n.bounds, point));

    if (containing.length) {
      containing.sort((a, b) => {
        const aa = N(a.width) * N(a.height);
        const bb = N(b.width) * N(b.height);
        return aa - bb;
      });

      return {
        method: "contains_point",
        node: containing[0],
        distance: round(dist(point, containing[0].center)),
        containing
      };
    }

    const threshold = options.threshold ?? Math.max(120, getGridSize());
    const nearest = nearestNode(point, nodes, threshold);

    return {
      method: nearest?.accepted ? "nearest_node" : "none",
      node: nearest?.accepted ? nearest.node : null,
      distance: nearest ? round(nearest.distance) : null,
      nearestDiagnostic: nearest
    };
  }

  async function buildGraph() {
    const nodes = getTileNodes();
    const drawingLines = getDrawingLineRows();
    const edges = buildEdgesFromDrawings(nodes, drawingLines);
    const adjacency = buildAdjacency(nodes, edges);
    const party = await resolvePartyToken();

    let partyPosition = null;

    if (party.token) {
      const point = party.token.center
        ? { x: round(party.token.center.x), y: round(party.token.center.y) }
        : centerOfBounds(boundsForPlaceable(party.token));

      partyPosition = {
        tokenName: party.tokenName,
        tokenUuid: party.tokenUuid,
        point,
        currentNode: findNodeForPoint(point, nodes, {
          threshold: Math.max(150, getGridSize() * 1.25)
        })
      };
    }

    return {
      generatedAt: new Date().toISOString(),
      scene: {
        id: canvas.scene?.id ?? null,
        name: canvas.scene?.name ?? null,
        gridSize: getGridSize()
      },
      counts: {
        nodes: nodes.length,
        drawingLines: drawingLines.length,
        validEdges: edges.filter(e => e.ok).length,
        rejectedEdges: edges.filter(e => !e.ok).length
      },
      party,
      partyPosition,
      nodes,
      drawingLines,
      edges,
      adjacency
    };
  }

  function getNodeById(graph, nodeId) {
    return graph.nodes.find(n => n.nodeId === nodeId) ?? null;
  }

  function getNeighborsForNode(graph, nodeId) {
    const row = graph.adjacency.find(a => a.nodeId === nodeId);
    if (!row) return [];
    return row.neighbors
      .map(n => getNodeById(graph, n.nodeId))
      .filter(Boolean);
  }

  function clearOverlay() {
    try {
      if (state.overlay) {
        state.overlay.destroy({ children: true });
        state.overlay = null;
      }
    } catch (_) {
      state.overlay = null;
    }
  }

  function drawCircleMarker(container, node, color, labelText, alpha = 0.18) {
    const radius = Math.max(18, Math.min(N(node.width, 25), N(node.height, 25)) / 2 + 12);

    const g = new PIXI.Graphics();
    g.lineStyle(4, color, 0.95);
    g.beginFill(color, alpha);
    g.drawCircle(node.center.x, node.center.y, radius);
    g.endFill();

    container.addChild(g);

    if (labelText) {
      const label = new PIXI.Text(labelText, {
        fontFamily: "Arial",
        fontSize: 18,
        fill: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center"
      });

      label.anchor.set(0.5, 0.5);
      label.x = node.center.x;
      label.y = node.center.y - radius - 18;

      container.addChild(label);
    }
  }

  function drawMovementOverlay(graph, currentNode, neighborNodes) {
    clearOverlay();

    const overlay = new PIXI.Container();
    overlay.name = "ONI Pathfinder Movement Overlay";
    overlay.zIndex = 999999;
    overlay.sortableChildren = true;

    for (const n of neighborNodes) {
      const line = new PIXI.Graphics();
      line.lineStyle(6, HIGHLIGHT.line, 0.65);
      line.moveTo(currentNode.center.x, currentNode.center.y);
      line.lineTo(n.center.x, n.center.y);
      overlay.addChild(line);
    }

    drawCircleMarker(overlay, currentNode, HIGHLIGHT.current, "Current", 0.12);

    neighborNodes.forEach((n, i) => {
      drawCircleMarker(overlay, n, HIGHLIGHT.neighbor, `${i + 1}`, 0.22);
    });

    try {
      canvas.stage.sortableChildren = true;
      canvas.stage.addChild(overlay);
    } catch (e) {
      err("Could not add overlay to canvas stage.", e);
    }

    state.overlay = overlay;
  }

  function buildPseudoMoveScriptSource() {
    return `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("Pathfinder pseudo movement needs casterToken.");

const fromX = Number(params.fromX ?? casterToken.center.x);
const fromY = Number(params.fromY ?? casterToken.center.y);
const toX = Number(params.toX ?? fromX);
const toY = Number(params.toY ?? fromY);
const durationMs = Math.max(1, Number(params.durationMs ?? 650));
const holdMs = Math.max(0, Number(params.holdMs ?? 40));

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function animate(obj, startX, startY, endX, endY, durMs) {
  return new Promise(resolve => {
    const start = performance.now();
    const ticker = canvas.app.ticker;

    const update = () => {
      const raw = (performance.now() - start) / durMs;
      const t = Math.min(Math.max(raw, 0), 1);
      const e = easeInOutCubic(t);

      obj.x = startX + (endX - startX) * e;
      obj.y = startY + (endY - startY) * e;

      if (t >= 1) {
        ticker.remove(update);
        resolve();
      }
    };

    ticker.add(update);
  });
}

async function createClone(token) {
  const baseObj = token.mesh ?? token.icon;
  const texture = baseObj?.texture ?? await loadTexture(token.document.texture.src);

  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.x = fromX;
  sprite.y = fromY;

  if (baseObj) {
    sprite.width = baseObj.width;
    sprite.height = baseObj.height;
    sprite.rotation = baseObj.rotation ?? 0;
    sprite.alpha = baseObj.alpha ?? 1;
  } else {
    sprite.width = token.w;
    sprite.height = token.h;
  }

  sprite.zIndex = 500000;

  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(sprite);
  canvas.stage.sortChildren();

  return sprite;
}

const baseMesh = casterToken.mesh ?? casterToken.icon;
const originalTokenVisible = casterToken.visible;
const originalMeshVisible = baseMesh?.visible ?? true;

let sprite = null;

try {
  sprite = await createClone(casterToken);

  if (baseMesh) baseMesh.visible = false;
  casterToken.visible = false;

  await animate(sprite, fromX, fromY, toX, toY, durationMs);

  if (holdMs > 0) await wait(holdMs);
} finally {
  if (sprite) {
    try { canvas.stage.removeChild(sprite); } catch (_) {}
    sprite.destroy();
  }

  if (baseMesh) baseMesh.visible = originalMeshVisible;
  casterToken.visible = originalTokenVisible;
}
`;
  }

  async function playPseudoMoveThenUpdateRealToken(token, node) {
    if (!token?.document) {
      ui.notifications?.warn?.("No party token found to move.");
      return false;
    }

    const tokenWidth = N(token.w, N(token.document.width, 1) * getGridSize());
    const tokenHeight = N(token.h, N(token.document.height, 1) * getGridSize());

    const fromCenter = token.center
      ? { x: round(token.center.x), y: round(token.center.y) }
      : centerOfBounds(boundsForPlaceable(token));

    const toCenter = {
      x: N(node.center.x),
      y: N(node.center.y)
    };

    const targetX = Math.round(toCenter.x - tokenWidth / 2);
    const targetY = Math.round(toCenter.y - tokenHeight / 2);

    log("PSEUDO MOVE START", {
      token: token.name,
      fromCenter,
      toNode: {
        id: node.nodeId,
        name: node.name,
        kind: node.kind,
        center: node.center
      },
      realUpdateOnce: { x: targetX, y: targetY }
    });

    const pseudoApi = game.ONI?.pseudo?.play ?? null;

    if (typeof pseudoApi !== "function") {
      warn("Pseudo Animation API not found. Falling back to single real token update.");
      await token.document.update({ x: targetX, y: targetY }, { animate: false });
      return true;
    }

    const scriptSource = buildPseudoMoveScriptSource();

    // Broadcast visual-only movement to all clients.
    game.ONI.pseudo.play({
      scriptId: "pathfinder.boardMove.v2",
      scriptSource,
      casterTokenUuid: token.document.uuid,
      targetTokenUuids: [],
      params: {
        fromX: fromCenter.x,
        fromY: fromCenter.y,
        toX: toCenter.x,
        toY: toCenter.y,
        durationMs: MOVE_MS,
        holdMs: 50
      },
      meta: {
        source: "Pathfinder Movement Prototype V2",
        fromNodeId: state.currentNode?.nodeId ?? null,
        toNodeId: node.nodeId,
        toNodeName: node.name
      }
    });

    // Update the real token document ONCE near the end of the pseudo animation.
    // This avoids Foundry document animation spam, but also prevents visible snap-back.
    const updateDelay = Math.max(0, MOVE_MS - REAL_UPDATE_BEFORE_END_MS);
    await wait(updateDelay);

    await token.document.update(
      { x: targetX, y: targetY },
      { animate: false }
    );

    // Let the pseudo clone finish and let Foundry process the single document update.
    await wait(REAL_UPDATE_BEFORE_END_MS + REBUILD_AFTER_MOVE_MS);

    // Refresh token reference after update.
    const freshToken =
      canvas.tokens?.get?.(token.id) ??
      canvas.tokens?.placeables?.find(t => t.document?.id === token.document.id) ??
      token;

    state.partyToken = freshToken;

    console.log(`${TAG} LANDED TILE`, {
      nodeId: node.nodeId,
      name: node.name,
      kind: node.kind,
      uuid: node.uuid,
      texture: node.texture,
      center: node.center,
      realTokenUpdate: { x: targetX, y: targetY }
    });

    return true;
  }

  function summarizeActiveMovement(graph, currentNode, neighborNodes, source = "normal") {
    console.group(`${TAG} ACTIVE MOVEMENT`);
    console.log("Source:", source);
    console.log("Scene:", graph.scene);
    console.log("Counts:", graph.counts);
    console.log("Party:", {
      dbName: graph.party?.dbName,
      sourceName: graph.party?.sourceName,
      tokenName: graph.party?.tokenName,
      tokenUuid: graph.party?.tokenUuid,
      reason: graph.party?.reason
    });
    console.log("Current Node:", currentNode);
    console.table(neighborNodes.map((n, i) => ({
      option: i + 1,
      nodeId: n.nodeId,
      name: n.name,
      kind: n.kind,
      cx: n.center.x,
      cy: n.center.y
    })));
    console.groupEnd();
  }

  async function rebuildMovementState() {
    const graph = await buildGraph();
    state.graph = graph;

    const partyToken = graph.party?.token ?? state.partyToken ?? null;
    state.partyToken = partyToken;

    if (!partyToken) {
      clearOverlay();
      ui.notifications?.warn?.("Pathfinder: Could not find party token. Select the party token and run again.");
      warn("No party token found.", graph.party);
      return false;
    }

    let currentNode = graph.partyPosition?.currentNode?.node ?? null;
    let currentSource = "detected_from_token_position";

    // Important fix:
    // Right after pseudo movement, Foundry may briefly report the old token center.
    // If we just landed on a known node, trust that node for the next movement state.
    if (state.pendingCurrentNodeId) {
      const forcedNode = getNodeById(graph, state.pendingCurrentNodeId);
      if (forcedNode) {
        currentNode = forcedNode;
        currentSource = "forced_after_landing";
        state.lastLandedNodeId = forcedNode.nodeId;
      }

      state.pendingCurrentNodeId = null;
    }

    state.currentNode = currentNode;

    if (!currentNode) {
      clearOverlay();
      ui.notifications?.warn?.("Pathfinder: Party token is not standing on or near a tile node.");
      warn("No current node detected.", graph.partyPosition);
      return false;
    }

    const neighborNodes = getNeighborsForNode(graph, currentNode.nodeId);
    state.neighborIds = new Set(neighborNodes.map(n => n.nodeId));

    drawMovementOverlay(graph, currentNode, neighborNodes);
    summarizeActiveMovement(graph, currentNode, neighborNodes, currentSource);

    ui.notifications?.info?.(
      `Pathfinder ready: ${currentNode.name} → ${neighborNodes.length} connected move(s).`
    );

    return true;
  }

  async function handleCanvasClick(ev) {
    if (!state.active) return;
    if (state.busy) {
      ui.notifications?.info?.("Pathfinder is already moving.");
      return;
    }

    if (ev.button !== 0) return;

    const graph = state.graph;
    if (!graph) return;

    const point = clientToCanvasPoint(ev.clientX, ev.clientY);
    const hit = findNodeForPoint(point, graph.nodes, {
      threshold: Math.max(120, getGridSize())
    });

    const clickedNode = hit.node ?? null;
    if (!clickedNode) return;

    const isNeighbor = state.neighborIds.has(clickedNode.nodeId);
    const isCurrent = state.currentNode?.nodeId === clickedNode.nodeId;

    if (isCurrent) {
      ui.notifications?.info?.("That is the current node.");
      return;
    }

    if (!isNeighbor) {
      ui.notifications?.warn?.(`${clickedNode.name} is not connected to your current node.`);
      console.warn(`${TAG} INVALID MOVE`, {
        clickedNode,
        currentNode: state.currentNode,
        validNeighborIds: Array.from(state.neighborIds)
      });
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();

    state.busy = true;
    clearOverlay();

    try {
      // This is the key fix for next-node logic.
      // The destination becomes the forced current node after the move.
      state.pendingCurrentNodeId = clickedNode.nodeId;

      const ok = await playPseudoMoveThenUpdateRealToken(state.partyToken, clickedNode);
      if (!ok) return;

      await rebuildMovementState();
    } catch (e) {
      console.error(`${TAG} Movement failed.`, e);
      ui.notifications?.error?.("Pathfinder movement failed. Check console.");
    } finally {
      state.busy = false;
    }
  }

  function installClickListener() {
    const view = getCanvasView();
    if (!view) {
      ui.notifications?.error?.("Pathfinder: Could not find canvas view.");
      return false;
    }

    const handler = (ev) => {
      handleCanvasClick(ev).catch(e => {
        console.error(`${TAG} Click handler failed.`, e);
      });
    };

    view.addEventListener("pointerdown", handler, true);
    state.clickHandler = handler;

    return true;
  }

  function stop() {
    state.active = false;

    try {
      const view = getCanvasView();
      if (view && state.clickHandler) {
        view.removeEventListener("pointerdown", state.clickHandler, true);
      }
    } catch (_) {}

    state.clickHandler = null;
    clearOverlay();

    console.log(`${TAG} stopped.`);
    ui.notifications?.info?.("Pathfinder movement prototype stopped.");
  }

  window.__ONI_PATHFINDER_MOVE_TEST__ = {
    state,
    stop,
    rebuild: rebuildMovementState,
    get graph() {
      return state.graph;
    },
    get currentNode() {
      return state.currentNode;
    },
    get neighborIds() {
      return Array.from(state.neighborIds);
    }
  };

  const installed = installClickListener();
  if (!installed) return;

  const ok = await rebuildMovementState();
  if (!ok) {
    warn("Prototype started, but movement state could not be built.");
  }

  console.log(`${TAG} Ready.`);
  console.log("Stop with:");
  console.log("window.__ONI_PATHFINDER_MOVE_TEST__?.stop()");
})();
