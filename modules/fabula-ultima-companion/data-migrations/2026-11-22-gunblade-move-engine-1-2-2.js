/**
 * Migration: 2026-11-22-gunblade-move-engine-1-2-2  (Gunblade move-engine scripts → engine 1.2.2)
 * ---------------------------------------------------------------------------
 * Engine 1.2.2 fixes a frame hitch 1.2.1 brought to the Gunblade Transform glint: canvas drawing is lazy, so the six glow sizes
 * 1.2.1 prepares before playback were really blurred on the glint's first frame (140-200 ms). Now they are rendered at half
 * resolution (same look once blurred) and flushed before frame 0. Same glow, choreography, timing and choices.
 * Rewrites move-engine scripts of another engine version (or empty fields); a hand-made script is left alone.
 * Logic: _move-engine-refresh.js. Idempotent.
 */
import { refreshGunbladeScripts, ENGINE_VERSION } from "./_move-engine-refresh.js";

export const key = "2026-11-22-gunblade-move-engine-1-2-2";
export const description = "Gunblade animations: move-engine scripts → engine " + ENGINE_VERSION + " (no frame hitch at the transform glint).";
export async function migrate(game, log = () => {}) { return refreshGunbladeScripts(game, log); }
