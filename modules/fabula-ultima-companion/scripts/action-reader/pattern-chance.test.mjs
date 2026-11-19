// ============================================================================
// action_pattern_chance (A4) — the per-row chance gate on AI pattern rows.
//
//     node scripts/action-reader/pattern-chance.test.mjs
//
// Nox Priest's Revive: `enemy_has_status Zombie` AND 33%. A pattern row holds
// ONE condition, so the coin flip rides its own column. Blank must stay 100 —
// every existing row is blank and must never start rolling.
// ============================================================================

const { normalizePatternChance } = await import("./actionReader-readPatternTable.js");
const { applyPatternChanceGate } = await import("./actionReader-evaluateConditions.js");

let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

// ── column normalization ─────────────────────────────────────────────────────
check("blank = 100",        normalizePatternChance(""), 100);
check("undefined = 100",    normalizePatternChance(undefined), 100);
check("\"33\"",             normalizePatternChance("33"), 33);
check("\"33%\"",            normalizePatternChance("33%"), 33);
check("number 50",          normalizePatternChance(50), 50);
check("clamp > 100",        normalizePatternChance("250"), 100);
check("clamp < 0",          normalizePatternChance("-5"), 0);
check("garbage = 100",      normalizePatternChance("abc"), 100);
check("0 stays 0",          normalizePatternChance("0"), 0);

// ── gate ─────────────────────────────────────────────────────────────────────
const pass = { passed: true, reason: "Enemy has Zombie.", details: {} };
const fail = { passed: false, reason: "No enemy has Zombie.", details: {} };
let rolled = 0;
const rng = (v) => () => { rolled++; return v; };

rolled = 0;
check("chance 100 never rolls", applyPatternChanceGate(pass, 100, rng(0.99)).passed, true);
check("  (no roll)", rolled, 0);
rolled = 0;
check("failed condition stays failed, no roll", applyPatternChanceGate(fail, 33, rng(0)).passed, false);
check("  (no roll)", rolled, 0);
check("33%: roll 32.0 passes",  applyPatternChanceGate(pass, 33, rng(0.32)).passed, true);
check("33%: roll 33.0 fails",   applyPatternChanceGate(pass, 33, rng(0.33)).passed, false);
check("33%: roll 99 fails",     applyPatternChanceGate(pass, 33, rng(0.99)).passed, false);
check("0%: roll 0 fails",       applyPatternChanceGate(pass, 0, rng(0)).passed, false);
check("gated flag on fail",     applyPatternChanceGate(pass, 33, rng(0.5)).details.chanceGated, true);
check("input not mutated",      pass.passed, true);

// Distribution sanity with the real RNG: ~33% of 20000 rows survive.
let kept = 0;
for (let i = 0; i < 20000; i++) if (applyPatternChanceGate(pass, 33).passed) kept++;
const pct = kept / 200;
check(`real RNG ~33% (got ${pct.toFixed(1)}%)`, pct > 30 && pct < 36, true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
