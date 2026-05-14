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
  // Perf logger — enable with: window.__DP_PERF__ = true
  // ---------------------------------------------------------------------------
  const PERF_TAG = "[DungeonPathing][Perf]";
  const perf = (...args) => { if (window.__DP_PERF__) console.info(PERF_TAG, ...args); };

  // Granular walk logger — enable with: window.__DP_WALK_DBG__ = true
  const WALK_TAG = "[DP][Walk]";
  const walkDbg  = (...args) => { if (window.__DP_WALK_DBG__) console.info(WALK_TAG, ...args); };

  // Yield to the browser event loop so any pending paint/layout completes
  // before we run a synchronous CPU-heavy pass like the graph build.
  const yieldFrame = () => new Promise(r => requestAnimationFrame(r));

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
    _arrivalDepth: 0,   // recursion guard for processArrivalAt chains
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
  let _rebuildCount = 0;
  async function rebuild() {
    const t0    = performance.now();
    const scene = canvas?.scene;
    if (!scene) return false;

    const idx = ++_rebuildCount;

    // Yield before the synchronous graph traversal so any pending browser
    // paint completes first — avoids hitching a frame that's already in flight.
    const tYield = performance.now();
    await yieldFrame();
    const dtYield = performance.now() - tYield;

    // ── 1. Graph build ──────────────────────────────────────────────────────
    const tGraph = performance.now();
    const graph  = DP.Graph.build();
    state.graph  = graph;
    const dtGraph = performance.now() - tGraph;

    // ── 2. TileState.ensure — GM only, skip tiles already initialised ───────
    const tEnsure = performance.now();
    let newTileCount = 0;
    if (game.user?.isGM) {
      const existingStates = scene?.flags?.[MOD]?.[DP.PATHING_ROOT_KEY]?.tileStates ?? {};
      for (const node of graph.nodes) {
        if (existingStates[node.nodeId]) continue; // already initialised → skip
        newTileCount++;
        const tileDoc = scene.tiles.get(node.nodeId);
        if (tileDoc) await DP.TileState.ensure(scene, tileDoc).catch(() => {});
      }
    }
    const dtEnsure = performance.now() - tEnsure;

    // ── 3. Resolve party token ──────────────────────────────────────────────
    const tToken = performance.now();
    let tokenCached = false;
    let token = state.partyToken;
    if (token && !token.destroyed && canvas.tokens?.get(token.id)) {
      tokenCached = true;
    } else {
      token = await DP.Graph.resolvePartyToken();
      state.partyToken = token;
    }
    const dtToken = performance.now() - tToken;

    if (!token) {
      DP.HelperMode.hide();
      ui.notifications?.warn?.("Dungeon Pathing: party token not found.");
      perf(`rebuild #${idx} ABORTED (no token) | graph ${dtGraph.toFixed(1)}ms | total ${(performance.now()-t0).toFixed(1)}ms`);
      return false;
    }

    // ── 4. Locate current node ──────────────────────────────────────────────
    const tLocate = performance.now();
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
    const dtLocate = performance.now() - tLocate;

    if (!currentNode) {
      DP.HelperMode.hide();
      ui.notifications?.warn?.("Dungeon Pathing: party token is not on a recognised tile node.");
      perf(`rebuild #${idx} ABORTED (no node) | graph ${dtGraph.toFixed(1)}ms | total ${(performance.now()-t0).toFixed(1)}ms`);
      return false;
    }

    // ── 5. Neighbors + helper mode ──────────────────────────────────────────
    const tNeighbors = performance.now();
    const neighbors  = DP.Graph.getNeighbors(currentNode.nodeId, graph);
    state.neighborIds = new Set(neighbors.map(n => n.nodeId));
    DP.HelperMode.update(neighbors);
    const dtNeighbors = performance.now() - tNeighbors;

    state.lastHoveredNodeId = null; // reset hover tracking after rebuild
    DP.Overlay.clearHover?.();
    DP.Events.graphRebuilt(graph, token);

    // Enter standby: system is ready, waiting for the player to pick a tile.
    DP.Events.standbyStart(token.document, currentNode, neighbors);
    DP.ScanMode?.show();
    DP.ScanMode?.showTravelBtn?.("dungeon");

    const dtTotal = performance.now() - t0;
    console.debug(TAG, "Graph ready →", currentNode.name, `(${neighbors.length} neighbour(s))`);
    perf(
      `rebuild #${idx} | graph ${dtGraph.toFixed(1)}ms (${graph.nodes.length} tiles)` +
      ` | ensure ${dtEnsure.toFixed(1)}ms (${newTileCount} new)` +
      ` | token ${dtToken.toFixed(1)}ms${tokenCached ? " (cached)" : " (async)"}` +
      ` | locate ${dtLocate.toFixed(1)}ms` +
      ` | neighbors ${dtNeighbors.toFixed(1)}ms (${neighbors.length})` +
      ` | TOTAL ${dtTotal.toFixed(1)}ms`
    );
    walkDbg(
      `rebuild #${idx}` +
      ` | yield ${dtYield.toFixed(1)}ms` +
      ` | graph ${dtGraph.toFixed(1)}ms (${graph.nodes.length} tiles)` +
      ` | ensure ${dtEnsure.toFixed(1)}ms (${newTileCount} new)` +
      ` | token ${dtToken.toFixed(1)}ms ${tokenCached ? "(cached)" : "(async)"}` +
      ` | locate ${dtLocate.toFixed(1)}ms` +
      ` | neighbors+helper ${dtNeighbors.toFixed(1)}ms (${neighbors.length})` +
      ` | TOTAL ${dtTotal.toFixed(1)}ms`
    );
    return true;
  }

  // ---------------------------------------------------------------------------
  // Arrival processing — shared by handleClick and force-move (+ any future
  // tile that programmatically lands the token on another tile).
  //
  // Runs: tokenMoved event → direction tracking → confirm dialog (or skip) →
  //       tileType resolve → turnConfirmed event → tile event dispatch → clear.
  //
  // Does NOT handle: savedPos / revert, turnStart/End, rebuild, or busy flag —
  // those belong to the outer handleClick / caller context.
  // ---------------------------------------------------------------------------
  const _MAX_ARRIVAL_DEPTH = 10;

  async function processArrivalAt(node, token, scene, fromNode) {
    state._arrivalDepth++;
    if (state._arrivalDepth > _MAX_ARRIVAL_DEPTH) {
      console.warn(TAG, `processArrivalAt: chain depth limit (${_MAX_ARRIVAL_DEPTH}) reached — stopping.`);
      state._arrivalDepth--;
      return;
    }

    try {
      // Refresh token reference — moveToNode may have updated the document.
      const freshToken = canvas.tokens?.get?.(token.document?.id ?? token.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === (token.document?.id ?? token.id))
        ?? token;

      // — Token moved event —
      DP.Events.tokenMoved(freshToken.document, fromNode, node);

      // — Track entry direction —
      if (DP.Direction && fromNode) {
        DP.Direction.lastEntryDirection = DP.Direction.computeDirection(fromNode, node);
      }

      // — Resolve tile doc and flags —
      const tileDoc            = scene.tiles.get(node.nodeId) ?? null;
      const usableFlag         = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.usable`);
      const isUsable           = usableFlag === true || usableFlag === "true";
      const skipConfirmFlag    = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.skipConfirm`);
      const skipConfirm        = skipConfirmFlag === true || skipConfirmFlag === "true";
      const disableGoBackFlag  = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.disableGoBack`);
      const disableGoBack      = disableGoBackFlag === true || disableGoBackFlag === "true";

      // — Confirmation (or skip if flagged) —
      let confirmed;
      if (skipConfirm) {
        confirmed = true;
      } else {
        confirmed = await DP.ConfirmDialog.ask(freshToken, { showUseButton: isUsable, showRevertButton: !disableGoBack });
      }

      if (confirmed === false) return;

      // — Resolve tile type (same override logic as handleClick) —
      const _storedType   = (tileDoc && DP.TileState.getCurrentType(scene, tileDoc.id))
        ?? node.tileType ?? DP.TILE_TYPES.UNKNOWN;
      const _forceMoveDir = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.forceMoveDirection`) ?? "";
      const tileType      = (_forceMoveDir && DP.Direction?.DIRS?.[_forceMoveDir])
        ? DP.TILE_TYPES.FORCE_MOVE : _storedType;

      console.debug(TAG, `[processArrivalAt][depth ${state._arrivalDepth}] tileType="${tileType}" at "${node.name}"`);

      // — Turn confirmed —
      DP.Events.turnConfirmed(freshToken.document, fromNode, node, tileDoc);

      // — Deferred markVisited —
      if (tileDoc) {
        const _tid = tileDoc.id;
        setTimeout(() => DP.Socket.markVisited(scene, _tid).catch(() => {}), 300);
      }

      // — Dispatch tile event —
      const shouldDispatchEvent = confirmed === "use" || !isUsable;
      if (shouldDispatchEvent) {
        DP.Events.tileEvent(freshToken.document, node, tileDoc, tileType);
        const { ok, cleared } = await DP.TileEventRegistry.dispatch(tileType, tileDoc, freshToken.document, scene);

        const persistFlag = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.persistAfterTrigger`);
        const shouldClear = (persistFlag === true || persistFlag === "true") ? false : cleared;
        if (shouldClear && tileDoc) await DP.Socket.clearTile(scene, tileDoc.id);
      }

    } finally {
      state._arrivalDepth--;
    }
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
    if (DP.FastTravel?.active) return; // FT mode owns the canvas while active
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
    if (!isNeighbor) return; // tile out of range — correct behaviour, no need to notify

    ev.preventDefault();
    ev.stopPropagation();

    // Standby ends — player has chosen a destination.
    // NOTE: use state.partyToken here; const token is declared later in this scope.
    DP.Events.standbyEnd(state.partyToken?.document, state.currentNode, clicked);
    DP.ScanMode?.hide();
    DP.ScanMode?.hideTravelBtn?.();

    state.busy = true;
    let _deferredVisitTileId = null; // set after confirm; fired after rebuild
    DP.HelperMode.hide();
    DP.Overlay.clearHover?.();

    const fromNode  = state.currentNode;
    const token     = state.partyToken;
    const scene     = canvas.scene;
    const tTurnStart = performance.now();

    try {
      // — Turn Start —
      DP.Events.turnStart(token.document, fromNode);

      // — Save position for revert —
      const savedPos = DP.Movement.savePosition(token);

      // — Footstep sound —
      DP.Sound.playFootstep();

      // — Move (preview with offset) —
      perf(`turn | pre-anim setup: ${(performance.now()-tTurnStart).toFixed(1)}ms`);
      const tAnim = performance.now();
      state.forcedNodeId = clicked.nodeId;
      const moved = await DP.Movement.moveToNode(token, clicked);
      if (!moved) { state.forcedNodeId = null; return; }
      perf(`turn | animation: ${(performance.now()-tAnim).toFixed(1)}ms`);

      // Refresh token reference after real doc update
      const freshToken = canvas.tokens?.get?.(token.id)
        ?? canvas.tokens?.placeables?.find(t => t.document?.id === token.document.id)
        ?? token;
      state.partyToken = freshToken;

      // — Token moved event —
      DP.Events.tokenMoved(freshToken.document, fromNode, clicked);

      // — Track entry direction (used by Force Move, Slippery, and future directional tiles) —
      if (DP.Direction) {
        DP.Direction.lastEntryDirection = DP.Direction.computeDirection(fromNode, clicked);
      }

      // — Resolve tile doc before dialog so we can check the usable / skipConfirm flags —
      const tileDoc            = scene.tiles.get(clicked.nodeId) ?? null;
      const usableFlag         = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.usable`);
      const isUsable           = usableFlag === true || usableFlag === "true";
      const skipConfirmFlag    = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.skipConfirm`);
      const skipConfirm        = skipConfirmFlag === true || skipConfirmFlag === "true";
      const disableGoBackFlag  = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.disableGoBack`);
      const disableGoBack      = disableGoBackFlag === true || disableGoBackFlag === "true";

      // — In-canvas confirmation buttons (or skip if flagged) —
      const tConfirm = performance.now();
      let confirmed;
      if (skipConfirm) {
        confirmed = true;
        perf(`turn | confirm dialog SKIPPED (skipConfirm flag): ${(performance.now()-tConfirm).toFixed(1)}ms`);
      } else {
        confirmed = await DP.ConfirmDialog.ask(freshToken, { showUseButton: isUsable, showRevertButton: !disableGoBack });
        perf(`turn | confirm dialog (player wait): ${(performance.now()-tConfirm).toFixed(1)}ms → ${confirmed === "use" ? "USED" : confirmed ? "CONFIRMED" : "REVERTED"}`);
      }

      if (confirmed === false) {
        // — Revert —
        const tRevert = performance.now();
        state.forcedNodeId = fromNode.nodeId;
        await DP.Movement.revertToPosition(freshToken, savedPos);
        DP.Events.turnReverted(freshToken.document, fromNode, clicked);
        perf(`turn | revert: ${(performance.now()-tRevert).toFixed(1)}ms`);
        return; // finally block handles rebuild and clears busy
      }

      // — Confirmed (land + optionally use) —
      DP.Events.turnConfirmed(freshToken.document, fromNode, clicked, tileDoc);

      const _storedType = (tileDoc && DP.TileState.getCurrentType(scene, tileDoc.id))
        ?? clicked.tileType
        ?? DP.TILE_TYPES.UNKNOWN;

      // If the tile has a forceMoveDirection flag, treat it as FORCE_MOVE
      // regardless of stored type — any tile can act as a conveyor without
      // needing to be named or retyped.
      const _forceMoveDir = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.forceMoveDirection`) ?? "";
      const tileType = (_forceMoveDir && DP.Direction?.DIRS?.[_forceMoveDir])
        ? DP.TILE_TYPES.FORCE_MOVE
        : _storedType;

      console.debug(TAG, `[tileType] stored="${_storedType}" forceMoveDir="${_forceMoveDir || "(none)"}" effective="${tileType}"`);

      // Mark visited on any positive confirmation (land or use).
      if (tileDoc) _deferredVisitTileId = tileDoc.id;

      // Dispatch tile event only when:
      //   - player pressed "Use" on a usable tile, OR
      //   - tile is not usable (standard confirm fires the event as before).
      const shouldDispatchEvent = confirmed === "use" || !isUsable;

      if (shouldDispatchEvent) {
        DP.Events.tileEvent(freshToken.document, clicked, tileDoc, tileType);

        const tEvent = performance.now();
        const { ok, cleared } = await DP.TileEventRegistry.dispatch(tileType, tileDoc, freshToken.document, scene);
        const dtEvent = performance.now() - tEvent;
        perf(`turn | tileEvent dispatch (${tileType}): ${dtEvent.toFixed(1)}ms`);
        walkDbg(`tileEvent dispatch (${tileType}): ${dtEvent.toFixed(1)}ms${dtEvent > 500 ? " ⚠ slow handler — check for deferred updates or heavy async work" : ""}`);

        // Per-tile override: "Persist after trigger" checkbox overrides registry default.
        const persistFlag = tileDoc?.getFlag(MOD, `${DP.PATHING_ROOT_KEY}.persistAfterTrigger`);
        const shouldClear = (persistFlag === true || persistFlag === "true") ? false : cleared;

        if (shouldClear && tileDoc) {
          const tClear = performance.now();
          await DP.Socket.clearTile(scene, tileDoc.id);
          perf(`turn | clearTile: ${(performance.now()-tClear).toFixed(1)}ms`);
        }
      }

      // — Turn End —
      DP.Events.turnEnd(freshToken.document, clicked);

    } catch (e) {
      console.error(TAG, "Turn loop error", e);
      ui.notifications?.error?.("Dungeon Pathing: unexpected error. See console.");
    } finally {
      DP.ConfirmDialog.forceClose?.();
      const tRebuild = performance.now();
      await rebuild();
      perf(`turn | final rebuild: ${(performance.now()-tRebuild).toFixed(1)}ms | TURN TOTAL: ${(performance.now()-tTurnStart).toFixed(1)}ms`);
      // Keep busy=true through the full rebuild so no concurrent turn can start.
      state.busy = false;

      // Deferred markVisited — fires 300 ms after rebuild completes so the
      // server socket queue is clear before the next turn's doc update.
      if (_deferredVisitTileId) {
        const _sceneRef = canvas.scene;
        const _tid      = _deferredVisitTileId;
        setTimeout(() => {
          DP.Socket.markVisited(_sceneRef, _tid)
            .catch(e => console.warn(TAG, "markVisited (deferred):", e));
        }, 300);
      }
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
    DP.ScanMode?.hideTravelBtn?.();
    DP.ScanMode?.detachTicker();
    DP.ConfirmDialog?.forceClose?.();
    console.debug(TAG, "Deactivated.");
  }

  async function applyForScene(scene) {
    if (!canvas?.ready) return;
    const effectiveScene = scene ?? canvas.scene;
    const mode = getSceneMode(effectiveScene);

    if (mode === DP.SCENE_MODE.DUNGEON) {
      await activate();
      // Sync FT button visibility (flag may have changed since last activate)
      DP.ScanMode?.updateFtBtnVisibility?.();
    } else {
      if (state.active) deactivate();
      // Exploration mode: show travel button if FT is enabled; hide otherwise
      if (mode === DP.SCENE_MODE.EXPLORATION) {
        const ftRaw = effectiveScene?.flags?.[MOD]?.[DP.FABULA_ROOT_KEY]?.[DP.GENERAL_KEY]?.fastTravelEnabled;
        const ftEnabled = ftRaw !== false && ftRaw !== "false" && ftRaw !== 0;
        if (ftEnabled) {
          DP.ScanMode?.showTravelBtn?.("exploration");
        } else {
          DP.ScanMode?.hideTravelBtn?.();
        }
      } else {
        DP.ScanMode?.hideTravelBtn?.();
      }
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

    // Debounce rapid tile/drawing mutations (e.g. multiple flag updates in one turn)
    // so only a single rebuild fires after the burst settles.
    let _rebuildTimer = null;
    const debouncedRebuild = () => {
      if (_rebuildTimer) clearTimeout(_rebuildTimer);
      _rebuildTimer = setTimeout(() => {
        _rebuildTimer = null;
        if (!state.active || state.busy) return;
        rebuild().catch(() => {});
      }, 100);
    };

    ["createTile", "deleteTile",
     "createDrawing", "deleteDrawing"].forEach(hookName => {
      const id = Hooks.on(hookName, debouncedRebuild);
      state.hookIds.push([hookName, id]);
    });

    // updateTile / updateDrawing: skip DP-internal updates (clearTile, mutateTile)
    // to prevent a second debouncedRebuild from firing after the main walk rebuild.
    {
      const id = Hooks.on("updateTile", (_doc, _change, options) => {
        if (options?.dungeonPathing) return;
        debouncedRebuild();
      });
      state.hookIds.push(["updateTile", id]);
    }
    {
      const id = Hooks.on("updateDrawing", (_doc, _change, options) => {
        if (options?.dungeonPathing) return;
        debouncedRebuild();
      });
      state.hookIds.push(["updateDrawing", id]);
    }

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
    processArrivalAt,

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
    console.debug(TAG, "Perf logging: window.__DP_PERF__ = true  (set in browser console)");
    console.debug(TAG, "Walk debug:   window.__DP_WALK_DBG__ = true  (per-move + per-rebuild timing)");
  });
})();
