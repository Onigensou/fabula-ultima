/**
 * Migration: 2026-11-22-gunblade-move-engine-1-2  (Gunblade move-engine scripts → engine 1.2.0)
 * ---------------------------------------------------------------------------
 * Engine 1.2.0 fixes two things `move-engine parity` found in the Gunblade Transform's glint (flashActor):
 *   - a 100+ ms frame hitch: the glow was a canvas blur filter on the art every frame; now it is rendered once, before playback;
 *   - a double-bright token: the runtime's "blank" pose was not registered, so the token art was drawn twice during the glint.
 * Same choreography, timing and choices. Rewrites move-engine scripts of another engine version (or empty fields); a hand-made
 * script is left alone. Logic: _move-engine-refresh.js. Idempotent.
 */
import { refreshGunbladeScripts, ENGINE_VERSION } from "./_move-engine-refresh.js";

export const key = "2026-11-22-gunblade-move-engine-1-2";
export const description = "Gunblade animations: move-engine scripts → engine " + ENGINE_VERSION + " (smooth transform glint).";
export async function migrate(game, log = () => {}) { return refreshGunbladeScripts(game, log); }
