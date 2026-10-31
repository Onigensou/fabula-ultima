// Valley of the Dragon: encounter tables tightened to JRPG size (user, 2026-10-31).
//
// Surface 26 -> 14 rows, Underground 27 -> 14 rows. Each area has a core of 12 or 13
// groups with rarity tiers; Crona rows are extra to that budget, because Crona is a
// gimmick monster that turns up at a low chance on any map, mostly in its own group.
// Crona therefore joins the surface Enemies table too.
//
// Each list is the whole table: a row not named here is deleted. Width is the odds.
// Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const SURFACE = "Oijx8ksubxq9pc1R", UNDERGROUND = "sULKvLErNMF8JtUr";
const SURFACE_ENEMIES = "0LEghOv3aJyZVyVs", UNDERGROUND_ENEMIES = "hBupoi4SsKj1GmDM";
const clone = (o) => JSON.parse(JSON.stringify(o));
const need = async (key) => {
  const v = await getByKey("tables", key);
  if (!v) throw new Error(`missing ${key}`);
  return v;
};

const SURFACE_ROWS = [
  ["Electro Slime, Electro Slime, Electro Slime", 2],
  ["Electro Slime, Skizzik, Electro Slime", 3],
  ["Electro Slime, Lightning Prism, Electro Slime", 3],
  ["Ampere, Mana Ray", 3],
  ["Ampere, Obsidrax", 2, "EncTightenRow001"],
  ["Skizzik, Lightning Prism", 2],
  ["Drakoza, Drakoza", 2],
  ["Mist Dragon, Obsidrax", 2],
  ["Electro Slime, Kirin, Electro Slime", 3],
  ["Skizzik, Kirin, Skizzik", 2],
  ["Gigas, Electro Slime, Electro Slime", 1],
  ["Ampere, Skizzik", 1],
  ["Ampere, Lightning Prism", 1],
  ["Crona, Crona, Crona", 1, "EncTightenRow002"],
];

const UNDERGROUND_ROWS = [
  ["Electro Slime, Lightning Prism, Electro Slime", 3],
  ["Obsidrax, Electro Slime, Electro Slime", 7],
  ["Obsidrax, Mana Ray, Ampere", 6],
  ["Drakoza, Skizzik", 6],
  ["Fulgimite, Lightning Prism", 4],
  ["Fulgimite, Skizzik, Fulgimite", 2],
  ["Fulgimite, Obsidrax", 2],
  ["Crona, Crona, Crona", 2],
  ["Crona, Obsidrax", 1],
  ["Ampere, Lightning Prism", 1],
  ["Gigas, Skizzik", 1],
  ["Roper", 2],
  ["Galvanic Paryashera", 2],
  ["Galvanic Paryashera, Fulgimite, Fulgimite", 1],
];

async function rebuild({ changes, deletes }, id, plan, from, to) {
  const table = clone(await need(`!tables!${id}`));
  if (table.formula !== from) throw new Error(`${table.name} is ${table.formula}, expected ${from}`);
  const rows = [];
  for (const r of table.results) rows.push(await need(`!tables.results!${id}.${r}`));
  const byText = new Map(rows.map((r) => [r.text, r]));
  if (byText.size !== rows.length) throw new Error(`${table.name}: duplicate row text`);

  const results = [];
  let n = 1;
  for (const [text, width, newId] of plan) {
    const old = byText.get(text);
    if (!old && !newId) throw new Error(`${table.name}: no row "${text}"`);
    if (old && newId) throw new Error(`${table.name}: row "${text}" already exists`);
    const row = clone(old ?? rows[0]);
    if (newId) { row._id = newId; row.text = text; }
    row.range = [n, n + width - 1];
    row.weight = width;
    n += width;
    results.push(row._id);
    changes.push([`!tables.results!${id}.${row._id}`, row, `${row.range.join("-")}: ${text}`]);
  }
  table.results = results;
  table.formula = `1d${n - 1}`;
  if (table.formula !== to) throw new Error(`${table.name} sums to ${table.formula}, expected ${to}`);
  changes.push([`!tables!${id}`, table, `${table.name}: ${from} -> ${to}, ${plan.length} rows`]);

  const kept = new Set(plan.map((p) => p[0]));
  for (const r of rows) if (!kept.has(r.text)) deletes.push([`!tables.results!${id}.${r._id}`, r.text]);
}

(async () => {
  await run(async (ctx) => {
    await rebuild(ctx, SURFACE, SURFACE_ROWS, "1d26", "1d28");
    await rebuild(ctx, UNDERGROUND, UNDERGROUND_ROWS, "1d52", "1d40");

    const enemies = clone(await need(`!tables!${SURFACE_ENEMIES}`));
    if (enemies.formula !== "1d12") throw new Error(`surface Enemies is ${enemies.formula}`);
    let donor = null;
    for (const r of (await need(`!tables!${UNDERGROUND_ENEMIES}`)).results) {
      const row = await need(`!tables.results!${UNDERGROUND_ENEMIES}.${r}`);
      if (row.text === "Crona") donor = row;
    }
    if (!donor) throw new Error("no Crona row to copy");
    const crona = clone(donor);
    crona._id = "EncTightenCrona1";
    crona.range = [13, 13];
    ctx.changes.push([`!tables.results!${SURFACE_ENEMIES}.${crona._id}`, crona, "surface Enemies 13: Crona"]);
    enemies.results.push(crona._id);
    enemies.formula = "1d13";
    ctx.changes.push([`!tables!${SURFACE_ENEMIES}`, enemies, "surface Enemies: 1d13"]);
  }, "tighten valley encounters", "tables");
})().catch((e) => { console.error(e); process.exit(1); });
