#!/usr/bin/env node
"use strict";
//
// Mindscape — does SPREAD damage end fights as fast as the same damage on one target?  READ-ONLY.
//
//   node bin/spread-test.js [--encounter-set specs/encounters/house-set.json] [--base-levels 35,50]
//        [--multi 2,3] [--flat 5,10,20,30] [--presets standard,...] [--runs 500] [--seed spread-test]
//        [--out <file.json>]
//
// The guide prices extra targets (Multi N) at FULL value: extra targets x the rider's damage.
// The Explosion Whip A/B supported that against practice dummies, which never attack — so
// the other half of the old split-damage argument went untested: spread damage kills nothing
// sooner, so enemies stay alive (and keep acting) longer than the damage total suggests.
// In this game more enemies do not simply mean longer fights either: Multi, Chain and
// Overflow actions hit several at once, and AoE is meant to be weaker per target than a
// single-target action. This measures the rider itself, on top of the party's existing kit.
//
// On the Striker (its modelled kit is weapon-only, so every swing is a basic attack), same
// encounter and seed:
//   multi arms   the Striker's basic weapon + "every basic attack gains Multi N"
//   flat arms    the Striker's basic weapon + X damage on its single target, for several X
// A straight line is fitted through the flat arms (X = 0 is basic gear) for the Striker's
// damage per round, the fight's rounds and the party's damage taken per round. Then:
//   X_damage   the flat bonus that deals the same damage per round as the multi arm
//   X_rounds   the flat bonus that ends fights as fast as the multi arm
//   spread efficiency = X_rounds / X_damage
// 1.0 = spread damage ends fights as fast as the same damage on one target (full value is
// right); 0.6 = it is worth 60% of its damage total (a split-damage discount is warranted).
// The same ratio from party damage taken says whether enemies kept hitting for longer.
//
// The game must be CLOSED.

const fs = require("fs");
const path = require("path");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue } = require("../lib/baseline-gear");
const { buildArchetypeParty, PRESETS, DEFAULT_SKILL_LAYER_K } = require("../lib/archetype-party");
const { applySwaps, sourceFromDoc, currentSlotItems } = require("../lib/loadout-swap");
const RS = require("../lib/reference-set");

const RIDER = "Mindscape Multi Rider (Passive)";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const list = (v) => String(v).split(",").map((x) => x.trim()).filter(Boolean);
const f2 = (x) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(2));
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// Pure: least squares y = a + b x. Exported for tests.
function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

// Pure: flat points [{x, dealt, rounds, taken}] + one multi arm -> equivalent flat bonuses.
// A ratio is null where its flat line does not move (a flat bonus that does not shorten the
// fight cannot say what spread damage is worth). Exported for tests.
function spreadEfficiency(flat, multi) {
  const xs = flat.map((p) => p.x);
  const inverse = (key) => {
    const { a, b } = fitLine(xs, flat.map((p) => p[key]));
    return Math.abs(b) > 1e-9 ? (multi[key] - a) / b : null;
  };
  const xDamage = inverse("dealt");
  const xRounds = inverse("rounds");
  const xTaken = inverse("taken");
  const ok = (x) => x != null && xDamage != null && xDamage > 1e-9;
  const maxX = Math.max(...xs);
  return {
    xDamage, xRounds, xTaken,
    roundsEfficiency: ok(xRounds) ? xRounds / xDamage : null,
    takenEfficiency: ok(xTaken) ? xTaken / xDamage : null,
    extrapolated: [xDamage, xRounds, xTaken].some((x) => x != null && x > maxX * 1.25),
  };
}

function weaponDoc(base, label, patch) {
  const doc = { name: `${base.name} [${label}]`, system: { props: { ...base.props, name: `${base.name} [${label}]` } },
    effects: JSON.parse(JSON.stringify(base.effects ?? [])), items: [] };
  patch(doc);
  return doc;
}

function measure(party, striker, scope, runs, seed) {
  const arm = RS.runArm(party, scope.enemies, { runs, seed, conflictEvent: scope.conflictEvent ?? null });
  // Rounds of WON fights: a wipe ends a fight early too, and would read as "faster".
  return {
    dealt: arm.members[striker].dealtPerRound.mean, rounds: arm.meanWonRounds, taken: arm.partyTakenPerRound.mean,
    loss: arm.defeatRate, wonInOne: arm.wonBands.oneRound,
  };
}

// A group the party loses at least this often says nothing about how fast damage ends fights.
const MAX_LOSS = 0.5;

