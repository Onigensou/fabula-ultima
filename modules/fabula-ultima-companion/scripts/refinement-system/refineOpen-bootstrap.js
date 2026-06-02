// scripts/refinement-system/refineOpen-bootstrap.js
import { RefineOpenUI }      from "./refineOpen-ui.js";
import { RefineOpenBackend } from "./refineOpen-backend.js";
import { REFINEOPEN }        from "./refineOpen-const.js";
import { RefineWindowApp }   from "./refineWindow-app.js";

Hooks.once("ready", async () => {
  const ui = new RefineOpenUI({
    DEBUG:         false,
    LAYER_Z_INDEX: 90,
    ICON_OFFSET_X: 44, // sits to the right of the shop button (which is at x+0)
    ICON_OFFSET_Y: 56,
  });

  const backend = new RefineOpenBackend({
    DEBUG:    false,
    RANGE_PX: 140,
  });

  // Backend → UI
  backend.uiSetDesiredVisible = (set) => ui.setDesiredVisible(set);

  // UI → Backend
  ui.onClickBlacksmithToken = (tokenId) => backend.openBlacksmithByTokenId(tokenId);

  // Reposition on pan/zoom/resize
  Hooks.on("canvasPan",   () => ui.repositionAll());
  Hooks.on("canvasReady", () => ui.repositionAll());
  window.addEventListener("resize", () => ui.repositionAll());

  await backend.start();

  // Expose API surface
  window.FUCompanion = window.FUCompanion || {};
  window.FUCompanion.refineOpen = {
    version: "v1",
    backend,
    ui,
    open:  (blacksmithActorUuid) => RefineWindowApp.open(blacksmithActorUuid),
    close: () => RefineWindowApp.close(),
  };

  console.debug(REFINEOPEN.TAG, "Refinement proximity system ready.");
});
