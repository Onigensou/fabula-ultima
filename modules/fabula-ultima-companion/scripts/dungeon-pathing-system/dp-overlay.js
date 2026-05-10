// ============================================================================
// Dungeon Pathing System — Overlay
// Overlay is intentionally invisible in normal play.
// Visual feedback is handled by dp-helper-mode.js (H key toggle).
// This module is kept as a stub so the bootstrap's draw()/clear() calls
// remain valid and future optional overlays can be re-introduced here.
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  DP.Overlay = {
    draw(_currentNode, _neighborNodes) { /* intentionally empty — no circles in play */ },
    clear() {}
  };
})();
