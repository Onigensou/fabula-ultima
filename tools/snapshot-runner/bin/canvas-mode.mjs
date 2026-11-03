// canvas-mode — how much a headless test client DRAWS. Used by run.mjs and referee-staging.mjs.
//
// The implementation lives in tools/fvtt-playwright/lib/foundry.js (useCanvasMode), which every
// harness client goes through, so the Snapshot Runner, the Staging World and the live-world
// harness all draw (or not) the same way, and captures stay exact in every mode.
//
//   full  draw as the game does (visual / UX / UI checks)
//   low   the canvas at 0.25 resolution: same frames, a 16th of the pixels.  battle 641 s -> 152 s
//   off   no canvas drawing at all (the PIXI ticker still runs).               battle 641 s -> 32 s
//
// The mode changes no rules: a seeded battle comes out the same in every mode
// (bin/compare-battle.mjs). Default: off (run.mjs / referee-staging.mjs --canvas; connect() for any headless client).
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const { useCanvasMode, CANVAS_MODES: MODES } = await import(pathToFileURL(resolve(HERE, "../../fvtt-playwright/lib/foundry.js")).href);
export const CANVAS_MODES = MODES;

export async function applyCanvasMode(page, mode = "off") {
  if (!CANVAS_MODES.includes(mode)) throw new Error(`--canvas must be one of ${CANVAS_MODES.join("|")}, got "${mode}"`);
  const st = await useCanvasMode(page, mode);
  globalThis.__testCanvasMode = mode;
  await page.evaluate((m) => { globalThis.__testCanvasMode = m; }, mode).catch(() => {});
  return st;
}
