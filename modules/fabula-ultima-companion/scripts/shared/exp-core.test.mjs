// ============================================================================
// EXP core — gauge, overflow and award-formula harness.
//
//     node scripts/shared/exp-core.test.mjs
//
// This module is the single writer of experience, character level and
// skill_point, so every one of its edge cases is a silent one at the table: a
// level that doesn't fire, a Skill Point that never appears, an EXP bar that
// animates to the wrong place. The cases below are exactly the six divergences
// the unification reconciled — see docs/exp-award-pipeline.md.
//
// Foundry globals are stubbed just far enough for the module to load.
// ============================================================================

globalThis.foundry = {
  utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o) },
};
globalThis.Hooks = { callAll() {} };
globalThis.game = { actors: { get: () => null }, user: { id: "u", name: "GM" } };

const { computeExpAndLevel, computeExpAward, expToPct, EXP_RULE } =
  await import("./exp-core.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = typeof got === "number" && typeof want === "number"
    ? Math.abs(got - want) < 1e-6
    : got === want;
  if (ok) { pass++; console.log(` ok   ${label}`); }
  else    { fail++; console.log(`FAIL  ${label}: got ${got}, want ${want}`); }
};

const enemy = (id, level, rank = "soldier") =>
  ({ id, name: id, system: { props: { level: String(level), npc_rank: rank } } });
const MULTS = { G: 1, soldier: 1, elite: 1.5, champion: 3, boss: 1.6 };

// ── Divergence 1: the canonical gauge is 1..10, so a level is NINE wide ─────
eq("gauge width is 9", EXP_RULE.LEVEL_UP_AT - EXP_RULE.EXP_START, 9);

let r = computeExpAndLevel(1, 5, 9);
eq("1 + 9 levels exactly once", r.levelsGained, 1);
eq("  and rolls over to EXP_START", r.afterExp, 1);
eq("  level 5 -> 6", r.afterLevel, 6);

r = computeExpAndLevel(1, 5, 8.99);
eq("1 + 8.99 stops one hair short", r.levelsGained, 0);
eq("  afterExp", r.afterExp, 9.99);

// ── Multi-level: the award cap (15) exceeds a level, so double-ups happen ───
r = computeExpAndLevel(9, 5, 15);
eq("9 + 15 levels twice", r.levelsGained, 2);
eq("  afterExp", r.afterExp, 6);
eq("  level 5 -> 7", r.afterLevel, 7);

// ── Divergence 5: segments drive both bars ─────────────────────────────────
eq("  one segment per level crossed, plus the remainder", r.segments.length, 3);
eq("  first segment is a level-up", r.segments[0].levelUp, true);
eq("  first segment ends at the cap", r.segments[0].to, 10);
eq("  last segment is flat", r.segments.at(-1).levelUp, false);
eq("a zero gain still yields one segment", computeExpAndLevel(4, 3, 0).segments.length, 1);

// ── Divergence 1 (migration): old 0-based expAwarder data self-heals ───────
r = computeExpAndLevel(0, 41, 0);
eq("stored 0 normalises up to EXP_START", r.afterExp, 1);
eq("  without inventing a level", r.levelsGained, 0);

// ── Divergence 3: an over-cap stored value becomes levels, not confetti ────
// 19 raw points from a base of 1 is 18/9 = two whole levels.
r = computeExpAndLevel(19, 5, 0);
eq("stored 19 normalises to level +2", r.beforeLevel, 7);
eq("  with the remainder carried", r.beforeExp, 1);

// ── Divergence 4: negatives are honoured, but never de-level ───────────────
r = computeExpAndLevel(3, 7, -10);
eq("a big negative clamps at EXP_START", r.afterExp, 1);
eq("  and leaves the level alone", r.afterLevel, 7);

// ── Percentages divide by 9, not 10 ────────────────────────────────────────
eq("expToPct at floor", expToPct(1), 0);
eq("expToPct at cap", expToPct(10), 100);
eq("expToPct at midpoint", expToPct(5.5), 50);

// ── Divergence 6: one formula, and it reproduces the design-doc numbers ────
const pc = { id: "pc", name: "PC", system: { props: { level: "20" } } };
const sixSoldiers = Array.from({ length: 6 }, (_, i) => enemy("s" + i, 20));

let out = await computeExpAward({ partyActors: [pc], enemyActors: sixSoldiers, multipliers: MULTS });
eq("6 level-appropriate soldiers, fought", out.expByActorId.pc, 3.5);

out = await computeExpAward({ partyActors: [pc], enemyActors: sixSoldiers, multipliers: MULTS, mult: 0.7, floor: 0.5 });
eq("  the same six, taken down at 0.7x", out.expByActorId.pc, 2.45);

// The multiplier must land BEFORE the clamp. Against a single trivial enemy the
// raw value is under the fight floor of 1, so clamping first would round the
// discount away entirely and stealth would silently pay full price.
out = await computeExpAward({ partyActors: [pc], enemyActors: [enemy("w", 1)], multipliers: MULTS, mult: 0.7, floor: 0.5 });
eq("a trivial haul keeps its discount (mult before clamp)", out.expByActorId.pc, 0.5);
out = await computeExpAward({ partyActors: [pc], enemyActors: [enemy("w", 1)], multipliers: MULTS });
eq("  the same haul fought hits the floor of 1", out.expByActorId.pc, 1);

// Diminishing weights: the seventh enemy still counts, at the repeated tail.
const seven = Array.from({ length: 7 }, (_, i) => enemy("s" + i, 20));
out = await computeExpAward({ partyActors: [pc], enemyActors: seven, multipliers: MULTS });
eq("a 7th enemy adds the repeated tail weight", out.expByActorId.pc, 3.9);

// Boss premium fires on a champion even without the isBoss flag.
out = await computeExpAward({ partyActors: [pc], enemyActors: [enemy("c", 20, "champion")], multipliers: MULTS });
eq("champion presence applies the boss premium", out.expByActorId.pc, 4.8);
out = await computeExpAward({ partyActors: [pc], enemyActors: [enemy("e", 20, "elite")], multipliers: MULTS });
eq("elite alone does not", out.expByActorId.pc, 1.5);

// The level-delta clamp bottoms out against badly under-levelled enemies.
out = await computeExpAward({ partyActors: [pc], enemyActors: [enemy("weak", -60)], multipliers: MULTS });
eq("a hopelessly under-levelled enemy floors at 1", out.expByActorId.pc, 1);

// Empty inputs are a no-op, not a crash.
out = await computeExpAward({ partyActors: [], enemyActors: sixSoldiers, multipliers: MULTS });
eq("no party yields no awards", Object.keys(out.expByActorId).length, 0);
out = await computeExpAward({ partyActors: [pc], enemyActors: [], multipliers: MULTS });
eq("no enemies yields no awards", Object.keys(out.expByActorId).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
