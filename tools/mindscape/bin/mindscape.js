#!/usr/bin/env node
"use strict";
//
// Mindscape — offline Monte Carlo balance runs.
//
//   node bin/mindscape.js --enemies "Inferex,Centuaros" --runs 2000
//   node bin/mindscape.js --enemies Asura --runs 500 --seed asura-v3
//   node bin/mindscape.js --enemies Kirin --runs 1000 --force   (report anyway)
//
// The game must be CLOSED — Foundry holds an exclusive lock on the world DB.

const { loadParty, loadNamed, validate, resolveCurrentGame } = require("../lib/load-actors");
const { buildCoverage, extractActions } = require("../lib/skills");
const { runBattle } = require("../lib/engine");
const { resolveEvent } = require("../lib/conflict-events");
const RX = require("../lib/reactions");
const { Rng } = require("../lib/rng");

function parseArgs(argv) {
  const out = { runs: 1000, seed: "mindscape", force: false, verbose: false, expectedRounds: 7 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--enemies" || a === "-e") out.enemies = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--runs" || a === "-n") out.runs = Number(next());
    else if (a === "--seed") out.seed = next();
    else if (a === "--party") out.partyName = next();
    else if (a === "--expected") out.expectedRounds = Number(next());
    else if (a === "--force") out.force = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--conflict-event" || a === "-c") out.conflictEvent = next();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function pct(x) { return x == null ? "—" : `${(x * 100).toFixed(0)}%`; }

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// The verdict language is deliberately opinionated — the whole point of the tool
// is to stop hedging about whether a fight landed. Thresholds from
// project_fight_balance_playbook, observed in live runs.
function verdict(stats) {
  const r = stats.medianRounds;
  const hp = stats.medianHp;
  if (stats.outcomes.overtime / stats.runs > 0.25) {
    return `UNRESOLVED in ${pct(stats.outcomes.overtime / stats.runs)} of runs — neither side closes it out. That is a design failure, not a hard fight.`;
  }
  if (stats.outcomes.defeat / stats.runs > 0.5) return `DEFEAT in ${pct(stats.outcomes.defeat / stats.runs)} of runs — this is a wall.`;
  if (hp >= 0.85) return `TRIVIAL — median ${r} rounds at ${pct(hp)} party HP. The party was never in danger.`;
  if (hp >= 0.70) return `TOO EASY — median ${r} rounds at ${pct(hp)} party HP. No real pressure.`;
  if (hp >= 0.40) return `A REAL FIGHT — median ${r} rounds at ${pct(hp)} party HP.`;
  return `A CLOSE CALL — median ${r} rounds at ${pct(hp)} party HP.`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.enemies?.length) {
    console.log(`
Mindscape — offline Monte Carlo balance runs (game must be CLOSED)

  --enemies, -e  comma-separated actor names   (required)
  --runs, -n     iterations (default 1000)
  --seed         run label, for reproducibility (default "mindscape")
  --party        override the Current Game party
  --expected     round budget before "unresolved" (default 7)
  --force        report even when coverage is below the bar
  --verbose, -v  print every coverage warning
  --conflict-event, -c  scene rule to layer on (e.g. lightning-storm).
                 NEVER auto-read from the scene — pass it explicitly, or the
                 hazard is silently absent. The whole Valley of the Dragon
                 roster is built around one.
`);
    process.exit(args.help ? 0 : 1);
  }

  const game = await resolveCurrentGame();
  const party = await loadParty({ partyName: args.partyName });
  const enemies = await loadNamed(args.enemies);

  console.log(`\nMindscape — ${game.gameName}  ·  ${game.partyName}`);
  console.log(`${party.map((p) => p.name).join(", ")}  vs  ${enemies.map((e) => `${e.name} (L${e.level}, ${e.turnsPerRound} act)`).join(" + ")}`);

  // Structural validation first: a model that could not fight must never be
  // mistaken for a fight result.
  const problems = [...party, ...enemies].flatMap(validate);
  if (problems.length) {
    console.error(`\nREFUSING — the combat model is incomplete:`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(2);
  }

  // Coverage second. Silence about a gap is the failure mode.
  const combatants = [
    ...party.map((a) => ({ actor: a, side: "party" })),
    ...enemies.map((a) => ({ actor: a, side: "enemy" })),
  ];
  const cov = buildCoverage(combatants);
  console.log(`\nCoverage: ${cov.summary}`);
  for (const a of cov.perActor) {
    const gaps = a.unmodelled.length + a.unmodelledUtility.length;
    console.log(`  ${a.name.padEnd(11)} damage=${String(a.damageActions).padStart(2)} utility=${String(a.utility).padStart(2)} passive=${String(a.passives).padStart(2)}${gaps ? `   gaps=${gaps}` : ""}`);
  }
  if (args.verbose) { console.log(); for (const w of cov.warnings) console.log(`  ⚠ ${w}`); }

  // Reaction coverage, reported SEPARATELY from the turn-spendable bar. A
  // reaction is not turn-spendable, so folding it into that percentage would
  // change what the bar means; but leaving it out of the printout entirely is
  // how the whole layer stayed invisible in the first place.
  const rxLines = [];
  for (const c of combatants) {
    const ex = extractActions(c.actor);
    const declared = RX.declaredReactions(ex.passives).map((r) => r.name);
    const undeclared = RX.undeclaredReactions(ex.passives);
    if (declared.length || undeclared.length) rxLines.push({ name: c.actor.name, declared, undeclared });
  }
  const totDeclared = rxLines.reduce((s, r) => s + r.declared.length, 0);
  if (totDeclared || rxLines.some((r) => r.undeclared.length)) {
    console.log(`\nReactions: ${totDeclared} modelled`
      + `, ${rxLines.reduce((s, r) => s + r.undeclared.length, 0)} not in the registry (lib/reactions.js)`);
    for (const r of rxLines) {
      if (r.declared.length) console.log(`  ✓ ${r.name.padEnd(11)} ${r.declared.join(", ")}`);
      if (r.undeclared.length && args.verbose) console.log(`  · ${r.name.padEnd(11)} unmodelled: ${r.undeclared.join(", ")}`);
    }
  }

  const conflictEvent = args.conflictEvent ? resolveEvent(args.conflictEvent) : null;
  console.log(`\nConflict event: ${conflictEvent ? conflictEvent.label : "none"}`);

  if (cov.refuse && !args.force) {
    console.error(`
REFUSING TO REPORT — ${cov.summary}, over the ${pct(cov.threshold)} bar.

Past this share the numbers describe a fight nobody is playing. Declare the
missing actions in the utility registry (lib/skills.js) or re-run with --force
if you accept a partial model. Use --verbose to see every gap.`);
    process.exit(3);
  }
  if (cov.refuse) console.log(`\n⚠ FORCED past the coverage bar — these numbers describe a partial model.`);

  // ── Run ───────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const rounds = [], hps = [], dprs = [], rds = [];
  const outcomes = { victory: 0, defeat: 0, overtime: 0, "mutual-destruction": 0, inconclusive: 0 };
  const downs = new Map();

  for (let i = 0; i < args.runs; i++) {
    const rng = new Rng(`${args.seed}:${i}`);
    const r = runBattle({ party, enemies, rng, expectedRounds: args.expectedRounds, conflictEvent });
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    rounds.push(r.rounds);
    if (r.partyHpRemaining != null) hps.push(r.partyHpRemaining);
    dprs.push(r.baselineDpr);
    rds.push(r.roundDensity);
    for (const d of r.downs) downs.set(d.name, (downs.get(d.name) ?? 0) + 1);
  }

  const sr = rounds.slice().sort((a, b) => a - b);
  const sh = hps.slice().sort((a, b) => a - b);
  const stats = {
    runs: args.runs, outcomes,
    medianRounds: quantile(sr, 0.5),
    medianHp: quantile(sh, 0.5),
  };

  console.log(`\n${"─".repeat(64)}`);
  console.log(verdict(stats));
  console.log(`${"─".repeat(64)}`);

  console.log(`\nrounds     min ${sr[0]}  p25 ${quantile(sr, 0.25)}  median ${quantile(sr, 0.5)}  p75 ${quantile(sr, 0.75)}  max ${sr[sr.length - 1]}`);
  console.log(`party HP   p25 ${pct(quantile(sh, 0.25))}  median ${pct(quantile(sh, 0.5))}  p75 ${pct(quantile(sh, 0.75))}`);

  const hist = new Map();
  for (const r of rounds) hist.set(r, (hist.get(r) ?? 0) + 1);
  console.log(`\nround histogram`);
  for (const k of [...hist.keys()].sort((a, b) => a - b)) {
    const n = hist.get(k);
    console.log(`  ${String(k).padStart(2)}  ${"█".repeat(Math.max(1, Math.round((n / args.runs) * 50)))} ${pct(n / args.runs)}`);
  }

  console.log(`\noutcomes`);
  for (const [k, v] of Object.entries(outcomes)) if (v) console.log(`  ${k.padEnd(20)} ${pct(v / args.runs)}`);

  if (downs.size) {
    console.log(`\nper-PC down rate  (one PC going down early snowballs — this is the tell)`);
    for (const [name, n] of [...downs].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name.padEnd(11)} ${pct(n / args.runs)}`);
    }
  } else {
    console.log(`\nno PC went down in any run.`);
  }

  // The constants the Play Efficiency model needs re-derived. Counted in two
  // classes so they cannot double-count (spec D3).
  const meanDpr = dprs.reduce((a, b) => a + b, 0) / dprs.length;
  const meanRd = rds.reduce((a, b) => a + b, 0) / rds.length;
  const anyDowns = [...downs.values()].some((n) => n > 0);
  console.log(`\nmeasured constants  (feed docs/monster-balance-design.md)`);
  console.log(`  BaselineDPR   ${meanDpr.toFixed(1)}   (party damage / round, base actions only)`);
  console.log(`  RoundDensity  ${meanRd.toFixed(2)}   (actions / headcount / round)`);

  // These constants are only meaningful from a fight the party actually fights.
  // Publishing them off a losing run would bake a defeat into the HP tables.
  if (anyDowns) {
    console.log(`  ⚠ PCs went down in these runs, so both constants are UNDER-measured —`);
    console.log(`    a downed PC stops acting and stops dealing damage. Re-derive them`);
    console.log(`    from a fight the party wins cleanly, never from this one.`);
  } else if (meanRd < 1.0001) {
    console.log(`  ⚠ RD is ${meanRd.toFixed(2)} — at or below 1.00, so no free actions were`);
    console.log(`    granted. The party demonstrably has them (Acceleration, High Speed,`);
    console.log(`    Dance, Barrage), so this means the grants are still unmodelled in the`);
    console.log(`    utility registry. Do NOT publish this as the real Round Density.`);
  }

  console.log(`\n${args.runs} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s  ·  seed "${args.seed}"\n`);
}

main().catch((e) => { console.error(`\nMindscape failed: ${e.message}\n`); process.exit(1); });
