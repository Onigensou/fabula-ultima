// Dungeon links — migration DRY RUN on a copy of the world's scenes database.
//
// Reads every scene, converts its Drawing lines to links with the same rules
// the game uses (dp-links-core.js), and proves each map's walkable graph is
// unchanged. Writes nothing. Never point it at the live world while Foundry
// or safe-edit has it open: copy the folder first (the LevelDB LOCK is
// exclusive).
//
//   cp -r worlds/fabula-ultima-2/data/scenes /tmp/scenes-copy && rm /tmp/scenes-copy/LOCK
//   node tools/dungeon-links/migration-report.mjs /tmp/scenes-copy [--json out.json]
//
// Scope: dungeon-mode scenes, plus the legacy dungeons listed in LEGACY_DUNGEONS
// (old "cameraFollowToken" scenes that are dungeons; the migration also sets
// their scene mode to Dungeon).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const require = createRequire(resolve(ROOT, "tools/safe-edit/package.json"));
const { ClassicLevel } = require("classic-level");
vm.runInThisContext(readFileSync(resolve(ROOT, "modules/fabula-ultima-companion/scripts/dungeon-pathing-system/dp-links-core.js"), "utf8"));
const L = globalThis.DungeonPathing.LinksCore;
const MOD = "fabula-ultima-companion";
export const LEGACY_DUNGEONS = ["Vastwind_Field001", "Vastwind_Field002"];

const dir = process.argv[2];
if (!dir) { console.error("usage: migration-report.mjs <scenes-db-copy> [--json out.json]"); process.exit(2); }
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

const db = new ClassicLevel(dir, { valueEncoding: "json", keyEncoding: "utf8" });
await db.open();
const scenes = {}, tiles = {}, drawings = {};
for await (const [k, v] of db.iterator()) {
  if (k.startsWith("!scenes!")) scenes[v._id] = v;
  else if (k.startsWith("!scenes.tiles!")) (tiles[k.split("!")[2].split(".")[0]] ??= []).push({ ...v, id: v._id });
  else if (k.startsWith("!scenes.drawings!")) (drawings[k.split("!")[2].split(".")[0]] ??= []).push({ ...v, id: v._id });
}
await db.close();

const out = []; let bad = 0, totLinks = 0, totDel = 0;
for (const [id, s] of Object.entries(scenes)) {
  const mode = s.flags?.[MOD]?.oniFabula?.general?.sceneMode ?? "";
  const legacy = LEGACY_DUNGEONS.includes(s.name);
  if (mode !== "dungeon" && !legacy) continue;
  const already = !!s.flags?.[MOD]?.dungeonPathing?.linksVersion;
  const T = tiles[id] ?? [], D = drawings[id] ?? [];
  const r = L.migrateDrawings({ tiles: T, drawings: D, gridSize: s.grid?.size });
  const nodeIds = T.filter(t => !t.hidden).map(t => t.id);
  const cmp = L.sameNeighbours(L.legacyEdges({ tiles: T, drawings: D, gridSize: s.grid?.size }), L.edgesFromLinks(r.links, nodeIds));
  if (!cmp.same) bad++;
  const nLinks = Object.keys(r.links).length; totLinks += nLinks; totDel += r.migrated.length;
  const off = Object.values(r.links).filter(l => l.off).length, bent = Object.values(r.links).filter(l => l.via.length).length;
  out.push({ scene: s.name, id, mode: mode || "(legacy)", already, tiles: T.length, drawings: D.length, links: nLinks, off, bent,
    duplicates: r.duplicates.length, kept: r.kept, sameGraph: cmp.same, diffs: cmp.diffs, setDungeonMode: legacy && mode !== "dungeon" });
}
out.sort((a, b) => a.scene.localeCompare(b.scene));
for (const o of out) console.log(`${o.sameGraph ? "OK  " : "DIFF"} ${o.scene.padEnd(24)} ${o.mode.padEnd(9)} tiles ${String(o.tiles).padStart(3)}  drawings ${String(o.drawings).padStart(3)} → links ${String(o.links).padStart(3)}  off ${o.off}  bent ${String(o.bent).padStart(2)}  dup ${o.duplicates}  kept ${o.kept.length}${o.setDungeonMode ? "  + set mode Dungeon" : ""}${o.already ? "  (already migrated)" : ""}`);
console.log(`\n${out.length} scenes · ${totLinks} links · ${totDel} drawings to delete · ${bad ? bad + " scene(s) with a CHANGED graph" : "every graph unchanged"}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
process.exit(bad ? 1 : 0);
