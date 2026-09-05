// Register the Roo in the Fafnir Castle roll tables.
// Run from tools/safe-edit; --apply to write.
//
// RARITY IS PRESENCE ACROSS GROUPS, not range width. The dungeon's common
// monsters each appear in 3-6 of the Encounter table's rows (Dire Orc 6,
// Succubus 5, Death Gazer 5, Iron Colossus 5, Dragon Guard 4, Imp 3). The Roo
// gets 2 of 16 — half the least-common common monster, double Carlbero's
// single special-case row. Every row stays one-wide, so no existing odds move.
//
// ⚠ The random-battle resolver reads `table.results` DIRECTLY (it has to, for
// the novelty bias), which bypasses the die. A row parked ABOVE the formula
// maximum is the house idiom for "list it in the bestiary, never roll it" —
// that is what keeps ⭐️ Hilde-Fafnir out of random encounters while leaving her
// manually spawnable. Both boss rows shift up with the formula so containment
// is preserved exactly.
//
// The Roo is also unseen on its debut, so the novelty bias (weight x2 for a
// never-fought monster) roughly doubles its share until the first fight, then
// self-retires. Deliberate: you meet the new monster sooner.
const { withCollection } = require("../lib/db");
const { run } = require("./_fafnir-util");

const T_ENC = "hpCzLw5RI4wQNtF7";   // Fafnir Castle - Encounter
const T_ENE = "oVJkUYCxsiHW6guM";   // Fafnir Castle - Enemies
const ROO = "VwClo606KbQSK6aQ";
const MONSTER_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Monster_Icon.png";

// Fresh 16-char ids for the three new rows.
const R_ENC_GUARD = "Y7kQm2bTxWvL9dNr";   // Dragon Guard, Roo, Dragon Guard
const R_ENC_IMP   = "P4hSzJ8cRnVtA6yE";   // Imp, Death Gazer, Roo, Imp
const R_ENE_ROO   = "Q9wDfK3mLbXpT5uH";   // Roo (bestiary row)

const rk = (t, r) => `!tables.results!${t}.${r}`;

run(async ({ changes }) => {
  const { enc, ene, encRows, eneRows } = await withCollection("tables", undefined, async (db) => {
    const enc = await db.get(`!tables!${T_ENC}`);
    const ene = await db.get(`!tables!${T_ENE}`);
    const load = async (t, ids) => {
      const out = [];
      for (const id of ids) out.push(await db.get(rk(t, id)));
      return out;
    };
    return { enc, ene, encRows: await load(T_ENC, enc.results), eneRows: await load(T_ENE, ene.results) };
  });

  // Refuse to run twice — this script is additive and not idempotent.
  if (encRows.some((r) => /\bRoo\b/.test(r.text)) || eneRows.some((r) => r.documentId === ROO)) {
    throw new Error("the Roo is already registered in these tables — nothing to do");
  }
  if (enc.formula !== "1d14" || ene.formula !== "1d6") {
    throw new Error(`unexpected starting formulas (encounter ${enc.formula}, enemies ${ene.formula}) — reconcile by hand`);
  }

  // ── Encounter: insert two rows, renumber every range ────────────────────
  // Ordering convention is roughly easy -> hard so a GM can pick by row as
  // well as roll, so the new rows slot by unit count rather than appending.
  //   after old row 10 : Dragon Guard, Roo, Dragon Guard   (3 units)
  //   after old row 11 : Imp, Death Gazer, Roo, Imp        (4 units)
  const mkText = (id, text) => ({
    _id: id, type: "text", documentId: null, text,
    img: MONSTER_ICON, range: [0, 0], weight: 1, drawn: false, flags: {},
  });

  const encOrder = [];
  encRows.forEach((r, i) => {
    encOrder.push(r);
    if (i === 9) encOrder.push(mkText(R_ENC_GUARD, "Dragon Guard, Roo, Dragon Guard"));
    if (i === 10) encOrder.push(mkText(R_ENC_IMP, "Imp, Death Gazer, Roo, Imp"));
  });

  encOrder.forEach((r, i) => {
    const n = i + 1;
    if (r.range[0] !== n || r.range[1] !== n) {
      r.range = [n, n];
      changes.push([rk(T_ENC, r._id), r, `Encounter row ${n} — ${r.text}`]);
    }
  });
  // The two new rows always need writing, renumbered or not.
  for (const id of [R_ENC_GUARD, R_ENC_IMP]) {
    if (!changes.some((c) => c[0] === rk(T_ENC, id))) {
      const r = encOrder.find((x) => x._id === id);
      changes.push([rk(T_ENC, id), r, `Encounter row ${r.range[0]} — ${r.text} (NEW)`]);
    }
  }

  enc.results = encOrder.map((r) => r._id);
  enc.formula = `1d${encOrder.length}`;
  changes.push([`!tables!${T_ENC}`, enc,
    `Fafnir Castle - Encounter → ${enc.formula} (${encOrder.length} rows, Roo in 2)`]);

  // ── Enemies: Roo becomes row 7; both boss rows shift up ─────────────────
  // New ceiling is 7, so Hilde-Fafnir (8) and Carlbero (9) both stay above it.
  const rooRow = {
    _id: R_ENE_ROO, type: "document", documentCollection: "Actor",
    documentId: ROO, text: "Roo", img: "icons/svg/mystery-man.svg",
    range: [7, 7], weight: 1, drawn: false, flags: {},
  };
  const eneOrder = [...eneRows.slice(0, 6), rooRow, ...eneRows.slice(6)];
  eneOrder.forEach((r, i) => {
    const n = i + 1;
    if (r.range[0] !== n || r.range[1] !== n) {
      r.range = [n, n];
      changes.push([rk(T_ENE, r._id), r, `Enemies row ${n} — ${r.text}`]);
    }
  });
  if (!changes.some((c) => c[0] === rk(T_ENE, R_ENE_ROO))) {
    changes.push([rk(T_ENE, R_ENE_ROO), rooRow, "Enemies row 7 — Roo (NEW)"]);
  }

  ene.results = eneOrder.map((r) => r._id);
  ene.formula = "1d7";   // rollable 1-7; Hilde-Fafnir 8 and Carlbero 9 contained
  changes.push([`!tables!${T_ENE}`, ene,
    `Fafnir Castle - Enemies → 1d7 (Roo rollable; both boss rows still above the ceiling)`]);

  // Assert the containment invariant survived, before anything is written.
  const ceiling = eneOrder.length - 2;
  const contained = eneOrder.filter((r) => r.range[0] > ceiling).map((r) => r.text);
  if (contained.length !== 2 || !contained.some((t) => /Hilde-Fafnir/.test(t)) || !contained.some((t) => /Carlbero/.test(t))) {
    throw new Error(`boss containment broken — above-ceiling rows are [${contained}]`);
  }
  console.log(`\n  containment OK — above the 1d${ceiling} ceiling: ${contained.join(", ")}`);
}, "fafnir-castle: register Roo", "tables");
