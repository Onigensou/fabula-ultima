#!/usr/bin/env node
"use strict";
//
// Mindscape — archetype level sweep (ruleset Part 6g).  READ-ONLY.
//
//   node bin/archetype-sweep.js [--runs 1000] [--seed archetype-sweep] [--out <file.json>]
//
// Every archetype preset x level (20/30/41/50) x power (raw/table) x neutral encounter
// (normal / elite-pair), all on basic gear against rulebook-formula enemies of the same
// level. This is the blank-slate baseline an item is measured against: an --equip run on
// the same preset, level, power and seed, compared with the matching row here.
//
// Loads the world once (basic-gear catalogue); everything else is built in memory.
// The game must be CLOSED.

const fs = require("fs");
const path = require("path");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue } = require("../lib/baseline-gear");
const { buildArchetypeParty, PRESETS, DEFAULT_SKILL_LAYER_K } = require("../lib/archetype-party");
const { buildNeutralEncounter, KINDS } = require("../lib/neutral-encounter");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");

const LEVELS = [20, 30, 41, 50];
const POWERS = ["raw", "table"];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function measure(party, enemies, { runs, seed }) {
  const rounds = [];
  let hp = 0, dpr = 0, enemyDpr = 0, defeats = 0, overtime = 0, downs = 0;
  for (let i = 0; i < runs; i++) {
    const r = runBattle({ party, enemies, rng: new Rng(`${seed}:${i}`), expectedRounds: 10 });
    rounds.push(r.rounds);
    hp += r.partyHpRemaining ?? 0;
    dpr += r.baselineDpr;
    if (r.outcome === "defeat" || r.outcome === "mutual-destruction") defeats++;
    if (r.outcome === "overtime") overtime++;
    downs += r.downs.length;
    const dealt = (r.combatants ?? []).filter((c) => c.side === "enemy").reduce((s, c) => s + (c.damageDealt ?? 0), 0);
    enemyDpr += r.rounds ? dealt / r.rounds : 0;
  }
  const pct = (n) => Math.round((n / runs) * 100);
  return {
    medianRounds: median(rounds),
    bands: {
      oneRound: pct(rounds.filter((x) => x <= 1).length),
      twoToThree: pct(rounds.filter((x) => x >= 2 && x <= 3).length),
      fourPlus: pct(rounds.filter((x) => x >= 4).length),
    },
    partyHp: pct(hp),
    defeat: pct(defeats),
    overtime: pct(overtime),
    downsPerFight: +(downs / runs).toFixed(2),
    partyDpr: +(dpr / runs).toFixed(1),
    enemyDpr: +(enemyDpr / runs).toFixed(1),
  };
}

async function main() {
  const runs = Number(arg("--runs", 1000));
  const seed = arg("--seed", "archetype-sweep");
  const out = arg("--out", null);

  const worldItems = await loadWorldItems();
  const folders = await loadWorldFolders();
  const catalogue = basicCatalogue(worldItems, folders);

  const rows = [];
  for (const kind of Object.keys(KINDS)) {
    for (const level of LEVELS) {
      const enemies = buildNeutralEncounter(kind, { level });
      for (const power of POWERS) {
        for (const preset of Object.keys(PRESETS)) {
          const party = buildArchetypeParty(preset, { level, power, catalogue });
          rows.push({ kind, level, power, preset,
            partyHpPool: party.reduce((s, p) => s + p.hp.max, 0),
            enemyHpPool: enemies.reduce((s, e) => s + e.hp.max, 0),
            ...measure(party, enemies, { runs, seed }) });
        }
      }
    }
  }

  console.log(`\nArchetype sweep — ${runs} runs per row, seed "${seed}", k ${DEFAULT_SKILL_LAYER_K} (table power)`);
  console.log("Raw model rounds; Mindscape reads about one round long vs live on its calibration pair.\n");
  for (const kind of Object.keys(KINDS)) {
    console.log(`### ${kind}\n`);
    console.log("| Level | Power | Preset | Rounds | 1 / 2–3 / 4+ | Party HP left | Defeat | Party DPR | Enemy DPR | HP pools (party / enemy) |");
    console.log("|---|---|---|---|---|---|---|---|---|---|");
    for (const r of rows.filter((x) => x.kind === kind)) {
      console.log(`| ${r.level} | ${r.power} | ${r.preset} | ${r.medianRounds} | ${r.bands.oneRound} / ${r.bands.twoToThree} / ${r.bands.fourPlus} `
        + `| ${r.partyHp}% | ${r.defeat}%${r.overtime ? ` (+${r.overtime}% overtime)` : ""} | ${r.partyDpr} | ${r.enemyDpr} | ${r.partyHpPool} / ${r.enemyHpPool} |`);
    }
    console.log("");
  }

  if (out) {
    const record = { id: "archetype-sweep", capturedAt: new Date().toISOString().slice(0, 10), runs, seed,
      k: DEFAULT_SKILL_LAYER_K, levels: LEVELS, rows };
    fs.writeFileSync(path.resolve(out), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${path.resolve(out)}`);
  }
}

main().catch((e) => { console.error(`\narchetype-sweep failed: ${e.message}\n`); process.exit(1); });
