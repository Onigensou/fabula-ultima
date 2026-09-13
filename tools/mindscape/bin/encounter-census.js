#!/usr/bin/env node
"use strict";
//
// Mindscape — census of the world's Encounter tables (equipment guide Part 4).  READ-ONLY.
//
//   node bin/encounter-census.js [--min-level 20] [--out expectations/encounter-census.json]
//
// The guide prices anything that depends on HOW MANY enemies are present (Multi N, extra
// targets) or WHICH species they are ("+50% vs Humanoid") from a mix. It used to be a guess
// (20% solo / 30% two / 50% three+, and 12.5% per species). This counts it from the spawn
// groups the table actually rolls: every "<Area> - Encounter" RollTable under a dungeon
// folder, each row a comma-separated list of monster names.
//
// Weighting: every row by its share of the table's die (range width inside the formula's
// ceiling — a row ranged ABOVE the die maximum is boss containment and is never rolled),
// every TABLE equally in the aggregates. Rows whose lone monster acts more than once per
// round (Asura, Carlbero) or carries the boss star are reported apart: the band test and
// the non-boss mix exclude them.
//
// The game must be CLOSED.

const fs = require("fs");
const path = require("path");
const { withCollection } = require("../../safe-edit/lib/db");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");
const { loadWorldFolders } = require("../lib/baseline-gear");
const { loadAll } = require("../lib/load-actors");

const ROOT_FOLDER = "The Legend of Dragonslayer";
const MULTI = [2, 3];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const s = (v) => String(v ?? "").trim();
const pct = (x) => `${Math.round(100 * x)}%`;

// "1d22" -> 22. Offline there is no Foundry Roll to maximise, so only the NdM shape the
// dungeon tables use is accepted; anything else is reported and the whole table counted.
function dieCeiling(formula) {
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*$/i.exec(s(formula));
  return m ? Number(m[1]) * Number(m[2]) : null;
}

async function loadTables(world) {
  return withCollection("tables", world, async (db) => {
    const tables = new Map();
    const results = new Map();
    for await (const [key, value] of db.iterator()) {
      if (key.startsWith("!tables!")) tables.set(value._id, value);
      else if (key.startsWith("!tables.results!")) {
        const tableId = key.split("!")[2].split(".")[0];
        if (!results.has(tableId)) results.set(tableId, []);
        results.get(tableId).push(value);
      }
    }
    return { tables, results };
  });
}

// Pure: rows -> the weighted census of one table. Exported for tests.
function censusOfRows(rows, { minLevel = 0 } = {}) {
  const total = rows.reduce((a, r) => a + r.weight, 0);
  const out = { weight: 0, counts: {}, extraTargets: {}, species: {}, speciesPresent: {}, elite: 0, bodies: 0 };
  if (!total) return out;
  for (const r of rows) {
    if (r.boss || r.level < minLevel) continue;
    const w = r.weight / total;
    const n = r.monsters.length;
    out.weight += w;
    const bucket = n >= 5 ? "5+" : String(n);
    out.counts[bucket] = (out.counts[bucket] ?? 0) + w;
    for (const N of MULTI) out.extraTargets[N] = (out.extraTargets[N] ?? 0) + w * (Math.min(n, N) - 1);
    out.bodies += w * n;
    for (const m of r.monsters) {
      out.species[m.species] = (out.species[m.species] ?? 0) + w / n;
      if (m.rank === "elite") out.elite += w / n;
    }
    for (const sp of new Set(r.monsters.map((m) => m.species))) out.speciesPresent[sp] = (out.speciesPresent[sp] ?? 0) + w;
  }
  // Renormalise over the rows that qualified.
  const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, out.weight ? v / out.weight : 0]));
  return {
    weight: out.weight, counts: norm(out.counts), extraTargets: norm(out.extraTargets), species: norm(out.species),
    speciesPresent: norm(out.speciesPresent), eliteShare: out.weight ? out.elite / out.weight : 0,
    meanEnemies: out.weight ? out.bodies / out.weight : 0,
  };
}

