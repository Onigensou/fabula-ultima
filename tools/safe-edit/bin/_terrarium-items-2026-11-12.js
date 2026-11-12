// Terrarium items (user-approved 2026-11-12, mockup v4
// https://claude.ai/artifact/Sg95izKw5SLo32vd2E53wD).
//
// Every item is named "Terrarium: <Tile Type>". The three legacy items keep
// their ids and are renamed; Camp and Random Battle are new (clones of the
// Saferoom doc, the same plain consumable shape). Each carries
// flags["fabula-ultima-companion"].terrarium = "<kind>" so the code never
// depends on the name. Flavour text stays empty (user, 2026-11-12).
//
// Copies found 2026-11-12 (scenes/journal/macros/settings: none):
//   items  : k1ws4o2xY7qXkfaf Terrain Destroyer, GSggw21CziniktM7 Terrain
//            Generator: Saferoom, 535RjElIC0JJRvm6 Terrain Generator: Terrarium
//   actors : St. Reefesia BqBoJEye80GAm9fX — embedded Terrain Destroyer
//            pPcJ4sB3Vjxd1rIA + her consumable_list mirror row
//   tables : Vastwind Field - Consumable fxXT0ZlnFlDYwfgv — result text of
//            Saferoom (guEKIXgXkUpoIsYI) and Terrarium (0yt8SPA5rk3RIcxI)
//
// Run from tools/safe-edit:  node bin/_terrarium-items-2026-11-12.js items|actors|tables [--apply]
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const MOD = "fabula-ultima-companion";
const ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/";
const desc = (tile) =>
  `<ul><li><p>Turn target <strong>adjacent</strong> <strong>tile</strong> into a <strong>${tile}</strong>.</p></li>`
  + `<li><p>Dungeon only. Doesn't use a step or end the turn.</p></li></ul>`;

// kind → target doc
const ITEMS = [
  { id: "k1ws4o2xY7qXkfaf", kind: "blank",         name: "Terrarium: Blank",         tile: "Blank Tile",         cost: "150", rarity: "Common", img: ART + "Blank_Tile.png" },
  { id: "GSggw21CziniktM7", kind: "healing",       name: "Terrarium: Healing",       tile: "Healing Tile",       cost: "150", rarity: "Common", img: ART + "Healing_Tile.png" },
  { id: "535RjElIC0JJRvm6", kind: "gathering",     name: "Terrarium: Gathering",     tile: "Gathering Tile",     cost: "150", rarity: "Common", img: ART + "Gathering_Tile.png" },
  { id: "TerrariumCamp001", kind: "camp",          name: "Terrarium: Camp",          tile: "Camp Tile",          cost: "500", rarity: "Rare",   img: ART + "Camp_Tile.png",          cloneOf: "GSggw21CziniktM7" },
  { id: "TerrariumRBattle", kind: "random_battle", name: "Terrarium: Random Battle", tile: "Random Battle Tile", cost: "150", rarity: "Common", img: ART + "Random_Battle_Tile.png", cloneOf: "GSggw21CziniktM7" },
];
const LEGACY_NAMES = new Set(["Terrain Destroyer", "Terrain Generator: Saferoom", "Terrain Generator: Terrarium"]);

function shape(doc, spec, { newId = null } = {}) {
  const d = JSON.parse(JSON.stringify(doc));
  if (newId) {
    d._id = newId;
    d.sort = (Number(d.sort) || 0) + 1;
    if (d._stats) { d._stats.createdTime = null; d._stats.modifiedTime = null; d._stats.duplicateSource = null; d._stats.compendiumSource = null; }
  }
  d.name = spec.name;
  d.img = spec.img;
  const p = d.system.props;
  p.name = spec.name;
  p.description = desc(spec.tile);
  p.item_cost = spec.cost;
  p.item_rarity = spec.rarity;
  if (newId) p.item_quantity = "1";
  d.flags = d.flags ?? {};
  d.flags[MOD] = { ...(d.flags[MOD] ?? {}), terrarium: spec.kind };
  return d;
}

const which = process.argv[2];
if (which === "items") {
  run(async ({ changes }) => {
    const src = {};
    for (const s of ITEMS) {
      const k = `!items!${s.id}`;
      const existing = await getByKey("items", k);
      if (s.cloneOf) {
        const base = src[s.cloneOf] ?? await getByKey("items", `!items!${s.cloneOf}`);
        if (!base) throw new Error(`clone source missing: ${s.cloneOf}`);
        changes.push([k, shape(existing ?? base, s, { newId: existing ? null : s.id }), `${existing ? "update" : "CREATE"} "${s.name}" (${s.cost} z ${s.rarity})`]);
      } else {
        if (!existing) throw new Error(`legacy item missing: ${s.id}`);
        if (existing.name !== s.name && !LEGACY_NAMES.has(existing.name)) throw new Error(`unexpected name on ${s.id}: ${existing.name}`);
        src[s.id] = existing;
        changes.push([k, shape(existing, s), `"${existing.name}" → "${s.name}"`]);
      }
    }
  }, "Terrarium items — world", "items");
} else if (which === "actors") {
  run(async ({ changes }) => {
    const A = "BqBoJEye80GAm9fX", I = "pPcJ4sB3Vjxd1rIA";
    const spec = ITEMS[0];
    const ik = `!actors.items!${A}.${I}`, ak = `!actors!${A}`;
    const it = await getByKey("actors", ik), a = await getByKey("actors", ak);
    if (!it || !a) throw new Error(`missing ${ik} or ${ak}`);
    if (it.name !== spec.name && it.name !== "Terrain Destroyer") throw new Error(`unexpected ${it.name}`);
    const next = shape(it, spec);
    changes.push([ik, next, `${a.name}'s copy "${it.name}" → "${spec.name}"`]);
    const owner = JSON.parse(JSON.stringify(a));
    const row = owner.system?.props?.consumable_list?.[I];
    if (row) {
      row.name = spec.name;
      row.consume_description = next.system.props.description;
      changes.push([ak, owner, `${a.name}: consumable_list mirror row → "${spec.name}"`]);
    }
  }, "Terrarium items — actor copies", "actors");
} else if (which === "tables") {
  run(async ({ changes }) => {
    const T = "fxXT0ZlnFlDYwfgv";
    for (const [rid, id, name] of [["guEKIXgXkUpoIsYI", "GSggw21CziniktM7", "Terrarium: Healing"], ["0yt8SPA5rk3RIcxI", "535RjElIC0JJRvm6", "Terrarium: Gathering"]]) {
      const k = `!tables.results!${T}.${rid}`;
      const r = await getByKey("tables", k);
      if (!r || r.documentId !== id) throw new Error(`unexpected table result ${k}`);
      const next = { ...r, text: name };
      changes.push([k, next, `Vastwind Field - Consumable [${r.range}] "${r.text}" → "${name}"`]);
    }
  }, "Terrarium items — loot table text", "tables");
} else {
  console.log("usage: node bin/_terrarium-items-2026-11-12.js items|actors|tables [--apply]");
}
