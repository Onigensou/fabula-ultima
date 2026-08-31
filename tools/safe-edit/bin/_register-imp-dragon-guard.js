// Add the Imp and the Dragon Guard to the Fafnir Castle dungeon tables.
// Run from tools/safe-edit; --apply to write.
//
// The sibling _register-fafnir-castle.js only fills an EMPTY placeholder and
// refuses to run against a populated table, which is correct for a first fill
// and useless for an addition. This one edits in place.
//
// ⚠ The two tables are coupled by NAME ONLY, with no referential integrity:
// Encounter rows are plain text, so a renamed monster silently breaks them and
// preflight will NOT catch it (its `tables` suite validates only *document*
// rows). Adding a monster means editing BOTH, and bumping BOTH formulas.
//
// Boss containment on Enemies: rollable rows are 1..formula-ceiling, and
// anything parked ABOVE it can never come out of `table.roll()`. Hilde-Fafnir
// and Carlbero live up there. Inserting two rollable monsters therefore means
// pushing both parked rows further up as the ceiling rises — get that wrong and
// the final boss starts turning up in random encounters. dp-random-battle
// walks `table.results` directly (it has to, to preserve authored range
// widths) and re-applies the ceiling itself, so the invariant is the FORMULA,
// not the row order.
const { getByKey } = require("../lib/db");
const { IDS } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const ENEMIES = "oVJkUYCxsiHW6guM";     // Fafnir Castle - Enemies    (1d4 -> 1d6)
const ENCOUNTER = "hpCzLw5RI4wQNtF7";   // Fafnir Castle - Encounter  (1d9 -> 1d14)

const MONSTER_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Monster_Icon.png";
const ENEMY_ICON = "icons/svg/mystery-man.svg";

// ── Enemies (the bestiary list) ────────────────────────────────────────────
// Imp and Dragon Guard become rollable rows 5 and 6; the two parked entries
// shift to 7 and 8, still above the new 1d6 ceiling.
const ENEMY_ORDER = [
  ["DYJbRo5tX5d0TjY0", "Death Gazer",     IDS.DG],
  ["FEzS8RrJ66gqA0Ul", "Dire Orc",        IDS.DO],
  ["H6ZBW62Wtyr2DfDE", "Succubus",        IDS.SU],
  ["PCGcoIeHTZg6MuZv", "Iron Colossus",   IDS.IC],
  ["Xq3bopvd8aioNqod", "Imp",             IDS.IM],
  ["E0MO1WyFWwfoHyi7", "Dragon Guard",    IDS.DGD],
  // ── above the 1d6 ceiling: never rolled ──
  ["h4qrO4YKt5FrU9S9", "⭐️ Hilde-Fafnir", IDS.HF],
  ["2LHLJLdpDdiaQIF7", "Carlbero",        IDS.CB],
];
const ENEMIES_FORMULA = "1d6";

// ── Encounter (the troop list) ─────────────────────────────────────────────
// Ordered easy -> hard so a GM can pick by row as well as roll, and built to
// TEACH: each new monster gets a row where it is the only unfamiliar thing on
// the board before it starts appearing in combinations.
//
//   2  Dragon Guard alone — a plain fight against the castle's line soldier,
//      no gimmick to read, just its damage.
//   3  the Imp's introduction. A Dire Orc rides along on purpose: two Imps by
//      themselves deal almost nothing, so the fight would have no clock and the
//      party would never feel the cost of being robbed.
//   7  strip plus real damage — the combination the Imp exists to enable, and
//      the row most likely to reveal whether the gimmick is too strong.
//   12 the castle garrison: its own guards, around its own wall.
//
// Existing rows are re-ranged but never re-texted; the five new ones are woven
// in rather than appended, because appending would have put every new fight
// past the hardest old one.
const ENCOUNTER_ORDER = [
  ["gOJR1WEJypXiGWCI", "Dire Orc, Dire Orc"],
  ["efnTS2Bcc7US4IPW", "Dragon Guard, Dragon Guard"],
  ["A4JaKWcsxzEABmpA", "Imp, Dire Orc, Imp"],
  ["P5XcgEmzMq7q2r3n", "Succubus, Dire Orc, Succubus"],
  ["ksp5ucZJEITiWMu9", "Dragon Guard, Death Gazer, Dragon Guard"],
  ["k0cMJ77RS5msWWgj", "Dire Orc, Death Gazer, Dire Orc"],
  ["ItgzP9KLkhguSoFk", "Imp, Dragon Guard, Imp"],
  ["Qck7ZCJldprYfcIp", "Death Gazer, Succubus, Death Gazer"],
  ["jSYm2F6sdcnpSFCU", "Dire Orc, Iron Colossus, Dire Orc"],
  ["W7OI3fkn8NocXHnQ", "Succubus, Iron Colossus, Succubus"],
  ["cVe8YfeRdOxGAWZH", "Dire Orc, Death Gazer, Iron Colossus, Succubus"],
  ["HUWtrOi5L5OI8Lyu", "Imp, Dragon Guard, Iron Colossus, Dragon Guard, Imp"],
  ["LZZrahp1sXwBFuXD", "Death Gazer, Succubus, Iron Colossus, Succubus, Death Gazer"],
  ["10t55RI3spejUwmB", "Carlbero"],
];
const ENCOUNTER_FORMULA = "1d14";

