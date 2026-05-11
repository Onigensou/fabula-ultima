// ============================================================================
// Dungeon Pathing System — Overlay
// Hover highlight: when the cursor enters a walkable tile, a semi-transparent
// golden rectangle is drawn over it using PIXI.Graphics on the canvas stage.
//
// Performance: a single PIXI.Graphics instance is kept alive for the session.
// Instead of creating/destroying objects on each hover, we just call g.clear()
// and redraw — no stage add/remove, no sortChildren() per hover event.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};

  // Single persistent graphics object — created once, reused across hovers.
  let _g = null;

  function ensureGraphics() {
    if (_g && !_g.destroyed) return _g;
    if (!canvas?.stage) return null;
    const g = new PIXI.Graphics();
    g.name   = "ONI DungeonPathing HoverHighlight";
    g.zIndex = 999997;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(g);
    _g = g;
    return g;
  }

  DP.Overlay = {
    draw(_currentNode, _neighborNodes) {}, // legacy stub

    clear() {
      if (_g && !_g.destroyed) _g.clear();
    },

    setHoverNode(node) {
      if (!node || !canvas?.stage) { this.clearHover(); return; }

      const g = ensureGraphics();
      if (!g) return;

      const cfg = DP.UI?.HOVER_HIGHLIGHT ?? { COLOR: 0xffd966, ALPHA: 0.22, CORNER_R: 6 };
      const b   = node.bounds;

      g.clear();
      g.beginFill(cfg.COLOR, cfg.ALPHA);
      g.drawRoundedRect(b.left, b.top, b.right - b.left, b.bottom - b.top, cfg.CORNER_R);
      g.endFill();
    },

    clearHover() {
      if (_g && !_g.destroyed) _g.clear();
    },
  };
})();
