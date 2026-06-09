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
//   Each mode uses a dedicated image asset sized to the tile template.
//   The sprite is stretched to match the actual tile bounds on the map so it
//   overlays correctly regardless of how large the tile was placed.
//
//   Idle animation — gentle alpha pulse via a single shared PIXI ticker:
//     Fog    0.85 – 1.00  @ 0.45 rad/s  (~14s period)
//     Shroud 0.78 – 1.00  @ 0.28 rad/s  (~22s period)
//   Phase is seeded per-container so tiles don't breathe in unison.
//
// Transitions:
//   Reveal (fog lifts)    — container.alpha fades OUT 600ms cubic ease.
//   Re-fog (mist returns) — container.alpha fades IN  500ms cubic ease.
//   First load / snap     — container appears at alpha 1 instantly.
//
// Performance — PIXI pitfalls guarded:
//   · parent?.removeChild() always before destroy({ children:true })
//   · _animating Set prevents double-animation on the same tile
//   · No DOM reads inside any animation loop
//   · Single shared PIXI ticker drives all idle animations
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

  // Idle animation parameters per mode
  const IDLE = {
    fog:    { minAlpha: 0.85, amp: 0.15, speed: 0.45 },
    shroud: { minAlpha: 0.78, amp: 0.22, speed: 0.28 },
  };

  const _fogContainers       = new Map();  // tileId → PIXI.Container
  const _animating           = new Set();  // tileId — mid-animation guard
  let   _prevAdjacentIds     = new Set();
  let   _initialized         = false;
  const _localShroudRevealed = new Set();

  let _tickerFn = null;

  // ---------------------------------------------------------------------------
  // Flag helper — fogMode with backward compat for old boolean fog flag
  // ---------------------------------------------------------------------------
  function getFogMode(tileDoc) {
    const mode = tileDoc?.getFlag(DP.MODULE_ID, `${DP.PATHING_ROOT_KEY}.fogMode`);
    if (mode === "fog" || mode === "shroud") return mode;
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
  // Idle ticker — single shared callback for all active containers
  // ---------------------------------------------------------------------------
  function _startIdleTick() {
    if (_tickerFn || !canvas?.app?.ticker) return;
    _tickerFn = () => {
      if (!_fogContainers.size) return;
      const t = performance.now() * 0.001; // seconds
      for (const [tileId, container] of _fogContainers) {
        if (container.destroyed || _animating.has(tileId)) continue;
        const sprite = container._sprite;
        if (!sprite || sprite.destroyed) continue;
        const { minAlpha, amp, speed } = container._idle;
        // sin normalised to [0,1] → mapped to [minAlpha, 1.0]
        sprite.alpha = minAlpha + amp * ((Math.sin(t * speed + container._idlePhase) + 1) * 0.5);
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

    // Idle animation params — phase seeded from current time so containers
    // start at alpha 1.0 and drift downward smoothly (no snap on first tick)
    const idle = IDLE[fogMode] ?? IDLE.fog;
    container._idle      = idle;
    container._idlePhase = Math.PI / 2 - performance.now() * 0.001 * idle.speed;

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
            _startIdleTick();

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

      _prevAdjacentIds = adjacentIds;
      _initialized = true;
    },

    destroyAll() {
      _stopIdleTick();
      for (const tileId of [..._fogContainers.keys()]) {
        destroyContainer(tileId);
      }
      _localShroudRevealed.clear();
      _prevAdjacentIds = new Set();
      _initialized = false;
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
      _startIdleTick();
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
