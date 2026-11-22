"use strict";
// move-engine · what a MOCKUP page's assemble.js reads instead of its own vendor/ copy.
//
//   const ME = require("<repo>/tools/move-engine/build/mockup-parts.js");
//   const js = [ME.engine(), ME.common(), <part-hud>, ME.fxMelee(), ME.moves(), ME.family("sonic-katar", "head"), <page part>,
//               ME.family("sonic-katar", "gunblade"), <part-ui>].join("\n");
//   const css = ME.css(["hud", "dn", "hpbar", "namecard"]);  head = ME.pageHead();  window.HPBAR_T = ME.hpbarTiming()
//
// The page sets its stage BEFORE the engine runs (window.STAGE_PRESET, window.ACTORS, window.MOVE_ROLES, optional
// window.MOVE_SEED), instead of regex-patching the engine source like the Lionheart / Sonic Katar assemble scripts did.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// shared core + the mockup host engine + the shared fx core, in load order
const engine = () => [rd("shared/core.js"), rd("mockup/engine.js"), rd("shared/fx-core.js")].join("\n");
const common = () => rd("shared/common.js");
const fxMelee = () => rd("shared/fx-melee.js");
// the move framework (def / T / TO) + the shared results (moveCheck / moveChain / the dice rule)
const moves = () => [rd("shared/moves.js"), rd("shared/results.js")].join("\n");
// the shared result picker (page UI): mountResultPicker(el) after the page UI is built
const resultPicker = () => rd("mockup/result-picker.js");
// a family's host-neutral move files (tools/move-engine/moves/<family>/<file>.js)
const family = (fam, file) => rd("moves/" + fam + "/" + file + ".js");
const css = (names) => names.map((n) => rd("mockup/vendor/" + n + ".css")).join("\n");
const pageHead = () => rd("mockup/vendor/page-head.nx.html");
const hpbarTiming = () => rd("mockup/vendor/hpbar.json");
// <script> preamble that sets the stage for the engine. roles = JS source for window.MOVE_ROLES (who acts on the page:
// "{ caster: () => ACT[WIELD], target: () => ACT.orc }"); the game gives a move the action's caster / targets instead.
function stageScript({ preset = null, actors = null, seed = null, roles = null } = {}) {
  const out = [];
  if (preset) out.push("window.STAGE_PRESET = " + JSON.stringify(preset) + ";");
  if (actors) out.push("window.ACTORS = " + JSON.stringify(actors) + ";");
  if (roles) out.push("window.MOVE_ROLES = " + roles + ";");
  if (seed != null) out.push("window.MOVE_SEED = " + JSON.stringify(seed) + ";");
  return out.join("\n");
}

// the stages the existing mockups used
const PRESETS = {
  valley001: { horizon: 52.0, strength: .386 },   // Valley_Battlemap001 (Lionheart, Sonic Katar)
  valley004: { horizon: 58.6, strength: .374 },   // Valley_Battlemap004 (engine default)
};
const PARTY_LINE = {
  hina: { cx: 1202, cy: 162, sc: 1.54, kind: "party" }, zarg: { cx: 1257, cy: 272, sc: 1.56, kind: "party" },
  keren: { cx: 1312, cy: 382, sc: 1.47, kind: "party" }, blanche: { cx: 1367, cy: 492, sc: 1.55, kind: "party" },
};

module.exports = { ROOT, engine, common, fxMelee, moves, resultPicker, family, css, pageHead, hpbarTiming, stageScript, PRESETS, PARTY_LINE };
