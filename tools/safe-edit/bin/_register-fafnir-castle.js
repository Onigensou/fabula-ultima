// Register the five new monsters in the Fafnir Castle dungeon tables.
// Run from tools/safe-edit; --apply to write.
//
// The dungeon's 13-table folder already exists (BykuRa1wHg4VliNO) with its Item
// and Zenit tables filled at the deepest tier in the world (~1096z average).
// Enemies and Encounter were 1d1 zero-row placeholders — that is what this
// fills in. The remaining Event/Treasure placeholders are left alone.
//
// ⚠ The two tables are coupled by NAME ONLY, with no referential integrity:
// Encounter rows are plain text, so a renamed monster silently breaks them and
// preflight will NOT catch it (its `tables` suite only validates *document*
// rows). Adding a monster means editing BOTH, and bumping BOTH formulas.
const { openCollection, getByKey } = require("../lib/db");
const { IDS } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const ENEMIES = "oVJkUYCxsiHW6guM";     // Fafnir Castle - Enemies    (1d1 -> 1d4)
const ENCOUNTER = "hpCzLw5RI4wQNtF7";   // Fafnir Castle - Encounter  (1d1 -> 1d8)

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

// Boss containment: ⭐️ Hilde-Fafnir is listed in the bestiary at row 5 of a
// 1d4, so `table.roll()` can never reach it. That containment is only as good
// as the reader — anything walking `table.results` directly (which the weighted
// random-battle picker must, to preserve authored range widths) has to filter
// on the formula ceiling itself. dp-random-battle does.
const NEW_ENEMIES = [
  docRow("DYJbRo5tX5d0TjY0", 1, "Death Gazer",     IDS.DG),
  docRow("FEzS8RrJ66gqA0Ul", 2, "Dire Orc",        IDS.DO),
  docRow("H6ZBW62Wtyr2DfDE", 3, "Succubus",        IDS.SU),
  docRow("PCGcoIeHTZg6MuZv", 4, "Iron Colossus",   IDS.IC),
  docRow("h4qrO4YKt5FrU9S9", 5, "⭐️ Hilde-Fafnir", IDS.HF),
];

// Troops are ASSEMBLED to a budget, never carved out of one. Counting in
// soldier-equivalents (Iron Colossus is an Elite = 2), the official line for
// 4 PCs is 3 easy / 4 normal / 5 hard.
//
// Ordered easy -> hard so a GM can pick by row as well as roll, and built to
// TEACH: the Orc-only opener is a plain fight with no gimmick, then Charm
// arrives with a bodyguard, then the Gaze arrives with escorts, and only after
// each has been met alone do they start combining. Row text reads as board
// layout — centrepiece in the middle, flankers mirrored around it.
//
// Row 8 is deliberately over the "5 = hard" line. This is the last dungeon in
// the game and the table wants a ceiling; it is also the row most likely to
// need tuning once these five have actually been played.
const NEW_ENCOUNTERS = [
  textRow("gOJR1WEJypXiGWCI", 1, "Dire Orc, Dire Orc"),
  textRow("P5XcgEmzMq7q2r3n", 2, "Succubus, Dire Orc, Succubus"),
  textRow("k0cMJ77RS5msWWgj", 3, "Dire Orc, Death Gazer, Dire Orc"),
  textRow("Qck7ZCJldprYfcIp", 4, "Death Gazer, Succubus, Death Gazer"),
  textRow("jSYm2F6sdcnpSFCU", 5, "Dire Orc, Iron Colossus, Dire Orc"),
  textRow("W7OI3fkn8NocXHnQ", 6, "Succubus, Iron Colossus, Succubus"),
  textRow("cVe8YfeRdOxGAWZH", 7, "Dire Orc, Death Gazer, Iron Colossus, Succubus"),
  textRow("LZZrahp1sXwBFuXD", 8, "Death Gazer, Succubus, Iron Colossus, Succubus, Death Gazer"),
];

run(async ({ changes }) => {
  for (const [tableId, rows, formula, label] of [
    [ENEMIES, NEW_ENEMIES, "1d4", "Enemies"],
    [ENCOUNTER, NEW_ENCOUNTERS, "1d8", "Encounter"],
  ]) {
    const table = await getByKey("tables", `!tables!${tableId}`);
    if (!table) throw new Error(`missing table ${tableId}`);
    if ((table.results ?? []).length) {
      throw new Error(`${table.name} already has ${table.results.length} rows — this script only fills an empty placeholder`);
    }

    // In LevelDB a table's `results` is a string[] of ids and each row lives at
    // its own `!tables.results!<table>.<row>` key — the same layout as items
    // and AEs. A row written only into the array is not a document, and a row
    // written only at its key is never enumerated.
    for (const row of rows) changes.push([`!tables.results!${tableId}.${row._id}`, row, `${label} row ${row.range[0]} — ${row.text}`]);

    table.results = rows.map((r) => r._id);
    // The formula MUST track the row count or the new rows are unrollable.
    table.formula = formula;
    table.replacement = true;
    table.displayRoll = true;
    changes.push([`!tables!${tableId}`, table, `${table.name}: 1d1 -> ${formula}, ${rows.length} rows`]);
  }
}, "fafnir-castle: table registration", "tables");
