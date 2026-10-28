#!/usr/bin/env node
"use strict";
//
// Orbment roll simulator — measures the Alchemist's random Attunement OFFLINE,
// using the game's OWN roll tables and augment registry (imported live from the
// module, so the numbers here are the numbers that ship).
//
//   node bin/orbment-roll-sim.js                       # cost-to-target report, all item types
//   node bin/orbment-roll-sim.js --kind armor --rarity uncommon
//   node bin/orbment-roll-sim.js --session weapon:rare:rough:12 --seed 7
//                                                      # a readable roll-by-roll session
//   node bin/orbment-roll-sim.js --runs 50000           # averages per stone (default 100000)
//
// Design rule it checks (user, 2026-10-28): rolls are cheap, good results are
// rare — a specific good Orbment is a rare-drop chase; Upgrade is the guaranteed
// path. Perfect percentage rolls should cost about what a Jackpot does, never more.

const path = require("path");
const { pathToFileURL } = require("url");

const MOD = path.resolve(__dirname, "../../../modules/fabula-ultima-companion/scripts/orbment");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

// Small seeded PRNG (LCG) so a --session replays exactly.
function seeded(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

(async () => {
  const T = await import(pathToFileURL(path.join(MOD, "orbment-roll-tables.js")).href);
  const R = await import(pathToFileURL(path.join(MOD, "augment-registry.js")).href);
  const byId = new Map(R.AUGMENTS.map((a) => [a.id, a]));
  const label = (o) => (o ? R.resolveAugment(o.id, o.param, o.value)?.label ?? o.id : "Empty slot");
  const standing = (o) => (o ? T.slotStanding(byId.get(o.id), o.value) : null);

  const session = arg("session", null);
  if (session) {
    const [kind = "weapon", rarity = "rare", grade = "rough", n = "12"] = session.split(":");
    const rng = seeded(arg("seed", 7));
    const pool = R.rollableAugments(kind);
    const price = T.attunePrice(rarity, grade);
    console.log(`\n${kind} (${rarity}) · ${T.STONES[grade].label} · ${price} z per roll`);
    let cur = null, spent = 0;
    for (let i = 1; i <= Number(n); i++) {
      const now = T.rollAugment(pool, grade, { rng });
      spent += price;
      const v = T.verdictFor(standing(cur), { tier: now.tier, stepIndex: now.stepIndex, stepCount: now.stepCount });
      console.log(`${String(i).padStart(3)}. ${label(cur).padEnd(30)} → ${label(now).padEnd(30)} ${T.TIERS[now.tier].padEnd(9)} ${v}`);
      cur = now;
    }
    console.log(`     spent ${spent.toLocaleString()} z`);
    return;
  }

  const RUNS = Number(arg("runs", 100000));
  const kinds = arg("kind", null) ? [arg("kind")] : ["weapon", "armor", "shield"];
  const rarity = arg("rarity", "rare");
  const rng = seeded(arg("seed", 5));
  // Targets per item type: [name, test(result)] — broad goals and specific chases.
  const TARGETS = {
    weapon: [["Rare or better", (o) => o.tier >= 2], ["any Jackpot", (o) => o.tier === 3], ["Multi (2)", (o) => o.id === "multi"],
      ["Fury +10%", (o) => o.id === "fury" && o.value === 10], ["Hunter +5 (any)", (o) => o.id === "hunter" && o.value === 5]],
    armor: [["Rare or better", (o) => o.tier >= 2], ["Max HP +15", (o) => o.id === "max_hp" && o.value === 15], ["Accuracy Up", (o) => o.id === "accuracy_up"],
      ["Ward: Physical 20%", (o) => o.id === "ward_phys" && o.value === 20], ["Aegis 10%", (o) => o.id === "aegis" && o.value === 10], ["Guard +5 (any)", (o) => o.id === "guard" && o.value === 5]],
    shield: [["Rare or better", (o) => o.tier >= 2], ["Max HP +15", (o) => o.id === "max_hp" && o.value === 15], ["Accuracy Up", (o) => o.id === "accuracy_up"]],
  };
  for (const kind of kinds) {
    const pool = R.rollableAugments(kind);
    const per = [0, 0, 0, 0]; pool.forEach((a) => per[a.tier]++);
    console.log(`\n== ${kind} · pool ${pool.length} (C/U/R/J ${per.join("/")}) · item rarity ${rarity}`);
    for (const grade of Object.keys(T.STONES)) {
      const price = T.attunePrice(rarity, grade);
      const tiers = [0, 0, 0, 0];
      for (let i = 0; i < RUNS; i++) tiers[T.rollAugment(pool, grade, { rng }).tier]++;
      console.log(`  ${T.STONES[grade].label.padEnd(15)} ${String(price).padStart(4)} z · ` + tiers.map((c, i) => `${T.TIERS[i]} ${(c / RUNS * 100).toFixed(1)}%`).join(" · "));
      for (const [name, test] of TARGETS[kind] ?? []) {
        let hits = 0;
        for (let i = 0; i < RUNS; i++) if (test(T.rollAugment(pool, grade, { rng }))) hits++;
        const rolls = hits ? RUNS / hits : Infinity;
        console.log(`      ${name.padEnd(22)} ${Number.isFinite(rolls) ? rolls.toFixed(1).padStart(7) : "  never"} rolls ≈ ${Number.isFinite(rolls) ? Math.round(rolls * price).toLocaleString().padStart(8) : "-"} z`);
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
