// ============================================================================
// Updraft — pure-rule harness.
//
//     node scripts/conflict-event/events/updraft.test.mjs
//
// Bare Node. The filter is where every ruling lives (Air only, HP only, a hit or
// a hazard, never a cost), and a mistake there misfires silently at the table.
// ============================================================================

import { updraftSubjectFor, updraftCharges } from "./updraft.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const loss = (p = {}) => ({
  trigger: "creature_lose_resource",
  payload: { resource: "hp", element: "air", cause: "damage", amount: 12, subjectActorUuid: "Actor.A", ...p },
});

eq("an Air hit lifts its target", updraftSubjectFor(loss()), "Actor.A");
eq("element case does not matter", updraftSubjectFor(loss({ element: "AIR" })), "Actor.A");
eq("an Air hazard lifts too", updraftSubjectFor(loss({ cause: "hazard" })), "Actor.A");
eq("self-inflicted Air still lifts (the rule names no source)",
  updraftSubjectFor(loss({ causeActorUuid: "Actor.A" })), "Actor.A");
eq("Fire does not lift", updraftSubjectFor(loss({ element: "fire" })), null);
eq("no element does not lift", updraftSubjectFor(loss({ element: null })), null);
eq("MP loss does not lift", updraftSubjectFor(loss({ resource: "mp" })), null);
eq("an HP cost does not lift", updraftSubjectFor(loss({ cause: "cost" })), null);
eq("a drain does not lift", updraftSubjectFor(loss({ cause: "drain" })), null);
eq("0 damage (Immune) does not lift", updraftSubjectFor(loss({ amount: 0 })), null);
eq("an absorbed Air hit is a gain, not a loss",
  updraftSubjectFor({ ...loss(), trigger: "creature_gain_resource" }), null);
eq("other triggers are ignored", updraftSubjectFor({ trigger: "creature_defeated", payload: {} }), null);
eq("garbage is ignored", updraftSubjectFor(null), null);

eq("hit off its own turn: Flying lasts 1 turn end", updraftCharges({ isOwnTurn: false }), 1);
eq("hit on its own turn: 2 (this turn's end, then its next)", updraftCharges({ isOwnTurn: true }), 2);
eq("default is off-turn", updraftCharges(), 1);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
