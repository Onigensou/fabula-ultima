// scripts/shop-open/shopopen-bootstrap.js
import { ShopOpenBackend } from "./shopopen-backend.js";
import { ShopOpenUI } from "./shopopen-ui.js";
import { SHOPOPEN } from "./shopopen-const.js";

Hooks.once("ready", async () => {
  // You can add a game setting toggle later; for now always on.
  const ui = new ShopOpenUI({
    DEBUG: false,           // UI debug off by default
    LAYER_Z_INDEX: 90,
    ICON_OFFSET_Y: 56,
  });

  const backend = new ShopOpenBackend({
    DEBUG: true,            // backend debug on (safe)
    RANGE_PX: 140,
    FORCE_CLOSE_TO_NONE: true,
  });

  // Backend -> UI
  backend.uiSetDesiredVisible = (set) => ui.setDesiredVisible(set);

  // UI -> Backend
  ui.onClickShopToken = (tokenId) => backend.openShopByTokenId(tokenId);

  // Reposition on pan/zoom/resize (UI-owned; backend stays clean)
  Hooks.on("canvasPan", () => ui.repositionAll());
  window.addEventListener("resize", () => ui.repositionAll());
  Hooks.on("canvasReady", () => ui.repositionAll());

  // Start backend (it will trigger initial scan -> UI shows icons)
  await backend.start();

  // Optional: expose for debugging in console
  window.FUCompanion = window.FUCompanion || {};
  window.FUCompanion.shopOpen = {
    version: "v1-module",
    backend,
    ui,
    start: () => backend.start(),
    stop: async () => { await backend.stop(); ui.destroy(); },
    const: SHOPOPEN,
  };

  console.log(SHOPOPEN.TAG, "Module bootstrap loaded (ShopOpen).");
});
