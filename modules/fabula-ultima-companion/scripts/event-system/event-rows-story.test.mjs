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

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