async function main() {
  const runs = Number(arg("--runs", 1000));
  const seed = arg("--seed", "spread-test");
  const power = arg("--power", "table");
  const presets = list(arg("--presets", Object.keys(PRESETS).join(",")));
  const multis = list(arg("--multi", "2,3")).map(Number);
  const flats = list(arg("--flat", "10,20,40,60")).map(Number);
  const encounterSet = arg("--encounter-set", "specs/encounters/house-set.json");
  const baseLevels = list(arg("--base-levels", "35,50")).map(Number);
  const out = arg("--out", null);

  const scopes = [
    ...(encounterSet === "none" ? [] : (await RS.loadEncounterSet(encounterSet)).map((s) => ({ ...s, kind: "house" }))),
    ...RS.neutralScopes(baseLevels, { defense: null }).map((s) => ({ ...s, kind: "base", group: `rulebook L${s.level}` })),
  ];
  const worldItems = await loadWorldItems();
  const catalogue = basicCatalogue(worldItems, await loadWorldFolders());

  const t0 = Date.now();
  const rows = [];
  const skipped = [];
  for (const scope of scopes) {
    for (const preset of presets) {
      const build = () => buildArchetypeParty(preset, { level: scope.level, power, catalogue });
      const withWeapon = (makeDoc) => {
        const party = build();
        const s = party.find((m) => m.fromArchetype?.role === "striker");
        const doc = makeDoc(currentSlotItems(s).main);
        applySwaps(s, [{ slot: "main", source: sourceFromDoc(doc, doc.name) }], { worldItems });
        return { party, name: s.name };
      };
      const base = build();
      const strikerName = base.find((m) => m.fromArchetype?.role === "striker")?.name;
      if (!strikerName) continue;
      const flat = [{ x: 0, ...measure(base, strikerName, scope, runs, seed) }];
      if (flat[0].loss >= MAX_LOSS || flat[0].rounds == null) {
        skipped.push(`${scope.id} ${preset} (basic gear loses ${Math.round(100 * flat[0].loss)}%)`);
        continue;
      }
      for (const x of flats) {
        const { party, name } = withWeapon((w) => weaponDoc(w, `+${x}`, (d) => {
          d.system.props.damage_bonus = String((Number(w.props.damage_bonus) || 0) + x);
        }));
        flat.push({ x, ...measure(party, name, scope, runs, seed) });
      }
      for (const n of multis) {
        const { party, name } = withWeapon((w) => weaponDoc(w, `Multi ${n}`, (d) => {
          d.items.push({ name: RIDER, props: { skill_type: "Passive", mindscape_target_count: String(n) } });
        }));
        const m = measure(party, name, scope, runs, seed);
        rows.push({ scope: scope.id, group: scope.group, kind: scope.kind, level: scope.level, enemies: scope.enemies.length,
          preset, multi: n, flat, arm: m, ...spreadEfficiency(flat, m),
          dealtGainPct: flat[0].dealt ? (100 * (m.dealt - flat[0].dealt)) / flat[0].dealt : null });
      }
    }
  }

  console.log(`\nSpread test — ${power} power (k ${DEFAULT_SKILL_LAYER_K}), Striker basic attacks, ${runs} runs per arm, seed "${seed}"`);
  console.log(`Flat arms +${flats.join("/+")}; spread efficiency = flat bonus ending fights as fast ÷ flat bonus dealing as much damage.`);
  console.log(`1.00 = spread damage is worth its full total; below 1 = a split-damage discount. "taken" = the same from party damage taken.\n`);
  const table = (label, keyFn) => {
    console.log(`### ${label}\n`);
    console.log(`| Group | Multi | Striker damage gain | Flat-equivalent by damage | Rounds efficiency | Taken efficiency | Rows |`);
    console.log(`|---|---|---|---|---|---|---|`);
    const keys = [...new Set(rows.map((r) => `${keyFn(r)}\u0000${r.multi}`))];
    for (const k of keys) {
      const [g, n] = k.split("\u0000");
      const rs = rows.filter((r) => keyFn(r) === g && String(r.multi) === n);
      const ext = rs.filter((r) => r.extrapolated).length;
      console.log(`| ${g} | ${n} | +${f2(mean(rs.map((r) => r.dealtGainPct)))}% | +${f2(mean(rs.map((r) => r.xDamage)))} `
        + `| **${f2(mean(rs.map((r) => r.roundsEfficiency)))}** | ${f2(mean(rs.map((r) => r.takenEfficiency)))} | ${rs.length}${ext ? ` (${ext} extrapolated)` : ""} |`);
    }
    console.log("");
  };
  table("By dungeon", (r) => r.group);
  table("By enemies in the fight", (r) => `${r.enemies} enemies${r.kind === "base" ? " (rulebook)" : ""}`);
  const all = (n) => rows.filter((r) => r.multi === n);
  for (const n of multis) {
    console.log(`Multi ${n}, all rows: rounds efficiency ${f2(mean(all(n).map((r) => r.roundsEfficiency)))}, taken efficiency ${f2(mean(all(n).map((r) => r.takenEfficiency)))}`);
  }
  console.log(`\n${rows.length} rows · ${skipped.length} group × preset skipped as too lethal to time (loss ≥ ${100 * MAX_LOSS}%)`
    + `${skipped.length ? `:\n  · ${skipped.join("\n  · ")}` : ""}`);
  console.log(`Rounds are WON fights only. ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (out) {
    fs.writeFileSync(path.resolve(out), `${JSON.stringify({
      id: "spread-test", capturedAt: new Date().toISOString().slice(0, 10), runs, seed, power, k: DEFAULT_SKILL_LAYER_K,
      presets, multis, flats, encounterSet, baseLevels, maxLoss: MAX_LOSS, skipped, rows,
    }, null, 2)}\n`);
    console.log(`wrote ${path.resolve(out)}`);
  }
}

module.exports = { fitLine, spreadEfficiency };

if (require.main === module) {
  main().catch((e) => { console.error(`\nspread-test failed: ${e.message}\n`); process.exit(1); });
}
