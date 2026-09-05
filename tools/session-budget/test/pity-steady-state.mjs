/**
 * Derives the random-battle trigger rate used in model/tile-costs.json.
 *
 * dp-random-battle.js does NOT roll the configured random_battle_percentage as
 * an independent chance per tile. It runs a pity chain (nextRate):
 *
 *   miss -> p = min(100, p + 20 + rand*10)
 *   hit  -> p = max(minimum_encounter_percentage, round(p * 0.5))
 *
 * That chain has a steady state near 47% no matter what base rate is
 * configured, which is why session length is insensitive to
 * random_battle_percentage but sensitive to minimum_encounter_percentage.
 *
 * Run: node test/pity-steady-state.mjs
 */
const RUNS = 2_000_000;

function steadyState(minimum, start = 30) {
  let p = start, hits = 0;
  for (let i = 0; i < RUNS; i++) {
    const appear = Math.floor(Math.random() * 100) + 1 <= p;
    if (appear) hits++;
    p = appear
      ? Math.max(minimum, Math.round(p * 0.5))
      : Math.min(100, p + 20 + Math.random() * 10);
  }
  return hits / RUNS;
}

console.log(`\n  Random-battle pity chain — steady state over ${RUNS.toLocaleString()} tile steps\n`);
console.log("  minimum_encounter_%   trigger rate   tiles per battle");
for (const min of [5, 10, 15, 20, 25, 30]) {
  const r = steadyState(min);
  console.log(`  ${String(min).padStart(17)}%   ${(r * 100).toFixed(1).padStart(11)}%   ${(1 / r).toFixed(2).padStart(16)}`);
}
console.log("\n  Starting rate is irrelevant after ~5 tiles — the chain forgets it.\n");

for (const start of [5, 30, 90]) {
  const r = steadyState(5, start);
  console.log(`  start ${String(start).padStart(2)}% -> ${(r * 100).toFixed(1)}%`);
}
console.log("");
