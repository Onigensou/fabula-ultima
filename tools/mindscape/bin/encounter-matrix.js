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
const { loadAll, loadParty, validate, loadSummons } = require("../lib/load-actors");
const { loadStatusLibrary } = require("../lib/world-items");
const { loadDungeonEvents, eventMix } = require("../lib/dungeon-events");
const { runLine } = require("../lib/line-runner");
const MD = require("../lib/monster-data");
const { loadWorldFolders } = require("../lib/baseline-gear");
const { buildCoverage, extractActions } = require("../lib/skills");
const ST = require("../lib/stances");
const { runBattle } = require("../lib/engine");
const PP = require("../lib/party-policy");
const { Rng } = require("../lib/rng");

const ROOT_FOLDER = "The Legend of Dragonslayer";
const COLLECTIONS = ["actors", "tables", "folders", "items", "scenes"];

// Story-started fights that sit in no Encounter table (chapter tracker, 2026-10-19).
const STORY_FIGHTS = {
  // Flame Drake and Lightning Drake are NOT listed: they are adds Fafnir summons mid-fight
  // (Summon Elemental Drake), so judging them alone, one action against the whole party,
  // says nothing. They belong to the Fafnir fight, which Mindscape cannot simulate yet.
  // Asura and Rakshasa are counterpart standalone elites met in story events (Asura left the
  // Encounter table 2026-10-20; both stay on the Enemies table so the GM can spawn them).
  "Valley of the Dragon": [["⭐️ Fafnir"], ["Rakshasa"], ["Asura"]],
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
    // "data": each monster plays from its own reaction / effect / pattern tables
    // (lib/monster-data.js), turns alternate as in the Battle Director. "registry": the
    // hand-written passives and Mindscape's block turn order, as before 2026-10-20.
    monsterRules: "data",
    // "auto": each Encounter table's rows are fought under the conflict events of the
    // battle maps its floors launch onto, by Random Battle tile share. "none": no event.
    events: "auto",
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
    else if (a === "--monster-rules") out.monsterRules = next();
    else if (a === "--events") out.events = next();
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
  // An escape (Roo leaving once it has no allies) ends the fight with the party standing:
  // resolved for length and danger, and counted on its own as well.
  const wins = results.filter((r) => r.outcome === "victory" || r.outcome === "escaped");
  const rounds = wins.map((r) => r.rounds).sort((a, b) => a - b);
  const hp = wins.map((r) => r.partyHpRemaining).filter((x) => x != null).sort((a, b) => a - b);
  return {
    runs: n,
    win: wins.length / n,
    defeat: share("defeat") + share("mutual-destruction"),
    overtime: share("overtime"),
    escaped: share("escaped"),
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
  const statusLibrary = args.monsterRules === "data" ? await loadStatusLibrary({ world }) : null;
  const dungeonEvents = args.events === "auto" ? await loadDungeonEvents({ world }) : new Map();

  // Gather every fight to run.
  const fights = [];
  for (const t of [...tables.values()].sort((a, b) => s(a.name).localeCompare(s(b.name)))) {
    if (!/ - Encounter$/.test(s(t.name))) continue;
    const fc = chain(t.folder);
    if (fc[0] !== ROOT_FOLDER || !args.dungeons.includes(fc[1])) continue;
    const { ceiling, rows } = rowsOfTable(t, results.get(t._id) ?? []);
    for (const r of rows.sort((a, b) => a.range[0] - b.range[0])) {
      fights.push({ dungeon: fc[1], source: s(t.name), formula: s(t.formula), range: r.range,
        weight: r.weight, rolls: r.width > 0, names: r.names, ceiling, tableId: t._id });
    }
  }
  if (args.story) {
    for (const d of args.dungeons) for (const names of STORY_FIGHTS[d] ?? []) {
      fights.push({ dungeon: d, source: "story (no table)", range: null, weight: null, rolls: false, names, story: true });
    }
  }

  const summonCache = new Map();
  async function loadSummonsCached(enemies) {
    const k = enemies.map((e) => e.id).join(",");
    if (!summonCache.has(k)) summonCache.set(k, await loadSummons(enemies, { world }));
    return summonCache.get(k);
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
    // A status-gated action that nothing grants is locked out. That only stops the
    // monster acting when it has NO ungated action; otherwise it is one unused move
    // (Gigas never Bodyslams in the sim, but swings every turn).
    const broken = [], unused = [];
    for (const e of args.monsterRules === "data" ? [] : new Set(enemies)) {
      const acts = extractActions(e).actions;
      const b = ST.brokenCycle(acts);
      if (!b) continue;
      if (acts.some((a) => !a.stanceRequires && !a.stanceGrants)) {
        unused.push(`${e.name}: ${acts.filter((a) => a.stanceRequires).map((a) => a.name).join(", ")} (needs ${[].concat(b).join(", ")})`);
      } else {
        broken.push(`${e.name} (${[].concat(b).join(", ")})`);
      }
    }
    if (broken.length) line.brokenCycle = broken;
    if (unused.length) line.unusedActions = unused;

    const expectedRounds = line.kind === "boss" ? 10 : 7;
    const summons = args.monsterRules === "data" ? await loadSummonsCached(enemies) : null;
    const mix = eventMix(f.tableId ? dungeonEvents.get(f.tableId) : null);
    line.events = mix.map((e) => ({ id: e.event, share: e.share, tiles: e.tiles, battleMaps: e.battleMaps }));
    if (args.monsterRules === "data") line.dataCoverage = [...new Set(enemies)].map((e) => ({ name: e.name, gaps: MD.coverage(e) })).filter((x) => x.gaps.length);
    const gaps = {};
    const { all: res, byEvent } = runLine({ party, enemies, events: line.events, runs: args.runs, seed: `${args.seed}:${f.source}:${f.names.join("+")}`,
      expectedRounds, policy: args.policy, monsterRules: args.monsterRules, statusLibrary, summons,
      onResult: (r) => { for (const [g, c] of Object.entries(r.dataGaps ?? {})) gaps[g] = (gaps[g] ?? 0) + c; } });
    line.byEvent = {};
    if (mix.length > 1 || mix[0].event) for (const [id, b] of Object.entries(byEvent)) line.byEvent[id] = { share: b.share, stats: summarise(b.results) };
    if (Object.keys(gaps).length) line.dataGaps = Object.keys(gaps).map((g) => { const [who, kind, what] = g.split("|"); return { who, kind, what, runs: gaps[g] }; });
    line.stats = summarise(res);
    line.notes = notes(line.stats, line.kind);
    if (line.brokenCycle) line.notes.unshift(`never acts: ${line.brokenCycle.join("; ")}`);
  }

  const report = {
    id: "encounter-matrix", generated: new Date().toISOString(), seed: args.seed, runs: args.runs, policy: args.policy,
    monsterRules: args.monsterRules, events: args.events,
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
  out.push(`${r.generated.slice(0, 10)} · ${r.runs} runs per fight · seed \`${r.seed}\` · party policy **${r.policy ?? "legacy"}** · monster rules **${r.monsterRules ?? "registry"}** · conflict events **${r.events ?? "none"}** · party: ${r.party.join(", ")}`);
  if ((r.monsterRules ?? "registry") === "data") {
    out.push("");
    out.push("Monsters play from their own reaction / effect / action-pattern tables (lib/monster-data.js) and turns alternate between sides as in the Battle Director. Each Valley row is fought under the conflict event of the battle map its floors launch onto, in proportion to the Random Battle tiles on those floors.");
  }
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
    out.push("| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Event | Win | Rounds p50 / p90 | HP left p50 / p10 | Lowest party HP p50 | Any PC down | Against targets | Not simulated |");
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const l of ls) {
      const range = l.range ? `${l.range[0]}-${l.range[1]}` : "story";
      const rolls = l.story ? "—" : l.rolls ? pct(l.weight) : "never (above die)";
      if (l.error) { out.push(`| ${range} | ${rolls} | ${l.enemies.join(", ")} | | | | | | | | | | ⚠ ${l.error} | |`); continue; }
      const st = l.stats;
      const evs = Object.entries(l.byEvent ?? {});
      const ev = evs.length ? evs.map(([id, b]) => `${id} ${pct(b.share)}: win ${pct(b.stats.win)}, low ${pct(b.stats.lowP50)}`).join("<br>") : "none";
      const gaps = (r.monsterRules ?? "registry") === "data"
        ? [...(l.dataCoverage ?? []).flatMap((c) => c.gaps.map((g) => `${c.name}: ${g}`)), ...(l.dataGaps ?? []).filter((g) => g.kind !== "decided at the table").map((g) => `${g.who}: ${g.what} (${g.kind})`)]
        : l.enemyGaps;
      out.push(`| ${range} | ${rolls} | ${l.enemies.join(", ")} | ${l.kind} | ${l.level} | ${l.enemyHp} | ${ev} | ${pct(st.win)} | ${num(st.roundsP50)} / ${num(st.roundsP90)} | ${pct(st.hpP50)} / ${pct(st.hpP10)} | ${pct(st.lowP50)} | ${pct(st.anyDown)} | ${l.notes.join("; ") || "on target"} | ${gaps.length ? [...new Set(gaps)].join("; ") : "—"} |`);
    }
  }
  out.push("");
  out.push("Rolls = share of the table's die. \"Any PC down\" = runs where at least one PC hit 0 HP. Not simulated = what the sim cannot run for that monster (in data mode: a decision a person makes at the table, or an effect / trigger the interpreter does not know), so it plays weaker in the sim than at the table. Event = the conflict event and its share of the row's runs, with that event's own win rate and median lowest party HP.");
  return out.join("\n");
}

module.exports = { rowsOfTable, summarise, notes, snapshotWorld };
if (require.main === module) main().catch((e) => { console.error(`\nencounter-matrix failed: ${e.stack || e.message}\n`); process.exit(1); });
