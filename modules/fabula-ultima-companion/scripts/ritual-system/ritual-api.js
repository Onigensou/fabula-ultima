// ============================================================================
// Ritual System — public API + bootstrap.
//
//     FUCompanion.api.ritual.open()          // open the setup window
//     FUCompanion.api.ritual.canOpen()       // is a performer resolvable?
//     game.modules.get("fabula-ultima-companion").api.ritual.open()
//
// The docked scene-mode button in dp-scan-mode.js knows nothing about rituals
// beyond these two calls, exactly as it knows nothing about healing.
//
// Also wires the GM-mediated cast socket on every client at startup.
//
// v1 covers rituals performed OUTSIDE a conflict. The in-conflict flow (core
// p. 121: an Objective action opens a Ritual Clock, the party fills it, then
// the caster spends the MP and rolls) is deferred — conflicts belong to Battle
// Director. `performCast` is exported separately so that flow can drive the
// same cast step when it lands.
// ============================================================================

import { RITUAL_MODULE_ID, RITUAL_TAG } from "./ritual-const.js";
import { RitualHUD } from "./ritual-hud-app.js";
import { wireRitualSocket } from "./ritual-socket.js";
import { performCast } from "./ritual-cast.js";
import { RitualFeedback } from "./ritual-feedback.js";
import { gatherOfferableMaterials } from "./ritual-materials.js";
import { openMatTuner, applyStoredMatTuning } from "./ritual-mat-tuner.js";
import { canOpenRitual, blockedReason, resolvePerformer, disciplinesForActor } from "./ritual-actor.js";
import { wireRitualPips } from "./ritual-pip.js";
import { getSessions } from "./ritual-session.js";

const api = {
  /** Open the local Ritual window. */
  open() { RitualHUD.open(); return RitualHUD; },
  /** Close it if open. */
  close() { RitualHUD.close(); },
  /** True while the window is on screen. */
  get isOpen() { return RitualHUD.isOpen; },
  /** True when this client has a performer who knows at least one discipline. */
  canOpen() { return canOpenRitual(); },
  /** Why canOpen() is false — a tooltip string, or null when it is true. */
  blockedReason() { return blockedReason(); },
  /** The resolved performer, or null. */
  performer() { return resolvePerformer(); },
  /** Disciplines an actor may perform. */
  disciplines(actor) { return disciplinesForActor(actor); },
  /** Materials an actor may offer: their own bag plus the party's. */
  materials(actor) { return gatherOfferableMaterials(actor); },
  /** Spectator banner — `.feedback._test()` to preview it locally. */
  feedback: RitualFeedback,
  /** Live style tuners (local, never written to the world). */
  tuner: { material: () => openMatTuner() },
  /** GM-authoritative cast. Exported for the deferred in-conflict flow. */
  performCast,
  /** Attend a live session as a read-only spectator (GM pip calls this). */
  spectate(sessionId) {
    const s = getSessions().find((x) => x.sessionId === sessionId);
    if (s) RitualHUD.spectate(s);
    return RitualHUD;
  },
  /** Live shared-window sessions on this client (debugging). */
  sessions() { return getSessions(); },
  /** Direct handle (advanced / debugging). */
  HUD: RitualHUD,
};

function ensureModuleApi() {
  const mod = game.modules?.get(RITUAL_MODULE_ID);
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
    wireRitualSocket();
    wireRitualPips();         // GM-only: the attend-pip stack (no-op for players)
    applyStoredMatTuning();   // restore a tuned Offer Material look before any window opens
    const m = ensureModuleApi(); if (m) m.ritual = api;
    ensureGlobalApi().ritual = api;
    console.debug(RITUAL_TAG, "Ritual system ready — FUCompanion.api.ritual.open()");
  } catch (e) {
    console.warn(RITUAL_TAG, "bootstrap failed", e);
  }
});

export { api as RitualApi };
