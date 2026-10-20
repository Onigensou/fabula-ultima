"use strict";
//
// Mindscape — which conflict event a dungeon's random encounters are fought under.
//
// A random encounter is not fought "in the dungeon": the Random Battle tile on an
// exploration floor launches it on THAT floor's configured battle map
// (dp-random-battle.js, `oniDungeon.battleMap`), and the battle map carries the
// conflict event (`oniFabula.general.conflictEvent`). The Valley of the Dragon has two:
// its surface floors fight on Valley_Battlemap001 (Lightning Storm), its caves on
// Valley_Battlemap002/003 (Lightning Crystal).
//
// So an Encounter table's rows meet each event in proportion to where the party can
// actually roll them — the number of Random Battle tiles on the floors that use the
// table. A floor with no tiles never starts a random fight, however large it is.
//
// Read from a COPY of the world (scenes collection), like everything else here.

const { withCollection } = require("../../safe-edit/lib/db");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");

const NS = "fabula-ultima-companion";
const SCENE_KEY = /^!scenes!([^!.]+)$/;
const TILE_KEY = /^!scenes\.tiles!([^!.]+)\.([^!.]+)$/;

function findKey(o, k, depth = 0) {
  if (!o || typeof o !== "object" || depth > 6) return undefined;
  if (k in o) return o[k];
  for (const v of Object.values(o)) {
    const r = findKey(v, k, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
const idOf = (ref) => String(ref ?? "").trim().replace(/^(Scene|RollTable)\./, "");

function isRandomBattleTile(t) {
  return /random.?battle/i.test(JSON.stringify(t?.flags ?? {}));
}

// encounterTableId -> [{ event: "lightning-storm" | null, tiles, floors: [name], battleMap }]
async function loadDungeonEvents({ world = DEFAULT_WORLD } = {}) {
  return withCollection("scenes", world, async (db) => {
    const scenes = new Map();
    const tiles = new Map();
    for await (const [k, v] of db.iterator()) {
      let m;
      if ((m = SCENE_KEY.exec(k))) scenes.set(m[1], v);
      else if ((m = TILE_KEY.exec(k)) && isRandomBattleTile(v)) tiles.set(m[1], (tiles.get(m[1]) ?? 0) + 1);
    }
    const out = new Map();
    for (const [id, s] of scenes) {
      const dun = s.flags?.[NS]?.oniDungeon ?? s.flags?.world?.oniDungeon ?? s.flags?.oniDungeon;
      const table = idOf(dun?.encounterTable);
      if (!table || !dun?.battleMap) continue;
      const map = scenes.get(idOf(dun.battleMap));
      const event = String(findKey(map?.flags, "conflictEvent") ?? "").trim() || null;
      const list = out.get(table) ?? [];
      let e = list.find((x) => x.event === event);
      if (!e) { e = { event, tiles: 0, floors: [], battleMaps: [] }; list.push(e); }
      e.tiles += tiles.get(id) ?? 0;
      e.floors.push(s.name);
      if (map?.name && !e.battleMaps.includes(map.name)) e.battleMaps.push(map.name);
      out.set(table, list);
    }
    return out;
  });
}

// The event mix for one table: shares by Random Battle tile count; a table whose
// floors carry no tiles yet falls back to an even split over its events.
function eventMix(list) {
  if (!list?.length) return [{ event: null, share: 1, tiles: 0, floors: [], battleMaps: [] }];
  const total = list.reduce((t, e) => t + e.tiles, 0);
  return list.map((e) => ({ ...e, share: total ? e.tiles / total : 1 / list.length })).filter((e) => e.share > 0);
}

module.exports = { loadDungeonEvents, eventMix };
