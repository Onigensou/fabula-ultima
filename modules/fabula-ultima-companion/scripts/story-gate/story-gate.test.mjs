// Tests for the Story Gate's planning. No game required.
//
// What this cannot check: the config fields, real document writes, walls
// actually stopping a token, or anything seen from a player client.
//
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};

const hooks = {};
globalThis.Hooks = {
  on: (name, fn) => { (hooks[name] ??= []).push(fn); },
  once: (name, fn) => { (hooks[name] ??= []).push(fn); }
};
globalThis.game = { ready: true, scenes: [] };
globalThis.FUCompanion = { isPrimaryGM: () => true };
const switches = {};
globalThis.oni = { GameState: { getSwitch: (n) => switches[n] === true } };
vm.runInThisContext(readFileSync(resolve(HERE, "story-gate.js"), "utf8"), { filename: "story-gate.js" });
const SG = globalThis.oni.StoryGate;

const MOD = "fabula-ultima-companion";
const gated = (id, name, rest = {}) => ({ id, flags: { [MOD]: { storyGate: { openedBy: name } } }, ...rest });
const on = () => true, off = () => false;

// ── isClosed ─────────────────────────────────────────────────────────────────
check("blank name is not a gate", SG.isClosed("") === false && SG.isClosed("  ") === false && SG.isClosed(null) === false);
check("a switch nobody has set is closed", SG.isClosed("Great Seal Open") === true);
switches["Great Seal Open"] = true;
check("switch ON opens", SG.isClosed("Great Seal Open") === false);
check("name is trimmed", SG.isClosed("  Great Seal Open ") === false);
delete switches["Great Seal Open"];

const saved = globalThis.oni.GameState;
delete globalThis.oni.GameState;
check("no game state yet: stays closed", SG.isClosed("Great Seal Open") === true);
globalThis.oni.GameState = saved;

// ── planScene ────────────────────────────────────────────────────────────────
const scene = (over = {}) => ({
  tiles: [gated("glyph", "S", { hidden: false }), { id: "plain", hidden: false, flags: {} }],
  walls: [gated("wall", "S", { move: 20 }), { id: "stone", move: 20, flags: {} }],
  ...over
});

let p = SG.planScene(scene(), off);
check("closed and already shown: no writes", p.tiles.length === 0 && p.walls.length === 0);

p = SG.planScene(scene(), on);
check("ON hides the tile", p.tiles.length === 1 && p.tiles[0]._id === "glyph" && p.tiles[0].hidden === true);
check("ON opens the wall", p.walls.length === 1 && p.walls[0]._id === "wall" && p.walls[0].move === 0);
check("ungated documents are left alone", !p.tiles.some(t => t._id === "plain") && !p.walls.some(w => w._id === "stone"));

p = SG.planScene(scene({ tiles: [gated("glyph", "S", { hidden: true })], walls: [gated("wall", "S", { move: 0 })] }), off);
check("OFF again restores tile and wall", p.tiles[0]?.hidden === false && p.walls[0]?.move === 20);

p = SG.planScene(scene({ tiles: [gated("glyph", "S", { hidden: true })], walls: [gated("wall", "S", { move: 0 })] }), on);
check("already open: no writes", p.tiles.length === 0 && p.walls.length === 0);

p = SG.planScene(scene({ tiles: [gated("a", "A", { hidden: false }), gated("b", "B", { hidden: false })], walls: [] }), (n) => n === "A");
check("each document follows its own switch", p.tiles.length === 1 && p.tiles[0]._id === "a");

p = SG.planScene({}, on);
check("a scene with nothing gated is fine", p.tiles.length === 0 && p.walls.length === 0);

// ── reconcile ────────────────────────────────────────────────────────────────
const writes = [];
const live = {
  ...scene(),
  updateEmbeddedDocuments: async (type, rows) => { writes.push([type, rows.length]); }
};
globalThis.game.scenes = [live];

await SG.reconcile();
check("reconcile with the switch off writes nothing", writes.length === 0);

switches.S = true;
await SG.reconcile();
check("reconcile with the switch on writes both", writes.length === 2 && writes[0][0] === "Tile" && writes[1][0] === "Wall");

writes.length = 0;
globalThis.FUCompanion.isPrimaryGM = () => false;
await SG.reconcile();
check("only the primary GM writes", writes.length === 0);
globalThis.FUCompanion.isPrimaryGM = () => true;

check("switch changes, load and arrival all trigger it",
  !!hooks.oniGameStateChanged?.length && !!hooks.canvasReady?.length && !!hooks.ready?.length);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
