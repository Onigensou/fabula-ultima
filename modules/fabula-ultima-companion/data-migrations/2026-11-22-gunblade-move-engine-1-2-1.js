/**
 * Migration: 2026-11-22-gunblade-move-engine-1-2-1  (Gunblade move-engine scripts → engine 1.2.1)
 * ---------------------------------------------------------------------------
 * Engine 1.2.1: the Gunblade Transform glint glow matches the mockup's CSS glow. The mockup's glow keeps full strength and
 * SHRINKS (14 px → 0); 1.2.0 faded one 14 px glow out (softer). Now a few glow sizes are rendered once before playback and
 * each frame draws the size of the moment, behind the art (still no per-frame blur, so no frame hitch).
 * Same choreography, timing and choices. Rewrites move-engine scripts of another engine version (or empty fields); a hand-made
 * script is left alone. Logic: _move-engine-refresh.js. Idempotent.
 */
import { refreshGunbladeScripts, ENGINE_VERSION } from "./_move-engine-refresh.js";

export const key = "2026-11-22-gunblade-move-engine-1-2-1";
export const description = "Gunblade animations: move-engine scripts → engine " + ENGINE_VERSION + " (transform glint glow matches the mockup).";
export async function migrate(game, log = () => {}) { return refreshGunbladeScripts(game, log); }
