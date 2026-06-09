// ============================================================================
// Dungeon Pathing System — Fog Overlay
//
// Fog tiles are author-marked (flag: dungeonPathing.fog = true) but their true
// type is hidden from players until the party token steps onto an adjacent tile.
//
// Visual: a PIXI.Container placed over each unrevealed fog tile containing an
// opaque fill + "?" label.  When the party reaches an adjacent tile, the
// container fades out (600ms ease-in-out cubic) then is destroyed.
//
// Reveal persistence: stored in scene flags at dungeonPathing.fogRevealed so
// the revealed state survives page refresh.  Non-GM clients send a raw socket
// request; the GM writes the flag (same pattern as markVisited).
//
// Performance notes:
//   - Each container is destroyed with parent?.removeChild() BEFORE destroy()
//     to avoid the PIXI stage sortChildren orphan pitfall.
//   - The rAF animation loop is per-reveal and self-terminates — no persistent
//     per-frame overhead between reveals.
//   - No DOM reads anywhere — layout thrashing is impossible.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Fog]";

  // Fog visual config
  const FOG_COLOR  = 0x3a5070;   // dark slate-blue
  const FOG_ALPHA  = 0.92;       // near-opaque to hide tile beneath
  const FOG_Z      = 999996;     // below hover (999997) and helper cursors (999998)
  const REVEAL_MS  = 600;        // fade-out duration in milliseconds

  // Active fog containers: tileId → PIXI.Container
  const _fogContainers = new Map();

  // Local guard: tiles revealed during this session — prevents double-reveal
  // even if refresh() fires again before the scene flag write completes.
  const _localRevealed = new Set();

  // ---------------------------------------------------------------------------
  // PIXI helpers
  // ---------------------------------------------------------------------------

  function ensureStage() {
    if (!canvas?.stage) return false;
    canvas.stage.sortableChildren = true;
    return true;
  }

  function buildContainer(node) {
    const b = node.bounds;
    const w = b.right - b.left;
    const h = b.bottom - b.top;

    const container = new PIXI.Container();
    container.name   = `ONI_DP_Fog_${node.nodeId}`;
    container.zIndex = FOG_Z;
    container.x      = b.left;
    container.y      = b.top;

    // Background fill — covers the tile beneath entirely
    const gfx = new PIXI.Graphics();
    gfx.beginFill(FOG_COLOR, FOG_ALPHA);
    gfx.drawRoundedRect(0, 0, w, h, 6);
    gfx.endFill();
    container.addChild(gfx);

    // "?" label — centred, white, semi-opaque
    const style = new PIXI.TextStyle({
      fontSize:   Math.min(w, h) * 0.45,
      fill:       0xffffff,
      fontWeight: "bold",
      fontFamily: "sans-serif",
    });
    const label      = new PIXI.Text("?", style);
    label.alpha      = 0.55;
    label.anchor.set(0.5);
    label.x = w / 2;
    label.y = h / 2;
    container.addChild(label);

    return container;
  }

  function destroyContainer(tileId) {
    const c = _fogContainers.get(tileId);
    if (!c) return;
    _fogContainers.delete(tileId);
    if (c.destroyed) return;
    c.parent?.removeChild(c);   // avoid PIXI stage-children orphan
    c.destroy({ children: true });
  }

  // ---------------------------------------------------------------------------
  // Reveal animation — fade out then destroy
  // ---------------------------------------------------------------------------

  function _reveal(tileId) {
    // Guard: add to local set immediately so concurrent refresh() calls skip this tile
    _localRevealed.add(tileId);

    // Write reveal to scene flags via GM (fire-and-forget)
    const scene = canvas?.scene;
    if (scene) {
      DP.Socket?.markFogRevealed?.(scene, tileId)
        ?.catch(e => console.warn(TAG, "markFogRevealed failed:", e));
    }

    const container = _fogContainers.get(tileId);
    if (!container || container.destroyed) {
      _fogContainers.delete(tileId);
      return;
    }

    const start = performance.now();

    function tick() {
      if (container.destroyed) {
        _fogContainers.delete(tileId);
        return;
      }

      const t    = Math.min((performance.now() - start) / REVEAL_MS, 1);
      // Ease-in-out cubic
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      container.alpha = 1 - ease;

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        // Animation complete — remove and destroy
        container.parent?.removeChild(container);
        container.destroy({ children: true });
        _fogContainers.delete(tileId);
      }
    }

    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  DP.Fog = {

    /**
     * Main entry point — called from dp-bootstrap rebuild() after neighbors
     * are computed.  Renders fog containers for all unrevealed fog tiles and
     * reveals those adjacent to the current node.
     */
    refresh(graph, currentNode, neighbors) {
      if (!ensureStage()) return;

      const scene = canvas?.scene;
      if (!scene || !graph?.nodes) return;

      const adjacentIds = new Set([
        currentNode?.nodeId,
        ...neighbors.map(n => n.nodeId),
      ].filter(Boolean));

      const seenTileIds = new Set();

      for (const node of graph.nodes) {
        const tileId  = node.nodeId;
        const tileDoc = scene.tiles.get(tileId);
        if (!tileDoc) continue;

        const isFog = tileDoc.getFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fog`) === true;
        const isRevealed = _localRevealed.has(tileId)
          || !!(scene.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY]?.fogRevealed?.[tileId]);

        if (!isFog || isRevealed) {
          // Clean up any stale container (e.g. tile was just revealed elsewhere)
          if (_fogContainers.has(tileId)) destroyContainer(tileId);
          continue;
        }

        seenTileIds.add(tileId);

        // Ensure fog container exists
        if (!_fogContainers.has(tileId) || _fogContainers.get(tileId)?.destroyed) {
          const container = buildContainer(node);
          canvas.stage.addChild(container);
          _fogContainers.set(tileId, container);
        }

        // Reveal if adjacent to party (includes standing on the tile itself)
        if (adjacentIds.has(tileId)) {
          _reveal(tileId);
        }
      }

      // Destroy containers for tiles no longer in the graph (scene change guard)
      for (const [tileId] of _fogContainers) {
        if (!seenTileIds.has(tileId)) destroyContainer(tileId);
      }
    },

    /**
     * Destroy all fog containers and clear session state.
     * Called on dungeon deactivate and canvas/scene change.
     */
    destroyAll() {
      for (const tileId of [..._fogContainers.keys()]) {
        destroyContainer(tileId);
      }
      _localRevealed.clear();
    },
  };

  console.debug(TAG, "Fog overlay manager loaded.");
})();
