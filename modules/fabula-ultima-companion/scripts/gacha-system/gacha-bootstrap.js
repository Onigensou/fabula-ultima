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
import { playReveal, beginReveal, stop as stopFx } from "./gacha-fx.js";
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

let _installed = false;

function install() {
  if (_installed) return;
  _installed = true;

  Net.setup({
    // Another client pressed Wish — launch our streak with theirs. Spectators
    // included: watching is the point of a gacha screen.
    onStart:  (payload) => { if (UI.isOpen()) beginReveal(payload?.count ?? 1); },
    onReveal: (payload) => playReveal(payload),
    onPool:   (payload) => UI.refreshPool(payload?.pool),
  });

  // Small diagnostic surface — the reveal handler living behind a hook that may
  // already have fired is exactly the kind of failure that looks like "the
  // animation is broken" from the outside.
  const api = (globalThis.FUCompanion ??= {}).api ??= {};
  api.gacha = { installed: true, isOpen: UI.isOpen, replay: playReveal };

  // A reload while already standing on the scene still has to open the screen —
  // canvasReady has usually fired before this point.
  if (isGachaScene(canvas?.scene)) enter();

  log("Ready.");
}

// `Hooks.once("ready")` never fires for a module evaluated after ready has
// already gone by, which silently left the reveal handler uninstalled while the
// overlay itself still opened from canvasReady — the screen worked, the
// animation simply never played. Check the flag first and only wait if we must.
if (globalThis.game?.ready) install();
else Hooks.once("ready", install);

Hooks.on("canvasReady", () => sync(canvas?.scene));

// Keep the overlay inside Foundry's chrome when that chrome moves.
Hooks.on("collapseSidebar", () => { if (UI.isOpen()) setTimeout(() => UI.relayout(), 260); });
window.addEventListener("resize", () => { if (UI.isOpen()) UI.relayout(); });

Hooks.on("canvasTearDown", () => leave());

Hooks.on("updateScene", (scene) => {
  if (!canvas?.scene || scene.id !== canvas.scene.id) return;
  sync(scene);
});

// Currency and pity live on the party actor; when they change underneath us
// (another player's purchase, a GM edit) the counters should follow.
//
// Scoped to the party actor on purpose. A wish grants several items and
// decrements the coupon in one burst, and an unfiltered hook would repaint the
// whole overlay once per document touched, mid-animation.
const touchesParty = (doc) => {
  const partyId = UI.partyActorId();
  if (!partyId) return false;
  return doc?.id === partyId || doc?.parent?.id === partyId;
};

Hooks.on("updateActor", (actor) => {
  if (UI.isOpen() && touchesParty(actor)) UI.refreshPool();
});

Hooks.on("updateItem", (item) => {
  if (UI.isOpen() && touchesParty(item)) UI.refreshPool();
});

Hooks.on("createItem", (item) => {
  if (UI.isOpen() && touchesParty(item)) UI.refreshPool();
});
