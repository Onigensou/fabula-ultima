// ============================================================================
// Polymorph pure rules — offline tests.
//
//     node scripts/polymorph/polymorph-math.test.mjs
// ============================================================================

import {
  formMultiplier, scaleIntoForm, scaleOutOfForm,
  newConflictCounter, tickOnTurnEnd, normalizeAffinity, readFormProfile, formTags,
} from "./polymorph-math.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

// ── Multiplier ──
eq("m: Lava Golem example (60 vs 150) = 1.75", formMultiplier(60, 150), 1.75);
eq("m: equal size = 1", formMultiplier(60, 60), 1);
eq("m: weaker form floors at 1", formMultiplier(60, 20), 1);
eq("m: huge Champion caps at 2", formMultiplier(60, 9000), 2);
eq("m: ratio 3 hits the cap exactly", formMultiplier(50, 150), 2);
eq("m: bad input = 1", formMultiplier(0, 100), 1);
eq("m: NaN = 1", formMultiplier("x", 100), 1);

// ── Into / out of form (the worked example) ──
eq("in: 45/60 ×1.75 → 79/105", scaleIntoForm(45, 60, 1.75), { cur: 79, max: 105 });
eq("out: 39/105 → 23/60 (ceil of 22.29)", scaleOutOfForm(39, 105, 60), 23);
eq("in: full stays full", scaleIntoForm(60, 60, 2), { cur: 120, max: 120 });
eq("out: full stays full", scaleOutOfForm(120, 120, 60), 60);
eq("in: 0 stays 0", scaleIntoForm(0, 60, 2), { cur: 0, max: 120 });
eq("out: 0 stays 0", scaleOutOfForm(0, 120, 60), 0);
eq("in: 1 HP never rounds to 0", scaleIntoForm(1, 300, 1), { cur: 1, max: 300 });
eq("out: 1 HP in form never reverts to 0", scaleOutOfForm(1, 120, 60), 1);
eq("in: m=1 is identity", scaleIntoForm(33, 60, 1), { cur: 33, max: 60 });
eq("out: m=1 is identity", scaleOutOfForm(33, 60, 60), 33);

// No free healing: round-trip with no damage never ends above where it started.
let heals = 0;
for (let max = 1; max <= 120; max++) for (let cur = 0; cur <= max; cur++) for (const m of [1, 1.25, 1.5, 1.75, 2]) {
  const f = scaleIntoForm(cur, max, m);
  const back = scaleOutOfForm(f.cur, f.max, max);
  if (back > cur + 1) heals++;                // allow +1 from round-up only
  if (back < cur) heals++;                    // and never a loss
}
eq("round-trip never heals >1 or loses HP", heals, 0);

// ── Turn counter ──
// Self-drink on own turn in round 2: rounds 3,4,5 count; expires end of round 5.
{
  let c = newConflictCounter({ round: 2, bearerActedOrActing: true });
  let r = tickOnTurnEnd(c, 2); eq("drink turn does not count", [r.ticked, r.counter.turnsLeft], [false, 3]);
  r = tickOnTurnEnd(r.counter, 3); eq("round 3 ticks", [r.ticked, r.counter.turnsLeft, r.expired], [true, 2, false]);
  r = tickOnTurnEnd(r.counter, 3); eq("extra turn round 3 is a bonus", [r.ticked, r.counter.turnsLeft], [false, 2]);
  r = tickOnTurnEnd(r.counter, 4); eq("round 4 ticks", r.counter.turnsLeft, 1);
  // Stop removes the round-5 turn: no turn end call at all in round 5.
  r = tickOnTurnEnd(r.counter, 6); eq("after a Stopped round, round 6 is the 3rd turn", [r.ticked, r.expired], [true, true]);
}
// Ally gives it before the bearer acted this round: this round's turn counts.
{
  const c = newConflictCounter({ round: 1, bearerActedOrActing: false });
  let r = tickOnTurnEnd(c, 1); eq("ally-given: bearer's turn this round counts", r.counter.turnsLeft, 2);
}
// Free Round (round 0) counts like any round.
{
  const c = newConflictCounter({ round: 0, bearerActedOrActing: false });
  const r = tickOnTurnEnd(c, 0); eq("free round turn counts", r.counter.turnsLeft, 2);
}
// Input is never mutated.
{
  const c = newConflictCounter({ round: 1, bearerActedOrActing: false });
  tickOnTurnEnd(c, 1); eq("tick does not mutate input", c.turnsLeft, 3);
}

// ── Profile ──
eq("affinity '-' → NA", normalizeAffinity("-"), "NA");
eq("affinity rs → RS", normalizeAffinity("rs"), "RS");
{
  const p = readFormProfile({
    dex_base: 10, ins_base: 6, mig_base: 12, wlp_base: 8, dex_current: 10, ins_current: 6,
    defense: 14, magic_defense: 9, max_hp: 150, max_mp: 40, affinity_6: "AB", affinity_7: "VU", affinity_1: "-",
    species: "CONSTRUCT",
  });
  eq("profile attrs", p.attrs, { dex: 10, ins: 6, mig: 12, wlp: 8 });
  eq("profile def offset (flat 14 over d10)", p.defOffset, 4);
  eq("profile mdef offset", p.mdefOffset, 3);
  eq("profile affinities", [p.affinities.affinity_1, p.affinities.affinity_6, p.affinities.affinity_7], ["NA", "AB", "VU"]);
}
eq("tags: authored + species", formTags("Aquatic, flying", "BEAST"), ["aquatic", "flying", "beast"]);
eq("tags: array, dedupe", formTags(["aquatic", "AQUATIC"], ""), ["aquatic"]);

console.log(`polymorph-math: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
