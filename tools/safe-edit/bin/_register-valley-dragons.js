// Register Mist Dragon + Drakoza in the Valley of the Dragon dungeon tables.
// Run from tools/safe-edit; --apply to write.
//
// Both tables must have their FORMULA raised alongside the new rows. A row
// parked ABOVE the die maximum is the house idiom for "list it in the bestiary,
// never roll it" (Ancient Temple - Enemies keeps Geist at row 9 of a 1d8), and
// dp-random-battle's rollableRows() drops such rows on purpose. These two
// monsters are meant to be rolled, so the ceiling moves with them.
const { openCollection, getByKey } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const journal = require("../lib/journal");

const APPLY = process.argv.includes("--apply");

const ENEMIES = "0LEghOv3aJyZVyVs";     // Valley of the Dragon - Enemies   (1d9  -> 1d11)
const ENCOUNTER = "Oijx8ksubxq9pc1R";   // Valley of the Dragon - Encounter (1d23 -> 1d27)

const DRAKOZA = "H6Ubup6kmkgNQzLU";
const MIST = "8kluKkqkcGFkmXNO";

const MONSTER_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Monster_Icon.png";
const ENEMY_ICON = "icons/svg/mystery-man.svg";   // what every existing Enemies row uses

const docRow = (id, n, text, documentId) => ({
  _id: id, type: "document", documentCollection: "Actor", documentId,
  text, img: ENEMY_ICON, range: [n, n], weight: 1, drawn: false, flags: {},
});
const textRow = (id, n, text) => ({
  _id: id, type: "text", documentId: null,
  text, img: MONSTER_ICON, range: [n, n], weight: 1, drawn: false, flags: {},
});

// Troops are ASSEMBLED to a TP budget, never carved out of one. Drakoza ~1.0 TP
// (140 HP), Mist Dragon ~1.5 (200) at the 135 effective-DPR design point, which
// puts all four of these in the same 1.7-2.4 round band the table already runs at.
// The pairings also feed the fiction: Phantom Shift's fixed repertoire is lifted
// off Skizzik / Obsidrax / Mana Ray, so the mist reads best standing next to them.
const NEW_ENEMIES = [
  docRow("Vd1nMBoyCLXvQTaE", 10, "Drakoza", DRAKOZA),
  docRow("Kq7ZsRpEUmH3fWbA", 11, "Mist Dragon", MIST),
];
const NEW_ENCOUNTERS = [
  textRow("Nb4TxJqWvHc9RmLd", 24, "Drakoza, Drakoza"),
  textRow("Pj8GyKsQwEz2VnRt", 25, "Drakoza, Skizzik"),
  textRow("Rw6DhLmXbUa5CkYp", 26, "Mist Dragon, Obsidrax"),
  textRow("Zt3FcNvBqJi7SoGe", 27, "Mist Dragon, Mana Ray, Drakoza"),
];

// In LevelDB a table's `results` is a string[] of ids and each row lives at its
// own `!tables.results!<table>.<row>` key — the same layout as items/AEs, and
// the same trap: an inline row object on the parent is dropped on load. The
// readable export INLINES them, so it is not a guide to the storage shape.
const rowKey = (table, row) => `!tables.results!${table}.${row}`;

(async () => {
  const enemies = await getByKey("tables", `!tables!${ENEMIES}`);
  const encounter = await getByKey("tables", `!tables!${ENCOUNTER}`);
  if (!enemies || !encounter) throw new Error("missing table doc");

  const changes = [];
  const extend = async (table, tableId, rows, newFormula, label) => {
    const t = JSON.parse(JSON.stringify(table));
    const existing = [];
    for (const id of t.results) {
      const r = await getByKey("tables", rowKey(tableId, id));
      if (!r) throw new Error(`${label}: result ${id} listed but missing on disk`);
      existing.push(r);
    }
    const taken = new Set(existing.map((r) => r.range[0]));
    for (const r of rows) {
      if (taken.has(r.range[0])) throw new Error(`${label}: range ${r.range[0]} already occupied`);
      if (t.results.includes(r._id)) throw new Error(`${label}: duplicate result id ${r._id}`);
      if (r.type === "text" && r.text.split(",").some((n) => !n.trim())) throw new Error(`${label}: blank troop entry`);
      changes.push([rowKey(tableId, r._id), r, `${label} row ${r.range[0]}: ${r.text}`]);
    }
    t.results = [...t.results, ...rows.map((r) => r._id)];
    t.formula = newFormula;
    // The die maximum and the row count must agree, or rows silently stop being
    // reachable (too small) or the table rolls a hole (too large).
    const max = Number(/^1d(\d+)$/.exec(newFormula)?.[1]);
    const covered = new Set([...existing, ...rows].map((r) => r.range[0]));
    for (let n = 1; n <= max; n++) if (!covered.has(n)) throw new Error(`${label}: no row for roll ${n}`);
    if (t.results.length !== max) throw new Error(`${label}: ${t.results.length} rows vs die max ${max}`);
    changes.push([`!tables!${tableId}`, t, `${label}: ${table.formula} -> ${newFormula}, +${rows.length} rows`]);
  };

  await extend(enemies, ENEMIES, NEW_ENEMIES, "1d11", "Enemies");
  await extend(encounter, ENCOUNTER, NEW_ENCOUNTERS, "1d27", "Encounter");

  // Every text-row troop name must resolve to a real Actor, or a random battle
  // draws a row it cannot spawn.
  const roster = new Map();
  {
    const db = await openCollection("actors");
    try {
      for await (const [k, v] of db.iterator()) {
        if (/^!actors![^.]+$/.test(k) && v?.name) roster.set(v.name, v._id);
      }
    } finally { await db.close(); }
  }
  for (const r of NEW_ENCOUNTERS) {
    for (const name of r.text.split(",").map((s) => s.trim())) {
      if (!roster.has(name)) throw new Error(`encounter row ${r.range[0]}: no actor named "${name}"`);
    }
  }
  console.log(`verified ${NEW_ENCOUNTERS.length} troop rows against the live actor roster`);

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${changes.length} writes\n`);
  for (const [key, , note] of changes) console.log(`  ${key}\n    ${note}`);
  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }

  const backupPath = snapshotCollection("tables");
  console.log(`\nbackup: ${backupPath}`);
  const db = await openCollection("tables");
  try {
    for (const [key, value] of changes) await db.put(key, value);
  } finally { await db.close(); }
  journal.append({
    uuid: "collection:tables", collection: "tables", key: changes.map((c) => c[0]).join(","),
    beforeHash: null, afterHash: null, backupPath, patch: null,
    note: `valley-of-the-dragon: ${changes.map((c) => c[2]).join("; ")}`,
  });
  console.log(`\nwrote ${changes.length} docs`);
})();
