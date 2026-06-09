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
// Visuals:
//   Fog    — cool blue-grey mist; soft overlapping ellipses, no hard edges.
//   Shroud — deep indigo/violet veil; denser, more ominous.
//   Both   — organic shape (no rectangular base), idle breathing animation.
//
// Animations:
//   Reveal (fog lifts)    — fade OUT 600ms ease-in-out cubic.
//   Re-fog (mist returns) — new container fades IN 500ms (fog mode only).
//   Idle breathing        — per-layer alpha oscillation via PIXI ticker
//                           (single shared ticker, all containers updated together).
//   First load / snap     — containers appear at full alpha instantly.
//
// Performance — PIXI pitfalls guarded:
//   · parent?.removeChild() always before destroy({ children:true })
//   · _animating Set prevents double-animation on the same tile
//   · No DOM reads inside any animation loop
//   · Single PIXI ticker for idle (not one rAF per tile)
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

  // Shared PIXI ticker for idle breathing animation
  let _tickerFn = null;

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

  // ---------------------------------------------------------------------------
  // Idle ticker — single shared callback, all active containers updated per frame
  // ---------------------------------------------------------------------------
  function _startIdleTick() {
    if (_tickerFn || !canvas?.app?.ticker) return;
    _tickerFn = () => {
      if (!_fogContainers.size) return;
      const t = performance.now() * 0.001; // seconds
      for (const [tileId, container] of _fogContainers) {
        if (container.destroyed || _animating.has(tileId)) continue;
        for (const layer of (container._fogLayers ?? [])) {
          // Oscillate each layer between 80% and 100% of its base alpha.
          // sin range [-1,1] → normalised to [0,1] → mapped to [0.80, 1.00].
          layer.gfx.alpha = layer.baseAlpha *
            (0.80 + 0.20 * ((Math.sin(t * layer.speed + layer.phase) + 1) * 0.5));
        }
      }
    };
    canvas.app.ticker.add(_tickerFn);
  }

  function _stopIdleTick() {
    if (!_tickerFn) return;
    canvas?.app?.ticker?.remove?.(_tickerFn);
    _tickerFn = null;
  }

  // ---------------------------------------------------------------------------
  // Layer configs
  //   Each entry: { x, y, rx, ry, color, baseAlpha, phase, speed }
  //   x/y are in tile-local coordinates (origin = top-left of tile).
  //   phase/speed drive the idle animation; different values per layer so
  //   they breathe independently rather than all pulsing in unison.
  // ---------------------------------------------------------------------------

  // Blue-grey mist — transient fog
  function _fogLayers(cx, cy, w, h) {
    return [
      // Two large masses cover the center without a hard rectangle
      { x: cx * 0.95, y: cy * 1.05, rx: w * 0.58, ry: h * 0.48, color: 0x4a7090, baseAlpha: 0.60, phase: 0.0, speed: 0.40 },
      { x: cx * 1.08, y: cy * 0.90, rx: w * 0.52, ry: h * 0.44, color: 0x3d6070, baseAlpha: 0.52, phase: 1.6, speed: 0.35 },
      // Outer wisps drift beyond tile edges for an organic boundary
      { x: cx * 1.28, y: cy * 0.72, rx: w * 0.44, ry: h * 0.32, color: 0x6895b0, baseAlpha: 0.38, phase: 0.8, speed: 0.55 },
      { x: cx * 0.65, y: cy * 1.28, rx: w * 0.42, ry: h * 0.30, color: 0x72a0bc, baseAlpha: 0.33, phase: 2.4, speed: 0.50 },
      { x: cx * 0.75, y: cy * 0.70, rx: w * 0.36, ry: h * 0.26, color: 0x8ab8d0, baseAlpha: 0.28, phase: 3.2, speed: 0.62 },
      { x: cx * 1.22, y: cy * 1.30, rx: w * 0.38, ry: h * 0.24, color: 0x9acce0, baseAlpha: 0.24, phase: 4.0, speed: 0.48 },
      // Bright central highlight — creates the illusion of depth
      { x: cx * 1.05, y: cy * 0.95, rx: w * 0.28, ry: h * 0.20, color: 0xbadaec, baseAlpha: 0.18, phase: 1.2, speed: 0.70 },
    ];
  }

  // Deep indigo/violet veil — permanent shroud
  function _shroudLayers(cx, cy, w, h) {
    return [
      // Dense dark base layers — heavier, slower breath than fog
      { x: cx * 1.00, y: cy * 1.00, rx: w * 0.60, ry: h * 0.50, color: 0x120924, baseAlpha: 0.78, phase: 0.0, speed: 0.28 },
      { x: cx * 0.90, y: cy * 1.05, rx: w * 0.55, ry: h * 0.45, color: 0x1e0d3c, baseAlpha: 0.65, phase: 1.8, speed: 0.25 },
      // Purple bloom layers — mid-opacity, moderate speed
      { x: cx * 1.15, y: cy * 0.80, rx: w * 0.46, ry: h * 0.36, color: 0x3d1870, baseAlpha: 0.48, phase: 0.9, speed: 0.40 },
      { x: cx * 0.70, y: cy * 1.20, rx: w * 0.44, ry: h * 0.34, color: 0x4e2288, baseAlpha: 0.42, phase: 2.7, speed: 0.38 },
      // Edge tendrils — lighter, faster — give it a restless quality
      { x: cx * 0.82, y: cy * 0.68, rx: w * 0.36, ry: h * 0.26, color: 0x6638a8, baseAlpha: 0.32, phase: 1.4, speed: 0.52 },
      { x: cx * 1.20, y: cy * 1.32, rx: w * 0.34, ry: h * 0.24, color: 0x7848c0, baseAlpha: 0.26, phase: 3.5, speed: 0.46 },
      // Soft violet shimmer near centre — gives the shroud an inner glow
      { x: cx * 1.02, y: cy * 0.98, rx: w * 0.24, ry: h * 0.18, color: 0xb090e0, baseAlpha: 0.22, phase: 2.2, speed: 0.60 },
    ];
  }

  // ---------------------------------------------------------------------------
  // Build a PIXI.Container — one separate Graphics per layer (enables idle anim)
  // ---------------------------------------------------------------------------
  function buildContainer(node, fogMode) {
    const b  = node.bounds;
    const w  = b.right - b.left;
    const h  = b.bottom - b.top;
    const cx = w / 2;
    const cy = h / 2;

    const container = new PIXI.Container();
    container.name        = `ONI_DP_Fog_${node.nodeId}`;
    container.zIndex      = FOG_Z;
    container.x           = b.left;
    container.y           = b.top;
    container._fogLayers  = [];

    const layers = fogMode === "shroud"
      ? _shroudLayers(cx, cy, w, h)
      : _fogLayers(cx, cy, w, h);

    for (const layer of layers) {
      const gfx = new PIXI.Graphics();
      gfx.beginFill(layer.color, 1);
      gfx.drawEllipse(layer.x, layer.y, layer.rx, layer.ry);
      gfx.endFill();
      gfx.alpha = layer.baseAlpha;
      container.addChild(gfx);
      container._fogLayers.push({
        gfx,
        baseAlpha: layer.baseAlpha,
        phase:     layer.phase,
        speed:     layer.speed,
      });
    }

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

        const isAdjacent   = adjacentIds.has(tileId);
        const wasAdjacent  = _prevAdjacentIds.has(tileId);
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
            const container = buildContainer(node, fogMode);
            canvas.stage.addChild(container);
            _fogContainers.set(tileId, container);
            _startIdleTick();

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
      _stopIdleTick();
      for (const tileId of [..._fogContainers.keys()]) {
        destroyContainer(tileId);
      }
      _localShroudRevealed.clear();
      _prevAdjacentIds = new Set();
      _initialized = false;
    },

    /**
     * Immediately restore the fog container for a single shroud tile after a
     * manual GM reset (per-tile Reset Shroud button in tile config).
     * Clears the local session guard and re-creates the PIXI container if the
     * tile is not currently adjacent to the party.
     */
    resetShroudLocally(tileId) {
      _localShroudRevealed.delete(tileId);
      _animating.delete(tileId);

      const api = globalThis.__ONI_DUNGEON_PATHING__;
      if (!api?.state?.active || !api.graph) return;

      const node = api.graph.nodeMap?.get(tileId);
      if (!node || !ensureStage()) return;

      const isAdjacent = api.currentNode?.nodeId === tileId
        || api.state.neighborIds?.has(tileId);
      if (isAdjacent) return; // would be lifted again immediately on next rebuild

      if (_fogContainers.has(tileId) && !_fogContainers.get(tileId)?.destroyed) return;

      // Look up fogMode from tile document to use correct visual
      const tileDoc = canvas?.scene?.tiles?.get(tileId);
      const fogMode = tileDoc ? getFogMode(tileDoc) : "shroud";

      const container = buildContainer(node, fogMode ?? "shroud");
      canvas.stage.addChild(container);
      _fogContainers.set(tileId, container);
      _startIdleTick();
      container.alpha = 1;
    },
  };

  // ---------------------------------------------------------------------------
  // Multi-client sync — when the GM resets fogRevealed flags the scene flag
  // change arrives here via Foundry's native updateScene broadcast.  We clear
  // the corresponding entries from _localShroudRevealed (the in-memory session
  // guard) so all clients correctly show fog again on the next rebuild.
  // ---------------------------------------------------------------------------
  Hooks.on("updateScene", (sceneDoc, diff) => {
    if (!canvas?.scene || sceneDoc.id !== canvas.scene.id) return;
    const dp = diff?.flags?.[DP.MODULE_ID]?.[DP.PATHING_ROOT_KEY];
    if (!dp) return;

    let changed = false;

    // Full clear: scene.unsetFlag("dungeonPathing.fogRevealed") → "-=fogRevealed": null
    if ("-=fogRevealed" in dp) {
      _localShroudRevealed.clear();
      changed = true;
    } else if (dp.fogRevealed && typeof dp.fogRevealed === "object") {
      // Per-tile clear: unsetFlag("fogRevealed.tileId") → "fogRevealed": { "-=tileId": null }
      for (const key of Object.keys(dp.fogRevealed)) {
        if (key.startsWith("-=")) {
          _localShroudRevealed.delete(key.slice(2));
          changed = true;
        }
      }
    }

    if (changed) {
      // Trigger a rebuild so all clients recreate fog containers immediately
      globalThis.__ONI_DUNGEON_PATHING__?.rebuild?.().catch(() => {});
    }
  });

  console.debug(TAG, "Fog overlay manager loaded.");
})();
