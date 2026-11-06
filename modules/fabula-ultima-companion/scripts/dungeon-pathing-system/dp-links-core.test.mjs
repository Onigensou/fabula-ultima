// Tests for the dungeon links core: drawing → link migration, edges, map checks.
// No game required.
//
// What this cannot check: the PIXI link layer, fog fades, real scene updates,
// or anything seen from a player client.
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
vm.runInThisContext(readFileSync(resolve(HERE, "dp-links-core.js"), "utf8"), { filename: "dp-links-core.js" });
const L = globalThis.DungeonPathing.LinksCore;
const MOD = "fabula-ultima-companion";

// Tiles are 27×27 like the real dungeon tiles; grid 60 → snap radius 80.
const tile = (id, x, y, extra = {}) => ({ id, x: x - 13.5, y: y - 13.5, width: 27, height: 27, ...extra });
const line = (id, pts, extra = {}) => ({ id, x: pts[0][0], y: pts[0][1], shape: { points: pts.flatMap(([x, y]) => [x - pts[0][0], y - pts[0][1]]) }, ...extra });
const tiles = [tile("A", 100, 100), tile("B", 300, 100), tile("C", 300, 300), tile("D", 100, 300), tile("H", 500, 500, { hidden: true })];
const drawings = [
  line("ab", [[116, 100], [284, 100]], { flags: { [MOD]: { pathKind: "main" } } }),          // straight, stops at tile edges like the real lines
  line("bc", [[300, 116], [340, 200], [300, 284]], { flags: { [MOD]: { pathKind: "side" } } }), // bent line → via point
  line("cd", [[284, 300], [116, 300]], { hidden: true }),                                    // hidden drawing → link switched off
  line("ab2", [[118, 104], [282, 104]]),                                                     // second line on the same pair
  line("deco", [[600, 600], [700, 650]]),                                                    // decoration, no tiles near
  line("dot", [[100, 100], [104, 104]]),                                                     // too short
  { id: "box", x: 0, y: 0, shape: { type: "r", points: [] } },                               // a rectangle, not a line
  line("da", [[100, 284], [100, 116]], { flags: { [MOD]: { dungeonPathing: { requiresSwitch: "Gate Open" } } } }),
];

const r = L.migrateDrawings({ tiles, drawings, gridSize: 60 });
check("straight line becomes a main link", r.links.ab?.a === "A" && r.links.ab?.b === "B" && r.links.ab.route === "main" && r.links.ab.via.length === 0);
check("bent line keeps its bend point", r.links.bc?.route === "side" && JSON.stringify(r.links.bc.via) === "[[340,200]]");
check("hidden drawing becomes a switched-off link", r.links.cd?.off === true);
check("world-map switch lock carries over", r.links.da?.requiresSwitch === "Gate Open");
check("duplicate line on the same pair is merged", !r.links.ab2 && r.duplicates.some(d => d.id === "ab2" && d.of === "ab") && r.migrated.includes("ab2"));
check("decoration, short marks and shapes are kept, not migrated",
  ["deco", "dot", "box"].every(id => r.kept.some(k => k.id === id) && !r.migrated.includes(id)));
check("link ids are the drawing ids (fog keeps working)", Object.keys(r.links).sort().join(",") === "ab,bc,cd,da");

// The whole point: the walkable graph must not change.
const nodeIds = tiles.filter(t => !t.hidden).map(t => t.id);
const before = L.legacyEdges({ tiles, drawings, gridSize: 60 });
const after = L.edgesFromLinks(r.links, nodeIds);
const cmp = L.sameNeighbours(before, after);
check("same neighbours before and after migration (switch OFF)", cmp.same, JSON.stringify(cmp.diffs));
check("locked route is not an edge while its switch is OFF", !after.some(e => e.linkId === "da"));
const afterOn = L.edgesFromLinks(r.links, nodeIds, { switchOn: n => n === "Gate Open" });
check("locked route becomes an edge when its switch is ON", afterOn.some(e => e.linkId === "da"));
check("switched-off link is never an edge", !afterOn.some(e => e.linkId === "cd"));
check("edges keep the drawingId field for old consumers", after.every(e => e.drawingId === e.linkId));
check("links to a tile that is gone are dropped", L.edgesFromLinks({ x: { a: "A", b: "GONE" } }, nodeIds).length === 0);

