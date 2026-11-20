"use strict";
// ============================================================================
// Nox Legion (Sealed Cavern, Map010) action animations, 2026-11-20. Approved mockup (all 24 moves, v8):
// claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU. Merged into _build-dungeon-animations.js's REGISTRY
// (actorId -> { actorName, items: { "<item name>": () => { script, timing, preload } } }).
// One signatures file per monster group: each exports ITEMS = { "<item name>": generator } (a generator may
// carry .optional = true when the item can be under another name: Gravis / Gravis Alta, Revive / Resurrection).
// ============================================================================
const { ACTORS } = require("./nox-assets.js");
const load = (f) => { try { return require(f); } catch (e) { if (e.code === "MODULE_NOT_FOUND" && String(e.message).includes(f.replace("./", ""))) return null; throw e; } };
const GROUPS = [
  ["ghoul", "Nox Ghoul", "./nox-ghoul-hound-signatures.js", "GHOUL_ITEMS"],
  ["hound", "Nox Hound", "./nox-ghoul-hound-signatures.js", "HOUND_ITEMS"],
  ["priest", "Nox Priest", "./nox-priest-signatures.js", "PRIEST_ITEMS"],
  ["wraith", "Nox Wraith", "./nox-wraith-viper-signatures.js", "WRAITH_ITEMS"],
  ["viper", "Nox Viper", "./nox-wraith-viper-signatures.js", "VIPER_ITEMS"],
  ["executioner", "Nox Executioner", "./nox-executioner-signatures.js", "EXECUTIONER_ITEMS"],
];
const NOX_REGISTRY = {};
for (const [k, actorName, file, exp] of GROUPS) { const m = load(file); if (!m || !m[exp]) continue; NOX_REGISTRY[ACTORS[k]] = { actorName, items: m[exp] }; }
module.exports = { NOX_REGISTRY };
