// ============================================================================
// Dungeon Pathing System — Bootstrap / Main Controller
//
// Lifecycle (per turn):
//   1. Turn Start    – graph built, overlay drawn, party token located
//   2. Player Choice – player clicks a neighbour tile
//   3. Token Moved   – token animates to destination (preview)
//   4. Confirmation  – dialog: "Land here?" / "Go back"
//   5a. Confirmed    – emit turn-confirmed, dispatch tile event, clear if needed
//   5b. Reverted     – token returns to previous position
//   6. Turn End      – emit turn-end, rebuild for next turn
//   Repeat
//
// Only activates when the scene's sceneMode flag === "dungeon".
// ============================================================================
(() => {
  const DP      = globalThis.DungeonPathing ??= {};
  const MOD     = DP.MODULE_ID;
  const TAG     = "[DungeonPathing][Bootstrap]";
  const GLOBAL  = "__ONI_DUNGEON_PATHING__";

  // Prevent double-install
  if (globalThis[GLOBAL]?.state?.installed) return;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    installed:       true,
    active:          false,   // system is running on this scene
    busy:            false,   // mid-turn (block re-entry)
    graph:           null,
    partyToken:      null,
    currentNode:     null,
    neighborIds:     new Set(),
    forcedNodeId:    null,    // forces current node after pseudo-move (prototype technique)
    clickHandler:    null,
    hookIds:         [],
  };

  // ---------------------------------------------------------------------------
  // Scene mode detection
  // ---------------------------------------------------------------------------
  function getSceneMode(scene) {
    const fab = scene?.flags?.[MOD]?.[DP.FABULA_ROOT_KEY]?.[DP.GENERAL_KEY];
    const mode = fab?.[DP.SCENE_MODE_KEY];
    if (mode === DP.SCENE_MODE.DUNGEON || mode === DP.SCENE_MODE.EXPLORATION || mode === DP.SCENE_MODE.NONE) return mode;
    // backward-compat: old boolean cameraFollowToken flag
    const legacy = fab?.cameraFollowToken;
    if (legacy === true || legacy === "true" || legacy === 1) return DP.SCENE_MODE.EXPLORATION;
    return DP.SCENE_MODE.NONE;
  }

  // ---------------------------------------------------------------------------
  // Canvas coordinate helper
  // ---------------------------------------------------------------------------
  function getCanvasView() {
    return canvas?.app?.view ?? canvas?.app?.renderer?.view
        ?? document.querySelector("#board canvas") ?? document.querySelector("canvas");
  }

  // ---------------------------------------------------------------------------
  // Graph + overlay rebuild
  // ---------------------------------------------------------------------------
  async function rebuild() {
    const scene = canvas?.scene;
    if (!scene) return false;

    const graph = DP.Graph.build();
    state.graph = graph;

    // Ensure every tile has a state entry (GM only; no-op for players)
    if (game.user?.isGM) {
      for (const node of graph.nodes) {
        const tileDoc = scene.tiles.get(node.nodeId);
        if (tileDoc) await DP.TileState.ensure(scene, tileDoc).catch(() => {});
      }
    }

    // Resolve party token
    const token = await DP.Graph.resolvePartyToken();
    state.partyToken = token;

    if (!token) {
      DP.Overlay.clear();
      ui.notifications?.warn?.("Dungeon Pathing: party token not found. Select the party token.");
      return false;
    }

    // Determine current node
    let currentNode = null;

    if (state.forcedNodeId) {
      currentNode = graph.nodeMap.get(state.forcedNodeId) ?? null;
      state.forcedNodeId = null;
    }

    if (!currentNode) {
      const center = token.center ?? { x: Number(token.document.x), y: Number(token.document.y) };
      currentNode  = DP.Graph.findNodeForPoint(center, graph.nodes);
    }

    state.currentNode  = currentNode;

    if (!currentNode) {
      DP.Overlay.clear();
      ui.notifications?.warn?.("Dungeon Pathing: party token is not on a recognised tile node.");
      return false;
    }

    const neighbors = DP.Graph.getNeighbors(currentNode.nodeId, graph);
    state.neighborIds = new Set(neighbors.map(n => n.nodeId));

    DP.Overlay.draw(currentNode, neighbors);
    DP.Events.graphRebuilt(graph, token);

    console.debug(TAG, "Graph ready →", currentNode.name, `(${neighbors.length} neighbour(s))`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Turn loop
  // ---------------------------------------------------------------------------
  async function handleClick(ev) {
    if (!state.active) return;
    if (state.busy)    { ui.notifications?.info?.("Movement in progress…"); return; }
    if (ev.button !== 0) return;

    const graph = state.graph;
    if (!graph) return;

    const worldPt = DP.Graph.clientToWorld(ev.clientX, ev.clientY);
    const clicked  = DP.Graph.findNodeForPoint(worldPt, graph.nodes);
    if (!clicked) return;

    const isCurrent  = state.currentNode?.nodeId === clicked.nodeId;
    const isNeighbor = state.neighborIds.has(clicked.nodeId);

    if (isCurrent)   { ui.notifications?.info?.("You are already on this tile."); return; }
    if (!isNeighbor) { ui.notifications?.warn?.(`${clicked.name} is not connected to your current tile.`); return; }

    ev.preventDefault();
    ev.stopPropagation();

    state.busy = true;
    DP.Overlay.clear();

    const fromNode = state.currentNode;
    const token    = state.partyToken;
    const scene    = canvas.scene;

    try {
      // — Turn Start —
      DP.Events.turnStart(token.document, fromNode);

      // — Save position for potential revert —
      const savedPos = DP.Movement.savePosition(token);

      // — Move token to destination (preview) —
      state.forcedNodeId = clicked.nodeId;
      const moved = await DP.Movement.moveToNode(token, clicked);
      if (!moved) { state.forcedNodeId = null; return; }

      // Refresh token reference after the real document update
      const freshToken = canvas.tokens?.get?.(token.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === token.document.id)
        ?? token;
      state.partyToken = freshToken;

      // — Emit token moved event —
      DP.Events.tokenMoved(freshToken.document, fromNode, clicked);

      // — Player confirmation —
      const confirmed = await DP.ConfirmDialog.ask(clicked.name);

      if (!confirmed) {
        // — Revert —
        state.forcedNodeId = fromNode.nodeId;
        await DP.Movement.revertToPosition(freshToken, savedPos);
        DP.Events.turnReverted(freshToken.document, fromNode, clicked);
        await rebuild();
        ui.notifications?.info?.("Movement cancelled — returned to previous tile.");
        return;
      }

      // — Confirmed —
      const tileDoc = scene.tiles.get(clicked.nodeId) ?? null;
      DP.Events.turnConfirmed(freshToken.document, fromNode, clicked, tileDoc);

      // Resolve tile type (registry state → fallback to node's inferred type)
      const tileType = (tileDoc && DP.TileState.getCurrentType(scene, tileDoc.id))
        ?? clicked.tileType
        ?? DP.TILE_TYPES.UNKNOWN;

      // — Tile Event —
      DP.Events.tileEvent(freshToken.document, clicked, tileDoc, tileType);

      const { ok, cleared } = await DP.TileEventRegistry.dispatch(tileType, tileDoc, freshToken.document, scene);

      if (cleared && tileDoc) {
        await DP.Socket.clearTile(scene, tileDoc.id);
      }

      // — Turn End —
      DP.Events.turnEnd(freshToken.document, clicked);

    } catch (e) {
      console.error(TAG, "Turn loop error", e);
      ui.notifications?.error?.("Dungeon Pathing: unexpected error. See console.");
    } finally {
      state.busy = false;
      await rebuild();
    }
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  function installClickListener() {
    const view = getCanvasView();
    if (!view) return false;

    const handler = ev => { handleClick(ev).catch(e => console.error(TAG, "click handler", e)); };
    view.addEventListener("pointerdown", handler, true);
    state.clickHandler = handler;
    return true;
  }

  function removeClickListener() {
    try {
      const view = getCanvasView();
      if (view && state.clickHandler) view.removeEventListener("pointerdown", state.clickHandler, true);
    } catch {}
    state.clickHandler = null;
  }

  // ---------------------------------------------------------------------------
  // Activate / deactivate per scene
  // ---------------------------------------------------------------------------
  async function activate() {
    if (state.active) return;
    state.active = true;
    installClickListener();
    await rebuild();
    ui.notifications?.info?.("Dungeon Pathing active. Click a highlighted tile to move.");
    console.debug(TAG, "Activated.");
  }

  function deactivate() {
    state.active      = false;
    state.busy        = false;
    state.graph       = null;
    state.partyToken  = null;
    state.currentNode = null;
    state.neighborIds.clear();
    state.forcedNodeId = null;
    removeClickListener();
    DP.Overlay.clear();
    console.debug(TAG, "Deactivated.");
  }

  async function applyForScene(scene) {
    if (!canvas?.ready) return;
    const mode = getSceneMode(scene ?? canvas.scene);
    if (mode === DP.SCENE_MODE.DUNGEON) {
      await activate();
    } else {
      if (state.active) deactivate();
    }
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  function installHooks() {
    const hCanvasReady = Hooks.on("canvasReady", async () => {
      await applyForScene(canvas.scene);
    });
    state.hookIds.push(["canvasReady", hCanvasReady]);

    const hCanvasTearDown = Hooks.on("canvasTearDown", () => {
      deactivate();
    });
    state.hookIds.push(["canvasTearDown", hCanvasTearDown]);

    const hUpdateScene = Hooks.on("updateScene", async (scene) => {
      if (!canvas?.scene || scene.id !== canvas.scene.id) return;
      // Scene mode may have changed → re-evaluate
      await applyForScene(scene);
    });
    state.hookIds.push(["updateScene", hUpdateScene]);

    // Rebuild graph if tiles or drawings change while dungeon mode is active
    const rebuildIfActive = async () => {
      if (!state.active || state.busy) return;
      await rebuild();
    };

    ["createTile", "updateTile", "deleteTile",
     "createDrawing", "updateDrawing", "deleteDrawing"].forEach(hookName => {
      const id = Hooks.on(hookName, rebuildIfActive);
      state.hookIds.push([hookName, id]);
    });

    // Hook into socketlib.ready to register our own socket handlers on the shared module socket.
    // socketlib allows multiple register() calls on the same module socket — this is safe
    // even though main.js also calls socketlib.registerModule().
    Hooks.once("socketlib.ready", () => {
      try {
        const socket = socketlib.registerModule(MOD);
        DP.Socket.register(socket);
      } catch (e) {
        // If socketlib isn't present (not a hard dependency), degrade gracefully.
        // Tile state mutations from non-GM clients will log a warning instead.
        console.warn(TAG, "socketlib not available — socket handlers skipped.", e?.message ?? e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  globalThis[GLOBAL] = {
    state,
    activate,
    deactivate,
    rebuild,

    /** Developer helper: reset all dungeon tiles to initial state. */
    async resetDungeon() {
      await DP.Socket.resetDungeon(canvas.scene);
      if (state.active) await rebuild();
    },

    /** Developer helper: force a specific tile type on a tile. */
    async mutateTile(tileId, newType, newTexture = null) {
      await DP.Socket.mutateTile(canvas.scene, tileId, newType, newTexture);
      if (state.active) await rebuild();
    },

    /** Read current graph snapshot. */
    get graph() { return state.graph; },
    get currentNode() { return state.currentNode; }
  };

  // Boot when Foundry is ready
  Hooks.once("ready", () => {
    installHooks();
    if (canvas?.ready) applyForScene(canvas?.scene);
    console.debug(TAG, "Dungeon Pathing System loaded.");
    console.debug(TAG, "Dev API: window.__ONI_DUNGEON_PATHING__");
    console.debug(TAG, "  .resetDungeon()  — reset all tiles to initial state");
    console.debug(TAG, "  .mutateTile(id, type, texture?)  — transform a tile");
    console.debug(TAG, "  .rebuild()  — rebuild graph manually");
  });
})();
