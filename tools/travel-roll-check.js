#!/usr/bin/env node
// ============================================================================
// Offline check — world-map Travel tiles (FU Core p.106–108)
// ----------------------------------------------------------------------------
//   node tools/travel-roll-check.js
//
// Loads the classic scripts travel-roll-api.js and dp-travel.js under just
// enough Foundry stubs, then asserts:
//   - every face of every threat die maps to the rulebook outcome
//     (1 discovery, 2–5 safe, 6+ danger) and the per-die rates that follow;
//   - a Travel tile's own threat overrides the scene's, an unknown one does not;
//   - danger damage follows the p.108 table by party level and threat tier;
//   - the timed-out danger auto-pick splits Battle 75 / Hazard 25.
// ============================================================================

const path = require("path");
const fs   = require("fs");
const vm   = require("vm");

const REPO = path.resolve(__dirname, "..");
const MOD  = "fabula-ultima-companion";
const SCRIPTS = [
  "modules/fabula-ultima-companion/scripts/travel-roll/travel-roll-api.js",
  "modules/fabula-ultima-companion/scripts/dungeon-pathing-system/dp-regions.js",
  "modules/fabula-ultima-companion/scripts/dungeon-pathing-system/dp-travel.js",
];

// ── Foundry stubs ──────────────────────────────────────────────────────────
globalThis.DungeonPathing = { MODULE_ID: MOD, PATHING_ROOT_KEY: "dungeonPathing" };
globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.ui    = { notifications: { warn() {}, error() {}, info() {} } };
globalThis.foundry = { utils: { escapeHTML: s => s, deepClone: o => JSON.parse(JSON.stringify(o)) } };
for (const rel of SCRIPTS) vm.runInThisContext(fs.readFileSync(path.join(REPO, rel), "utf8"), { filename: rel });

