#!/usr/bin/env node
"use strict";
//
// Mindscape — measure the vanilla equipment reference ladder (guide Parts 8 and 10).  READ-ONLY.
//
//   # the LIVE environment: real spawn groups, each at its own level and conflict event
//   node bin/reference-set.js --encounter-set specs/encounters/house-set.json --out <file.json>
//
//   # the rulebook BASE: neutral NPC encounters at chosen levels
//   node bin/reference-set.js [--levels 20,30,41,50] [--enemy-defense 13|dice] --out <file.json>
//
//   common: [--runs 1000] [--seed reference-set] [--presets standard,...] [--power table]
//           [--only weapon-damage,...]
//
// For every scope x preset: one baseline arm (basic gear), then one arm per reference item
// with the item swapped onto its wearer, same enemies, event and seed. Prints paper % vs
// sim % per item grouped by dungeon (encounter set) or level (neutral); writes every row
// with --out. The game must be CLOSED.

const fs = require("fs");
const path = require("path");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue } = require("../lib/baseline-gear");
const { buildArchetypeParty, PRESETS, DEFAULT_SKILL_LAYER_K } = require("../lib/archetype-party");
const { applySwaps } = require("../lib/loadout-swap");
const RS = require("../lib/reference-set");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const list = (v) => String(v).split(",").map((x) => x.trim()).filter(Boolean);
const f1 = (x) => (x == null ? "—" : x.toFixed(1));
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function main() {
  const runs = Number(arg("--runs", 1000));
  const seed = arg("--seed", "reference-set");
  const presets = list(arg("--presets", Object.keys(PRESETS).join(",")));
  const power = arg("--power", "table");
  const only = arg("--only", null) ? new Set(list(arg("--only", ""))) : null;
  const out = arg("--out", null);
  const encounterSet = arg("--encounter-set", null);
  // Neutral mode only. Default 13 = the guide's pricing design point; "dice" = pure rulebook.
  const defenseArg = arg("--enemy-defense", "13");
  const enemyDefense = defenseArg === "dice" ? null : Number(defenseArg);
  const levels = list(arg("--levels", "20,30,41,50")).map(Number);

  const items = RS.loadReferenceSet().filter((e) => !only || only.has(e.effect) || only.has(e.id));
  const scopes = encounterSet
    ? await RS.loadEncounterSet(encounterSet)
    : RS.neutralScopes(levels, { defense: enemyDefense });
  const worldItems = await loadWorldItems();
  const folders = await loadWorldFolders();
  const catalogue = basicCatalogue(worldItems, folders);

  const t0 = Date.now();
  const rows = [];
  const baselines = [];
  for (const scope of scopes) {
    const arm = { runs, seed, conflictEvent: scope.conflictEvent };
    for (const preset of presets) {
      const build = () => buildArchetypeParty(preset, { level: scope.level, power, catalogue });
      const baseline = RS.runArm(build(), scope.enemies, arm);
      baselines.push({ scope: scope.id, group: scope.group, level: scope.level, preset,
        meanRounds: baseline.meanRounds, bands: baseline.bands, partyHp: baseline.partyHp, defeatRate: baseline.defeatRate,
        partyTakenPerRound: baseline.partyTakenPerRound.mean });
      for (const entry of items) {
        const party = build();
        const wearer = RS.pickWearer(party, entry, baseline);
        const where = { scope: scope.id, group: scope.group, level: scope.level, preset };
        if (!wearer) { rows.push({ ...entry, ...where, skipped: `no ${entry.wearer} in ${preset}` }); continue; }
        const maxHpBefore = wearer.hp?.max ?? null;
        applySwaps(wearer, [{ slot: entry.slot, source: RS.makeReferenceSource(wearer, entry) }], { worldItems });
        const withItem = RS.runArm(party, scope.enemies, arm);
        const b = baseline.members[wearer.name];
        const i = withItem.members[wearer.name];
        const sim = RS.simValue(entry, scope.level, b, i, { baseline, withItem });
        rows.push({
          ...entry, ...where, wearer: wearer.name,
          paperPct: RS.paperValue(entry, scope.level, b), simPct: sim.pct, ci95: sim.ci95, vsOwnPct: sim.vsOwn,
          wearerPct: sim.wearerPct,
          partyTakenPerRound: { baseline: baseline.partyTakenPerRound.mean, withItem: withItem.partyTakenPerRound.mean },
          baseline: { perAction: b.perAction.mean, takenPerRound: b.takenPerRound.mean, defPerRound: b.defPerRound.mean,
            mdefPerRound: b.mdefPerRound.mean, downRate: b.downRate, defeatRate: baseline.defeatRate,
            partyHp: baseline.partyHp, meanRounds: baseline.meanRounds, bands: baseline.bands,
            actionsPerFight: b.actionsPerFight.mean, actionsPerRound: b.actionsPerRound.mean,
            damagePerHit: b.damagePerHit, maxHp: maxHpBefore },
          withItem: { perAction: i.perAction.mean, takenPerRound: i.takenPerRound.mean, downRate: i.downRate,
            defeatRate: withItem.defeatRate, partyHp: withItem.partyHp, meanRounds: withItem.meanRounds, bands: withItem.bands,
            actionsPerFight: i.actionsPerFight.mean, damagePerHit: i.damagePerHit, maxHp: wearer.hp?.max ?? null },
        });
      }
    }
  }

  const groups = [...new Set(scopes.map((s) => s.group))];
  console.log(`\nReference ladder — ${power} power (k ${DEFAULT_SKILL_LAYER_K}), ${runs} runs per arm, seed "${seed}"`);
  console.log(encounterSet
    ? `Scopes: ${scopes.length} live spawn groups from ${encounterSet}, each at its own party level.`
    : `Scopes: neutral rulebook "normal" encounters at ${enemyDefense == null ? "rulebook DEF/MDEF (dice)" : `DEF/MDEF ${enemyDefense}`}.`);
  for (const s of scopes) {
    if (!encounterSet) break;
    console.log(`  ${s.id.padEnd(9)} L${s.level}  ${s.label}${s.conflictEventName ? `  [${s.conflictEventName}]` : ""}`
      + `${s.unmodelled.length ? `  · ${s.unmodelled.length} unmodelled passive(s)` : ""}`);
  }
  console.log(`Offense % = extra damage per wearer action / BA(L). Defense % = damage prevented per round across the PARTY / HP-per-BA(L).`);
  console.log(`Cells: mean sim % over the group's scopes and presets [lowest–highest]; pre-correction paper % in brackets.\n`);

  console.log(`### baseline fights (basic gear, mean over presets)\n`);
  console.log(`| Group | Mean rounds | 1 / 2–3 / 4+ | Party HP left | Defeat |`);
  console.log(`|---|---|---|---|---|`);
  for (const g of groups) {
    const bs = baselines.filter((x) => x.group === g);
    console.log(`| ${g} | ${f1(avg(bs.map((x) => x.meanRounds)))} | ${Math.round(avg(bs.map((x) => x.bands.oneRound)))} / `
      + `${Math.round(avg(bs.map((x) => x.bands.twoToThree)))} / ${Math.round(avg(bs.map((x) => x.bands.fourPlus)))} `
      + `| ${Math.round(100 * avg(bs.map((x) => x.partyHp)))}% | ${Math.round(100 * avg(bs.map((x) => x.defeatRate)))}% |`);
  }
  console.log("");

  for (const effect of RS.EFFECTS) {
    const ids = [...new Set(rows.filter((r) => r.effect === effect).map((r) => r.id))];
    if (!ids.length) continue;
    console.log(`### ${effect}\n`);
    console.log(`| Item | ${groups.join(" | ")} |`);
    console.log(`|---|${groups.map(() => "---").join("|")}|`);
    for (const id of ids) {
      const cells = groups.map((g) => {
        const rs = rows.filter((r) => r.id === id && r.group === g && !r.skipped);
        if (!rs.length) return "—";
        if (effect === "max-hp") {
          const signed = (x) => `${x >= 0 ? "+" : ""}${f1(x)}`;
          return `KO ${signed(avg(rs.map((r) => 100 * (r.withItem.downRate - r.baseline.downRate))))} pts, `
            + `party HP ${signed(avg(rs.map((r) => 100 * (r.withItem.partyHp - r.baseline.partyHp))))} pts`;
        }
        const sims = rs.map((r) => r.simPct).filter((x) => x != null);
        if (!sims.length) return "—";
        return `${f1(avg(sims))}% [${f1(Math.min(...sims))}–${f1(Math.max(...sims))}] (${f1(avg(rs.map((r) => r.paperPct)))}%)`;
      });
      console.log(`| ${id} | ${cells.join(" | ")} |`);
    }
    console.log("");
  }
  const measured = rows.filter((r) => !r.skipped);
  const noisy = measured.filter((r) => r.simPct != null && Math.abs(r.simPct) < r.ci95);
  console.log(`${measured.length} measured arms, ${rows.length - measured.length} skipped, `
    + `${noisy.length} within their own 95% margin of zero · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (out) {
    const record = {
      id: "reference-set", capturedAt: new Date().toISOString().slice(0, 10), runs, seed, power, k: DEFAULT_SKILL_LAYER_K,
      mode: encounterSet ? "encounter-set" : "neutral",
      encounterSet: encounterSet ?? null,
      enemyDefense: encounterSet ? null : (enemyDefense ?? "dice"),
      levels: [...new Set(scopes.map((s) => s.level))],
      scopes: scopes.map((s) => ({ id: s.id, group: s.group, label: s.label, level: s.level,
        enemies: s.enemies.map((e) => e.name), conflictEvent: s.conflictEventName, unmodelled: s.unmodelled })),
      presets, guide: RS.GUIDE, baselines, rows,
    };
    fs.writeFileSync(path.resolve(out), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${path.resolve(out)}`);
  }
}

main().catch((e) => { console.error(`\nreference-set failed: ${e.message}\n`); process.exit(1); });
