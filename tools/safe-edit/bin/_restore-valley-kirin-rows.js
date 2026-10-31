// Valley of the Dragon surface: two Kirin rows back after the tightening (user, 2026-10-31).
//
// The first cut in _tighten-valley-encounters.js made the surface softer than the user
// wanted. These two rows carried real danger through combos, so they return at width 2
// each, under their original ids. Surface 14 -> 16 rows, 1d28 -> 1d32.
//
// Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const SURFACE = "Oijx8ksubxq9pc1R";
const AFTER = "Skizzik, Kirin, Skizzik";
const RESTORE = [
  ["ofd3pnxZ3fDM7EXO", "Kirin, Skizzik, Lightning Prism", 2],
  ["WzFFexCmIH2cztUW", "Ampere, Mana Ray, Kirin", 2],
];
const clone = (o) => JSON.parse(JSON.stringify(o));
const need = async (key) => {
  const v = await getByKey("tables", key);
  if (!v) throw new Error(`missing ${key}`);
  return v;
};

(async () => {
  await run(async ({ changes }) => {
    const table = clone(await need(`!tables!${SURFACE}`));
    if (table.formula !== "1d28") throw new Error(`surface Encounter is ${table.formula}`);
    const rows = [];
    for (const id of table.results) rows.push(clone(await need(`!tables.results!${SURFACE}.${id}`)));
    rows.sort((a, b) => a.range[0] - b.range[0]);

    const at = rows.findIndex((r) => r.text === AFTER);
    if (at < 0) throw new Error(`no row "${AFTER}"`);
    const added = RESTORE.map(([id, text, width]) => {
      const row = clone(rows[at]);
      row._id = id; row.text = text; row.weight = width; row.range = [0, width - 1];
      return row;
    });
    rows.splice(at + 1, 0, ...added);

    let n = 1;
    for (const row of rows) {
      const width = row.range[1] - row.range[0] + 1;
      row.range = [n, n + width - 1];
      n += width;
      changes.push([`!tables.results!${SURFACE}.${row._id}`, row, `${row.range.join("-")}: ${row.text}`]);
    }
    table.results = rows.map((r) => r._id);
    table.formula = `1d${n - 1}`;
    if (table.formula !== "1d32") throw new Error(`sums to ${table.formula}`);
    changes.push([`!tables!${SURFACE}`, table, `surface Encounter: 1d28 -> ${table.formula}, ${rows.length} rows`]);
  }, "restore valley kirin rows", "tables");
})().catch((e) => { console.error(e); process.exit(1); });
