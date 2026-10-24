// scripts/inn-system/innOpen-bootstrap.js
import { INN } from "./innOpen-const.js";
import { InnOpenUI } from "./innOpen-ui.js";
import { InnOpenBackend } from "./innOpen-backend.js";
import { openInn, installSocket } from "./innRest-core.js";

Hooks.once("ready", async () => {
  installSocket();

  const ui = new InnOpenUI({ DEBUG: false, LAYER_Z_INDEX: 90 });
  const backend = new InnOpenBackend({ DEBUG: false, RANGE_PX: 140 });

  backend.uiSetDesiredVisible = (set) => ui.setDesiredVisible(set);
  backend.onOpen = (tok) => openInn(tok);
  ui.onClickInnToken = (tokenId) => backend.openInnByTokenId(tokenId);

  // Keyboard play: the same buttons, offered to Confirm on walk maps.
  window.oni?.Interact?.register?.("inn", window.oni.Interact.tokenButtons(ui._btnByTokenId, {
    label: "Rest", icon: "fas fa-bed", order: 40,
    run: (tokenId) => backend.openInnByTokenId(tokenId),
  }));

  Hooks.on("canvasPan",   () => ui.repositionAll());
  Hooks.on("canvasReady", () => ui.repositionAll());
  window.addEventListener("resize", () => ui.repositionAll());

  await backend.start();

  window.FUCompanion = window.FUCompanion || {};
  window.FUCompanion.innOpen = { version: "v1", backend, ui, open: openInn };

  console.debug(INN.TAG, "Inn proximity system ready.");
});
