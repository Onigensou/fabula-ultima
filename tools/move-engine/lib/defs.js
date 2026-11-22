"use strict";
// Read a family's move definitions in Node (their tune sliders and defaults) without the engine: the move files only call
// def(...) / T / TO at load, so they run on shared/moves.js plus stubs for the host roles a family head reads.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function loadDefs(family, files) {
  const src = [rd(path.join(ROOT, "shared", "moves.js")), ...files.map((f) => rd(path.join(ROOT, "moves", family, f + ".js")))].join("\n");
  const stubs = "const SK = {}; const moveTarget = () => null, moveCaster = () => null, moveResult = () => null, moveStrikes = () => [], movePick = () => null, moveVariant = () => null;\n";
  // eslint-disable-next-line no-new-func
  return new Function(stubs + src + "\nreturn SK;")();
}
// a move's slider values: its defaults (= the approved values), with overrides on top
function tuneOf(SK, key, overrides = {}) {
  const s = SK[key]; if (!s) throw new Error("no move " + key);
  const T = {}; for (const t of s.tune || []) T[t.k] = t.v; return Object.assign(T, overrides);
}
module.exports = { loadDefs, tuneOf };
