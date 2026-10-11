// ============================================================================
// Lightning Crystal — rule harness.
//
//     node scripts/conflict-event/events/lightning-crystal.test.mjs
//
// Covers the pure half of the event: the spawn roll, the countdown and blast
// ranges, the damage → turns tiers, the predicate deciding whether a ledger
// event delays a crystal, and the per-turn tick key.
//
// Not covered here (needs a live Foundry): spawning, the countdown AE writes,
// the blast through BD's executor, and the shatter / sweep.
// ============================================================================

globalThis.game = { user: { isGM: true } };
globalThis.canvas = null;

const {
  rollCrystalCount, pinnedCrystalCount, rollCountdown, rollBlastDamage,
  bumpForDamage, crystalBumpFor, tickKeyFor,
} = await import("./lightning-crystal.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── Spawn roll: 25 / 50 / 25 ────────────────────────────────────────────────

eq("roll 0.00 → no crystal", rollCrystalCount(0), 0);
eq("roll 0.249 → no crystal", rollCrystalCount(0.249), 0);
eq("roll 0.25 → one", rollCrystalCount(0.25), 1);
eq("roll 0.749 → one", rollCrystalCount(0.749), 1);
eq("roll 0.75 → two", rollCrystalCount(0.75), 2);
eq("roll 0.999 → two", rollCrystalCount(0.999), 2);
eq("a roll of exactly 1 cannot produce a third crystal", rollCrystalCount(1), 2);

const pin = (v) => pinnedCrystalCount({ context: { conflictEventOptions: { crystalCount: v } } });
eq("no payload → roll", pinnedCrystalCount(null), null);
eq("no options → roll", pinnedCrystalCount({ context: {} }), null);
eq("pinned 0 is honoured, not treated as unset", pin(0), 0);
eq("pinned 2", pin(2), 2);
eq("a string count from a form field", pin("1"), 1);
eq("pinned above the cap clamps to 2", pin(7), 2);
eq("pinned negative clamps to 0", pin(-3), 0);
eq("garbage → roll", pin("many"), null);
eq("blank → roll", pin(""), null);

// ── Ranges ──────────────────────────────────────────────────────────────────

eq("countdown floor is 6", rollCountdown(0), 6);
eq("countdown ceiling is 9", rollCountdown(0.999), 9);
eq("countdown never exceeds 9 on a roll of 1", rollCountdown(1), 9);
eq("blast floor is 20", rollBlastDamage(0), 20);
eq("blast ceiling is 30", rollBlastDamage(0.999), 30);
eq("blast never exceeds 30 on a roll of 1", rollBlastDamage(1), 30);

const seenCountdown = new Set(), seenBlast = new Set();
for (let i = 0; i < 1000; i++) {
  seenCountdown.add(rollCountdown(i / 1000));
  seenBlast.add(rollBlastDamage(i / 1000));
}
eq("every countdown 6..9 is reachable", [...seenCountdown].sort((a, b) => a - b), [6, 7, 8, 9]);
eq("every blast value 20..30 is reachable", seenBlast.size, 11);

// ── Damage → turns ──────────────────────────────────────────────────────────

eq("0 damage buys nothing", bumpForDamage(0), 0);
eq("negative damage buys nothing", bumpForDamage(-5), 0);
eq("1 damage → +1", bumpForDamage(1), 1);
eq("24 damage → +1", bumpForDamage(24), 1);
eq("25 damage → +2", bumpForDamage(25), 2);
eq("49 damage → +2", bumpForDamage(49), 2);
eq("50 damage → +3", bumpForDamage(50), 3);
eq("a huge hit is still +3", bumpForDamage(400), 3);
eq("garbage buys nothing", bumpForDamage("abc"), 0);
eq("undefined buys nothing", bumpForDamage(undefined), 0);

// ── Which ledger events delay a crystal ─────────────────────────────────────

const CRYSTAL = "Scene.s.Token.t.Actor.crystal";
const ev = (payload, trigger = "creature_lose_resource") => ({ trigger, payload });
const hitPayload = (over = {}) => ({
  resource: "hp", cause: "damage", element: "physical", amount: 30,
  subjectActorUuid: CRYSTAL, causeActorUuid: "Actor.hero",
  ...over,
});
const hit = (over = {}) => ev(hitPayload(over));

eq("a normal hit", crystalBumpFor(hit()), { subjectUuid: CRYSTAL, turns: 2, damage: 30 });
eq("an Earth hit, already doubled by the vulnerability", crystalBumpFor(hit({ element: "earth", amount: 60 })), { subjectUuid: CRYSTAL, turns: 3, damage: 60 });
eq("a weak hit", crystalBumpFor(hit({ amount: 12 })), { subjectUuid: CRYSTAL, turns: 1, damage: 12 });

eq("Bolt never delays", crystalBumpFor(hit({ element: "bolt" })), null);
eq("Bolt never delays, whatever the case", crystalBumpFor(hit({ element: "Bolt", amount: 80 })), null);
eq("a zero (immune) hit does nothing", crystalBumpFor(hit({ amount: 0 })), null);

// Effect-row damage defaults to the hazard cause; it still counts.
eq("hazard-cause damage still delays", crystalBumpFor(hit({ cause: "hazard" })), { subjectUuid: CRYSTAL, turns: 2, damage: 30 });

eq("MP loss is not damage", crystalBumpFor(hit({ resource: "mp" })), null);
eq("a recovery is not a loss", crystalBumpFor(ev(hitPayload(), "creature_gain_resource")), null);
eq("defeat is not a bump", crystalBumpFor(ev(hitPayload(), "creature_defeated")), null);
eq("a payload with no amount", crystalBumpFor(hit({ amount: undefined })), null);
eq("no subject", crystalBumpFor(hit({ subjectActorUuid: null })), null);
eq("no payload", crystalBumpFor({ trigger: "creature_lose_resource" }), null);
eq("null cfg", crystalBumpFor(null), null);

// ── Tick key ────────────────────────────────────────────────────────────────

const k = (o) => tickKeyFor(o);
const base = { round: 2, actingTokenUuid: "T.a", turnsRemaining: 1 };
eq("no acting token → no key (never blocks a tick)", k({ round: 1 }), "");
eq("same turn → same key", k(base) === k({ ...base }), true);
eq("next round → new key", k(base) === k({ ...base, round: 3 }), false);
eq("another creature → new key", k(base) === k({ ...base, actingTokenUuid: "T.b" }), false);
eq("a second activation of the same creature → new key", k({ ...base, turnsRemaining: 4 }) === k({ ...base, turnsRemaining: 3 }), false);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
