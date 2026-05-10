// ============================================================================
// Dungeon Pathing System — Helper Mode
// Toggle with H key while dungeon mode is active.
// When ON: places a hand-cursor sprite on the right side of each walkable
//          (neighbour) tile so the player can see where they can move.
// When OFF: all indicators are removed.
// ============================================================================
(() => {
  const DP   = globalThis.DungeonPathing ??= {};
  const TAG  = "[DungeonPathing][HelperMode]";

  // Size read from DP.UI at runtime so the tuning block in dp-constants takes effect
  function getCursorCfg() {
    return DP.UI?.CURSOR ?? { SIZE: 36, EDGE_INSET: 0.35 };
  }

  let _container  = null;
  let _texture    = null;
  let _enabled    = false;
  let _keyHandler = null;

  // Cached current neighbor list so toggling ON re-shows them without a rebuild
  let _currentNeighbors = [];

  async function ensureTexture() {
    if (_texture) return _texture;
    try {
      _texture = await loadTexture(DP.HAND_CURSOR_URL);
    } catch (e) {
      console.warn(TAG, "Could not load hand cursor texture", e);
      _texture = null;
    }
    return _texture;
  }

  function destroyContainer() {
    try { _container?.destroy({ children: true }); } catch {}
    _container = null;
  }

  async function show(neighborNodes) {
    destroyContainer();
    if (!neighborNodes?.length) return;
    if (!canvas?.stage) return;

    _currentNeighbors = neighborNodes;

    const tex = await ensureTexture();

    const root = new PIXI.Container();
    root.name  = "ONI DungeonPathing HelperMode";
    root.zIndex = 999998;

    const cfg = getCursorCfg();

    for (const node of neighborNodes) {
      // Place the sprite on the right side of the tile, vertically centred
      const sprite = tex
        ? new PIXI.Sprite(tex)
        : buildFallbackMarker();

      if (tex) {
        sprite.width  = cfg.SIZE;
        sprite.height = cfg.SIZE;
        sprite.anchor.set(0, 0.5); // anchor left-centre
      }

      // Position: right edge of tile, vertically centred
      sprite.x = node.bounds.right  - cfg.SIZE * cfg.EDGE_INSET;
      sprite.y = node.center.y;

      root.addChild(sprite);
    }

    try {
      canvas.stage.sortableChildren = true;
      canvas.stage.addChild(root);
    } catch (e) {
      console.warn(TAG, "Could not add container to stage", e);
    }

    _container = root;
  }

  // Simple coloured dot as fallback if the texture fails to load
  function buildFallbackMarker() {
    const g = new PIXI.Graphics();
    g.beginFill(0xffffff, 0.8);
    g.drawCircle(0, 0, 10);
    g.endFill();
    return g;
  }

  function hide() {
    destroyContainer();
  }

  function toggle() {
    _enabled = !_enabled;
    if (_enabled) {
      show(_currentNeighbors);
      ui.notifications?.info?.("Helper mode ON — walkable tiles highlighted. Press H to toggle.");
    } else {
      hide();
      ui.notifications?.info?.("Helper mode OFF.");
    }
  }

  function installKeyListener() {
    if (_keyHandler) return;
    _keyHandler = (ev) => {
      if (!globalThis.__ONI_DUNGEON_PATHING__?.state?.active) return;
      if (ev.repeat) return;
      // Ignore if focus is in a text input
      const tag = document.activeElement?.tagName?.toLowerCase?.() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (ev.key === "h" || ev.key === "H") {
        ev.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", _keyHandler, true);
  }

  function removeKeyListener() {
    if (_keyHandler) window.removeEventListener("keydown", _keyHandler, true);
    _keyHandler = null;
  }

  DP.HelperMode = {
    get enabled() { return _enabled; },

    /** Called after every graph rebuild — updates which tiles are shown. */
    update(neighborNodes) {
      _currentNeighbors = neighborNodes ?? [];
      if (_enabled) show(_currentNeighbors);
    },

    /** Call when dungeon mode deactivates. */
    deactivate() {
      _enabled = false;
      hide();
      removeKeyListener();
    },

    /** Call when dungeon mode activates. */
    activate() {
      installKeyListener();
    },

    show,
    hide,
    toggle
  };
})();
