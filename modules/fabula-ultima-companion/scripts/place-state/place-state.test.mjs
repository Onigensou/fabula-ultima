// Tests for Place State (multi-state maps). No game required.
//
// What this cannot check: the Scene Config fields, real scene writes, a real
// door / Travel trip, or music actually changing on a client.
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
const switches = {};
globalThis.oni = { GameState: { getSwitch: (n) => switches[n] === true } };
globalThis.FUCompanion = { isPrimaryGM: () => true };
globalThis.game = { ready: true, scenes: [] };
vm.runInThisContext(readFileSync(resolve(HERE, "place-state.js"), "utf8"), { filename: "place-state.js" });
const P = globalThis.oni.Place;

const MOD = "fabula-ultima-companion";
const sc = (id, name, place = null, extra = {}) => ({
  id, name,
  flags: { [MOD]: { ...(place ? { place } : {}), ...(extra.flags ?? {}) } },
  ...extra.doc
});

const village = sc("V", "Ruhig_Village001", { id: "Ruhig Village" });
const ruin    = sc("R", "Ruhig_Village011", { id: "ruhig village ", activeWhen: "Ruhig Destroyed" });
const shop    = sc("S", "Item Shop");
const festival = sc("EF", "Eisendrache Festival", { id: "Eisendrache" });
const burnt    = sc("ED", "Eisendrache Kingdom", { id: "Eisendrache", activeWhen: "Eisendrache Destroyed" });
const scenes = [village, ruin, shop, festival, burnt];
globalThis.game.scenes = scenes;

// ── current state ────────────────────────────────────────────────────────────
check("switch OFF: starting state is current", P.currentSceneFor("R").id === "V");
check("redirect into the old state stays put while OFF", P.redirectId("V") === "V" && P.redirectId("R") === "V");
switches["Ruhig Destroyed"] = true;
check("switch ON: the later state is current", P.currentSceneFor("V").id === "R");
check("doors into the old state land in the current one", P.redirectId("V") === "R" && P.redirectId("R") === "R");
check("place id is trimmed and case-blind", P.samePlace(village, ruin));
check("scene without a place is never redirected", P.redirectId("S") === "S" && !P.isSuperseded(shop));
check("unknown scene id passes through", P.redirectId("nope") === "nope");
check("old state is superseded, current is not", P.isSuperseded(village) && !P.isSuperseded(ruin));
check("places do not leak into each other", P.redirectId("EF") === "EF" && !P.samePlace(village, festival));
switches["Eisendrache Destroyed"] = true;
check("second place follows its own switch", P.redirectId("EF") === "ED");

// ── visited spans states ─────────────────────────────────────────────────────
const visited = new Set(["V"]);
check("a place is visited when any state was", P.anyState(ruin, s => visited.has(s.id)));
check("a lone scene uses its own flag", !P.anyState(shop, s => visited.has(s.id)));

// ── stage ordering (three states) ────────────────────────────────────────────
const a = sc("A", "Town", { id: "T" });
const b = sc("B", "Town Burnt", { id: "T", activeWhen: "Burnt", stage: 1 });
const c = sc("C", "Town Rebuilt", { id: "T", activeWhen: "Rebuilt", stage: 2 });
const on = (...names) => (n) => names.includes(n);
check("three states: none ON → start", P.pickCurrent([a, b, c], on()).id === "A");
check("three states: Burnt → B", P.pickCurrent([a, b, c], on("Burnt")).id === "B");
check("three states: both ON → highest stage", P.pickCurrent([c, b, a], on("Burnt", "Rebuilt")).id === "C");
check("stage defaults: switch state beats start", P.stageOf(ruin) === 1 && P.stageOf(village) === 0);
const g1 = sc("G1", "Gated 1", { id: "G", activeWhen: "X" });
const g2 = sc("G2", "Gated 2", { id: "G", activeWhen: "Y", stage: 2 });
check("all states gated and OFF: lowest stage", P.pickCurrent([g2, g1], on()).id === "G1");
check("one state alone is never redirected", P.currentSceneFor(sc("L", "Lone", { id: "Lone" }), { scenes: [] })?.id === "L");

// ── story BGM ────────────────────────────────────────────────────────────────
const bgmScene = (cur) => ({
  id: "I", flags: { [MOD]: { storyBgm: { when: "Eisendrache Destroyed",
    normalPlaylist: "PL1", normalSound: "City", altPlaylist: "PL2", altSound: "Distress" } } },
  playlist: cur[0], playlistSound: cur[1]
});
check("BGM: ON wants the alternate", JSON.stringify(P.planBgm(bgmScene(["PL1", "City"]), on("Eisendrache Destroyed"))) === JSON.stringify({ playlist: "PL2", playlistSound: "Distress" }));
check("BGM: OFF wants the normal", JSON.stringify(P.planBgm(bgmScene(["PL2", "Distress"]), on())) === JSON.stringify({ playlist: "PL1", playlistSound: "City" }));
check("BGM: already right, no write", P.planBgm(bgmScene(["PL2", "Distress"]), on("Eisendrache Destroyed")) === null);
check("BGM: no switch, scene left alone", P.planBgm({ flags: { [MOD]: { storyBgm: { when: "" } } } }, on()) === null && P.planBgm(shop, on()) === null);
check("BGM: a blank side never clears the music", P.planBgm({ playlist: "X", playlistSound: "Y",
  flags: { [MOD]: { storyBgm: { when: "Z", normalPlaylist: "X", normalSound: "Y" } } } }, on("Z")) === null);

// ── story background ─────────────────────────────────────────────────────────
const bgScene = (src) => ({ background: { src }, flags: { [MOD]: { storyBg: { when: "Eisendrache Destroyed", normal: "Map001.png", alt: "Map_018.png" } } } });
check("BG: ON wants the destroyed art", P.planBg(bgScene("Map001.png"), on("Eisendrache Destroyed")) === "Map_018.png");
check("BG: OFF wants the festival art", P.planBg(bgScene("Map_018.png"), on()) === "Map001.png");
check("BG: already right, no write", P.planBg(bgScene("Map_018.png"), on("Eisendrache Destroyed")) === null);
check("BG: no switch set, left alone", P.planBg({ background: { src: "x" }, flags: { [MOD]: { storyBg: { when: "" } } } }, on()) === null && P.planBg(shop, on()) === null);

// ── reconcile writes ─────────────────────────────────────────────────────────
const writes = [];
const live = { ...bgmScene(["PL1", "City"]), toObject() { return this; }, update: async (u) => { writes.push(u); } };
globalThis.game.scenes = [live];
await P.reconcile();
check("reconcile writes the BGM on the primary GM", writes.length === 1 && writes[0].playlistSound === "Distress");
writes.length = 0;
globalThis.FUCompanion.isPrimaryGM = () => false;
await P.reconcile();
check("only the primary GM writes", writes.length === 0);
check("switch changes, load and arrival all trigger it",
  !!hooks.oniGameStateChanged?.length && !!hooks.canvasReady?.length && !!hooks.ready?.length);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
