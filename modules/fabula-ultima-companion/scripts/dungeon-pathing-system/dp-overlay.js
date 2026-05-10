// ============================================================================
// Dungeon Pathing System — Overlay
// Hover highlight: when the cursor enters a walkable tile, a semi-transparent
// golden rectangle is drawn over it using PIXI.Graphics on the canvas stage.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Overlay]";

  let _hoverContainer = null;

  function destroyHover() {
    try { _hoverContainer?.destroy({ children: true }); } catch {}
    _hoverContainer = null;
  }

  DP.Overlay = {
    // Legacy stubs — called from bootstrap after graph rebuild (no-op)
    draw(_currentNode, _neighborNodes) {},
    clear() { destroyHover(); },

    /** Highlight the given tile node (world-space bounds) when hovered. */
    setHoverNode(node) {
      destroyHover();
      if (!node || !canvas?.stage) return;

      const cfg = DP.UI?.HOVER_HIGHLIGHT ?? { COLOR: 0xffd966, ALPHA: 0.22, CORNER_R: 6 };
      const b   = node.bounds;

      const root = new PIXI.Container();
      root.name   = "ONI DungeonPathing HoverHighlight";
      root.zIndex = 999997;

      const g = new PIXI.Graphics();
      g.beginFill(cfg.COLOR, cfg.ALPHA);
      g.drawRoundedRect(b.left, b.top, b.right - b.left, b.bottom - b.top, cfg.CORNER_R);
      g.endFill();
      root.addChild(g);

      try {
        canvas.stage.sortableChildren = true;
        canvas.stage.addChild(root);
        canvas.stage.sortChildren();
      } catch (e) {
        console.warn(TAG, "Could not add hover highlight to stage", e);
      }

      _hoverContainer = root;
    },

    clearHover() {
      destroyHover();
    },
  };
})();
