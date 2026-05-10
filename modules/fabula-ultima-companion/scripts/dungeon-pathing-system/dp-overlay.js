// ============================================================================
// Dungeon Pathing System — PIXI Overlay
// Draws the movement indicator (current node ring + neighbour rings + lines).
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Overlay]";

  let _container = null;

  function destroy() {
    try {
      if (_container) {
        _container.destroy({ children: true });
      }
    } catch {}
    _container = null;
  }

  function drawCircle(container, node, color, label, fillAlpha = 0.15) {
    const N      = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    const radius = Math.max(18, Math.min(N(node.width), N(node.height)) / 2 + 12);

    const g = new PIXI.Graphics();
    g.lineStyle(4, color, 0.95);
    g.beginFill(color, fillAlpha);
    g.drawCircle(node.center.x, node.center.y, radius);
    g.endFill();
    container.addChild(g);

    if (label) {
      const text = new PIXI.Text(label, {
        fontFamily: "Arial", fontSize: 18, fill: "#ffffff",
        stroke: "#000000", strokeThickness: 4, align: "center"
      });
      text.anchor.set(0.5, 0.5);
      text.x = node.center.x;
      text.y = node.center.y - radius - 18;
      container.addChild(text);
    }
  }

  DP.Overlay = {
    /** Draw current + neighbour highlights on the canvas stage. */
    draw(currentNode, neighborNodes) {
      destroy();
      if (!canvas?.stage) return;

      const container        = new PIXI.Container();
      container.name         = "ONI DungeonPathing Overlay";
      container.zIndex       = 999999;
      container.sortableChildren = true;

      // Lines from current → neighbours
      for (const n of neighborNodes) {
        const line = new PIXI.Graphics();
        line.lineStyle(6, DP.HIGHLIGHT.LINE, 0.55);
        line.moveTo(currentNode.center.x, currentNode.center.y);
        line.lineTo(n.center.x, n.center.y);
        container.addChild(line);
      }

      drawCircle(container, currentNode, DP.HIGHLIGHT.CURRENT, "●", 0.1);
      neighborNodes.forEach((n, i) => drawCircle(container, n, DP.HIGHLIGHT.NEIGHBOR, `${i + 1}`, 0.2));

      try {
        canvas.stage.sortableChildren = true;
        canvas.stage.addChild(container);
      } catch (e) {
        console.warn(TAG, "Could not add overlay to stage", e);
      }

      _container = container;
    },

    clear() { destroy(); }
  };
})();
