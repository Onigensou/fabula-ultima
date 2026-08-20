// ============================================================================
// Gacha System — Bootstrap
// ----------------------------------------------------------------------------
// Single ESM entry point: everything else is reached through this import graph,
// so module.json only needs this one file listed.
//
// Arms on scene mode "gacha" for EVERY client, GM and player alike — same
// lifecycle as the title screen. Spectators get the screen and the animations;
// gacha-ui.js decides which controls they may actually touch.
// ============================================================================

import { GACHA, log } from "./gacha-const.js";
import * as Net from "./gacha-net.js";
import * as UI from "./gacha-ui.js";
import { playReveal, stop as stopFx } from "./gacha-fx.js";
import { closePanel } from "./gacha-panels.js";

function isGachaScene(scene) {
  const mode = scene?.flags?.[GACHA.MODULE_ID]?.oniFabula?.general?.sceneMode;
  return mode === GACHA.SCENE_MODE;
}

function enter() { UI.open(); }

function leave() {
  UI.close();
  closePanel();
  stopFx();
}

function sync(scene) {
  if (isGachaScene(scene)) enter();
  else leave();
}

Hooks.once("ready", () => {
  Net.setup({
    onReveal: (payload) => playReveal(payload),
    onPool:   (payload) => UI.refreshPool(payload?.pool),
  });

  // A reload while already standing on the scene still has to open the screen —
  // canvasReady has usually fired before this point.
  if (isGachaScene(canvas?.scene)) enter();

  log("Ready.");
});

Hooks.on("canvasReady", () => sync(canvas?.scene));

Hooks.on("canvasTearDown", () => leave());

Hooks.on("updateScene", (scene) => {
  if (!canvas?.scene || scene.id !== canvas.scene.id) return;
  sync(scene);
});

// Currency and pity live on the party actor; when it changes underneath us
// (another player's purchase, a GM edit) the counters should follow.
Hooks.on("updateActor", (actor) => {
  if (!UI.isOpen()) return;
  UI.refreshPool();
});

Hooks.on("updateItem", (item) => {
  if (!UI.isOpen()) return;
  if (item?.parent?.documentName !== "Actor") return;
  UI.refreshPool();
});
