#!/usr/bin/env node
"use strict";
//
// Mindscape — per-monster report card. What each monster actually DOES in the fights it
// appears in, read from the battle logs of every Encounter Matrix fight (same party policy,
// baseline stats), so one monster can be judged apart from the group around it.
//
//   node bin/monster-report.js [--runs 1000] [--plan specs/balance/plan.json] [--out file.json]
//
// Per monster: actions per round alive, hit rate, damage per landed hit, effective damage per
// round alive (what reaches the party after misses, Protect and affinities), rounds it
// survives, KOs per fight, and its share of the party's HP per fight.

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
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

async function main() {
  const runs = Number(arg("--runs", 1000));
  const out = arg("--out", null);
  const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "expectations", "encounter-matrix.json"), "utf8"));
  const policy = matrix.policy ?? "standard";
  const copyDir = path.join(os.tmpdir(), "fu-monster-report");
  const world = snapshotWorld(DEFAULT_WORLD, copyDir);
  const acc = {};
  let partyMaxHp = 0, pcCount = 0;
  try {
    const party = await loadParty({ world });
    partyMaxHp = party.reduce((t, p) => t + (p.hp.max ?? 0), 0);
    pcCount = party.length;
    for (const l of matrix.lines) {
      if (l.error) continue;
      const enemies = await loadNamed(l.enemies, { world });
      const counts = {};
      for (const n of l.enemies) counts[n] = (counts[n] ?? 0) + 1;
      for (let i = 0; i < runs; i++) {
        const r = runBattle({ party, enemies, rng: new Rng(`report:${l.source}:${l.enemies.join("+")}:${i}`), expectedRounds: l.kind === "boss" ? 10 : 7, policy });
        const perName = {};
        for (const n of Object.keys(counts)) perName[n] = { actions: 0, attacks: 0, hits: 0, dmg: 0, kos: 0 };
        let lastActor = null, lastRound = 0;
        for (const e of r.log) {
          const m = perName[e.actor];
          if (!m || e.reaction) continue;
          // One action = one log burst by this actor in this round (multi-target rows share it).
          if (!(lastActor === e.actor && lastRound === e.round && e.target)) m.actions++;
          lastActor = e.actor; lastRound = e.round;
          if (e.target == null || e.direction === "recover") continue;
          m.attacks++;
          if (!e.miss) { m.hits++; m.dmg += e.damage ?? 0; if (e.killed) m.kos++; }
        }
        for (const [name, m] of Object.entries(perName)) {
          const cs = r.combatants.filter((c) => c.side === "enemy" && c.name === name);
          const alive = cs.map((c) => c.downedOnRound ?? r.rounds);
          const a = (acc[name] ??= { fights: new Set(), roundsAlive: [], actions: 0, attacks: 0, hits: 0, dmg: 0, kos: 0, instanceRounds: 0, runs: 0 });
          a.fights.add(`${l.dungeon.startsWith("Fafnir") ? "F" : "V"}${l.range ? l.range[0] : "story"}`);
          a.roundsAlive.push(...alive);
          a.instanceRounds += alive.reduce((t, x) => t + x, 0);
          a.actions += m.actions; a.attacks += m.attacks; a.hits += m.hits; a.dmg += m.dmg; a.kos += m.kos;
          a.runs += cs.length;
        }
      }
    }
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
  const rows = Object.entries(acc).map(([name, a]) => ({
    name, fights: [...a.fights],
    roundsAlive: median(a.roundsAlive),
    hitRate: a.attacks ? a.hits / a.attacks : null,
    perHit: a.hits ? a.dmg / a.hits : null,
    perRound: a.instanceRounds ? a.dmg / a.instanceRounds : 0,
    perFight: a.runs ? a.dmg / a.runs : 0,
    partyShare: a.runs ? a.dmg / a.runs / partyMaxHp : 0,
    kosPerFight: a.runs ? a.kos / a.runs : 0,
  })).sort((x, y) => x.perRound - y.perRound);
  const report = { generated: new Date().toISOString(), policy, runs, partyMaxHp, avgPcHp: partyMaxHp / pcCount, rows };
  for (const r of rows) {
    console.log(`${r.name.padEnd(16)} alive ${String(r.roundsAlive).padStart(2)} rds · hit ${Math.round(100 * (r.hitRate ?? 0))}% · ${Math.round(r.perHit ?? 0)}/hit · ${Math.round(r.perRound)}/rd · ${Math.round(r.perFight)}/fight (${Math.round(100 * r.partyShare)}% party) · KO ${r.kosPerFight.toFixed(2)} · ${r.fights.length} fights`);
  }
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => { console.error(`monster-report failed: ${e.stack || e.message}`); process.exit(1); });
