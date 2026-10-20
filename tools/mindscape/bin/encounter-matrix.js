#!/usr/bin/env node
"use strict";
//
// Mindscape — the Encounter Matrix.  READ-ONLY on the real world.
//
// Every row of the chosen dungeons' "<Area> - Encounter" tables (plus story-started
// fights that sit in no table) run through the Mindscape engine. One line per fight:
// how often the table rolls it, rounds, party HP left, KO risk, model coverage, and the
// numbers set against the design targets. It reports NUMBERS AGAINST TARGETS, not
// verdicts: the sim party plays below a human table and the user owns the call on what
// "hard" or "fun" means (memory: feedback_balance_data_limits).
//
//   node bin/encounter-matrix.js                     # Valley of the Dragon + Fafnir Castle
//   node bin/encounter-matrix.js --runs 500 --dungeons "Fafnir Castle" --no-story
//   node bin/encounter-matrix.js --out expectations/encounter-matrix.json --md ../../docs/encounter-matrix.md
//   node bin/encounter-matrix.js --policy standard   # the party plays like the in-game sim AI
//                                                   # (legacy | standard | expert | novice, lib/party-policy.js)
//
// The world stores are COPIED to a temp folder first and only the copy is opened, so a
// run never rotates the live store's MANIFEST and works with the game open (it then
// reads the last state Foundry wrote to disk).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { withCollection } = require("../../safe-edit/lib/db");
const { WORLDS_DIR, DEFAULT_WORLD, worldDataDir } = require("../../safe-edit/lib/paths");
const { loadAll, loadParty, validate } = require("../lib/load-actors");
const { loadWorldFolders } = require("../lib/baseline-gear");
const { buildCoverage, extractActions } = require("../lib/skills");
const ST = require("../lib/stances");
const { runBattle } = require("../lib/engine");
const PP = require("../lib/party-policy");
const { Rng } = require("../lib/rng");

const ROOT_FOLDER = "The Legend of Dragonslayer";
const COLLECTIONS = ["actors", "tables", "folders", "items"];

// Story-started fights that sit in no Encounter table (chapter tracker, 2026-10-19).
const STORY_FIGHTS = {
  "Valley of the Dragon": [["⭐️ Fafnir"], ["Rakshasa"], ["Flame Drake"], ["Lightning Drake"]],
  "Fafnir Castle": [],
};

// Targets: Monster Design Rules Part 6 + Fight Balance Playbook.
const TARGETS = {
  normal: { rounds: [1.5, 2], longRounds: 4, label: "1.5-2 rds" },
  boss: { rounds: [5.5, 6], longRounds: 7.5, label: "5.5-6 rds" },
};
const HP_PRESSURE = 0.70;   // party HP left at victory above this = "the fight never happened"
const HP_TRIVIAL = 0.85;

