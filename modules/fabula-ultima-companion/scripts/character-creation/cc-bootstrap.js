/**
 * Character Creation — bootstrap.
 *
 * Publishes the public API and installs the shared advancement transport.
 *
 * The title screen is a plain (non-module) script and loads BEFORE esmodules,
 * so it cannot import this. It reaches the wizard through
 * `FUCompanion.api.characterCreation` at click time, by which point this has
 * registered. `openable()` exists so the title menu can grey the entry out
 * rather than fail on click when the world is missing its seed actor.
 */

import { CC, log, warn } from "./cc-const.js";
import { app } from "./cc-app.js";
import { previewFolder, folderNameFor } from "./cc-folder.js";
import { installNet } from "../advancement/advancement-net.js";

// Step modules self-register into STEP_RENDERERS on import. They are pulled in
// HERE rather than from cc-app so the dependency runs one way only — steps
// import the shell, never the reverse — and no import cycle exists.
import "./cc-step-profile.js";
import "./cc-step-attributes.js";

/** Is the world set up to create characters? */
export function openable() {
  const seed = game.actors?.get(CC.BLANK_PC_ID) ?? null;
  if (!seed) return { ok: false, reason: "missing_seed",
    message: `Blank PC seed "${CC.BLANK_PC_NAME}" (${CC.BLANK_PC_ID}) is not in this world.` };
  return { ok: true };
}

function open(opts = {}) {
  const gate = openable();
  if (!gate.ok) {
    warn(gate.message);
    ui.notifications?.error(`Cannot create a character: ${gate.message}`);
    return null;
  }
  app.open(opts);
  return app;
}

function registerApi() {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.characterCreation = {
    open,
    close: () => app.close(),
    openable,
    get draft() { return app.draft; },
    previewFolder,
    folderNameFor,
  };
}

Hooks.once("init", registerApi);
Hooks.once("ready", () => { installNet(); log("ready"); });
