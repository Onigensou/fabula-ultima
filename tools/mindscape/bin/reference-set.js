#!/usr/bin/env node
"use strict";
//
// Mindscape — measure the vanilla equipment reference ladder (guide Part 8).  READ-ONLY.
//
//   node bin/reference-set.js [--runs 400] [--seed reference-set] [--levels 20,30,41,50]
//                             [--presets standard,...] [--power table] [--only weapon-damage,...]
//                             [--out expectations/reference-set.json]
//
// For every level x preset: one baseline arm (basic gear), then one arm per reference item
// with the item swapped onto its wearer, same encounter and seed. Prints paper % vs sim %
// per item and the per-effect price curves; writes the full rows with --out.
// The game must be CLOSED (the basic-gear catalogue is read from the world once).

const fs = require("fs");
const path = require("path");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue } = require("../lib/baseline-gear");
const { buildArchetypeParty, PRESETS, DEFAULT_SKILL_LAYER_K } = require("../lib/archetype-party");
const { buildNeutralEncounter } = require("../lib/neutral-encounter");
const { applySwaps } = require("../lib/loadout-swap");
const RS = require("../lib/reference-set");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const list = (v) => String(v).split(",").map((x) => x.trim()).filter(Boolean);
const f1 = (x) => (x == null ? "—" : x.toFixed(1));

async function main() {
  const runs = Number(arg("--runs", 400));
  const seed = arg("--seed", "reference-set");
  const levels = list(arg("--levels", "20,30,41,50")).map(Number);
  const presets = list(arg("--presets", Object.keys(PRESETS).join(",")));
  const power = arg("--power", "table");
  const only = arg("--only", null) ? new Set(list(arg("--only", ""))) : null;
  const out = arg("--out", null);
  // Enemy DEF/MDEF. Default 13 = the equipment guide's own pricing design point (Part 4);
  // "dice" = the rulebook NPC's DEX/INS die, the sensitivity check.
  const defenseArg = arg("--enemy-defense", "13");
  const enemyDefense = defenseArg === "dice" ? null : Number(defenseArg);

  const items = RS.loadReferenceSet().filter((e) => !only || only.has(e.effect) || only.has(e.id));
  const worldItems = await loadWorldItems();
  const folders = await loadWorldFolders();
  const catalogue = basicCatalogue(worldItems, folders);

  const t0 = Date.now();
  const rows = [];
  for (const level of levels) {
    const enemies = buildNeutralEncounter("normal", { level, defense: enemyDefense });
    for (const preset of presets) {
      const build = () => buildArchetypeParty(preset, { level, power, catalogue });
      const baseParty = build();
      const baseline = RS.runArm(baseParty, enemies, { runs, seed });
      for (const entry of items) {
        const party = build();
        const wearer = RS.pickWearer(party, entry, baseline);
        if (!wearer) { rows.push({ ...entry, level, preset, skipped: `no ${entry.wearer} in ${preset}` }); continue; }
        applySwaps(wearer, [{ slot: entry.slot, source: RS.makeReferenceSource(wearer, entry) }], { worldItems });
        const arm = RS.runArm(party, enemies, { runs, seed });
        const b = baseline.members[wearer.name];
        const i = arm.members[wearer.name];
        const sim = RS.simValue(entry, level, b, i);
        rows.push({
          ...entry, level, preset, wearer: wearer.name,
          paperPct: RS.paperValue(entry, level, b), simPct: sim.pct, ci95: sim.ci95, vsOwnPct: sim.vsOwn,
          baseline: { perAction: b.perAction.mean, takenPerRound: b.takenPerRound.mean, defPerRound: b.defPerRound.mean,
            mdefPerRound: b.mdefPerRound.mean, downRate: b.downRate, defeatRate: baseline.defeatRate,
            partyHp: baseline.partyHp, meanRounds: baseline.meanRounds, bands: baseline.bands },
          withItem: { perAction: i.perAction.mean, takenPerRound: i.takenPerRound.mean, downRate: i.downRate,
            defeatRate: arm.defeatRate, partyHp: arm.partyHp, meanRounds: arm.meanRounds, bands: arm.bands },
        });
      }
    }
  }

  console.log(`\nReference ladder — ${power} power (k ${DEFAULT_SKILL_LAYER_K}), neutral "normal" encounter at `
    + `${enemyDefense == null ? "rulebook DEF/MDEF (dice)" : `DEF/MDEF ${enemyDefense}`}, ${runs} runs per arm, seed "${seed}"`);
  console.log(`Offense % = extra damage per wearer action / BA(L). Defense % = damage prevented per round / HP-per-BA(L).`);
  console.log(`Cells: mean sim % across presets [lowest–highest preset]; paper % from guide Part 4 in brackets.\n`);
  for (const effect of RS.EFFECTS) {
    const ids = [...new Set(rows.filter((r) => r.effect === effect).map((r) => r.id))];
    if (!ids.length) continue;
    console.log(`### ${effect}\n`);
    console.log(`| Item | ${levels.map((l) => `L${l}`).join(" | ")} |`);
    console.log(`|---|${levels.map(() => "---").join("|")}|`);
    for (const id of ids) {
      const cells = levels.map((level) => {
        const rs = rows.filter((r) => r.id === id && r.level === level && !r.skipped);
        if (!rs.length) return "—";
        if (effect === "max-hp") {
          const dDown = rs.map((r) => 100 * (r.withItem.downRate - r.baseline.downRate));
          const dHp = rs.map((r) => 100 * (r.withItem.partyHp - r.baseline.partyHp));
          const signed = (x) => `${x >= 0 ? "+" : ""}${f1(x)}`;
          return `wearer down rate ${signed(dDown.reduce((a, b) => a + b, 0) / rs.length)} pts, party HP ${signed(dHp.reduce((a, b) => a + b, 0) / rs.length)} pts (paper ${f1(rs[0].paperPct)}%)`;
        }
        const sims = rs.map((r) => r.simPct);
        const papers = rs.map((r) => r.paperPct);
        const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
        return `${f1(avg(sims))}% [${f1(Math.min(...sims))}–${f1(Math.max(...sims))}] (paper ${f1(avg(papers))}%)`;
      });
      console.log(`| ${id} | ${cells.join(" | ")} |`);
    }
    console.log("");
  }
  const noisy = rows.filter((r) => r.simPct != null && Math.abs(r.simPct) < r.ci95);
  console.log(`${rows.filter((r) => !r.skipped).length} measured arms, ${rows.filter((r) => r.skipped).length} skipped, `
    + `${noisy.length} within their own 95% margin of zero · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (out) {
    const record = { id: "reference-set", capturedAt: new Date().toISOString().slice(0, 10), runs, seed, power,
      k: DEFAULT_SKILL_LAYER_K, levels, presets, encounter: "normal", enemyDefense: enemyDefense ?? "dice", guide: RS.GUIDE, rows };
    fs.writeFileSync(path.resolve(out), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${path.resolve(out)}`);
  }
}

main().catch((e) => { console.error(`\nreference-set failed: ${e.message}\n`); process.exit(1); });
