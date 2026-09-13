#!/usr/bin/env node
"use strict";
//
// Mindscape — fit the table-power skill layer (ruleset Part 6g).  READ-ONLY.
//
//   node bin/calibrate-archetypes.js [--runs 2000] [--seed calib-2026-08-19]
//
// "table" power adds +round(k x level/10) damage to every archetype action. `k` is the
// ONE fitted value: the standard preset at L41 must deal the same party damage per round
// (BaselineDPR) as the REAL Current Game party, in the same fight, on the same seed —
// model against model, so the model's own biases cancel. Bisection over k; the world is
// loaded once. Prints the fit and a JSON block for expectations/archetype-calibration.json.
//
// The game must be CLOSED.

const { loadParty, loadNamed, resolveCurrentGame } = require("../lib/load-actors");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue, applyBaselineGear } = require("../lib/baseline-gear");
const { buildArchetypeParty } = require("../lib/archetype-party");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");

const ENCOUNTER = ["Inferex", "Centuaros"];
const LEVEL = 41;
const PRESET = "standard";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function measure(party, enemies, { runs, seed }) {
  let dpr = 0, hp = 0, rounds = 0, enemyDpr = 0, defeats = 0;
  const bands = { one: 0, standard: 0, long: 0 };
  for (let i = 0; i < runs; i++) {
    const r = runBattle({ party, enemies, rng: new Rng(`${seed}:${i}`), expectedRounds: 7 });
    dpr += r.baselineDpr;
    hp += r.partyHpRemaining ?? 0;
    rounds += r.rounds;
    if (r.outcome === "defeat") defeats++;
    const dealt = (r.combatants ?? []).filter((c) => c.side === "enemy").reduce((s, c) => s + (c.damageDealt ?? 0), 0);
    enemyDpr += r.rounds ? dealt / r.rounds : 0;
    if (r.rounds <= 1) bands.one++; else if (r.rounds <= 3) bands.standard++; else bands.long++;
  }
  const pct = (n) => Math.round((n / runs) * 100);
  return {
    baselineDpr: +(dpr / runs).toFixed(1), meanHp: +(hp / runs).toFixed(3), meanRounds: +(rounds / runs).toFixed(2),
    enemyDpr: +(enemyDpr / runs).toFixed(1), defeatRate: +(defeats / runs).toFixed(3),
    bands: { oneRound: pct(bands.one), twoToThree: pct(bands.standard), fourPlus: pct(bands.long) },
    partyHpPool: party.reduce((s, p) => s + (p.hp.max ?? 0), 0),
  };
}

async function main() {
  const runs = Number(arg("--runs", 2000));
  const seed = arg("--seed", "calib-2026-08-19");

  const game = await resolveCurrentGame();
  const realParty = await loadParty();
  const enemies = await loadNamed(ENCOUNTER);
  const worldItems = await loadWorldItems();
  const folders = await loadWorldFolders();
  const catalogue = basicCatalogue(worldItems, folders);

  const real = measure(realParty, enemies, { runs, seed });
  console.log(`\nreal party (${game.partyName}, L${realParty[0]?.level}) vs ${ENCOUNTER.join(" + ")}, ${runs} runs, seed ${seed}`);
  console.log(`  full gear:  ${JSON.stringify(real)}`);

  // The PRIMARY target: the real party on BASIC gear. Archetypes wear basic gear and
  // items are measured on top of it, so the skill layer must stand in for class skills
  // ONLY. Fitting against the fully geared party would fold the party's gear into k and
  // make every item read cheaper than it is.
  const stripped = await loadParty();
  applyBaselineGear(stripped, { names: ["all"], worldItems, folders });
  const realBasic = measure(stripped, enemies, { runs, seed });
  console.log(`  basic gear: ${JSON.stringify(realBasic)}`);

  const at = (k) => measure(buildArchetypeParty(PRESET, { level: LEVEL, power: "table", k, catalogue }), enemies, { runs, seed });
  const raw = measure(buildArchetypeParty(PRESET, { level: LEVEL, power: "raw", catalogue }), enemies, { runs, seed });
  console.log(`\narchetype ${PRESET} L${LEVEL} RAW power`);
  console.log(`  ${JSON.stringify(raw)}`);

  // Bisection on k: BaselineDPR rises with k (more damage on every action).
  const fit = (target, label) => {
    console.log(`\nfitting k to ${label} (BaselineDPR ${target})`);
    let lo = 0, hi = 20;
    let hiM = at(hi);
    while (hiM.baselineDpr < target && hi < 160) { hi *= 2; hiM = at(hi); }
    if (hiM.baselineDpr < target) throw new Error(`k up to ${hi} cannot reach DPR ${target}`);
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const m = at(mid);
      console.log(`  k=${mid.toFixed(3).padStart(7)}  BaselineDPR ${m.baselineDpr}`);
      if (m.baselineDpr < target) lo = mid; else hi = mid;
    }
    const k = +((lo + hi) / 2).toFixed(2);
    const fitted = at(k);
    console.log(`  fitted k = ${k}  ->  +${Math.round(k * LEVEL / 10)} damage at L${LEVEL}`);
    console.log(`  ${JSON.stringify(fitted)}`);
    return { k, fitted };
  };
  const primary = fit(realBasic.baselineDpr, "the real party on BASIC gear (primary)");
  const fullGear = fit(real.baselineDpr, "the real party on FULL gear (reference only)");
  const k = primary.k;

  const record = {
    id: "archetype-calibration", capturedAt: new Date().toISOString().slice(0, 10),
    method: `standard preset at L${LEVEL}, table power; k bisected until BaselineDPR matches the real Current Game party ON BASIC GEAR (--baseline-gear all) in the same fight, same seed, same model. Basic gear on both sides, so k stands in for class skills only and items are measured on top of it.`,
    encounter: ENCOUNTER, runs, seed, k,
    realFullGear: { party: game.partyName, ...real },
    realBasicGear: { party: game.partyName, ...realBasic },
    archetypeRaw: raw,
    archetypeTable: primary.fitted,
    fullGearFitForReference: { k: fullGear.k, archetypeTable: fullGear.fitted,
      note: "What k would be if gear were folded into the skill layer. Not used: it double-counts gear." },
  };
  console.log(`\n--- expectations/archetype-calibration.json ---\n${JSON.stringify(record, null, 2)}`);
}

main().catch((e) => { console.error(`\ncalibrate-archetypes failed: ${e.message}\n`); process.exit(1); });
