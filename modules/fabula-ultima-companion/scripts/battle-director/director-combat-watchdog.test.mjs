// ============================================================================
// DirectorCombat — the runaway watchdog.
//
//     node scripts/battle-director/director-combat-watchdog.test.mjs
//
// A director whose world disappears underneath it used to spin: its Foundry
// Combat was deleted and its scene switched away, and nextTurn() kept wrapping
// rounds at roughly forty a minute, firing the round announcer on every lap,
// until a human stopped it by hand. director-boot says outright that the
// End-Battle button is the only way out — which is precisely why nothing
// caught it.
//
// The rule this pins: a round in which NO combatant acts is not a round, it is
// a spin. One is survivable; two ends the combat.
// ============================================================================

globalThis.Hooks = { on() {}, once() {}, callAll() {}, off() {} };
globalThis.canvas = { scene: null, tokens: { placeables: [] } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.CONFIG = {};
globalThis.foundry = { utils: { randomID: () => "test-" + Math.random().toString(36).slice(2) } };
globalThis.game = {
  user: { isGM: true }, combat: null, items: [],
  scenes: { contents: [], current: null },
  modules: { get: () => ({ api: {} }) },
  settings: { get: () => null, set: () => {} },
};

const { DirectorCombat, DirectorCombatant } = await import("./director-combat.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── Fixture ─────────────────────────────────────────────────────────────────
// Two combatants, one a side, each with a single turn per round. Everything
// the watchdog cares about is turn bookkeeping, so the actors are stubs.

function combatant(id, side) {
  const c = Object.create(DirectorCombatant.prototype);
  Object.assign(c, {
    id, name: id, side, actorUuid: `Actor.${id}`,
    turnsPerRound: 1, turnsRemaining: 1, flags: {},
  });
  c.isDefeatedLive = () => false;
  return c;
}

function makeCombat() {
  const dc = new DirectorCombat({ scene: { id: "scene1", name: "Test" } });
  dc.combatants = [combatant("hero", "party"), combatant("mook", "enemy")];
  dc._notifyTurnActions = () => {};
  dc._effectiveActivation = () => 1;
  dc.firstSide = "party";
  dc.start();
  return dc;
}

// ── A healthy combat is untouched ───────────────────────────────────────────
// Both sides act every round, so the barren counter never arms and rounds keep
// advancing exactly as before. This is the guard against a fix that "solves"
// the spin by ending real battles.
console.log("\n── a played-out round is never barren ──");

let dc = makeCombat();
for (let i = 0; i < 6; i++) {
  dc.currentCombatantId = dc.eligibleOnSide(dc.currentSide)[0]?.id ?? null;
  dc.nextTurn();
}
eq("rounds advance normally while combatants act", dc.round > 1, true);
eq("  and the combat is still live", dc.ended, false);
eq("  with no barren streak recorded", dc._barrenRounds, 0);

// ── A world that has gone away ends, it does not spin ───────────────────────
// currentCombatantId stays null — nobody is ever picked, so nobody acts. That
// is exactly the shape of the live failure.
console.log("\n── a barren round ends the combat ──");

dc = makeCombat();
const roundsSeen = [];
for (let i = 0; i < 40 && !dc.ended; i++) {
  dc.currentCombatantId = null;              // nobody acts, ever
  for (const c of dc.combatants) c.turnsRemaining = 0;   // both sides exhausted
  const r = dc.nextTurn();
  roundsSeen.push(r.round);
}
eq("the combat ends rather than looping", dc.ended, true);
eq("  and it ends quickly, not after dozens of rounds", dc.round <= 3, true);
eq("  the announcer therefore fires a handful of times, not forty a minute",
  roundsSeen.length <= 3, true);

// ── One quiet round is survivable ───────────────────────────────────────────
// A single round where nobody happened to act must NOT end the battle — only a
// repeat does. Otherwise one odd round (everyone stunned, a side wiped mid-turn)
// would kill a live fight.
console.log("\n── one quiet round is not enough to end it ──");

dc = makeCombat();
dc.currentCombatantId = null;
for (const c of dc.combatants) c.turnsRemaining = 0;
dc.nextTurn();
eq("a single barren round does not end the combat", dc.ended, false);
eq("  but it is remembered", dc._barrenRounds, 1);

// Barren rounds must be CONSECUTIVE: a productive round in between clears the
// streak, so a long fight with the occasional quiet round is never ended.
// The streak is evaluated at the WRAP, which is the only place a round is
// judged — so play a full productive round and then a barren one, and the
// combat must still be alive.
for (const c of dc.combatants) { c.turnsRemaining = 1; }
dc.currentCombatantId = dc.eligibleOnSide(dc.currentSide)[0]?.id ?? null;
dc.nextTurn();                                    // a real turn happens
dc.currentCombatantId = null;
for (const c of dc.combatants) c.turnsRemaining = 0;
dc.nextTurn();                                    // wrap, having seen a turn
eq("a productive round clears the streak at the wrap", dc._barrenRounds, 0);
eq("  so the combat survives a quiet round either side of a real one", dc.ended, false);

// ── A restart starts clean ──────────────────────────────────────────────────
console.log("\n── a restart clears the watchdog ──");
dc._barrenRounds = 1;
dc.ended = false;
dc.started = false;
dc.start();
eq("start() resets the barren streak", dc._barrenRounds, 0);
eq("  and the turns-taken counter", dc._turnsTakenThisRound, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
