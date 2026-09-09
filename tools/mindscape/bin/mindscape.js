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
const { loadEnemyFiles } = require("../lib/enemy-file");
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
    else if (a === "--enemy-file" || a === "-f") (out.enemyFiles = out.enemyFiles ?? []).push(next());
    else if (a === "--set") (out.sets = out.sets ?? []).push(next());
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
  if (args.help || (!args.enemies?.length && !args.enemyFiles?.length)) {
    console.log(`
Mindscape — offline Monte Carlo balance runs (game must be CLOSED)

  --enemies, -e  comma-separated actor names from the world
  --enemy-file, -f  JSON spec for a monster that does not exist yet (repeatable).
                 Lets a design be measured BEFORE it is built. A spec is an
                 actor document with the same system.props keys, loaded through
                 the same model as a world actor. See specs/ for an example.
                 One of --enemies or --enemy-file is required.
  --runs, -n     iterations (default 1000)
  --seed         run label, for reproducibility (default "mindscape")
  --party        override the Current Game party
  --expected     round budget before "unresolved" (default 7)
  --set          patch a loaded enemy in memory, repeatable:
                 --set "Saber:damage_bonus=70"  or  --set "actor:max_hp=1000".
                 Sweeps the REAL built actor without editing the world.
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
  const enemies = [
    ...(args.enemies?.length ? await loadNamed(args.enemies) : []),
    ...(args.enemyFiles?.length ? loadEnemyFiles(args.enemyFiles) : []),
  ];

  console.log(`\nMindscape — ${game.gameName}  ·  ${game.partyName}`);
  // Say it loudly. A verdict about a monster that does not exist yet is a
  // different kind of claim from one about a monster on the sheet, and the
  // distinction must survive being pasted into a design doc.
  const paper = enemies.filter((e) => e.fromSpec);
  if (paper.length) {
    console.log(`⚠ PAPER DESIGN — ${paper.map((e) => e.name).join(", ")} `
      + `loaded from a spec file, not the world. These numbers describe a proposal.`);
  }
  // --set patches a loaded enemy IN MEMORY, so a dial can be swept against the
  // real built actor instead of a hand-maintained spec copy that drifts from it.
  // Nothing is written back; the world is opened read-only either way.
  for (const spec of args.sets ?? []) {
    const m = /^([^:]+):([^=]+)=(.*)$/.exec(spec);
    if (!m) { console.error('bad --set (want "Item:prop=value" or "actor:prop=value"): ' + spec); process.exit(2); }
    const [, whoRaw, propRaw, value] = m;
    const who = whoRaw.trim(), prop = propRaw.trim();
    let hits = 0;
    for (const e of enemies) {
      if (who.toLowerCase() === 'actor') {
        e._rawProps[prop] = value;
        // The loader DERIVES the scalars the engine actually reads (hp.max,
        // def, ...) at load time, so patching the raw prop alone is a silent
        // no-op: the run looks patched and behaves exactly as before.
        const n = Number(value);
        if (Number.isFinite(n)) {
          if (prop === 'max_hp') e.hp.max = n;
          else if (prop === 'current_hp') e.hp.cur = n;
          else if (prop === 'max_mp') e.mp.max = n;
          else if (prop === 'current_mp') e.mp.cur = n;
          else if (prop === 'defense') e.def = n;
          else if (prop === 'magic_defense') e.mdef = n;
        }
        hits++; continue;
      }
      for (const it of e.items ?? []) {
        if (String(it.name).trim().toLowerCase() !== who.toLowerCase()) continue;
        it.props[prop] = value; hits++;
      }
    }
    // A typo in an item name would otherwise sweep a dial that changes nothing
    // and read as 'this knob does not matter'.
    if (!hits) { console.error('--set matched nothing: ' + spec); process.exit(2); }
    console.log('  --set ' + who + '.' + prop + ' = ' + value + '  (' + hits + ' match' + (hits === 1 ? '' : 'es') + ')');
  }

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
  const lanes = new Map();
  const crisis = [];
  // Enemy-side pressure. baselineDpr answers how fast the PARTY kills; a
  // designer tuning a boss damage number needs the other direction, and the
  // engine already tracks damageDealt per combatant on both sides.
  const eDprs = [], ePools = [], eByName = new Map();

  for (let i = 0; i < args.runs; i++) {
    const rng = new Rng(`${args.seed}:${i}`);
    const r = runBattle({ party, enemies, rng, expectedRounds: args.expectedRounds, conflictEvent });
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    rounds.push(r.rounds);
    if (r.partyHpRemaining != null) hps.push(r.partyHpRemaining);
    dprs.push(r.baselineDpr);
    rds.push(r.roundDensity);
    for (const d of r.downs) downs.set(d.name, (downs.get(d.name) ?? 0) + 1);
    {
      const cs = r.combatants ?? [];
      let dealt = 0;
      for (const c of cs) {
        if (c.side !== 'enemy') continue;
        dealt += c.damageDealt ?? 0;
        const acc = eByName.get(c.name) ?? { dealt: 0, rounds: 0 };
        acc.dealt += c.damageDealt ?? 0; acc.rounds += r.rounds;
        eByName.set(c.name, acc);
      }
      if (r.rounds) eDprs.push(dealt / r.rounds);
      const pool = cs.filter((c) => c.side === 'party').reduce((t, c) => t + (c.maxHp ?? 0), 0);
      if (pool) ePools.push(pool);
    }
    for (const c of r.crisisRounds ?? []) if (c.round != null) crisis.push(c.round);
    if (r.laneReport) {
      for (const [fam, l] of Object.entries(r.laneReport)) {
        const acc = lanes.get(fam) ?? { swings: 0, effSum: 0 };
        acc.swings += l.swings;
        acc.effSum += l.meanEfficiency * l.swings;
        lanes.set(fam, acc);
      }
    }
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
  const meanEDpr = eDprs.length ? eDprs.reduce((a, b) => a + b, 0) / eDprs.length : 0;
  const meanPool = ePools.length ? ePools.reduce((a, b) => a + b, 0) / ePools.length : 0;
  // When the phase change lands. A boss whose Crisis passive is the whole second
  // half of the fight needs this as directly as it needs the round count: a
  // phase that arrives on the last round is a phase that never happened. Printed
  // only when at least one enemy actually reached Crisis.
  if (crisis.length) {
    const sc = crisis.slice().sort((a, b) => a - b);
    const share = crisis.length / (args.runs * enemies.length);
    console.log(`\ncrisis reached  round p25 ${quantile(sc, 0.25).toFixed(1)}`
      + `  median ${quantile(sc, 0.5).toFixed(1)}`
      + `  p75 ${quantile(sc, 0.75).toFixed(1)}`
      + `   (in ${pct(share)} of runs)`);
    const med = quantile(sc, 0.5);
    const endRounds = stats.medianRounds;
    if (endRounds) {
      const frac = med / endRounds;
      console.log(`  the phase change lands ${pct(frac)} of the way through the fight`
        + ` (round ${med.toFixed(1)} of ${endRounds})`);
    }
  }

  // The other half of the read: how hard the enemy side hits, in the same
  // units and over the same fight as BaselineDPR. Tuning a boss damage number
  // from party-HP-remaining alone is guesswork, because healing hides in it.
  if (meanEDpr > 0) {
    console.log('');
    console.log('enemy pressure  (how hard the other side hits)');
    console.log('  EnemyDPR      ' + meanEDpr.toFixed(1) + '   (damage dealt to the party / round)');
    if (meanPool) {
      console.log('  party pool    ' + meanPool.toFixed(0) + ' HP  ->  ' + pct(meanEDpr / meanPool) + ' of the pool per round');
      console.log('  rounds to wipe ' + (meanPool / meanEDpr).toFixed(1) + '  (ignoring healing and revives)');
    }
    if (eByName.size > 1) {
      for (const [n, acc] of [...eByName.entries()].sort((a, b) => b[1].dealt - a[1].dealt)) {
        console.log('  ' + n.padEnd(16) + (acc.rounds ? acc.dealt / acc.rounds : 0).toFixed(1) + ' /round');
      }
    }
    console.log('  - Damage DEALT, before healing. Party HP remaining is the net figure.');
  }

  // Weapon-lane pressure. Printed only when something actually read weapon
  // families, so ordinary fights are unaffected.
  //
  // A rotation mechanic is DESIGNED as a tempo and EXPERIENCED as a multiplier,
  // and those agree only if the party can field as many lanes as the window
  // expects. `lanes` is that reality check: how many distinct families the party
  // brought, how its damage was spread across them, and what efficiency each one
  // actually swung at.
  if (lanes.size) {
    const totalSwings = [...lanes.values()].reduce((s, l) => s + l.swings, 0);
    console.log(`\nweapon lanes  (${lanes.size} distinct famil${lanes.size === 1 ? "y" : "ies"} fielded by the party)`);
    const rows = [...lanes.entries()].sort((a, b) => b[1].swings - a[1].swings);
    for (const [fam, l] of rows) {
      const share = totalSwings ? l.swings / totalSwings : 0;
      const meanEff = l.swings ? l.effSum / l.swings : 100;
      console.log(`  ${fam.padEnd(10)} ${pct(share).padStart(4)} of swings   mean efficiency ${meanEff.toFixed(0)}%`);
    }
    // ⚠ Read this carefully before concluding anything about a rotation design.
    //
    // These means are for the party AS MODELLED, and the model does not adapt:
    // `chooseAction` already prefers whichever lane projects highest (efficiency
    // is inside projectDamage), but each PC only ever has the ONE weapon they
    // have equipped, and nothing swaps weapons mid-fight. A real party told
    // "vary your weapon" varies it; this one cannot.
    //
    // So a low mean here measures the UNADAPTED case — the floor, not the
    // expected case. It is evidence about how hard the mechanic punishes
    // repetition, NOT evidence that the rotation cannot be performed.
    console.log(`  · Means are for the party as modelled, which does NOT swap weapons.`);
    console.log(`    Treat them as the unadapted floor, not the expected case.`);
    if (lanes.size < 4) {
      console.log(`  · Only ${lanes.size} lanes were fielded, so a window wider than ${lanes.size} never`);
      console.log(`    opened in these runs. Check whether the party is CARRYING other`);
      console.log(`    weapon categories before reading that as a property of the design.`);
    }
  }

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
