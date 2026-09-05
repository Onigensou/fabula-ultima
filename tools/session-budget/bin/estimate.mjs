#!/usr/bin/env node
/**
 * Session Time Budget Estimator — CLI.
 *
 *   node bin/estimate.mjs plans/fafnir-b1-b2.json
 *   node bin/estimate.mjs plans/fafnir-b1-b2.json --runs 50000 --seed 7
 *   node bin/estimate.mjs --table
 *   node bin/estimate.mjs plans/foo.json --json > out.json
 *
 * Offline. Reads nothing from the world, writes nothing anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, loadPlan } from "../lib/model.mjs";
import { simulate, suggestCuts } from "../lib/estimate.mjs";
import { renderReport, renderCostTable } from "../lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const out = { plan: null, runs: 10000, seed: 20260905, json: false, table: false, color: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--table") out.table = true;
    else if (a === "--no-color") out.color = false;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!a.startsWith("-")) out.plan = a;
  }
  return out;
}

const HELP = `
Session Time Budget Estimator

  node bin/estimate.mjs <plan.json> [options]
  node bin/estimate.mjs --table            print the cost model

Options
  --runs N        Monte Carlo runs (default 10000)
  --seed N        RNG seed; same seed => identical report (default 20260905)
  --model PATH    alternate cost model (default model/tile-costs.json)
  --json          emit machine-readable JSON instead of the timeline
  --no-color      plain output

Plan file
  { "name": "Fafnir B1-B2",
    "session": { "start": "20:30", "target": "00:00", "hardStop": "01:00" },
    "segments": [
      { "name": "B1 descent", "scene": "Fafnir B1",
        "tiles": { "random_battle": 6, "skill_check": 2, "treasure": 1, "blank": 8 } },
      { "name": "B1 throne", "scene": "Fafnir B1",
        "tiles": { "story": 1 }, "beats": { "story": "Throne Confrontation" } }
    ] }

  Use "sequence": ["blank","random_battle","story"] instead of "tiles" when the
  exact walk order matters. Tile keys are DP.TILE_TYPES from dp-constants.js.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const modelPath = args.model ?? path.join(ROOT, "model", "tile-costs.json");
const model = loadModel(modelPath);

if (args.table) {
  console.log(renderCostTable(model, { color: args.color }));
  process.exit(0);
}

if (!args.plan) { console.log(HELP); process.exit(1); }
if (!fs.existsSync(args.plan)) {
  console.error(`Plan not found: ${args.plan}`);
  process.exit(1);
}

const plan = loadPlan(args.plan);
const result = simulate(model, plan, { runs: args.runs, seed: args.seed });
const cuts = suggestCuts(model, plan, result);

if (args.json) {
  console.log(JSON.stringify({ plan: plan.name ?? plan._file, result, cuts }, null, 2));
} else {
  console.log(renderReport(model, plan, result, cuts, { color: args.color }));
}
