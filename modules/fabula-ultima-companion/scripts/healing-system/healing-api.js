// ============================================================================
// Out-of-Combat Healing — public API + bootstrap.
//
// Exposes the entry point used by the dungeon-pathing button, macros, and the
// console:
//     FUCompanion.api.healing.open()                         // heal as your character
//     FUCompanion.api.healing.open({ casterActorId })        // heal as a specific actor
//     game.modules.get("fabula-ultima-companion").api.healing.open()
//
// Also wires the GM-mediated apply socket on every client at startup.
// ============================================================================

import { HEAL_MODULE_ID, HEAL_TAG } from "./healing-const.js";
import { HealingHUD } from "./healing-hud-app.js";
import { wireHealingSocket } from "./healing-socket.js";
import { openHealingTuner } from "./healing-tuner.js";

const api = {
  /** Open the local Healing HUD. Returns the HealingHUD singleton. */
  open(opts = {}) { HealingHUD.open(opts); return HealingHUD; },
  /** Close the HUD if open. */
  close() { HealingHUD.close(); },
  /** True while the HUD is on screen. */
  get isOpen() { return HealingHUD.isOpen; },
  /** Direct handle (advanced / debugging). */
  HUD: HealingHUD,
  /** Live layout tuner. */
  tuner: { open: () => openHealingTuner() },
};

function ensureModuleApi() {
  const mod = game.modules?.get(HEAL_MODULE_ID);
  if (!mod) return null;
  mod.api = mod.api || {};
  return mod.api;
}
function ensureGlobalApi() {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  return globalThis.FUCompanion.api;
}

Hooks.once("ready", () => {
  try {
    wireHealingSocket();
    const m = ensureModuleApi(); if (m) m.healing = api;
    ensureGlobalApi().healing = api;
    console.debug(HEAL_TAG, "Healing system ready — FUCompanion.api.healing.open()");
  } catch (e) {
    console.warn(HEAL_TAG, "bootstrap failed", e);
  }
});

export { api as HealingApi };
