#!/usr/bin/env node
"use strict";
//
// Mindscape — full-loadout band test per rarity (equipment guide Part 5).  READ-ONLY.
//
//   node bin/reference-loadout.js [--runs 1000] [--seed reference-loadout]
//        [--ladder expectations/reference-set.json] [--out expectations/reference-loadout.json]
//
// The rarity budgets are "% of one character's output per fight" per ITEM. A character
// wears three slots, so a full loadout at one rarity is worth 3 x the budget. This asks the
// question the budgets exist to answer: if EVERY member wears a whole loadout of that
// rarity, do standard fights stay inside the 2-3 round band, or collapse to 1 round?
//
// Each member's whole loadout budget is spent on OFFENSE — the upper bound, because
// offense is what shortens fights and the measured defensive curves are near zero at this
// table's accuracies. The magnitude comes from the MEASURED price curve (the ladder's
// sim % per point at that level, fitted through zero across presets and magnitudes):
// spell damage for members whose kit casts, weapon damage for everyone else.
// Enemies: the neutral encounters at the ladder's DEF/MDEF, so the curves apply.
// The game must be CLOSED (basic-gear catalogue).

const fs = require("fs");
const path = require("path");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue } = require("../lib/baseline-gear");
const { buildArchetypeParty, PRESETS, DEFAULT_SKILL_LAYER_K } = require("../lib/archetype-party");
const { buildNeutralEncounter, KINDS } = require("../lib/neutral-encounter");
const { applySwaps } = require("../lib/loadout-swap");
const { extractActions } = require("../lib/skills");
const RS = require("../lib/reference-set");

const RARITY_BUDGET = Object.freeze({ common: 5, uncommon: 10, rare: 15, legendary: 22.5 });
const SLOTS_PER_CHARACTER = 3;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

// % of output per point of magnitude, least squares through zero over every measured row.
function slopes(ladder) {
  const out = {};
  for (const r of ladder.rows) {
    if (r.skipped || r.simPct == null || !["weapon-damage", "spell-damage"].includes(r.effect)) continue;
    const k = `${r.effect}@${r.level}`;
    out[k] = out[k] ?? { xy: 0, xx: 0 };
    out[k].xy += r.simPct * r.magnitude;
    out[k].xx += r.magnitude * r.magnitude;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.xy / v.xx]));
}

function casts(member) {
  return extractActions(member).actions.some((a) => a.defenseTarget === "mdef");
}

async function main() {
  const runs = Number(arg("--runs", 1000));
  const seed = arg("--seed", "reference-loadout");
  const ladderFile = arg("--ladder", "expectations/reference-set.json");
  const out = arg("--out", null);

  const ladder = JSON.parse(fs.readFileSync(path.resolve(ladderFile), "utf8"));
  const slope = slopes(ladder);
  const defense = ladder.enemyDefense === "dice" ? null : Number(ladder.enemyDefense);
  const power = ladder.power ?? "table";

  const worldItems = await loadWorldItems();
  const folders = await loadWorldFolders();
  const catalogue = basicCatalogue(worldItems, folders);

  const rows = [];
  for (const level of ladder.levels) {
    for (const kind of Object.keys(KINDS)) {
      const enemies = buildNeutralEncounter(kind, { level, defense });
      for (const preset of Object.keys(PRESETS)) {
        const baseline = RS.runArm(buildArchetypeParty(preset, { level, power, catalogue }), enemies, { runs, seed });
        rows.push({ level, kind, preset, rarity: "basic", budgetPct: 0, magnitudes: {}, ...summary(baseline) });
        for (const [rarity, budget] of Object.entries(RARITY_BUDGET)) {
          const party = buildArchetypeParty(preset, { level, power, catalogue });
          const magnitudes = {};
          for (const m of party) {
            const effect = casts(m) ? "spell-damage" : "weapon-damage";
            const perPoint = slope[`${effect}@${level}`];
            if (!(perPoint > 0)) throw new Error(`no measured ${effect} curve at L${level} in ${ladderFile}`);
            const magnitude = Math.max(1, Math.round((SLOTS_PER_CHARACTER * budget) / perPoint));
            magnitudes[m.name] = `${effect === "spell-damage" ? "spell" : "weapon"} +${magnitude}`;
            const entry = { id: `loadout-${rarity}`, effect, magnitude, slot: effect === "spell-damage" ? "acc1" : "main" };
            applySwaps(m, [{ slot: entry.slot, source: RS.makeReferenceSource(m, entry) }], { worldItems });
          }
          rows.push({ level, kind, preset, rarity, budgetPct: budget, magnitudes, ...summary(RS.runArm(party, enemies, { runs, seed })) });
        }
      }
    }
  }

  console.log(`\nFull-loadout band test — ${power} power (k ${DEFAULT_SKILL_LAYER_K}), enemies at ${defense == null ? "rulebook DEF/MDEF" : `DEF/MDEF ${defense}`}, ${runs} runs per row`);
  console.log(`Every member wears ${SLOTS_PER_CHARACTER} x the rarity budget, all as offense (upper bound). Model rounds: about one long vs live.\n`);
  for (const kind of Object.keys(KINDS)) {
    console.log(`### ${kind}\n`);
    console.log("| Level | Preset | Loadout | Mean rounds | 1 / 2–3 / 4+ | Party HP left | Defeat | Per-member offense |");
    console.log("|---|---|---|---|---|---|---|---|");
    for (const r of rows.filter((x) => x.kind === kind)) {
      console.log(`| ${r.level} | ${r.preset} | ${r.rarity}${r.budgetPct ? ` (3×${r.budgetPct}%)` : ""} | ${r.meanRounds.toFixed(2)} `
        + `| ${r.bands.oneRound} / ${r.bands.twoToThree} / ${r.bands.fourPlus} | ${r.partyHp}% | ${r.defeat}% `
        + `| ${Object.values(r.magnitudes).join(", ") || "—"} |`);
    }
    console.log("");
  }
  if (out) {
    fs.writeFileSync(path.resolve(out), `${JSON.stringify({ id: "reference-loadout", capturedAt: new Date().toISOString().slice(0, 10),
      runs, seed, power, k: DEFAULT_SKILL_LAYER_K, enemyDefense: defense ?? "dice", budgets: RARITY_BUDGET,
      slopes: slope, rows }, null, 2)}\n`);
    console.log(`wrote ${path.resolve(out)}`);
  }
}

function summary(arm) {
  return {
    meanRounds: arm.meanRounds, bands: arm.bands,
    partyHp: Math.round(arm.partyHp * 100), defeat: Math.round(arm.defeatRate * 100),
  };
}

main().catch((e) => { console.error(`\nreference-loadout failed: ${e.message}\n`); process.exit(1); });
