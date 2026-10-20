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
//
// Live results file: { results: [{ fight, run, outcome, rounds, hp }], plan: [{ id, enemies: [{ name, quantity }] }] }
// Reads a COPY of the world (encounter-matrix.snapshotWorld).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");
const { loadParty, loadNamed } = require("../lib/load-actors");
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

async function main() {
  const liveFile = arg("--live", null);
  const runs = Number(arg("--runs", 2000));
  const out = arg("--out", null);
  if (!liveFile) { console.error("usage: node bin/calibrate-live.js --live <file> [--runs N] [--out file]"); process.exit(1); }
  const live = JSON.parse(fs.readFileSync(path.resolve(liveFile), "utf8"));

  const copyDir = path.join(os.tmpdir(), "fu-calibrate-live");
  const world = snapshotWorld(DEFAULT_WORLD, copyDir);
  const report = { generated: new Date().toISOString(), runs, scenario: "startingZp 0, phoenixFeathers 0, fabulaPoints 3, no guests", fights: [] };
  try {
    for (const plan of live.plan) {
      const names = plan.enemies.flatMap((e) => Array(e.quantity).fill(e.name));
      const boss = names.length === 1 && /asura|fafnir|rakshasa|carlbero/i.test(names[0]);
      const enemies = await loadNamed(names, { world });
      const row = { id: plan.id, enemies: names, live: summarise(live.results.filter((r) => r.fight === plan.id && !r.err)), mindscape: {} };
      for (const policy of ["novice", "legacy", "standard", "expert"]) {
        const party = liveScenario(await loadParty({ world }));
        const res = [];
        for (let i = 0; i < runs; i++) {
          const r = runBattle({ party, enemies, rng: new Rng(`calib:${plan.id}:${i}`), expectedRounds: boss ? 10 : 7, policy });
          res.push({ outcome: r.outcome, rounds: r.rounds, hp: r.partyHpRemaining });
        }
        row.mindscape[policy] = summarise(res);
      }
      report.fights.push(row);
    }
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }

  console.log(`Mindscape vs live sim — ${report.scenario}; Mindscape ${runs} runs per policy\n`);
  console.log("fight".padEnd(32) + "source".padEnd(12) + "  n   win  overtime  rounds(win)  HP left(win)");
  for (const f of report.fights) {
    const line = (label, s) => console.log("".padEnd(32) + label.padEnd(12) + String(s.n).padStart(4) + pct(s.win).padStart(6) + pct(s.overtime).padStart(10) + num(s.roundsWin).padStart(13) + pct(s.hpWin).padStart(14));
    console.log(`${f.id} (${f.enemies.join(" + ")})`.slice(0, 80));
    line("LIVE", f.live);
    for (const [p, s] of Object.entries(f.mindscape)) line(p, s);
  }
  if (out) { fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + "\n"); console.log(`\nwrote ${out}`); }
}

main().catch((e) => { console.error(`calibrate-live failed: ${e.stack || e.message}`); process.exit(1); });