const TR = globalThis.TravelRoll;
const T  = globalThis.DungeonPathing.Travel;
const I  = T._internals;

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${msg}`); if (!ok) failures++; };

// ── 1. Outcome bands for every die ─────────────────────────────────────────
console.log("Outcome bands (vanilla, no Treasure Hunter):");
const EXPECT = { minimal: 6, low: 8, medium: 10, high: 12, very_high: 20 };
for (const [level, faces] of Object.entries(EXPECT)) {
  const f = TR.getDieFormula(level);
  check(f === `1d${faces}`, `${level} rolls ${f}`);
  let danger = 0, discovery = 0, wrong = 0;
  for (let n = 1; n <= faces; n++) {
    const o = TR.getOutcome(n);
    const want = n === 1 ? "discovery" : n >= 6 ? "danger" : "safe";
    if (o !== want) wrong++;
    if (o === "danger") danger++;
    if (o === "discovery") discovery++;
  }
  check(wrong === 0, `${level}: every face maps to the rulebook band`);
  console.log(`         danger ${(100 * danger / faces).toFixed(1)}% · discovery ${(100 * discovery / faces).toFixed(1)}%`);
}
check(TR.getOutcome(1) === "discovery" && TR.getOutcome(2, 3) === "discovery" && TR.getOutcome(4, 3) === "safe",
      "Treasure Hunter SL2 widens discovery to ≤3 only");

// ── 2. Tile threat overrides scene threat ──────────────────────────────────
console.log("Threat resolution:");
const scene = (lvl) => ({ flags: { [MOD]: { oniDungeon: lvl ? { threatLevel: lvl } : {} } } });
const tile  = (lvl) => ({ flags: { [MOD]: { dungeonPathing: lvl ? { travelThreat: lvl } : {} } } });
check(T.threatFor(tile("high"), scene("low")) === "high",       "tile High beats scene Low");
check(T.threatFor(tile(""), scene("low")) === "low",            "blank tile uses scene Low");
check(T.threatFor(tile("bogus"), scene("low")) === "low",       "unknown tile value falls back to scene");
check(T.threatFor(tile(""), scene(null)) === "medium",          "nothing set → Medium (TravelRoll default)");

// ── 3. Danger damage table (Core p.108) ────────────────────────────────────
console.log("Danger damage:");
const D = [
  [41, "low", 30], [41, "medium", 50], [41, "high", 50], [41, "very_high", 80],
  [20, "minimal", 20], [25, "very_high", 60], [10, "high", 30], [3, "very_high", 40],
];
for (const [lv, threat, want] of D) {
  const got = I.damageFor(threat, lv);
  check(got === want, `party L${lv}, ${threat} → ${got} (want ${want})`);
}
check(I.THREAT_DL.high === 13 && I.THREAT_DL.very_high === 16 && I.THREAT_DL.low === 10, "DL 10 / 13 / 16 by threat");

// ── 4. Auto-pick split ─────────────────────────────────────────────────────
console.log("Danger auto-pick (20000 draws):");
const N = 20000, tally = { battle: 0, hazard: 0 };
for (let i = 0; i < N; i++) tally[I.weightedPick(I.DANGER_WEIGHTS)]++;
const battlePct = 100 * tally.battle / N;
console.log(`         battle ${battlePct.toFixed(1)}% · hazard ${(100 - battlePct).toFixed(1)}%`);
check(Math.abs(battlePct - 75) < 1.5, "Battle 75 / Hazard 25 within ±1.5pp");

// ── 5. Fabula Areas (painted Regions) ──────────────────────────────────────
console.log("Fabula Areas:");
const A = globalThis.DungeonPathing.Areas;
const behavior = (system) => ({ type: A.TYPE, disabled: false, system });
const area = (name, shapes, system) => ({ name, shapes, behaviors: [behavior(system)] });
const forest  = area("Whisperwood", [{ type: "rectangle", x: 0, y: 0, width: 1000, height: 1000, rotation: 0 }],
                     { threat: "high", encounterTable: "RollTable.forest", loot: { treasure: "RollTable.forestLoot" } });
const village = area("Relde", [{ type: "circle", x: 500, y: 500, radius: 100 }], { threat: "minimal", battleMap: "Scene.relde" });
const donut   = area("Lake Ring", [{ type: "circle", x: 2000, y: 2000, radius: 300 },
                                   { type: "circle", x: 2000, y: 2000, radius: 100, hole: true }], { threat: "medium" });
const tri     = area("Peak", [{ type: "polygon", points: [3000, 0, 3400, 0, 3200, 400] }], { threat: "very_high" });
const tilted  = area("Ridge", [{ type: "rectangle", x: 5000, y: 0, width: 400, height: 40, rotation: 90 }], { threat: "low" });
const off     = { name: "Disabled", shapes: [{ type: "rectangle", x: 0, y: 0, width: 9999, height: 9999 }],
                  behaviors: [{ type: A.TYPE, disabled: true, system: { threat: "very_high" } }] };
const mapScene = { regions: [forest, village, donut, tri, tilted, off],
                   flags: { [MOD]: { oniDungeon: { threatLevel: "low", encounterTable: "RollTable.scene",
                                                   battleMap: "Scene.sceneMap", loot: { treasure: "RollTable.sceneLoot", zenit: "RollTable.zenit" } } } } };
const at = (x, y) => A.areaAt(mapScene, { point: { x, y } })?.region?.name ?? null;
check(at(100, 100) === "Whisperwood",  "point in the forest → Whisperwood");
check(at(500, 520) === "Relde",        "village inside the forest → smallest area wins (Relde)");
check(at(2000, 2000) === null,         "centre of the lake ring is a hole → no area");
check(at(2250, 2000) === "Lake Ring",  "on the ring → Lake Ring");
check(at(3200, 100) === "Peak" && at(3010, 390) === null, "polygon inside / outside");
check(at(5200, 150) === "Ridge" && at(5390, 20) === null, "90° rotated rectangle (rotates about its centre)");
check(at(8000, 8000) === null,         "disabled behavior is ignored");

const base = mapScene.flags[MOD].oniDungeon;
const o = A.overlay(mapScene, base, { tile: { x: 90, y: 90, width: 20, height: 20 } });   // centre (100,100)
check(o.encounterTable === "RollTable.forest" && o.battleMap === "Scene.sceneMap", "overlay replaces set fields, inherits blank ones");
check(o.loot.treasure === "RollTable.forestLoot" && o.loot.zenit === "RollTable.zenit", "loot merges per key");
check(o.areaName === "Whisperwood" && base.encounterTable === "RollTable.scene", "areaName added; scene config not mutated");
check(A.overlay(mapScene, base, { point: { x: 9000, y: 50 } }) === base, "outside every area → scene config untouched");

const wtile = (x, y, threat) => ({ x: x - 10, y: y - 10, width: 20, height: 20,
                                   flags: { [MOD]: { dungeonPathing: threat ? { travelThreat: threat } : {} } } });
check(T.threatFor(wtile(100, 100), mapScene) === "high",          "threat: area High beats scene Low");
check(T.threatFor(wtile(100, 100, "minimal"), mapScene) === "minimal", "threat: tile's own beats the area");
check(T.threatFor(wtile(9000, 50), mapScene) === "low",           "threat: no area → scene");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
