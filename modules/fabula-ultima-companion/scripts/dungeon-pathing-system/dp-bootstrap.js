// ============================================================================
// Dungeon Pathing System — Bootstrap / Main Controller
//
// Turn lifecycle:
//   1. Turn Start    — graph built, helper mode updated
//   2. Player Choice — player clicks a walkable tile
//   3. Token Moved   — pseudo-animation + real update (with TOKEN_OFFSET)
//   4. Confirmation  — in-canvas ✔/⟲ buttons beside the token
//   5a. Confirmed    — tile event dispatched, tile cleared if needed
//   5b. Reverted     — token returns to previous position
//   6. Turn End      — graph rebuilt for next turn
//
// Active only when scene's sceneMode flag === "dungeon".
// ============================================================================
(() => {
  const DP      = globalThis.DungeonPathing ??= {};
  const MOD     = DP.MODULE_ID;
  const TAG     = "[DungeonPathing][Bootstrap]";
  const GLOBAL  = "__ONI_DUNGEON_PATHING__";

  if (globalThis[GLOBAL]?.state?.installed) return;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    installed:    true,
    active:       false,
    busy:         false,
    graph:        null,
    partyToken:   null,
    currentNode:  null,
    neighborIds:  new Set(),
    forcedNodeId: null,
    clickHandler: null,
    hoverHandler: null,
    hoverTimer:   null,
    lastHoveredNodeId: null,
    hookIds:      [],
  };

  // ---------------------------------------------------------------------------
  // Scene mode detection
  // ---------------------------------------------------------------------------
  function getSceneMode(scene) {
    const fab  = scene?.flags?.[MOD]?.[DP.FABULA_ROOT_KEY]?.[DP.GENERAL_KEY];
    const mode = fab?.[DP.SCENE_MODE_KEY];
    if (mode === DP.SCENE_MODE.DUNGEON || mode === DP.SCENE_MODE.EXPLORATION || mode === DP.SCENE_MODE.NONE) return mode;
    const legacy = fab?.cameraFollowToken;
    if (legacy === true || legacy === "true" || legacy === 1) return DP.SCENE_MODE.EXPLORATION;
    return DP.SCENE_MODE.NONE;
  }

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

    if (game.user?.isGM) {
      for (const node of graph.nodes) {
        const tileDoc = scene.tiles.get(node.nodeId);
        if (tileDoc) await DP.TileState.ensure(scene, tileDoc).catch(() => {});
      }
    }

    const token = await DP.Graph.resolvePartyToken();
    state.partyToken = token;

    if (!token) {
      DP.HelperMode.hide();
      ui.notifications?.warn?.("Dungeon Pathing: party token not found.");
      return false;
    }

    let currentNode = null;
    if (state.forcedNodeId) {
      currentNode = graph.nodeMap.get(state.forcedNodeId) ?? null;
      state.forcedNodeId = null;
    }
    if (!currentNode) {
      // Always derive from document coords (always current on all clients).
      // Reverse TOKEN_OFFSET so we seek the tile's logical centre, not the
      // offset display position — this keeps GM and player in sync.
      const gSize = Number(canvas?.grid?.size ?? 100) || 100;
      const offX  = Number(DP.UI?.TOKEN_OFFSET?.x ?? 0);
      const offY  = Number(DP.UI?.TOKEN_OFFSET?.y ?? 0);
      const tw    = Number(token.document?.width  ?? 1) * gSize;
      const th    = Number(token.document?.height ?? 1) * gSize;
      const seek  = {
        x: Number(token.document.x) + tw / 2 - offX,
        y: Number(token.document.y) + th / 2 - offY,
      };
      currentNode = DP.Graph.findNodeForPoint(seek, graph.nodes);
    }

    state.currentNode = currentNode;

    if (!currentNode) {
      DP.HelperMode.hide();
      ui.notifications?.warn?.("Dungeon Pathing: party token is not on a recognised tile node.");
      return false;
    }

    const neighbors = DP.Graph.getNeighbors(currentNode.nodeId, graph);
    state.neighborIds = new Set(neighbors.map(n => n.nodeId));

    // Update helper mode with current neighbours (shows hand cursors if mode is ON)
    DP.HelperMode.update(neighbors);

    state.lastHoveredNodeId = null; // reset hover tracking after rebuild
    DP.Overlay.clearHover?.();
    DP.Events.graphRebuilt(graph, token);

    // Enter standby: system is ready, waiting for the player to pick a tile.
    DP.Events.standbyStart(token.document, currentNode, neighbors);
    DP.ScanMode?.show();

    console.debug(TAG, "Graph ready →", currentNode.name, `(${neighbors.length} neighbour(s))`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Hover sound detection
  // ---------------------------------------------------------------------------
  function installHoverHandler() {
    if (state.hoverHandler) return;
    const view = getCanvasView();
    if (!view) return;

    state.hoverHandler = (ev) => {
      if (!state.active || state.busy) return;
      if (state.neighborIds.size === 0) return;
      if (DP.ConfirmDialog?.isOpen) return;

      // Throttle: only evaluate every ~80 ms
      if (state.hoverTimer) return;
      state.hoverTimer = setTimeout(() => { state.hoverTimer = null; }, 80);

      const worldPt = DP.Graph.clientToWorld(ev.clientX, ev.clientY);
      const graph   = state.graph;
      if (!graph) return;

      // Find which neighbour (if any) the pointer is currently over
      let hovered = null;
      for (const nodeId of state.neighborIds) {
        const node = graph.nodeMap.get(nodeId);
        if (!node) continue;
        const b = node.bounds;
        if (worldPt.x >= b.left && worldPt.x <= b.right &&
            worldPt.y >= b.top  && worldPt.y <= b.bottom) {
          hovered = node;
          break;
        }
      }

      if (hovered && hovered.nodeId !== state.lastHoveredNodeId) {
        state.lastHoveredNodeId = hovered.nodeId;
        DP.Sound.playHover();
        DP.Overlay.setHoverNode(hovered);
      } else if (!hovered && state.lastHoveredNodeId !== null) {
        state.lastHoveredNodeId = null;
        DP.Overlay.clearHover();
      }
    };

    view.addEventListener("pointermove", state.hoverHandler, { passive: true });
  }

  function removeHoverHandler() {
    const view = getCanvasView();
    if (view && state.hoverHandler) view.removeEventListener("pointermove", state.hoverHandler);
    state.hoverHandler = null;
    if (state.hoverTimer) { clearTimeout(state.hoverTimer); state.hoverTimer = null; }
  }

  // ---------------------------------------------------------------------------
  // Turn loop
  // ---------------------------------------------------------------------------
  async function handleClick(ev) {
    if (!state.active) return;
    if (state.busy) { ui.notifications?.info?.("Movement in progress…"); return; }
    if (ev.button !== 0) return;

    // If the in-canvas confirm buttons are showing, let PIXI handle pointer events
    if (DP.ConfirmDialog?.isOpen) return;

    const graph = state.graph;
    if (!graph) return;

    const worldPt = DP.Graph.clientToWorld(ev.clientX, ev.clientY);
    const clicked  = DP.Graph.findNodeForPoint(worldPt, graph.nodes);
    if (!clicked) return;

    const isCurrent  = state.currentNode?.nodeId === clicked.nodeId;
    const isNeighbor = state.neighborIds.has(clicked.nodeId);

    if (isCurrent)   { ui.notifications?.info?.("You are already on this tile."); return; }
    if (!isNeighbor) { ui.notifications?.warn?.(`${clicked.name} is not a connected tile.`); return; }

    ev.preventDefault();
    ev.stopPropagation();

    // Standby ends — player has chosen a destination.
    // NOTE: use state.partyToken here; const token is declared later in this scope.
    DP.Events.standbyEnd(state.partyToken?.document, state.currentNode, clicked);
    DP.ScanMode?.hide();

    state.busy = true;
    DP.HelperMode.hide();
    DP.Overlay.clearHover?.();

    const fromNode = state.currentNode;
    const token    = state.partyToken;
    const scene    = canvas.scene;

    try {
      // — Turn Start —
      DP.Events.turnStart(token.document, fromNode);

      // — Save position for revert —
      const savedPos = DP.Movement.savePosition(token);

      // — Footstep sound —
      DP.Sound.playFootstep();

      // — Move (preview with offset) —
      state.forcedNodeId = clicked.nodeId;
      const moved = await DP.Movement.moveToNode(token, clicked);
      if (!moved) { state.forcedNodeId = null; return; }

      // Refresh token reference after real doc update
      const freshToken = canvas.tokens?.get?.(token.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === token.document.id)
        ?? token;
      state.partyToken = freshToken;

      // — Token moved event —
      DP.Events.tokenMoved(freshToken.document, fromNode, clicked);

      // — In-canvas confirmation buttons —
      const confirmed = await DP.ConfirmDialog.ask(freshToken);

      if (!confirmed) {
        // — Revert —
        state.forcedNodeId = fromNode.nodeId;
        await DP.Movement.revertToPosition(freshToken, savedPos);
        DP.Events.turnReverted(freshToken.document, fromNode, clicked);
        await rebuild();
        return;
      }

      // — Confirmed —
      const tileDoc  = scene.tiles.get(clicked.nodeId) ?? null;
      DP.Events.turnConfirmed(freshToken.document, fromNode, clicked, tileDoc);

      const tileType = (tileDoc && DP.TileState.getCurrentType(scene, tileDoc.id))
        ?? clicked.tileType
        ?? DP.TILE_TYPES.UNKNOWN;

      DP.Events.tileEvent(freshToken.document, clicked, tileDoc, tileType);

      const { ok, cleared } = await DP.TileEventRegistry.dispatch(tileType, tileDoc, freshToken.document, scene);

      // Mark tile visited for Fast Travel eligibility (fire-and-forget).
      if (tileDoc) {
        DP.Socket.markVisited(scene, tileDoc.id).catch(e => console.warn(TAG, "markVisited:", e));
      }

      // Per-tile override: "Persist after trigger" checkbox overrides registry default.
      const persistFlag = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.persistAfterTrigger`);
      const shouldClear = (persistFlag === true || persistFlag === "true") ? false : cleared;

      if (shouldClear && tileDoc) {
        await DP.Socket.clearTile(scene, tileDoc.id);
      }

      // — Turn End —
      DP.Events.turnEnd(freshToken.document, clicked);

    } catch (e) {
      console.error(TAG, "Turn loop error", e);
      ui.notifications?.error?.("Dungeon Pathing: unexpected error. See console.");
    } finally {
      state.busy = false;
      DP.ConfirmDialog.forceClose?.();
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
  // Activate / deactivate
  // ---------------------------------------------------------------------------
  async function activate() {
    if (state.active) return;
    state.active = true;
    DP.Sound.preloadAll();
    installClickListener();
    installHoverHandler();
    DP.HelperMode.activate();
    DP.ScanMode?.attachTicker();
    await rebuild();
    console.debug(TAG, "Activated. Press H to toggle helper mode.");
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
    removeHoverHandler();
    DP.FastTravel?.exit?.();
    DP.HelperMode.deactivate();
    DP.Overlay.clearHover?.();
    DP.ScanMode?.hide();
    DP.ScanMode?.detachTicker();
    DP.ConfirmDialog?.forceClose?.();
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
      await applyForScene(scene);
    });
    state.hookIds.push(["updateScene", hUpdateScene]);

    const rebuildIfActive = async () => {
      if (!state.active || state.busy) return;
      await rebuild();
    };

    ["createTile", "updateTile", "deleteTile",
     "createDrawing", "updateDrawing", "deleteDrawing"].forEach(hookName => {
      const id = Hooks.on(hookName, rebuildIfActive);
      state.hookIds.push([hookName, id]);
    });

    // Block token drag (left-click drag-drop) while dungeon mode is active.
    // Allows only updates flagged dungeonPathing:true (from dp-movement.js).
    // GM clients are exempt so the GM can still manually correct positions.
    Hooks.on("preUpdateToken", (tokenDoc, change, options) => {
      if (!state.active) return;
      if (game.user?.isGM) return;
      if (options?.dungeonPathing) return;
      if (!("x" in change || "y" in change)) return;
      delete change.x;
      delete change.y;
    });

    // Sync currentNode across all clients when the party token moves.
    // The local client has state.busy = true during its own turn loop,
    // so this only triggers a rebuild on OTHER clients (GM / spectators).
    const hUpdateToken = Hooks.on("updateToken", async (tokenDoc) => {
      if (!state.active || state.busy) return;
      // If we know the party token, only rebuild for that token's moves.
      if (state.partyToken && state.partyToken.document?.id !== tokenDoc.id) return;
      await rebuild();
    });
    state.hookIds.push(["updateToken", hUpdateToken]);

    Hooks.once("socketlib.ready", () => {
      try {
        const socket = socketlib.registerModule(MOD);
        DP.Socket.register(socket);
      } catch (e) {
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

    async resetDungeon() {
      await DP.Socket.resetDungeon(canvas.scene);
      if (state.active) await rebuild();
    },

    async mutateTile(tileId, newType, newTexture = null) {
      await DP.Socket.mutateTile(canvas.scene, tileId, newType, newTexture);
      if (state.active) await rebuild();
    },

    get graph()       { return state.graph; },
    get currentNode() { return state.currentNode; }
  };

  Hooks.once("ready", () => {
    installHooks();
    if (canvas?.ready) applyForScene(canvas?.scene);
    console.debug(TAG, "Dungeon Pathing System loaded.");
    console.debug(TAG, "Dev API: window.__ONI_DUNGEON_PATHING__");
    console.debug(TAG, "  H key — toggle helper mode (walkable tile indicators)");
    console.debug(TAG, "  .resetDungeon()  — reset all tiles to initial state");
    console.debug(TAG, "  .mutateTile(id, type, texture?)");
  });
})();
