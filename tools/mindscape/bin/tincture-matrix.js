#!/usr/bin/env node
"use strict";
//
// Mindscape — the Tincture Cycle matrix (ruleset Part 6l).
//
// Every group in an encounter file x every arm (no tinctures, damage 25/30,
// Endurance 25/30, both 25/30). Runs are PAIRED: run i of a group uses the same
// seed in every arm, so a difference between arms is the tincture, not the dice.
//
//   node bin/tincture-matrix.js --set specs/encounters/tincture-set.json \
//     --runs 1000 --out expectations/tincture-matrix.json
//
// The game must be CLOSED — Foundry holds an exclusive lock on the world DB.

const fs = require("fs");
const path = require("path");
const { loadParty, loadNamed } = require("../lib/load-actors");
const { runBattle } = require("../lib/engine");
const { resolveEvent } = require("../lib/conflict-events");
const { Rng } = require("../lib/rng");
const TN = require("../lib/tinctures");

const ARMS = [
  { id: "baseline", pct: {} },
  { id: "dmg25", pct: { strength: 25, spirit: 25 } },
  { id: "dmg30", pct: { strength: 30, spirit: 30 } },
  { id: "end25", pct: { endurance: 25 } },
  { id: "end30", pct: { endurance: 30 } },
  { id: "all25", pct: { strength: 25, spirit: 25, endurance: 25 } },
  { id: "all30", pct: { strength: 30, spirit: 30, endurance: 30 } },
];

function parseArgs(argv) {
  const out = { runs: 1000, seed: "tincture-matrix", user: TN.DEFAULT_USER, stock: TN.DEFAULT_STOCK };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--set") out.setFile = next();
    else if (a === "--runs" || a === "-n") out.runs = Number(next());
    else if (a === "--seed") out.seed = next();
    else if (a === "--out") out.out = next();
    else if (a === "--only") out.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--arms") out.arms = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--user") out.user = next();
    else if (a === "--stock") out.stock = Number(next());
  }
  return out;
}

// The same in-memory patch grammar as mindscape.js --set: "Item:prop=value" on an
// item the enemy carries, or "actor:prop=value". Refuses a patch that matches
// nothing — a typo would otherwise read as "this dial does not matter".
function applySets(enemies, sets) {
  for (const spec of sets ?? []) {
    const eq = spec.indexOf("=");
    const colon = spec.indexOf(":");
    if (colon < 1 || eq < colon + 2) throw new Error(`bad set "${spec}" (want "Item:prop=value" or "actor:prop=value")`);
    const who = spec.slice(0, colon).trim();
    const prop = spec.slice(colon + 1, eq).trim();
    const value = spec.slice(eq + 1);
    let hits = 0;
    for (const e of enemies) {
      if (who.toLowerCase() === "actor") {
        e._rawProps[prop] = value;
        const n = Number(value);
        if (Number.isFinite(n)) {
          if (prop === "max_hp") e.hp.max = n;
          else if (prop === "current_hp") e.hp.cur = n;
          else if (prop === "defense") e.def = n;
          else if (prop === "magic_defense") e.mdef = n;
        }
        hits++;
        continue;
      }
      for (const it of e.items ?? []) {
        if (String(it.name).trim().toLowerCase() !== who.toLowerCase()) continue;
        it.props[prop] = value;
        hits++;
      }
    }
    if (!hits) throw new Error(`set matched nothing: ${spec}`);
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarise(results, carrier) {
  const n = results.length;
  const wins = results.filter((r) => r.outcome === "victory");
  const share = (o) => results.filter((r) => r.outcome === o).length / n;
  const party = (r) => r.combatants.filter((c) => c.side === "party");
  const downRate = {};
  for (const r of results) for (const d of r.downs) downRate[d.name] = (downRate[d.name] ?? 0) + 1 / n;
  const used = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.tinctures?.used ?? {})) used[k] = (used[k] ?? 0) + v / n;
  }
  const carrierRow = (r) => r.combatants.find((c) => c.side === "party" && c.name.trim().toLowerCase() === carrier);
  return {
    runs: n,
    win: wins.length / n,
    defeat: share("defeat") + share("mutual-destruction"),
    overtime: share("overtime"),
    wonRounds: mean(wins.map((r) => r.rounds)),
    wonHp: mean(wins.map((r) => r.partyHpRemaining)),
    downsPerFight: mean(results.map((r) => r.downs.length)),
    downRate,
    used,
    addedDamage: mean(results.map((r) => party(r).reduce((s, c) => s + (c.tinctureBonusDealt ?? 0), 0))),
    prevented: mean(results.map((r) => party(r).reduce((s, c) => s + (c.tincturePrevented ?? 0), 0))),
    carrierDamage: mean(results.map((r) => carrierRow(r)?.damageDealt ?? 0)),
    partyDamage: mean(results.map((r) => party(r).reduce((s, c) => s + c.damageDealt, 0))),
  };
}