run(async ({ changes }) => {
  // ── Enemies ─────────────────────────────────────────────────────────────
  const enemies = await getByKey("tables", `!tables!${ENEMIES}`);
  if (!enemies) throw new Error(`missing table ${ENEMIES}`);
  const known = new Set(enemies.results ?? []);
  for (const [rowId, , actorId] of ENEMY_ORDER) {
    if (!(await getByKey("actors", `!actors!${actorId}`))) throw new Error(`Enemies row "${rowId}" points at missing actor ${actorId}`);
  }
  ENEMY_ORDER.forEach(([rowId, text, actorId], i) => {
    const n = i + 1;
    changes.push([`!tables.results!${ENEMIES}.${rowId}`, {
      _id: rowId, type: "document", documentCollection: "Actor", documentId: actorId,
      text, img: ENEMY_ICON, range: [n, n], weight: 1, drawn: false, flags: {},
    }, `Enemies row ${n} — ${text}${known.has(rowId) ? "" : " (NEW)"}`]);
  });
  enemies.results = ENEMY_ORDER.map(([rowId]) => rowId);
  enemies.formula = ENEMIES_FORMULA;
  changes.push([`!tables!${ENEMIES}`, enemies, `${enemies.name}: -> ${ENEMIES_FORMULA}, ${ENEMY_ORDER.length} rows (2 parked above the ceiling)`]);

  // ── Encounter ───────────────────────────────────────────────────────────
  const enc = await getByKey("tables", `!tables!${ENCOUNTER}`);
  if (!enc) throw new Error(`missing table ${ENCOUNTER}`);
  const knownEnc = new Set(enc.results ?? []);
  ENCOUNTER_ORDER.forEach(([rowId, text], i) => {
    const n = i + 1;
    changes.push([`!tables.results!${ENCOUNTER}.${rowId}`, {
      _id: rowId, type: "text", documentId: null,
      text, img: MONSTER_ICON, range: [n, n], weight: 1, drawn: false, flags: {},
    }, `Encounter row ${n} — ${text}${knownEnc.has(rowId) ? "" : " (NEW)"}`]);
  });
  enc.results = ENCOUNTER_ORDER.map(([rowId]) => rowId);
  enc.formula = ENCOUNTER_FORMULA;
  changes.push([`!tables!${ENCOUNTER}`, enc, `${enc.name}: -> ${ENCOUNTER_FORMULA}, ${ENCOUNTER_ORDER.length} rows`]);

  // Every Encounter row names monsters that must exist in the Enemies list, or
  // the text is a dead reference nothing will catch at runtime.
  const roster = new Set(ENEMY_ORDER.map(([, text]) => text));
  for (const [, text] of ENCOUNTER_ORDER) {
    for (const name of text.split(",").map((s) => s.trim())) {
      if (!roster.has(name)) throw new Error(`Encounter row names "${name}", which is not in the Enemies table`);
    }
  }
}, "fafnir-castle: register Imp + Dragon Guard", "tables");