// Pure: average several table censuses, each table weighted equally. Exported for tests.
function averageCensus(list) {
  const used = list.filter((c) => c.weight > 0);
  const avgMap = (key) => {
    const acc = {};
    for (const c of used) for (const [k, v] of Object.entries(c[key])) acc[k] = (acc[k] ?? 0) + v / used.length;
    return acc;
  };
  const mean = (key) => used.reduce((a, c) => a + c[key], 0) / (used.length || 1);
  return { tables: used.length, counts: avgMap("counts"), extraTargets: avgMap("extraTargets"), species: avgMap("species"),
    speciesPresent: avgMap("speciesPresent"), eliteShare: mean("eliteShare"), meanEnemies: mean("meanEnemies") };
}

async function main() {
  const world = DEFAULT_WORLD;
  const minLevel = Number(arg("--min-level", 20));
  const out = arg("--out", null);

  const folders = await loadWorldFolders({ world });
  const { tables, results } = await loadTables(world);
  const npcs = new Map();
  for (const a of await loadAll()) {
    if (!a.isNpc) continue;
    const k = s(a.name).toLowerCase();
    if (!npcs.has(k)) npcs.set(k, a);
  }
  const chain = (id) => {
    const names = [];
    const seen = new Set();
    for (let f = folders.get(id); f && !seen.has(f.id); f = folders.get(f.parent)) { seen.add(f.id); names.unshift(f.name); }
    return names;
  };

  const warnings = [];
  const perTable = [];
  for (const t of [...tables.values()].sort((a, b) => s(a.name).localeCompare(s(b.name)))) {
    if (!/ - Encounter$/.test(s(t.name))) continue;
    const folderChain = chain(t.folder);
    if (folderChain[0] !== ROOT_FOLDER) continue;
    const dungeon = folderChain[1] ?? "?";
    const ceiling = dieCeiling(t.formula);
    if (ceiling == null) warnings.push(`${t.name}: formula "${s(t.formula)}" is not NdM — every row counted`);
    const rows = [];
    for (const r of results.get(t._id) ?? []) {
      const [lo, hi] = r.range ?? [1, 1];
      const top = ceiling == null ? hi : Math.min(hi, ceiling);
      const width = Math.max(0, top - lo + 1);
      if (!width) continue;                                   // above the die: boss containment
      const names = s(r.text ?? r.description ?? r.name).split(",").map(s).filter(Boolean);
      const starred = names.some((n) => n.startsWith("⭐"));
      const monsters = [];
      for (const raw of names) {
        const name = raw.replace(/^⭐️?\s*/u, "");
        const m = npcs.get(name.toLowerCase());
        if (!m) { warnings.push(`${t.name} [${lo}-${hi}]: "${name}" matches no monster actor — that slot never spawns`); continue; }
        monsters.push({ name: m.name, level: m.level, rank: s(m.rank).toLowerCase(), species: s(m.species).toUpperCase() || "?", turns: m.turnsPerRound ?? 1 });
      }
      if (!monsters.length) continue;
      const boss = starred || (monsters.length === 1 && monsters[0].turns > 1);
      rows.push({ range: [lo, hi], weight: width, monsters, boss, level: Math.max(...monsters.map((m) => m.level)) });
    }
    if (!rows.length) continue;
    perTable.push({ table: s(t.name), dungeon, formula: s(t.formula), rows,
      all: censusOfRows(rows), band: censusOfRows(rows, { minLevel }),
      bossRows: rows.filter((r) => r.boss).map((r) => r.monsters.map((m) => m.name).join(", ")) });
  }

  const overall = averageCensus(perTable.map((t) => t.all));
  const band = averageCensus(perTable.map((t) => t.band));
  // Second weighting: every non-boss ROW counts once, whatever table it sits in, so a
  // one-row table (a cave's lone elite) cannot weigh as much as a 26-row dungeon.
  const pooled = perTable.flatMap((t) => {
    const total = t.rows.reduce((a, r) => a + r.weight, 0);
    return t.rows.map((r) => ({ ...r, weight: (r.weight / total) * t.rows.length }));
  });
  const rowsAll = { tables: perTable.length, ...censusOfRows(pooled) };
  const rowsBand = { tables: perTable.length, ...censusOfRows(pooled, { minLevel }) };
  const speciesList = [...new Set(perTable.flatMap((t) => Object.keys(t.all.species)))].sort();

  console.log(`\nEncounter census — ${perTable.length} Encounter tables under "${ROOT_FOLDER}", each table weighted equally.`);
  console.log(`Non-boss rows only; a row weighs its share of the table's die. Band = groups whose highest monster is L${minLevel}+.\n`);
  console.log(`| Table | Rows | 1 | 2 | 3 | 4 | 5+ | Mean enemies | Extra targets M2 / M3 | Elite share | Band rows |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
  const line = (label, c, rows, bandRows) => console.log(`| ${label} | ${rows} | ${["1", "2", "3", "4", "5+"].map((k) => pct(c.counts[k] ?? 0)).join(" | ")} `
    + `| ${c.meanEnemies.toFixed(2)} | ${(c.extraTargets[2] ?? 0).toFixed(2)} / ${(c.extraTargets[3] ?? 0).toFixed(2)} | ${pct(c.eliteShare)} | ${bandRows} |`);
  for (const t of perTable) line(t.table, t.all, t.rows.filter((r) => !r.boss).length, t.band.weight ? pct(t.band.weight) : "—");
  line(`**All tables** (tables equal)`, overall, "", "");
  line(`**Band L${minLevel}+** (tables equal)`, band, "", "");
  line(`**All tables** (rows equal)`, rowsAll, "", "");
  line(`**Band L${minLevel}+** (rows equal)`, rowsBand, "", "");

  console.log(`\nSpecies — share of enemies (share of fights with at least one):\n`);
  console.log(`| Species | All, tables equal | Band L${minLevel}+, tables equal | All, rows equal | Band L${minLevel}+, rows equal |`);
  console.log(`|---|---|---|---|---|`);
  const cell = (c, sp) => `${pct(c.species[sp] ?? 0)} (${pct(c.speciesPresent[sp] ?? 0)})`;
  for (const sp of speciesList) {
    console.log(`| ${sp} | ${cell(overall, sp)} | ${cell(band, sp)} | ${cell(rowsAll, sp)} | ${cell(rowsBand, sp)} |`);
  }
  const bosses = perTable.flatMap((t) => t.bossRows.map((b) => `${t.table}: ${b}`));
  if (bosses.length) console.log(`\nExcluded as boss / solo multi-activation rows:\n  · ${bosses.join("\n  · ")}`);
  if (warnings.length) console.log(`\n⚠ ${warnings.length} warning(s):\n  · ${[...new Set(warnings)].join("\n  · ")}`);

  if (out) {
    fs.writeFileSync(path.resolve(out), `${JSON.stringify({
      id: "encounter-census", capturedAt: new Date().toISOString().slice(0, 10), minLevel,
      overall, band, rowsEqual: { overall: rowsAll, band: rowsBand }, tables: perTable.map(({ rows, ...t }) => ({ ...t, rows: rows.map((r) => ({ ...r, monsters: r.monsters.map((m) => m.name) })) })),
      warnings: [...new Set(warnings)],
    }, null, 2)}\n`);
    console.log(`\nwrote ${path.resolve(out)}`);
  }
}

module.exports = { censusOfRows, averageCensus, dieCeiling };

if (require.main === module) {
  main().catch((e) => { console.error(`\nencounter-census failed: ${e.message}\n`); process.exit(1); });
}
