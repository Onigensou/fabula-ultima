// ============================================================================
// Dungeon Pathing System — Fog Overlay
//
// Supports three tile concealment modes (set via fogMode flag on tile):
//
//   "fog"       — Transient proximity fog.  The mist lifts when the party stands
//                 adjacent, then drifts back when they move away.  No persistence.
//
//   "shroud"    — Permanent veil.  The shroud parts the first time the party is
//                 adjacent and never returns.  Stored in scene.fogRevealed.
//
//   "invisible" — Hidden passage.  The tile mesh and all connecting path drawings
//                 fade to alpha 0 until the party is adjacent.  Like fog, it
//                 re-hides when the party moves away.  No overlay sprite — the
//                 tile mesh itself is animated directly.
//
// Visuals:
//   Fog/Shroud use a dedicated image asset sized to the tile template.
//   Invisible operates directly on tile.mesh.alpha and drawing.alpha — no sprite.
//
// Transitions:
//   Reveal (fog lifts / path appears)  — alpha fades OUT/IN 600ms cubic ease.
//   Re-fog / re-hide (returns)         — alpha fades IN/OUT 500ms cubic ease.
//   First load / snap                  — fog appears at alpha 1; invisible snaps to 0 instantly.
//
// Performance — PIXI pitfalls guarded:
//   · parent?.removeChild() always before destroy({ children:true })
//   · _animating/_animatingMesh/_animatingDrawing Sets prevent double-animation
//   · No DOM reads inside any animation loop
//   · Textures preloaded once via Foundry's loadTexture on "ready"
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Fog]";

  const FOG_Z     = 999996;  // below hover (999997) and helper cursors (999998)
  const REVEAL_MS = 600;
  const REFOG_MS  = 500;

  const FOG_TEXTURE_URL    = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Fog_Tile.png";
  const SHROUD_TEXTURE_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Shroud_Tile.png";

  const _fogContainers       = new Map();  // tileId → PIXI.Container
  const _animating           = new Set();  // tileId — mid-animation guard
  let   _prevAdjacentIds     = new Set();
  let   _initialized         = false;
  const _localShroudRevealed  = new Set();

  // Invisible tile state
  const _animatingMesh        = new Set();  // tileId   — guard for tile mesh alpha animations
  const _animatingDrawing     = new Set();  // drawingId — guard for drawing alpha animations
  const _hiddenTileIds        = new Set();  // invisible tiles currently at alpha 0
  const _hiddenDrawingIds     = new Set();  // drawing edges currently at alpha 0

  // ---------------------------------------------------------------------------
  // Flag helper — fogMode with backward compat for old boolean fog flag
  // ---------------------------------------------------------------------------
  function getFogMode(tileDoc) {
    const mode = tileDoc?.getFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fogMode`);
    if (mode === "fog" || mode === "shroud" || mode === "invisible") return mode;
    const legacy = tileDoc?.getFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fog`);
    if (legacy === true || legacy === "true") return "shroud";
    return null;
  }

  // ---------------------------------------------------------------------------
  // PIXI stage helper
  // ---------------------------------------------------------------------------
  function ensureStage() {
    if (!canvas?.stage) return false;
    canvas.stage.sortableChildren = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Texture preload — called once on "ready"; ensures both textures are cached
  // so buildContainer can apply them synchronously.
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    Promise.all([
      loadTexture(FOG_TEXTURE_URL),
      loadTexture(SHROUD_TEXTURE_URL),
    ]).catch(e => console.warn(TAG, "texture preload failed:", e));
  });

  // ---------------------------------------------------------------------------
  // Build a fog/shroud container for the given node
  // ---------------------------------------------------------------------------
  function buildContainer(node, fogMode) {
    const b  = node.bounds;
    const w  = b.right - b.left;
    const h  = b.bottom - b.top;

    const container = new PIXI.Container();
    container.name   = `ONI_DP_Fog_${node.nodeId}`;
    container.zIndex = FOG_Z;
    container.x      = b.left;
    container.y      = b.top;

    // Build sprite
    const url    = fogMode === "shroud" ? SHROUD_TEXTURE_URL : FOG_TEXTURE_URL;
    const cached = getTexture(url);
    const sprite = new PIXI.Sprite(cached ?? PIXI.Texture.EMPTY);
    sprite.width  = w;
    sprite.height = h;
    sprite.alpha  = 1;
    container.addChild(sprite);
    container._sprite = sprite;

    // If texture wasn't cached yet, load it and update the sprite in-place
    if (!cached) {
      loadTexture(url).then(tex => {
        if (!sprite.destroyed) {
          sprite.texture = tex;
          sprite.width   = w;
          sprite.height  = h;
        }
      }).catch(() => {});
    }

    return container;
  }

  function destroyContainer(tileId) {
    const c = _fogContainers.get(tileId);
    if (!c) return;
    _fogContainers.delete(tileId);
    _animating.delete(tileId);
    if (c.destroyed) return;
    c.parent?.removeChild(c);
    c.destroy({ children: true });
  }

  // ---------------------------------------------------------------------------
  // Animation: fade OUT (reveal)
  // ---------------------------------------------------------------------------
  function _animateReveal(tileId, fogMode) {
    if (_animating.has(tileId)) return;
    _animating.add(tileId);

    if (fogMode === "shroud") {
      _localShroudRevealed.add(tileId);
      const scene = canvas?.scene;
      if (scene) {
        DP.Socket?.markFogRevealed?.(scene, tileId)
          ?.catch(e => console.warn(TAG, "markFogRevealed failed:", e));
      }
    }

    const container = _fogContainers.get(tileId);
    if (!container || container.destroyed) {
      _animating.delete(tileId);
      _fogContainers.delete(tileId);
      return;
    }

    const start = performance.now();
    function tick() {
      if (container.destroyed) {
        _animating.delete(tileId);
        _fogContainers.delete(tileId);
        return;
      }
      const t    = Math.min((performance.now() - start) / REVEAL_MS, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      container.alpha = 1 - ease;
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        container.parent?.removeChild(container);
        container.destroy({ children: true });
        _fogContainers.delete(tileId);
        _animating.delete(tileId);
      }
    }
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Animation: fade IN (re-fog, fog mode only)
  // ---------------------------------------------------------------------------
  function _animateFadeIn(tileId) {
    if (_animating.has(tileId)) return;
    const container = _fogContainers.get(tileId);
    if (!container || container.destroyed) return;

    _animating.add(tileId);
    container.alpha = 0;

    const start = performance.now();
    function tick() {
      if (container.destroyed) {
        _animating.delete(tileId);
        return;
      }
      const t    = Math.min((performance.now() - start) / REFOG_MS, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      container.alpha = ease;
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        container.alpha = 1;
        _animating.delete(tileId);
      }
    }
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Invisible tile — utility helpers
  // ---------------------------------------------------------------------------
  function _getDrawingPlaceable(drawingId) {
    return canvas?.drawings?.placeables?.find(d => d.document?.id === drawingId) ?? null;
  }

  function _getEdgesForNode(nodeId, graph) {
    return (graph?.edges ?? []).filter(e => e.fromNodeId === nodeId || e.toNodeId === nodeId);
  }

  // An edge should remain hidden if ANY of its endpoint tiles is currently invisible-hidden.
  function _shouldHideEdge(edge) {
    return _hiddenTileIds.has(edge.fromNodeId) || _hiddenTileIds.has(edge.toNodeId);
  }

  // ---------------------------------------------------------------------------
  // Invisible tile — tile mesh animators
  // ---------------------------------------------------------------------------
  function _animateTileReveal(tileId) {
    if (_animatingMesh.has(tileId)) return;
    const mesh = canvas?.tiles?.get(tileId)?.mesh;
    if (!mesh) return;
    _animatingMesh.add(tileId);
    _hiddenTileIds.delete(tileId);
    const start = performance.now();
    function tick() {
      if (!_animatingMesh.has(tileId)) return;  // cancelled by destroyAll
      const m = canvas?.tiles?.get(tileId)?.mesh;
      if (!m) { _animatingMesh.delete(tileId); return; }
      const t    = Math.min((performance.now() - start) / REVEAL_MS, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      m.alpha = ease;
      if (t < 1) { requestAnimationFrame(tick); }
      else { m.alpha = 1; _animatingMesh.delete(tileId); }
    }
    requestAnimationFrame(tick);
  }

  function _animateTileHide(tileId) {
    if (_animatingMesh.has(tileId)) return;
    const mesh = canvas?.tiles?.get(tileId)?.mesh;
    if (!mesh) return;
    _animatingMesh.add(tileId);
    _hiddenTileIds.add(tileId);
    const start = performance.now();
    function tick() {
      if (!_animatingMesh.has(tileId)) return;  // cancelled by destroyAll
      const m = canvas?.tiles?.get(tileId)?.mesh;
      if (!m) { _animatingMesh.delete(tileId); return; }
      const t    = Math.min((performance.now() - start) / REFOG_MS, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      m.alpha = 1 - ease;
      if (t < 1) { requestAnimationFrame(tick); }
      else { m.alpha = 0; _animatingMesh.delete(tileId); }
    }
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Invisible tile — drawing edge animators
  // ---------------------------------------------------------------------------
  function _animateDrawingReveal(drawingId) {
    if (_animatingDrawing.has(drawingId)) return;
    const dr = _getDrawingPlaceable(drawingId);
    if (!dr) return;
    _animatingDrawing.add(drawingId);
    _hiddenDrawingIds.delete(drawingId);
    const start = performance.now();
    function tick() {
      if (!_animatingDrawing.has(drawingId)) return;
      const fresh = _getDrawingPlaceable(drawingId);
      if (!fresh) { _animatingDrawing.delete(drawingId); return; }
      const t    = Math.min((performance.now() - start) / REVEAL_MS, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      fresh.alpha = ease;
      if (t < 1) { requestAnimationFrame(tick); }
      else { fresh.alpha = 1; _animatingDrawing.delete(drawingId); }
    }
    requestAnimationFrame(tick);
  }

  function _animateDrawingHide(drawingId) {
    if (_animatingDrawing.has(drawingId)) return;
    const dr = _getDrawingPlaceable(drawingId);
    if (!dr) return;
    _animatingDrawing.add(drawingId);
    _hiddenDrawingIds.add(drawingId);
    const start = performance.now();
    function tick() {
      if (!_animatingDrawing.has(drawingId)) return;
      const fresh = _getDrawingPlaceable(drawingId);
      if (!fresh) { _animatingDrawing.delete(drawingId); return; }
      const t    = Math.min((performance.now() - start) / REFOG_MS, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      fresh.alpha = 1 - ease;
      if (t < 1) { requestAnimationFrame(tick); }
      else { fresh.alpha = 0; _animatingDrawing.delete(drawingId); }
    }
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Invisible tile — per-node visibility update (called from refresh)
  // ---------------------------------------------------------------------------
  function _handleInvisibleNode(tileId, adjacentIds, graph, seenDrawingIds) {
    const isAdjacent  = adjacentIds.has(tileId);
    const wasAdjacent = _prevAdjacentIds.has(tileId);
    const isHidden    = _hiddenTileIds.has(tileId);
    const inAnimMesh  = _animatingMesh.has(tileId);
    const edges       = _getEdgesForNode(tileId, graph);

    for (const e of edges) seenDrawingIds.add(e.drawingId);

    if (isAdjacent) {
      // Tile just became visible — animate reveal if it was hidden
      if (isHidden && !inAnimMesh) {
        _animateTileReveal(tileId);
        for (const edge of edges) {
          // Only reveal edge when both invisible endpoints are now adjacent
          if (!_shouldHideEdge(edge)
              && _hiddenDrawingIds.has(edge.drawingId)
              && !_animatingDrawing.has(edge.drawingId)) {
            _animateDrawingReveal(edge.drawingId);
          }
        }
      }
    } else {
      if (!isHidden && !inAnimMesh) {
        if (wasAdjacent && _initialized) {
          // Party moved away — fade out
          _animateTileHide(tileId);
          for (const edge of edges) {
            if (!_hiddenDrawingIds.has(edge.drawingId) && !_animatingDrawing.has(edge.drawingId)) {
              _animateDrawingHide(edge.drawingId);
            }
          }
        } else if (!_initialized) {
          // Scene first load — snap hidden immediately, no animation
          const m = canvas?.tiles?.get(tileId)?.mesh;
          if (m) m.alpha = 0;
          _hiddenTileIds.add(tileId);
          for (const edge of edges) {
            const dr = _getDrawingPlaceable(edge.drawingId);
            if (dr) dr.alpha = 0;
            _hiddenDrawingIds.add(edge.drawingId);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  DP.Fog = {

    refresh(graph, currentNode, neighbors) {
      if (!ensureStage()) return;
      const scene = canvas?.scene;
      if (!scene || !graph?.nodes) return;

      const adjacentIds = new Set(
        [currentNode?.nodeId, ...neighbors.map(n => n.nodeId)].filter(Boolean)
      );

      const seenTileIds           = new Set();
      const seenInvisibleTileIds  = new Set();
      const seenInvisibleDrawings = new Set();

      for (const node of graph.nodes) {
        const tileId  = node.nodeId;
        const tileDoc = scene.tiles.get(tileId);
        if (!tileDoc) continue;

        const fogMode = getFogMode(tileDoc);

        // Invisible tile — handled separately; does not use a PIXI overlay container
        if (fogMode === "invisible") {
          seenInvisibleTileIds.add(tileId);
          _handleInvisibleNode(tileId, adjacentIds, graph, seenInvisibleDrawings);
          continue;
        }

        if (!fogMode) {
          if (_fogContainers.has(tileId)) destroyContainer(tileId);
          continue;
        }

        seenTileIds.add(tileId);

        if (fogMode === "shroud") {
          const isPermaRevealed = _localShroudRevealed.has(tileId)
            || !!(scene.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY]?.fogRevealed?.[tileId]);
          if (isPermaRevealed) {
            if (_fogContainers.has(tileId)) destroyContainer(tileId);
            continue;
          }
        }

        const isAdjacent   = adjacentIds.has(tileId);
        const wasAdjacent  = _prevAdjacentIds.has(tileId);
        const hasContainer = _fogContainers.has(tileId)
          && !_fogContainers.get(tileId)?.destroyed;

        if (isAdjacent) {
          if (hasContainer && !_animating.has(tileId)) {
            _animateReveal(tileId, fogMode);
          }
        } else {
          if (!hasContainer && !_animating.has(tileId)) {
            const container = buildContainer(node, fogMode);
            canvas.stage.addChild(container);
            _fogContainers.set(tileId, container);

            if (wasAdjacent && _initialized && fogMode === "fog") {
              _animateFadeIn(tileId);
            } else {
              container.alpha = 1;
            }
          }
        }
      }

      for (const [tileId] of _fogContainers) {
        if (!seenTileIds.has(tileId)) destroyContainer(tileId);
      }

      // Restore tiles/drawings that were invisible but are no longer in the graph
      // or whose fogMode was changed away from "invisible".
      for (const tileId of [..._hiddenTileIds]) {
        if (!seenInvisibleTileIds.has(tileId)) {
          _animatingMesh.delete(tileId);
          const m = canvas?.tiles?.get(tileId)?.mesh;
          if (m && !m.destroyed) m.alpha = 1;
          _hiddenTileIds.delete(tileId);
        }
      }
      for (const drawingId of [..._hiddenDrawingIds]) {
        if (!seenInvisibleDrawings.has(drawingId)) {
          _animatingDrawing.delete(drawingId);
          const dr = _getDrawingPlaceable(drawingId);
          if (dr) dr.alpha = 1;
          _hiddenDrawingIds.delete(drawingId);
        }
      }

      _prevAdjacentIds = adjacentIds;
      _initialized = true;
    },

    destroyAll() {
      for (const tileId of [..._fogContainers.keys()]) {
        destroyContainer(tileId);
      }
      _localShroudRevealed.clear();
      _prevAdjacentIds = new Set();
      _initialized = false;

      // Reset all invisible tile meshes (hidden + mid-animation)
      for (const tileId of new Set([..._hiddenTileIds, ..._animatingMesh])) {
        const m = canvas?.tiles?.get(tileId)?.mesh;
        if (m && !m.destroyed) m.alpha = 1;
      }
      _hiddenTileIds.clear();
      _animatingMesh.clear();

      // Reset all invisible drawing edges (hidden + mid-animation)
      for (const drawingId of new Set([..._hiddenDrawingIds, ..._animatingDrawing])) {
        const dr = _getDrawingPlaceable(drawingId);
        if (dr) dr.alpha = 1;
      }
      _hiddenDrawingIds.clear();
      _animatingDrawing.clear();
    },

    resetShroudLocally(tileId) {
      _localShroudRevealed.delete(tileId);
      _animating.delete(tileId);

      const api = globalThis.__ONI_DUNGEON_PATHING__;
      if (!api?.state?.active || !api.graph) return;

      const node = api.graph.nodeMap?.get(tileId);
      if (!node || !ensureStage()) return;

      const isAdjacent = api.currentNode?.nodeId === tileId
        || api.state.neighborIds?.has(tileId);
      if (isAdjacent) return;

      if (_fogContainers.has(tileId) && !_fogContainers.get(tileId)?.destroyed) return;

      const tileDoc = canvas?.scene?.tiles?.get(tileId);
      const fogMode = (tileDoc ? getFogMode(tileDoc) : null) ?? "shroud";

      const container = buildContainer(node, fogMode);
      canvas.stage.addChild(container);
      _fogContainers.set(tileId, container);
      container.alpha = 1;
    },
  };

  // ---------------------------------------------------------------------------
  // Multi-client sync
  // ---------------------------------------------------------------------------
  Hooks.on("updateScene", (sceneDoc, diff) => {
    if (!canvas?.scene || sceneDoc.id !== canvas.scene.id) return;
    const dp = diff?.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY];
    if (!dp) return;

    let changed = false;

    if ("-=fogRevealed" in dp) {
      _localShroudRevealed.clear();
      changed = true;
    } else if (dp.fogRevealed && typeof dp.fogRevealed === "object") {
      for (const key of Object.keys(dp.fogRevealed)) {
        if (key.startsWith("-=")) {
          _localShroudRevealed.delete(key.slice(2));
          changed = true;
        }
      }
    }

    if (changed) {
      globalThis.__ONI_DUNGEON_PATHING__?.rebuild?.().catch(() => {});
    }
  });

  console.debug(TAG, "Fog overlay manager loaded.");
})();