function parseArgs(argv) {
  const out = {
    runs: 1000, seed: "encounter-matrix", world: DEFAULT_WORLD,
    dungeons: ["Valley of the Dragon", "Fafnir Castle"], story: true, party: null, policy: "standard",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--runs" || a === "-n") out.runs = Number(next());
    else if (a === "--seed") out.seed = next();
    else if (a === "--dungeons") out.dungeons = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--no-story") out.story = false;
    else if (a === "--party") out.party = next();
    else if (a === "--out") out.out = next();
    else if (a === "--md") out.md = next();
    else if (a === "--copy-dir") out.copyDir = next();
    else if (a === "--policy") out.policy = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const s = (v) => String(v ?? "").trim();
const pct = (x) => (x == null ? "—" : `${Math.round(100 * x)}%`);
const num = (x, d = 1) => (x == null ? "—" : x.toFixed(d));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function dieCeiling(formula) {
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*$/i.exec(s(formula));
  return m ? Number(m[1]) * Number(m[2]) : null;
}

// Copy the stores the loaders read, then hand back a world "name" that resolves to the
// copy: the loaders join the name under worlds/, and a relative path walks out of it.
function snapshotWorld(world, copyDir) {
  const dest = path.join(copyDir, "data");
  fs.rmSync(copyDir, { recursive: true, force: true });
  for (const c of COLLECTIONS) {
    const src = path.join(worldDataDir(world), c);
    fs.cpSync(src, path.join(dest, c), { recursive: true, filter: (p) => path.basename(p) !== "LOCK" });
  }
  const rel = path.relative(WORLDS_DIR, copyDir);
  if (path.isAbsolute(rel)) throw new Error(`copy dir must be on the same drive as ${WORLDS_DIR}`);
  return rel;
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

// Pure: one table's results -> fights with roll weights. Exported for tests.
function rowsOfTable(table, results) {
  const ceiling = dieCeiling(table.formula);
  const rows = [];
  for (const r of results) {
    const [lo, hi] = r.range ?? [1, 1];
    const top = ceiling == null ? hi : Math.min(hi, ceiling);
    const width = Math.max(0, top - lo + 1);
    const names = s(r.text ?? r.description ?? r.name).split(",").map(s).filter(Boolean);
    if (!names.length) continue;
    rows.push({ range: [lo, hi], width, names });
  }
  const total = rows.reduce((a, r) => a + r.width, 0);
  for (const r of rows) r.weight = total ? r.width / total : 0;
  return { ceiling, rows };
}

// Pure: results -> the line's numbers. Exported for tests.
function summarise(results) {
  const n = results.length;
  const share = (o) => results.filter((r) => r.outcome === o).length / n;
  const wins = results.filter((r) => r.outcome === "victory");
  const rounds = wins.map((r) => r.rounds).sort((a, b) => a - b);
  const hp = wins.map((r) => r.partyHpRemaining).filter((x) => x != null).sort((a, b) => a - b);
  return {
    runs: n,
    win: wins.length / n,
    defeat: share("defeat") + share("mutual-destruction"),
    overtime: share("overtime"),
    roundsP50: quantile(rounds, 0.5), roundsP90: quantile(rounds, 0.9),
    hpP50: quantile(hp, 0.5), hpP10: quantile(hp, 0.1),
    // Every run, not just wins: where an unresolved or lost fight leaves the party.
    hpEndP50: quantile(results.map((r) => r.partyHpRemaining ?? 0).sort((x, y) => x - y), 0.5),
    roundsAllP50: quantile(results.map((r) => r.rounds).sort((x, y) => x - y), 0.5),
    // The party's lowest point during the fight (engine partyHpLow) — the danger signal
    // that healing cannot wash out.
    lowP50: quantile(results.map((r) => r.partyHpLow ?? 1).sort((x, y) => x - y), 0.5),
    anyDown: results.filter((r) => (r.knockedOut ?? r.downs).length > 0).length / n,
    downsPerFight: mean(results.map((r) => r.downs.length)),
  };
}

// Pure: numbers -> notes against the targets. Facts, not verdicts.
function notes(st, kind) {
  const t = TARGETS[kind];
  const out = [];
  if (st.overtime > 0.25) out.push(`unresolved in ${pct(st.overtime)}`);
  if (st.defeat > 0.10) out.push(`party loses ${pct(st.defeat)}`);
  if (st.roundsP50 != null) {
    if (st.roundsP50 < t.rounds[0]) out.push(`rounds below ${t.label}`);
    else if (st.roundsP50 > t.longRounds) out.push(`rounds above long target (${t.longRounds})`);
    else if (st.roundsP50 > t.rounds[1]) out.push(`rounds above ${t.label}`);
  }
  if (st.hpP50 != null && st.hpP50 >= HP_TRIVIAL) out.push(`HP left ≥ ${pct(HP_TRIVIAL)}`);
  else if (st.hpP50 != null && st.hpP50 >= HP_PRESSURE) out.push(`HP left ≥ ${pct(HP_PRESSURE)}`);
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const copyDir = args.copyDir ?? path.join(os.tmpdir(), "fu-encounter-matrix");
  const world = snapshotWorld(args.world, copyDir);

  const all = await loadAll({ world });
  const npcs = new Map();
  for (const a of all) if (a.isNpc && !npcs.has(s(a.name).toLowerCase())) npcs.set(s(a.name).toLowerCase(), a);
  const party = await loadParty({ world, partyName: args.party });
  const partyProblems = party.flatMap(validate);
  if (partyProblems.length) throw new Error(`party model incomplete: ${partyProblems.join("; ")}`);

  const folders = await loadWorldFolders({ world });
  const chain = (id) => {
    const names = [];
    const seen = new Set();
    for (let f = folders.get(id); f && !seen.has(f.id); f = folders.get(f.parent)) { seen.add(f.id); names.unshift(f.name); }
    return names;
  };
  const { tables, results } = await loadTables(world);

  // Gather every fight to run.
  const fights = [];
  for (const t of [...tables.values()].sort((a, b) => s(a.name).localeCompare(s(b.name)))) {
    if (!/ - Encounter$/.test(s(t.name))) continue;
    const fc = chain(t.folder);
    if (fc[0] !== ROOT_FOLDER || !args.dungeons.includes(fc[1])) continue;
    const { ceiling, rows } = rowsOfTable(t, results.get(t._id) ?? []);
    for (const r of rows.sort((a, b) => a.range[0] - b.range[0])) {
      fights.push({ dungeon: fc[1], source: s(t.name), formula: s(t.formula), range: r.range,
        weight: r.weight, rolls: r.width > 0, names: r.names, ceiling });
    }
  }
  if (args.story) {
    for (const d of args.dungeons) for (const names of STORY_FIGHTS[d] ?? []) {
      fights.push({ dungeon: d, source: "story (no table)", range: null, weight: null, rolls: false, names, story: true });
    }
  }

  const partyCov = buildCoverage(party.map((a) => ({ actor: a, side: "party" })));
  const lines = [];
  const t0 = Date.now();
  for (const f of fights) {
    const line = { ...f, enemies: f.names };
    lines.push(line);
    const enemies = [];
    const missing = [];
    for (const raw of f.names) {
      const m = npcs.get(raw.toLowerCase()) ?? npcs.get(raw.replace(/^⭐️?\s*/u, "").toLowerCase());
      if (m) enemies.push(m); else missing.push(raw);
    }
    if (missing.length) { line.error = `no actor named ${missing.join(", ")}`; continue; }
    const starred = f.names.some((n) => n.startsWith("⭐"));
    const turns = enemies.map((e) => e.turnsPerRound ?? 1);
    line.kind = starred || f.story || (enemies.length === 1 && turns[0] > 1) || enemies.some((e) => s(e.rank).toLowerCase() === "champion") ? "boss" : "normal";
    line.level = Math.max(...enemies.map((e) => e.level ?? 0));
    line.enemyHp = enemies.reduce((a, e) => a + (e.hp?.max ?? 0), 0);

    const problems = enemies.flatMap(validate);
    if (problems.length) { line.error = `model incomplete: ${problems.join("; ")}`; continue; }
    const combatants = [...party.map((a) => ({ actor: a, side: "party" })), ...enemies.map((a) => ({ actor: a, side: "enemy" }))];
    const cov = buildCoverage(combatants);
    line.coverage = cov.summary;
    // Party gaps are the same on every line, so the per-line signal is the ENEMY's gaps.
    const enemyGaps = new Map();
    for (const a of cov.perActor) {
      if (a.side !== "enemy") continue;
      for (const u of [...a.unmodelled, ...a.unmodelledUtility]) enemyGaps.set(`${a.name}: ${u.name}`, true);
    }
    line.enemyGaps = [...enemyGaps.keys()];
    const broken = [...new Set(enemies)].map((e) => [e.name, ST.brokenCycle(extractActions(e).actions)]).filter(([, b]) => b);
    if (broken.length) line.brokenCycle = broken.map(([n, b]) => `${n} (${[].concat(b).join(", ")})`);

    const expectedRounds = line.kind === "boss" ? 10 : 7;
    const res = [];
    for (let i = 0; i < args.runs; i++) {
      res.push(runBattle({ party, enemies, rng: new Rng(`${args.seed}:${f.source}:${f.names.join("+")}:${i}`), expectedRounds, policy: args.policy }));
    }
    line.stats = summarise(res);
    line.notes = notes(line.stats, line.kind);
    if (line.brokenCycle) line.notes.unshift(`never acts: ${line.brokenCycle.join("; ")}`);
  }

  const report = {
    id: "encounter-matrix", generated: new Date().toISOString(), seed: args.seed, runs: args.runs, policy: args.policy,
    partyCoverage: partyCov.summary,
    party: party.map((p) => `${p.name} L${p.level ?? "?"}`), dungeons: args.dungeons,
    caveat: "Sim party plays below a human table: low-pressure numbers are reliable, high-pressure ones overstate difficulty. Numbers, not verdicts.",
    targets: TARGETS, lines,
  };
  const md = renderMarkdown(report);
  console.log(md);
  console.log(`\n${lines.length} fights × ${args.runs} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (args.out) { fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + "\n"); console.log(`wrote ${args.out}`); }
  if (args.md) { fs.writeFileSync(path.resolve(args.md), md + "\n"); console.log(`wrote ${args.md}`); }
  fs.rmSync(copyDir, { recursive: true, force: true });
}

function renderMarkdown(r) {
  const out = [];
  out.push(`# Encounter Matrix — ${r.dungeons.join(" + ")}`);
  out.push("");
  out.push(`${r.generated.slice(0, 10)} · ${r.runs} runs per fight · seed \`${r.seed}\` · party policy **${r.policy ?? "legacy"}** · party: ${r.party.join(", ")}`);
  out.push("");
  out.push(`> ${r.caveat}`);
  out.push("");
  if ((r.policy ?? "legacy") === "legacy") {
    out.push(`Party model: ${r.partyCoverage} — the same on every line.`);
  } else {
    out.push(`Party model: the **${r.policy}** policy (lib/party-policy.js) also plays Zero Power, IP items and revives, element swaps, Adoration skills, Warning Shot, Stop and Prophetic Defender. Still not modelled:`);
    for (const x of PP.NOT_PORTED) out.push(`- ${x}`);
  }
  out.push("");
  out.push(`Targets: normal ${TARGETS.normal.label} (long ≤ ${TARGETS.normal.longRounds}), boss ${TARGETS.boss.label} (long ${TARGETS.boss.longRounds}); party HP left at victory under ${pct(HP_PRESSURE)}, ${pct(HP_TRIVIAL)}+ = trivial.`);
  for (const d of r.dungeons) {
    const ls = r.lines.filter((l) => l.dungeon === d);
    if (!ls.length) continue;
    out.push("");
    out.push(`## ${d}`);
    out.push("");
    out.push("| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Win | Rounds p50 / p90 | HP left p50 / p10 | Any PC down | Against targets | Enemy actions not modelled |");
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const l of ls) {
      const range = l.range ? `${l.range[0]}-${l.range[1]}` : "story";
      const rolls = l.story ? "—" : l.rolls ? pct(l.weight) : "never (above die)";
      if (l.error) { out.push(`| ${range} | ${rolls} | ${l.enemies.join(", ")} | | | | | | | | ⚠ ${l.error} | |`); continue; }
      const st = l.stats;
      out.push(`| ${range} | ${rolls} | ${l.enemies.join(", ")} | ${l.kind} | ${l.level} | ${l.enemyHp} | ${pct(st.win)} | ${num(st.roundsP50)} / ${num(st.roundsP90)} | ${pct(st.hpP50)} / ${pct(st.hpP10)} | ${pct(st.anyDown)} | ${l.notes.join("; ") || "on target"} | ${l.enemyGaps.length ? l.enemyGaps.join("; ") : "—"} |`);
    }
  }
  out.push("");
  out.push("Rolls = share of the table's die. \"Any PC down\" = runs where at least one PC hit 0 HP. Enemy actions not modelled = the sim never uses them, so that monster is weaker in the sim than at the table.");
  return out.join("\n");
}

module.exports = { rowsOfTable, summarise, notes, snapshotWorld };
if (require.main === module) main().catch((e) => { console.error(`\nencounter-matrix failed: ${e.stack || e.message}\n`); process.exit(1); });
