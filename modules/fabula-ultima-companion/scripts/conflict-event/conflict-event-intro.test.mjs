// ============================================================================
// Conflict Event System — battle-start line regression harness.
//
//     node scripts/conflict-event/conflict-event-intro.test.mjs
//
// Bare Node, like the registry harness. Walks the flows the user set as the
// rule (2026-11-04): first battle after entering a dungeon shows the line,
// coming back after a town trip shows it again, the second battle in the same
// trip does not — and a Champion battle always does.
// ============================================================================

import { TRIP_GAP_MS, normalizeTrip, stepTrip, decideIntro, isChampionActor } from "./conflict-event-intro.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const battle = (state, eventId, at, champion = false) => decideIntro(state, { eventId, champion, now: at });

// ── The user's three flows ──────────────────────────────────────────────────

let s = normalizeTrip(null);
s = stepTrip(s, "exploration");                 // in town
s = stepTrip(s, "dungeon");                     // enter the dungeon
let r = battle(s, "lightning-storm", T0);
eq("entered the dungeon, first battle → show", r.introduce, true);
s = r.state;

s = stepTrip(s, "conflict");                    // the battle scene itself
s = stepTrip(s, "dungeon");                     // back from the battle
r = battle(s, "lightning-storm", T0 + 10 * MIN);
eq("same trip, second battle → hide", r.introduce, false);
s = r.state;

s = stepTrip(s, "exploration");                 // shopping in town
s = stepTrip(s, "dungeon");                     // back in
r = battle(s, "lightning-storm", T0 + 40 * MIN);
eq("left for town and came back, first battle → show", r.introduce, true);
s = r.state;

// ── What does not end a trip ────────────────────────────────────────────────

for (const mode of ["conflict", "theatre", "camp", "title", "gacha", "stealth"]) {
  eq(`a ${mode} scene keeps the trip`, stepTrip(s, mode), s);
}
eq("moving between two dungeon maps keeps the trip", stepTrip(s, "dungeon"), s);
let camp = stepTrip(stepTrip(s, "camp"), "dungeon");
eq("camping inside the dungeon keeps the trip", battle(camp, "lightning-storm", T0 + 50 * MIN).introduce, false);

// Town → inn camp → set out: the town is what ended the trip, the camp in
// between changes nothing, so the dungeon starts a new one.
let inn = stepTrip(stepTrip(stepTrip(s, "exploration"), "camp"), "dungeon");
eq("town, then camp, then the dungeon → new trip", battle(inn, "lightning-storm", T0 + 60 * MIN).introduce, true);

// ── Per event ───────────────────────────────────────────────────────────────

r = battle(s, "lightning-crystal", T0 + 45 * MIN);
eq("a different event on the same trip → show", r.introduce, true);
eq("…and both are now remembered", r.state.shown, ["lightning-storm", "lightning-crystal"]);

// ── Champion ────────────────────────────────────────────────────────────────

r = battle(s, "lightning-storm", T0 + 45 * MIN, true);
eq("already shown this trip, but a Champion battle → show", r.introduce, true);
eq("a Champion battle does not add a duplicate", r.state.shown, ["lightning-storm"]);

// ── A new session ───────────────────────────────────────────────────────────

r = battle(s, "lightning-storm", T0 + 40 * MIN + TRIP_GAP_MS + MIN);
eq("more than the gap since the last battle → show again", r.introduce, true);
eq("…as a new trip", r.state.trip, s.trip + 1);
r = battle(s, "lightning-storm", T0 + 40 * MIN + TRIP_GAP_MS - MIN);
eq("just under the gap → still the same trip", r.introduce, false);

// ── Edges ───────────────────────────────────────────────────────────────────

eq("no event → nothing to show", battle(s, "", T0).introduce, false);
eq("a broken setting repairs to a fresh trip", normalizeTrip("garbage"), { inDungeon: false, trip: 0, shown: [], lastBattleAt: 0 });
eq("a first battle with no trip history → show", battle(null, "lightning-storm", T0).introduce, true);

eq("npc_rank Champion", isChampionActor({ system: { props: { npc_rank: "Champion" } } }), true);
eq("npc_rank Elite is not", isChampionActor({ system: { props: { npc_rank: "Elite" } } }), false);
eq("champion checkbox", isChampionActor({ system: { props: { champion: true } } }), true);
eq("Soldier text wins over a stray checkbox", isChampionActor({ system: { props: { npc_rank: "soldier", champion: true } } }), false);
eq("a PC (no rank) is not", isChampionActor({ system: { props: {} } }), false);
eq("no actor is not", isChampionActor(null), false);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
