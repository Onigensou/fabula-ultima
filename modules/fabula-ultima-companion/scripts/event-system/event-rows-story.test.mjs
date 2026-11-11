// Tests for the story actions' plain helpers. No game required.
// What this cannot check: a real fight, a scene change, a token walk or the
// name panel on a client — those are sandbox checks.
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) fail++; };

const registered = [];
globalThis.window = globalThis;
globalThis.Hooks = { on: () => 0, once: () => 0, off: () => 0 };
window.oni = { EventSystem: {
  Logic: { toNumber: (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : d) },
  EventRegistry: { register: (d) => registered.push(d) },
  Client: { register: () => {}, run: () => {}, setMarker: () => {}, addCleanup: () => {}, removeCleanup: () => {} }
} };
vm.runInThisContext(readFileSync(resolve(HERE, "event-rows-story.js"), "utf8"), { filename: "event-rows-story.js" });
const S = window.oni.EventSystem.RowsStory;

check("registers the seven actions", ["startBattle", "changeScene", "moveToken", "nameInput", "recoverAll", "loop", "breakLoop"].every(t => registered.some(d => d.type === t)));

const e = S.parseEnemyList("Ape, Wolf x2");
check("enemy list: names and counts", JSON.stringify(e) === JSON.stringify([{ name: "Ape", quantity: 1 }, { name: "Wolf", quantity: 2 }]));
check("enemy list: × and repeats add up", JSON.stringify(S.parseEnemyList("Voidog ×2, Voidog")) === JSON.stringify([{ name: "Voidog", quantity: 3 }]));
check("enemy list: star names and blanks", JSON.stringify(S.parseEnemyList(" , ⭐️ Fafnir ,")) === JSON.stringify([{ name: "⭐️ Fafnir", quantity: 1 }]));
check("enemy list: a name ending in x stays", S.parseEnemyList("Phoenix")[0]?.name === "Phoenix");

const w = S.parseWaypoints("Kid Start; 1030, 900 ;Crowd Spot");
check("waypoints: markers and points", JSON.stringify(w) === JSON.stringify([{ mark: "Kid Start" }, { x: 1030, y: 900 }, { mark: "Crowd Spot" }]));

check("victory runs Victory", S.battleBranch("victory", false).key === "victory" && !S.battleBranch("victory", false).stop);
check("defeat without story loss stops after Defeat", S.battleBranch("defeat", false).key === "defeat" && S.battleBranch("defeat", false).stop);
check("defeat with story loss carries on", S.battleBranch("defeat", true).stop === false);
check("an escape counts as a defeat", S.battleBranch("escaped", true).key === "defeat");

check("loop: a normal pass repeats", S.loopStep({ ok: true }) === "again");
check("loop: Break Loop leaves it", S.loopStep({ ok: true, stop: true, breakLoop: true }) === "break");
check("loop: End Event inside still ends the event", S.loopStep({ ok: true, stop: true }) === "stop");

const battle = registered.find(d => d.type === "startBattle");
const row = { type: "startBattle" }; battle.prepare(row);
check("start battle defaults", row.engagement === "normal" && Array.isArray(row.victoryRows) && Array.isArray(row.defeatRows) && row.storyLoss === false);
check("start battle: no return point by default", row.returnScene === "" && row.returnAt === "");

// "Return to": where the party is put on the return scene
const doorScene = {
  grid: { size: 100 }, width: 2000, height: 1600,
  tiles: { get: (id) => (id === "door1" ? { x: 1000, y: 2800, width: 100, height: 120 } : null) },
  tokens: { contents: [{ name: "Exit Mark", x: 300, y: 400, width: 1, height: 1, actor: null }] },
  flags: {}
};
const rp = (at, sc = doorScene) => JSON.stringify(S.returnPoint(sc, at));
check("return point: x, y", rp("1036, 2860") === JSON.stringify({ x: 1036, y: 2860 }));
check("return point: a door tile's centre", rp("door1") === JSON.stringify({ x: 1050, y: 2860 }));
check("return point: a marker token's centre", rp("Exit Mark") === JSON.stringify({ x: 350, y: 450 }));
check("return point: nothing by that name", S.returnPoint(doorScene, "Nowhere") === null);
check("return point: blank = the scene centre without a spawn point", rp("") === JSON.stringify({ x: 1000, y: 800 }));
check("return point: blank = the spawn point", rp("", { ...doorScene, flags: { "fabula-ultima-companion": { oniFabula: { general: { spawnPoint: { x: 5, y: 6 } } } } } }) === JSON.stringify({ x: 5, y: 6 }));
check("return point: no scene", S.returnPoint(null, "1, 2") === null);
globalThis.DungeonPathing = { UI: { TOKEN_OFFSET: { x: 0, y: -20 } } };
const dungeonScene = { ...doorScene, flags: { "fabula-ultima-companion": { oniFabula: { general: { sceneMode: "dungeon" } } } } };
check("return point: a node on a dungeon map lands with the party token offset, as a walk does", rp("door1", dungeonScene) === JSON.stringify({ x: 1050, y: 2840 }));
check("return point: off a dungeon map, no offset", rp("door1") === JSON.stringify({ x: 1050, y: 2860 }));

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
