#!/usr/bin/env node
"use strict";
//
// Mindscape vs the live (in-game) sim — the calibration step of the balance review.
//
// Runs the same fights through Mindscape under every party policy, in the SAME scenario
// the live sim defaults to (no Zero Power, no Phoenix Feathers, 3 Fabula Points, no
// guests), and lines the numbers up against a live results file collected through the
// test bridge.
//
//   node bin/calibrate-live.js --live <live-results.json> [--runs 2000] [--out expectations/live-calibration.json]
//        [--monster-rules data|registry] [--policies standard,expert]
//
// PARITY (step 3 of the balance-review plan): each fight is judged AGREES or DRIFTS for
// the first listed policy. A live batch is small (4-5 runs), so the win-rate tolerance is
// the wider of 20 points and the 95% band of the live sample; rounds may differ by 1.5.
// Exit code 2 when anything drifts, so a scheduled run can flag it.
//
// Live results file: { results: [{ fight, run, outcome, rounds, hp }], plan: [{ id, enemies: [{ name, quantity }] }] }
// Reads a COPY of the world (encounter-matrix.snapshotWorld).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");
const { loadParty, loadNamed, loadSummons } = require("../lib/load-actors");
const { loadStatusLibrary } = require("../lib/world-items");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");
const { snapshotWorld } = require("./encounter-matrix");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const pct = (x) => (x == null ? "  —" : `${String(Math.round(100 * x)).padStart(3)}%`);
const num = (x, d = 1) => (x == null ? " —" : x.toFixed(d));
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// The live sim's run() defaults: startingZp 0, phoenixFeathers 0, fabulaPoints 3.
function liveScenario(party) {
  for (const p of party) {
    p.zp = 0;
    p.fabulaPoints = 3;
    p.items = (p.items ?? []).filter((it) => !/^phoenix feather$/i.test(String(it.name).trim()));
  }
  return party;
}

function summarise(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.outcome === "victory");
  return {
    n,
    win: n ? wins.length / n : null,
    overtime: n ? rows.filter((r) => r.outcome === "overtime").length / n : null,
    roundsWin: median(wins.map((r) => r.rounds)),
    hpWin: median(wins.map((r) => r.hp)),
  };
}

