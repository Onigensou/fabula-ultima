#!/usr/bin/env node
"use strict";
//
// Mindscape — full-loadout band test per rarity (equipment guide Part 5).  READ-ONLY.
//
//   node bin/reference-loadout.js --ladder <ladder.json> [--runs 1000] [--seed reference-loadout]
//        [--out <file.json>]
//
// The rarity budgets are "% of one character's output per fight" per ITEM. A character
// wears three slots, so a full loadout at one rarity is worth 3 x the budget. This asks the
// question the budgets exist to answer: if EVERY member wears a whole loadout of that
// rarity, do standard fights stay inside the 2-3 round band, or collapse to 1 round?
//
// Each member's whole loadout budget is spent on OFFENSE — the upper bound, because
// offense is what shortens fights. The magnitude comes from the ladder's MEASURED price
// curve for the same scope (sim % per point, fitted through zero across presets and
// magnitudes): spell damage for members whose kit casts, weapon damage for everyone else.
//
// The scopes come from the ladder file itself: an encounter-set ladder re-runs the same
// live spawn groups with their conflict events; a neutral ladder re-runs its rulebook
// levels, adding the elite-pair encounter at the same levels (same curves).
// The game must be CLOSED.

const fs = require("fs");
const path = require("path");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue } = require("../lib/baseline-gear");
const { buildArchetypeParty, PRESETS, DEFAULT_SKILL_LAYER_K } = require("../lib/archetype-party");
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
// Keyed by scope; ladders written before scopes existed key by level.
function slopes(ladder) {
  const acc = {};
  for (const r of ladder.rows) {
    if (r.skipped || r.simPct == null || !["weapon-damage", "spell-damage"].includes(r.effect)) continue;
    const key = `${r.effect}@${ladder.mode === "encounter-set" ? r.scope : `L${r.level}`}`;
    acc[key] = acc[key] ?? { xy: 0, xx: 0 };
    acc[key].xy += r.simPct * r.magnitude;
    acc[key].xx += r.magnitude * r.magnitude;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.xy / v.xx]));
}

function casts(member) {
  return extractActions(member).actions.some((a) => a.defenseTarget === "mdef");
}

async function main() {
  const ladderFile = arg("--ladder", null);
  if (!ladderFile) throw new Error("--ladder <reference-set output json> is required");
  const runs = Number(arg("--runs", 1000));
  const seed = arg("--seed", "reference-loadout");
  const out = arg("--out", null);

  const ladder = JSON.parse(fs.readFileSync(path.resolve(ladderFile), "utf8"));
  const slope = slopes(ladder);
  const power = ladder.power ?? "table";
  let scopes;
  if (ladder.mode === "encounter-set") {
    scopes = await RS.loadEncounterSet(ladder.encounterSet);
  } else {
    const defense = ladder.enemyDefense == null || ladder.enemyDefense === "dice" ? null : Number(ladder.enemyDefense);
    scopes = [...RS.neutralScopes(ladder.levels, { defense }), ...RS.neutralScopes(ladder.levels, { defense, kind: "elite-pair" })];
  }

  const worldItems = await loadWorldItems();
  const folders = await loadWorldFolders();
  const catalogue = basicCatalogue(worldItems, folders);

  const rows = [];
  for (const scope of scopes) {
    const arm = { runs, seed, conflictEvent: scope.conflictEvent };
    for (const preset of Object.keys(PRESETS)) {
      const baseline = RS.runArm(buildArchetypeParty(preset, { level: scope.level, power, catalogue }), scope.enemies, arm);
      rows.push({ scope: scope.id, group: scope.group, label: scope.label, level: scope.level, preset,
        rarity: "basic", budgetPct: 0, magnitudes: {}, ...summary(baseline) });
      for (const [rarity, budget] of Object.entries(RARITY_BUDGET)) {
        const party = buildArchetypeParty(preset, { level: scope.level, power, catalogue });
        const magnitudes = {};
        for (const m of party) {
          // A caster's spells can be worthless against a group: the Wyrmwood's fire roster
          // ABSORBS the archetype Caster's fire spells, so its measured spell curve is not
          // positive and the model has it swing its weapon instead. Spend that member's
          // budget where its damage actually goes, and say so in the row.
          let effect = casts(m) ? "spell-damage" : "weapon-damage";
          if (effect === "spell-damage" && !(slope[`spell-damage@${scope.slopeKey}`] > 0)) effect = "weapon-damage";
          const perPoint = slope[`${effect}@${scope.slopeKey}`];
          if (!(perPoint > 0)) throw new Error(`no positive measured ${effect} curve for ${scope.slopeKey} in ${ladderFile}`);
          const magnitude = Math.max(1, Math.round((SLOTS_PER_CHARACTER * budget) / perPoint));
          magnitudes[m.name] = `${effect === "spell-damage" ? "spell" : "weapon"} +${magnitude}`;
          const entry = { id: `loadout-${rarity}`, effect, magnitude, slot: effect === "spell-damage" ? "acc1" : "main" };
          applySwaps(m, [{ slot: entry.slot, source: RS.makeReferenceSource(m, entry) }], { worldItems });
        }
        rows.push({ scope: scope.id, group: scope.group, label: scope.label, level: scope.level, preset,
          rarity, budgetPct: budget, magnitudes, ...summary(RS.runArm(party, scope.enemies, arm)) });
      }
    }
  }

  console.log(`\nFull-loadout band test — ${power} power (k ${DEFAULT_SKILL_LAYER_K}), ladder ${ladderFile}, ${runs} runs per row`);
  console.log(`Every member wears ${SLOTS_PER_CHARACTER} x the rarity budget, all as offense (upper bound). Model rounds: about one long vs live.\n`);
  const rarities = ["basic", ...Object.keys(RARITY_BUDGET)];
  for (const scope of scopes) {
    console.log(`### ${scope.id} — ${scope.label} (L${scope.level}${scope.conflictEventName ? `, ${scope.conflictEventName}` : ""})\n`);
    console.log(`| Preset | ${rarities.map((r) => `${r} rounds · 1/2–3/4+`).join(" | ")} |`);
    console.log(`|---|${rarities.map(() => "---").join("|")}|`);
    for (const preset of Object.keys(PRESETS)) {
      const cells = rarities.map((rar) => {
        const r = rows.find((x) => x.scope === scope.id && x.preset === preset && x.rarity === rar);
        return `${r.meanRounds.toFixed(2)} · ${r.bands.oneRound}/${r.bands.twoToThree}/${r.bands.fourPlus}${r.defeat ? ` · ${r.defeat}% loss` : ""}`;
      });
      console.log(`| ${preset} | ${cells.join(" | ")} |`);
    }
    console.log("");
  }
  const one = rows.filter((r) => r.bands.oneRound > 0);
  console.log(`rows with any 1-round fights: ${one.length} of ${rows.length}${one.length ? ` (max ${Math.max(...one.map((r) => r.bands.oneRound))}%)` : ""}`);

  if (out) {
    fs.writeFileSync(path.resolve(out), `${JSON.stringify({
      id: "reference-loadout", capturedAt: new Date().toISOString().slice(0, 10), runs, seed, power, k: DEFAULT_SKILL_LAYER_K,
      ladder: ladderFile, mode: ladder.mode ?? "neutral", budgets: RARITY_BUDGET, slopes: slope,
      scopes: scopes.map((s) => ({ id: s.id, group: s.group, label: s.label, level: s.level, conflictEvent: s.conflictEventName })),
      rows }, null, 2)}\n`);
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
