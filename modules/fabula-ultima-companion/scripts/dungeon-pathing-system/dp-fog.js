// ============================================================================
// Dungeon Pathing System — Fog Overlay
//
// Supports two tile concealment modes (set via fogMode flag on tile):
//
//   "fog"    — Transient proximity fog.  The mist lifts when the party stands
//              adjacent, then drifts back when they move away.  No persistence.
//
//   "shroud" — Permanent veil.  The shroud parts the first time the party is
//              adjacent and never returns.  Stored in scene.fogRevealed.
//
// Visual: layered overlapping ellipses in cool grey-blue tones — no labels,
// no hard edges.  The composition resembles drifting mist patches rather than
// a solid block.
//
// Animations:
//   Reveal (fog lifts)       — fade OUT 600ms ease-in-out cubic.
//   Re-fog (mist returns)    — new container fades IN 500ms (fog mode only).
//   First load / scene snap  — containers appear at full alpha instantly.
//
// Performance — PIXI pitfalls guarded:
//   · parent?.removeChild() always before destroy({ children:true })
//   · _animating Set prevents double-animation on the same tile
//   · No DOM reads inside any animation loop
//   · No persistent rAF — every animation self-terminates
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Fog]";

  const FOG_Z     = 999996;  // below hover (999997) and helper cursors (999998)
  const REVEAL_MS = 600;     // fade-out duration in ms
  const REFOG_MS  = 500;     // fade-in duration in ms (fog mode re-hide)

  // Active PIXI containers
  const _fogContainers = new Map();  // tileId → PIXI.Container
  const _animating     = new Set();  // tileId — currently mid-animation (guard)

  // Adjacency from previous refresh — detects transitions
  let _prevAdjacentIds = new Set();
  let _initialized     = false;

  // Local guard for shroud permanent reveals (survives until destroyAll)
  const _localShroudRevealed = new Set();

  // ---------------------------------------------------------------------------
  // Flag helper — fogMode with backward compat for old boolean fog flag
  // ---------------------------------------------------------------------------
  function getFogMode(tileDoc) {
    const mode = tileDoc?.getFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fogMode`);
    if (mode === "fog" || mode === "shroud") return mode;
    // Old boolean flag → shroud (original behavior was permanent reveal)
    const legacy = tileDoc?.getFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fog`);
    if (legacy === true || legacy === "true") return "shroud";
    return null;
  }

  // ---------------------------------------------------------------------------
  // PIXI helpers
  // ---------------------------------------------------------------------------

  function ensureStage() {
    if (!canvas?.stage) return false;
    canvas.stage.sortableChildren = true;
    return true;
  }

  function buildContainer(node) {
    const b  = node.bounds;
    const w  = b.right - b.left;
    const h  = b.bottom - b.top;
    const cx = w / 2;
    const cy = h / 2;

    const container = new PIXI.Container();
    container.name   = `ONI_DP_Fog_${node.nodeId}`;
    container.zIndex = FOG_Z;
    container.x      = b.left;
    container.y      = b.top;

    const gfx = new PIXI.Graphics();

    // Deep base layer — anchors the darkness so the tile beneath is invisible
    gfx.beginFill(0x0b131e, 0.78);
    gfx.drawRoundedRect(0, 0, w, h, 6);
    gfx.endFill();

    // Organic fog wisps — soft overlapping ellipses at varying positions/opacities.
    // Positions are deliberately asymmetric so the result reads as mist, not geometry.
    const wisps = [
      // Large central mass
      { x: cx * 0.95, y: cy * 1.10, rx: w * 0.60, ry: h * 0.40, color: 0x5d85a0, a: 0.40 },
      // Upper-right wisp
      { x: cx * 1.22, y: cy * 0.78, rx: w * 0.46, ry: h * 0.33, color: 0x7aa3bc, a: 0.33 },
      // Lower-left wisp
      { x: cx * 0.68, y: cy * 1.25, rx: w * 0.44, ry: h * 0.30, color: 0x8fb8cc, a: 0.28 },
      // Upper-left tendril
      { x: cx * 0.78, y: cy * 0.72, rx: w * 0.38, ry: h * 0.28, color: 0xa8cedd, a: 0.24 },
      // Lower-right tendril
      { x: cx * 1.18, y: cy * 1.28, rx: w * 0.42, ry: h * 0.26, color: 0xbad5e4, a: 0.21 },
      // Bright highlight near centre — gives depth
      { x: cx * 1.02, y: cy * 0.92, rx: w * 0.30, ry: h * 0.22, color: 0xd5e8f0, a: 0.16 },
    ];

    for (const wisp of wisps) {
      gfx.beginFill(wisp.color, wisp.a);
      gfx.drawEllipse(wisp.x, wisp.y, wisp.rx, wisp.ry);
      gfx.endFill();
    }

    container.addChild(gfx);
    return container;
  }

  function destroyContainer(tileId) {
    const c = _fogContainers.get(tileId);
    if (!c) return;
    _fogContainers.delete(tileId);
    _animating.delete(tileId);
    if (c.destroyed) return;
    c.parent?.removeChild(c);           // prevent PIXI stage orphan
    c.destroy({ children: true });
  }

  // ---------------------------------------------------------------------------
  // Animation: fade OUT (reveal)
  // ---------------------------------------------------------------------------
  function _animateReveal(tileId, fogMode) {
    if (_animating.has(tileId)) return;
    _animating.add(tileId);

    // Shroud mode only — write permanent reveal flag
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
  // Public API
  // ---------------------------------------------------------------------------

  DP.Fog = {

    /**
     * Main entry point — called from dp-bootstrap rebuild() after neighbors
     * are computed.
     *
     * Fog mode:    show fog for all non-adjacent tiles; reveal adjacent ones;
     *              fade fog back in when party moves away.
     * Shroud mode: show fog until first adjacency; reveal permanently; never
     *              re-create after reveal.
     */
    refresh(graph, currentNode, neighbors) {
      if (!ensureStage()) return;
      const scene = canvas?.scene;
      if (!scene || !graph?.nodes) return;

      const adjacentIds = new Set(
        [currentNode?.nodeId, ...neighbors.map(n => n.nodeId)].filter(Boolean)
      );

      const seenTileIds = new Set();

      for (const node of graph.nodes) {
        const tileId  = node.nodeId;
        const tileDoc = scene.tiles.get(tileId);
        if (!tileDoc) continue;

        const fogMode = getFogMode(tileDoc);

        if (!fogMode) {
          if (_fogContainers.has(tileId)) destroyContainer(tileId);
          continue;
        }

        seenTileIds.add(tileId);

        // Shroud: permanently revealed once first seen
        if (fogMode === "shroud") {
          const isPermaRevealed = _localShroudRevealed.has(tileId)
            || !!(scene.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY]?.fogRevealed?.[tileId]);
          if (isPermaRevealed) {
            if (_fogContainers.has(tileId)) destroyContainer(tileId);
            continue;
          }
        }

        const isAdjacent  = adjacentIds.has(tileId);
        const wasAdjacent = _prevAdjacentIds.has(tileId);
        const hasContainer = _fogContainers.has(tileId)
          && !_fogContainers.get(tileId)?.destroyed;

        if (isAdjacent) {
          // Party is adjacent — lift the fog
          if (hasContainer && !_animating.has(tileId)) {
            _animateReveal(tileId, fogMode);
          }
        } else {
          // Party is not adjacent — fog should be visible
          if (!hasContainer && !_animating.has(tileId)) {
            const container = buildContainer(node);
            canvas.stage.addChild(container);
            _fogContainers.set(tileId, container);

            if (wasAdjacent && _initialized && fogMode === "fog") {
              // Transition: was adjacent last turn → mist drifts back in
              _animateFadeIn(tileId);
            } else {
              // First load or shroud first appearance — snap to full opacity
              container.alpha = 1;
            }
          }
        }
      }

      // Purge containers for tiles no longer in the graph (scene/canvas change guard)
      for (const [tileId] of _fogContainers) {
        if (!seenTileIds.has(tileId)) destroyContainer(tileId);
      }

      _prevAdjacentIds = adjacentIds;
      _initialized = true;
    },

    /**
     * Destroy all active fog containers and reset session state.
     * Called on dungeon deactivate, canvas teardown, and dungeon reset.
     */
    destroyAll() {
      for (const tileId of [..._fogContainers.keys()]) {
        destroyContainer(tileId);
      }
      _localShroudRevealed.clear();
      _prevAdjacentIds = new Set();
      _initialized = false;
    },
  };

  console.debug(TAG, "Fog overlay manager loaded.");
})();