// Map checks
const links = {
  l1: { a: "A", b: "B" }, l2: { a: "B", b: "C" },
  l3: { a: "C", b: "D", oneWay: true },  // C → D only: D is a trap
};
const mc = L.mapCheck({ tileIds: ["A", "B", "C", "D", "E"], links, start: "A" });
check("unreachable tile is reported", JSON.stringify(mc.unreachable) === '["E"]');
check("one-way dead end is reported as a trap", JSON.stringify(mc.traps) === '["D"]');
const mc2 = L.mapCheck({ tileIds: ["A", "B", "C", "D"], links: { ...links, l4: { a: "D", b: "A" } }, start: "A" });
check("a way back clears the trap", mc2.traps.length === 0 && mc2.unreachable.length === 0);

// ── Phase C: in-play rules ───────────────────────────────────────────────────
const P = {
  gate:  { a: "A", b: "B", lock: { type: "key", item: "Rusty Key" } },
  ward:  { a: "B", b: "C", lock: { type: "switch", name: "Ward" } },
  rock:  { a: "C", b: "D", lock: { type: "check", attrA: "MIG", attrB: "DEX", dl: 10 } },
  ledge: { a: "D", b: "A", oneWay: true },
  crev:  { a: "A", b: "C", hidden: { by: "adjacent" } },
  rope:  { a: "B", b: "D", hidden: { by: "event" } },
  crumb: { a: "D", b: "E", collapse: true },
};
const ids4 = ["A", "B", "C", "D", "E"];
const ed = (st = {}, sw = () => false) => L.edgesFromLinks(P, ids4, { state: st, switchOn: sw }).map(e => e.linkId).sort().join(",");
check("locked and one-way links stay in the graph; hidden ones do not", ed() === "crumb,gate,ledge,rock,ward");
check("a found hidden path joins the graph", ed({ revealed: { crev: true, rope: true } }) === "crev,crumb,gate,ledge,rock,rope,ward");
check("a broken bridge leaves the graph", !ed({ broken: { crumb: true } }).includes("crumb"));
const rule = (id, from, st = {}, sw = () => false) => L.stepRule(id, P[id], from, { state: st, switchOn: sw });
check("key gate blocks until unlocked", rule("gate", "A").reason === "key" && rule("gate", "A", { unlocked: { gate: true } }).ok);
check("ward blocks until its switch is ON", rule("ward", "B").reason === "switch" && rule("ward", "B", {}, n => n === "Ward").ok);
check("skill-check rock blocks until passed", rule("rock", "C").reason === "check" && rule("rock", "C", { unlocked: { rock: true } }).ok);
check("one-way: allowed a → b, refused b → a", rule("ledge", "D").ok && rule("ledge", "A").reason === "oneway");
check("plain link always passes", rule("crumb", "D").ok && rule("crumb", "E").ok);
check("linkBetween ignores links that are not there yet", L.linkBetween(P, "A", "C") === null && L.linkBetween(P, "A", "C", { revealed: { crev: true } })?.id === "crev");
check("landing at either end reveals a hidden-until-landing path", JSON.stringify(L.toRevealOnLanding(P, "C")) === '["crev"]' && L.toRevealOnLanding(P, "C", { revealed: { crev: true } }).length === 0);
check("event-hidden paths are not revealed by landing", L.toRevealOnLanding(P, "D").length === 0);
const evs = [{ id: "e1", when: { type: "land", arg: "D" }, then: [{ type: "connect", arg: "rope" }] }, { id: "e2", when: { type: "switch", arg: "Ward" }, then: [] }];
check("land event fires once", L.eventsFor(evs, "land", "D").length === 1 && L.eventsFor(evs, "land", "D", { events: { e1: true } }).length === 0);
check("event conditions are honoured", L.eventsFor(evs, "land", "D", {}, () => false).length === 0);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
