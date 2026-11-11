/**
 * Leak fixes for third-party modules (2026-11-12, found by tools/snapshot-runner/checks/fx-leak.js).
 *
 * Bar Brawl 1.8.9 redraws a token's bars with `this.bars.removeChildren()` and never destroys what it
 * removed. Each bar it drew is a Container with `cacheAsBitmap = true` (a RenderTexture, which texture
 * GC never collects) plus a PIXI.Text label (its own canvas texture, kept in PIXI's cache for the
 * session). Every HP / MP / IP change redraws the bars, so a battle left ~33 render textures and ~144
 * cached canvases behind, and a session kept growing.
 *
 * Fix: while Bar Brawl owns the bars, a token's bar container destroys what it removes. Bar Brawl builds
 * every bar fresh on each draw and never re-adds a removed one, so destroying them is safe; shared bar
 * images are untouched (a Sprite's texture is not destroyed by default).
 */
const PATCHED = Symbol("fuBarsDestroyOnRemove");

function patchBars(token) {
  const bars = token?.bars;
  if (!bars || bars[PATCHED] || typeof bars.removeChildren !== "function") return;
  const removeChildren = bars.removeChildren;
  bars.removeChildren = function (...args) {
    const removed = removeChildren.apply(this, args);
    for (const c of removed ?? []) {
      try { if (!c.destroyed) c.destroy({ children: true }); } catch (_e) { /* already gone */ }
    }
    return removed;
  };
  bars[PATCHED] = true;
}

let _hooked = false;
export function initThirdPartyLeakFixes() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  Hooks.once("ready", () => {
    if (!game.modules.get("barbrawl")?.active) return;
    Hooks.on("drawToken", patchBars);
    for (const t of globalThis.canvas?.tokens?.placeables ?? []) patchBars(t);
  });
}

initThirdPartyLeakFixes();