const pct = (x) => (x == null ? "  —" : `${(x * 100).toFixed(0)}%`);
const num = (x, d = 1) => (x == null ? "—" : x.toFixed(d));
const signed = (x, d = 2) => (x == null ? "" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);

function printGroup(g, arms) {
  const base = arms.baseline;
  console.log(`\n== ${g.id}  ${g.label}  ·  ${g.enemies.join(" + ")}${g.conflictEvent ? `  [${g.conflictEvent}]` : ""}${g.boss ? "  (BOSS PROXY)" : ""}`);
  console.log("  arm        win   defeat  won rds (Δ)      HP@win (Δ)    downs  used S/Sp/E        added  prevented  carrier dmg");
  for (const [id, s] of Object.entries(arms)) {
    const dR = base && s !== base && s.wonRounds != null && base.wonRounds != null ? ` (${signed(s.wonRounds - base.wonRounds)})` : "";
    const dH = base && s !== base && s.wonHp != null && base.wonHp != null ? ` (${signed((s.wonHp - base.wonHp) * 100, 0)})` : "";
    const used = ["strength", "spirit", "endurance"].map((k) => (s.used[k] == null ? "-" : s.used[k].toFixed(1))).join("/");
    console.log("  " + id.padEnd(9)
      + pct(s.win).padStart(5) + pct(s.defeat).padStart(8)
      + `  ${num(s.wonRounds, 2)}${dR}`.padEnd(18)
      + `${pct(s.wonHp)}${dH}`.padEnd(14)
      + num(s.downsPerFight, 2).padStart(5)
      + `  ${used}`.padEnd(20)
      + num(s.addedDamage).padStart(6) + num(s.prevented).padStart(11) + num(s.carrierDamage).padStart(13));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.setFile) {
    console.error("usage: node bin/tincture-matrix.js --set <encounter file> [--runs N] [--seed S] [--out file] [--only ids] [--arms ids]");
    process.exit(1);
  }
  const set = JSON.parse(fs.readFileSync(path.resolve(args.setFile), "utf8"));
  const groups = set.groups.filter((g) => !args.only || args.only.includes(g.id));
  const arms = ARMS.filter((a) => !args.arms || args.arms.includes(a.id));
  const carrier = String(args.user).trim().toLowerCase();

  const party = await loadParty({});
  if (!party.some((p) => String(p.name).trim().toLowerCase() === carrier)) {
    console.error(`carrier "${args.user}" is not in the party`);
    process.exit(2);
  }
  console.log(`Tincture matrix — ${party.map((p) => p.name).join(", ")}  ·  carried by ${args.user}  ·  ${args.stock} of each`);
  console.log(`${args.runs} paired runs per arm  ·  seed "${args.seed}"  ·  ⚠ PAPER CONSUMABLES, partial model (--force equivalent)`);

  const report = {
    generated: new Date().toISOString(), seed: args.seed, runs: args.runs,
    carrier: args.user, stock: args.stock, arms: arms.map((a) => ({ id: a.id, pct: a.pct })), groups: [],
  };
  const t0 = Date.now();
  for (const g of groups) {
    const enemies = await loadNamed(g.enemies);
    applySets(enemies, g.sets);
    const conflictEvent = g.conflictEvent ? resolveEvent(g.conflictEvent) : null;
    const expectedRounds = g.expectedRounds ?? 7;
    const run = (tinctures) => {
      const results = [];
      for (let i = 0; i < args.runs; i++) {
        results.push(runBattle({
          party, enemies, rng: new Rng(`${args.seed}:${g.id}:${i}`), expectedRounds, conflictEvent, tinctures,
        }));
      }
      return results;
    };
    // The baseline runs double as the carrier's prior: who actually deals the party's
    // DEF and MDEF damage in THIS fight (tinctures.measureLanePrior).
    const baseResults = run(null);
    const lanePrior = TN.measureLanePrior(baseResults);
    const out = {};
    for (const arm of arms) {
      const results = arm.id === "baseline" ? baseResults
        : run({ pct: arm.pct, user: args.user, stock: args.stock, lanePrior });
      out[arm.id] = summarise(results, carrier);
    }
    printGroup(g, out);
    console.log(`  carrier prior (dmg/round by lane): ${Object.entries(lanePrior)
      .map(([n, v]) => `${n} def ${v.def.toFixed(0)} mdef ${v.mdef.toFixed(0)}`).join("  ·  ")}`);
    report.groups.push({ ...g, lanePrior, arms: out });
  }
  console.log(`\n${groups.length} groups × ${arms.length} arms in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + "\n");
    console.log(`wrote ${args.out}`);
  }
}

main().catch((e) => { console.error(`\ntincture-matrix failed: ${e.message}\n`); process.exit(1); });
