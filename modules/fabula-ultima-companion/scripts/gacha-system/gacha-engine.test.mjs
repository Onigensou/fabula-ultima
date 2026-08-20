// ============================================================================
// Gacha System — pity math regression harness.
//
//     node scripts/gacha-system/gacha-engine.test.mjs
//
// Covers `rollRarities`, the pure core of the roll engine. It is worth pinning
// because both guarantees the player is shown on the banner card live here:
// the 30-pull 5-star ceiling, and the "every 10 wishes includes a 4-star or
// higher" floor. Both are off-by-one traps — a counter compared before instead
// of after its increment silently turns the 30th pull into the 31st.
//
// Math.random is stubbed per-case, so every assertion below is deterministic.
//
// What this does NOT cover: table resolution, granting, or spend atomicity —
// those need real documents and are verified in-game.
// ============================================================================

import { rollRarities } from "./gacha-engine.js";
import { PITY_FIVE, PITY_FOUR } from "./gacha-const.js";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`); }
}

/** Force Math.random to a fixed value for the duration of fn(). */
function withRandom(value, fn) {
  const real = Math.random;
  Math.random = typeof value === "function" ? value : () => value;
  try { return fn(); } finally { Math.random = real; }
}

const NO_LUCK   = { five: 0, four: 0, three: 1 };   // random never beats a rate
const ALL_FIVE  = { five: 1, four: 0, three: 0 };
const zero      = { five: 0, four: 0 };

console.log("\ngacha: pity math\n");

// ── 5-star hard ceiling ─────────────────────────────────────────────────────

withRandom(0.999, () => {
  const { rarities } = rollRarities(PITY_FIVE, NO_LUCK, zero);
  check(
    `pull #${PITY_FIVE} is the guaranteed 5-star (not #${PITY_FIVE + 1})`,
    rarities[PITY_FIVE - 1],
    "five"
  );
  check(
    "no 5-star lands before the ceiling",
    rarities.slice(0, PITY_FIVE - 1).includes("five"),
    false
  );
});

withRandom(0.999, () => {
  const { pity } = rollRarities(PITY_FIVE, NO_LUCK, zero);
  check("hitting the ceiling resets BOTH counters", pity, { five: 0, four: 0 });
});

// ── 4-star floor ────────────────────────────────────────────────────────────

withRandom(0.999, () => {
  const { rarities } = rollRarities(PITY_FOUR, NO_LUCK, zero);
  check(
    `pull #${PITY_FOUR} is a guaranteed 4-star or better`,
    rarities[PITY_FOUR - 1],
    "four"
  );
  check(
    "the nine pulls before it may all be 3-star",
    rarities.slice(0, PITY_FOUR - 1).every((r) => r === "three"),
    true
  );
});

withRandom(0.999, () => {
  // A full x10 with no luck must never be all-3-star: that is precisely the
  // "1 in 5 ten-pulls is a total dud" failure the floor exists to prevent.
  const { rarities } = rollRarities(10, NO_LUCK, zero);
  check("a x10 always contains a 4-star or better", rarities.includes("four") || rarities.includes("five"), true);
});

// ── Counter carry-over ──────────────────────────────────────────────────────

withRandom(0.999, () => {
  const first = rollRarities(9, NO_LUCK, zero);
  check("nine unlucky pulls leave the 4-star counter at 9", first.pity.four, 9);

  const second = rollRarities(1, NO_LUCK, first.pity);
  check("the tenth pull across a batch boundary still honours the floor", second.rarities[0], "four");
  check("...and resets the 4-star counter only", second.pity, { five: 10, four: 0 });
});

// ── A natural 5-star satisfies the 4-star floor ─────────────────────────────

withRandom(0, () => {
  const { rarities, pity } = rollRarities(1, ALL_FIVE, { five: 5, four: 9 });
  check("a natural 5-star is still a 5-star", rarities[0], "five");
  check("a natural 5-star clears the 4-star floor too", pity, { five: 0, four: 0 });
});

// ── Normal distribution path ────────────────────────────────────────────────

withRandom(0.5, () => {
  // 0.5 falls past five (0.03) and past five+four (0.15) → 3-star.
  const { rarities } = rollRarities(1, { five: 0.03, four: 0.12, three: 0.85 }, zero);
  check("mid-roll with stock rates yields a 3-star", rarities[0], "three");
});

withRandom(0.1, () => {
  // 0.1 is past five (0.03) but inside five+four (0.15) → 4-star.
  const { rarities } = rollRarities(1, { five: 0.03, four: 0.12, three: 0.85 }, zero);
  check("a roll inside the 4-star band yields a 4-star", rarities[0], "four");
});

withRandom(0.01, () => {
  const { rarities } = rollRarities(1, { five: 0.03, four: 0.12, three: 0.85 }, zero);
  check("a roll inside the 5-star band yields a 5-star", rarities[0], "five");
});

// ── Batch size integrity ────────────────────────────────────────────────────

withRandom(0.5, () => {
  const { rarities } = rollRarities(10, { five: 0.03, four: 0.12, three: 0.85 }, zero);
  check("a x10 returns exactly ten outcomes", rarities.length, 10);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