// AGREES / DRIFTS, with the reason. Fights with no usable live run are UNKNOWN.
// Exact binomial test: if the sim's win rate were the truth, how likely is a live result
// at least this far out? Under 5% = drifts. Honest at n = 4, unlike a fixed band.
function binomTail(n, k, p, upper) {
  const c = (n, r) => { let x = 1; for (let i = 0; i < r; i++) x = (x * (n - i)) / (i + 1); return x; };
  let t = 0;
  for (let i = upper ? k : 0; upper ? i <= n : i <= k; i++) t += c(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  return t;
}
function parity(liveS, mine) {
  if (!liveS?.n || !mine?.n) return { verdict: "unknown", why: "no usable live runs" };
  const k = Math.round(liveS.win * liveS.n);
  const p = Math.min(0.999, Math.max(0.001, mine.win));
  const upper = liveS.win >= mine.win;
  const tail = binomTail(liveS.n, k, p, upper);
  const why = [];
  if (tail < 0.05) why.push(`live won ${k}/${liveS.n}; at the sim's ${Math.round(100 * mine.win)}% that happens ${(100 * tail).toFixed(1)}% of the time`);
  if (liveS.roundsWin != null && mine.roundsWin != null && Math.abs(mine.roundsWin - liveS.roundsWin) > 1.5) why.push(`rounds ${liveS.roundsWin} live vs ${mine.roundsWin} sim`);
  return { verdict: why.length ? "drifts" : "agrees", why: why.join("; ") || `live ${k}/${liveS.n} is plausible at the sim's ${Math.round(100 * mine.win)}% (p=${tail.toFixed(2)})`,
    direction: upper ? "sim harder than live" : "sim easier than live", p: tail };
}

async function main() {
  const liveFile = arg("--live", null);
  const runs = Number(arg("--runs", 2000));
  const out = arg("--out", null);
  if (!liveFile) { console.error("usage: node bin/calibrate-live.js --live <file> [--runs N] [--out file]"); process.exit(1); }
  const live = JSON.parse(fs.readFileSync(path.resolve(liveFile), "utf8"));
  const monsterRules = arg("--monster-rules", "data");
  const policies = arg("--policies", "standard,novice,legacy,expert").split(",").map((x) => x.trim()).filter(Boolean);

  const copyDir = path.join(os.tmpdir(), "fu-calibrate-live");
  const world = snapshotWorld(DEFAULT_WORLD, copyDir);
  const report = { generated: new Date().toISOString(), runs, monsterRules, policies, scenario: "startingZp 0, phoenixFeathers 0, fabulaPoints 3, no guests, no conflict event", fights: [] };
  try {
    const statusLibrary = monsterRules === "data" ? await loadStatusLibrary({ world }) : null;
    for (const plan of live.plan) {
      const names = plan.enemies.flatMap((e) => Array(e.quantity).fill(e.name));
      const boss = names.length === 1 && /asura|fafnir|rakshasa|carlbero/i.test(names[0]);
      const enemies = await loadNamed(names, { world });
      const summons = monsterRules === "data" ? await loadSummons(enemies, { world }) : null;
      // A "stalled" live run is the sim hanging (its watchdog aborted it), not a fight
      // result: counted apart, never as a loss.
      const mine = live.results.filter((r) => r.fight === plan.id && !r.err);
      const row = { id: plan.id, enemies: names, live: summarise(mine.filter((r) => r.outcome !== "stalled")),
        liveStalled: mine.filter((r) => r.outcome === "stalled").length, mindscape: {} };
      for (const policy of policies) {
        const party = liveScenario(await loadParty({ world }));
        const res = [];
        for (let i = 0; i < runs; i++) {
          const r = runBattle({ party, enemies, rng: new Rng(`calib:${plan.id}:${i}`), expectedRounds: boss ? 10 : 7, policy, monsterRules, statusLibrary, summons });
          res.push({ outcome: r.outcome, rounds: r.rounds, hp: r.partyHpRemaining });
        }
        row.mindscape[policy] = summarise(res);
      }
      row.parity = parity(row.live, row.mindscape[policies[0]]);
      report.fights.push(row);
    }
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }

  console.log(`Mindscape vs live sim — ${report.scenario}; Mindscape ${runs} runs per policy\n`);
  console.log("fight".padEnd(32) + "source".padEnd(12) + "  n   win  overtime  rounds(win)  HP left(win)");
  for (const f of report.fights) {
    const line = (label, s) => console.log("".padEnd(32) + label.padEnd(12) + String(s.n).padStart(4) + pct(s.win).padStart(6) + pct(s.overtime).padStart(10) + num(s.roundsWin).padStart(13) + pct(s.hpWin).padStart(14));
    console.log(`${f.id} (${f.enemies.join(" + ")})${f.liveStalled ? ` — ${f.liveStalled} live run(s) stalled, excluded` : ""}`);
    line("LIVE", f.live);
    for (const [p, s] of Object.entries(f.mindscape)) line(p, s);
    console.log("".padEnd(32) + `PARITY (${policies[0]}, ${monsterRules}): ${f.parity.verdict.toUpperCase()} — ${f.parity.why}`);
  }
  const drift = report.fights.filter((x) => x.parity.verdict === "drifts");
  console.log(`\n${report.fights.length - drift.length} of ${report.fights.length} fights agree with the live sim${drift.length ? `; drifting: ${drift.map((x) => x.id).join(", ")}` : ""}`);
  process.exitCode = drift.length ? 2 : 0;
  if (out) { fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + "\n"); console.log(`\nwrote ${out}`); }
}

main().catch((e) => { console.error(`calibrate-live failed: ${e.stack || e.message}`); process.exit(1); });
