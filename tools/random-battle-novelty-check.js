#!/usr/bin/env node
// ============================================================================
// Offline check — DP.RandomBattle's novelty-biased encounter draw
// ----------------------------------------------------------------------------
//   node tools/random-battle-novelty-check.js
//
// Stubs just enough Foundry surface to load the classic script
// (modules/fabula-ultima-companion/scripts/dungeon-pathing-system/dp-random-battle.js)
// and call pickEncounter() 20k times per scenario, asserting the resulting
// spread matches the intended weighting.
//
// The dynamic ActionReaderCore import cannot resolve under Node, so this
// exercises the local weighted-pick fallback. That is deliberate and still
// meaningful: the two implementations are the same cumulative sweep, and the
// fallback is the path that runs if the import ever breaks in the browser.
//
// See modules/fabula-ultima-companion/docs/dungeon-random-encounter-design.md
// ============================================================================

const path = require("path");
const fs   = require("fs");

const REPO       = path.resolve(__dirname, "..");
const SCRIPT_REL = "modules/fabula-ultima-companion/scripts/dungeon-pathing-system/dp-random-battle.js";

// ── Fixture ────────────────────────────────────────────────────────────────
const ACTORS = ["Electro Slime", "Lightning Prism", "Kirin", "Skizzik", "Mana Ray"]
  .map((name, i) => ({ id: `a${i}`, name, uuid: `Actor.a${i}` }));
const byName = new Map(ACTORS.map(a => [a.name, a]));

let UNSEEN = new Set(["Kirin", "Mana Ray"]);   // everything else has been met
let BIAS   = 1;

// Every row is 1-wide, so the authored base weight is equal across rows and any
// skew in the output is purely the novelty bias.
const ROWS = [
  "Electro Slime, Electro Slime",      // 0 new
  "Lightning Prism, Electro Slime",    // 0 new
  "Skizzik, Electro Slime",            // 0 new
  "Kirin, Electro Slime",              // 1 new
  "Mana Ray, Mana Ray",                // 1 new — DISTINCT count, not slot count
  "Kirin, Mana Ray",                   // 2 new
].map((text, i) => ({ text, range: [i + 1, i + 1] }));

// ── Foundry stubs ──────────────────────────────────────────────────────────
globalThis.DungeonPathing = { MODULE_ID: "fabula-ultima-companion", HOOKS: { GRAPH_REBUILT: "x" } };
globalThis.Hooks = { once() {}, on() {}, off() {} };
globalThis.ui    = { notifications: { warn() {}, error() {}, info() {} } };
globalThis.game  = {
  user:     { isGM: true },
  settings: { register() {}, get: () => false, set() {} },
  modules:  { get: () => null },
  macros:   { getName: () => null },
  scenes:   { get: () => null },
  tables:   { get: (id) => (id === "enc" ? { results: ROWS } : null) },
  actors:   { getName: (n) => byName.get(String(n).trim()) ?? null, get: () => null },
};
globalThis.fromUuid   = async () => null;
globalThis.window     = globalThis;
globalThis.CampSystem = { Party: { resolve: async () => [] } };
globalThis.oni = {
  FabulaConfig: {
    readDungeon: () => ({ encounterTable: "enc", enemiesTable: "", encounterNoveltyBias: BIAS }),
  },
};
globalThis.FUCompanion = {
  api: {
    encyclopedia: {
      // null == no page == the party has never fought this monster
      getPageForActor: (uuid) => {
        const a = ACTORS.find(x => x.uuid === uuid);
        return a && UNSEEN.has(a.name) ? null : { placeholder: true };
      },
    },
  },
};

const realWarn = console.warn;
console.warn = () => {};
console.debug = () => {};

// ── Load the script under test ─────────────────────────────────────────────
new Function(fs.readFileSync(path.join(REPO, SCRIPT_REL), "utf8"))();
const { pickEncounter } = globalThis.DungeonPathing.RandomBattle._internals;

// ── Run ────────────────────────────────────────────────────────────────────
const N   = 20000;
const TOL = 1.5;   // percentage points

async function sample(label) {
  const tally = new Map(ROWS.map(r => [r.text, 0]));
  for (let i = 0; i < N; i++) {
    const key = (await pickEncounter({ id: "s", name: "Test" })).map(p => p.name).join(", ");
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log(`\n=== ${label} ===`);
  for (const r of ROWS) {
    const newCount = new Set(r.text.split(",").map(s => s.trim()).filter(n => UNSEEN.has(n))).size;
    console.log(`  ${newCount} new | ${((tally.get(r.text) ?? 0) / N * 100).toFixed(1).padStart(5)}%  ${r.text}`);
  }
  return (text) => (tally.get(text) ?? 0) / N * 100;
}

function check(label, ok) {
  console.log(`  → ${label} : ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

(async () => {
  // 1. Default bias. Weights are 1,1,1,2,2,3 → total 10 → 10/10/10/20/20/30 %.
  const p1 = await sample("bias = 1 (default), 2 monsters unmet");
  const ok1 = check("expected 10/10/10/20/20/30",
    Math.abs(p1(ROWS[0].text) - 10) < TOL &&
    Math.abs(p1(ROWS[3].text) - 20) < TOL &&
    Math.abs(p1(ROWS[5].text) - 30) < TOL);

  // 2. Bias off → the authored table, untouched.
  BIAS = 0;
  const p2 = await sample("bias = 0 (disabled)");
  const ok2 = check("expected a flat 16.7% each",
    ROWS.every(r => Math.abs(p2(r.text) - 100 / 6) < TOL));

  // 3. Roster exhausted → every multiplier collapses to 1 with no special case.
  BIAS = 1; UNSEEN = new Set();
  const p3 = await sample("bias = 1, but the party has met everything");
  const ok3 = check("expected a flat 16.7% each",
    ROWS.every(r => Math.abs(p3(r.text) - 100 / 6) < TOL));

  console.warn = realWarn;
  const all = ok1 && ok2 && ok3;
  console.log(`\nALL: ${all ? "PASS" : "FAIL"}`);
  process.exit(all ? 0 : 1);
})();
