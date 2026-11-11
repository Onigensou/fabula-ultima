// scripts/crafting-system/crafting-bootstrap.js
//
// Wires the Crafting System (Blueprints) into the running client and exposes
// FUCompanion.api.crafting. Loaded by a dynamic import from director-boot's
// ready hook, like the Orbment system: no module.json entry, a hard reload
// picks it up.
//
//   api.crafting.craft({ bookId, blueprintId, place, actorId, qty })  → result
//   api.crafting.open({ place, bookId, actor, ... })   the crafting window
//   api.crafting.openForNpc(actor) / openForSpot(regionDoc)
//   api.crafting.openEditor()                          GM Blueprint Editor
//   api.crafting.setCrafter(actor, { on, bookId, quote })
//   api.crafting.readConfig() / saveConfig(cfg)
//   api.crafting.feedback.announce(...) / _test()      result banner
// Camp Forge → Craft lives in orbment/camp-forge.js (it calls executeCraft).

import { TAG } from "./crafting-const.js";
import * as data from "./crafting-data.js";
import { craft, executeCraft, installCraftSocket, craftFailText } from "./crafting-craft.js";
import { feedback, installFeedback } from "./crafting-feedback.js";
import { CraftWindow, CraftPanel } from "./crafting-window.js";
import { initCraftingOpen, openForNpc, openForSpot, setCrafter, isCrafterActor, resolveCrafter } from "./crafting-open.js";
import { openEditor, registerEditorMenu } from "./blueprint-editor.js";

let _installed = false;
export function initCrafting() {
  if (_installed) return;
  _installed = true;
  installCraftSocket();
  installFeedback();
  try { initCraftingOpen(); } catch (e) { console.warn(TAG, "initCraftingOpen failed", e); }
  if (game.user?.isGM) registerEditorMenu();

  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  const api = (root.api = root.api ?? {});
  api.crafting = {
    craft, executeCraft, craftFailText,
    open: (opts) => CraftWindow.open(opts), CraftWindow, CraftPanel,
    openForNpc, openForSpot, resolveCrafter,
    openEditor, setCrafter, isCrafter: isCrafterActor,
    readConfig: data.readConfig, saveConfig: data.saveConfig, data,
    feedback,
  };
  console.debug(TAG, "Crafting system ready.");
}
