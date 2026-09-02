// ============================================================================
// Stealth Mode — core logic harness.
//
//     node scripts/stealth-system/sm-core.test.mjs
//
// Covers the parts where a bug is silent at the table: facing arcs, the
// detection model, reachability against walls, the alert/awareness split, the
// takedown DL, and the AI's last-known-position behaviour. None of these
// announce themselves when wrong — they just make the mode feel arbitrary.
//
// Foundry is stubbed as a plain 100px square grid with a swappable wall
// predicate, which is enough for every module below the UI.
// ============================================================================

const GS = 100;

// ── Stubs ───────────────────────────────────────────────────────────────────

let WALLS = () => false;   // (from, to) => blocked

globalThis.foundry = {
  utils: {
    getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o),
    mergeObject: (a, b) => structuredClone({ ...a, ...b }),
    escapeHTML: (s) => String(s),
  },
};
globalThis.Hooks = { callAll() {}, on() {}, once() {}, off() {} };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

const scene = {
  id: "scene1",
  width: 1000, height: 1000,
  grid: { type: 1, size: GS, distance: 1 },
  tiles: [],
  lights: [],
  tokens: [],
};

globalThis.canvas = {
  scene,
  dimensions: { sceneX: 0, sceneY: 0, sceneWidth: 1000, sceneHeight: 1000 },
  grid: {
    size: GS,
    type: 1,
    getOffset: ({ x, y }) => ({ i: Math.floor(y / GS), j: Math.floor(x / GS) }),
    getCenterPoint: ({ i, j }) => ({ x: j * GS + GS / 2, y: i * GS + GS / 2 }),
    getTopLeftPoint: ({ i, j }) => ({ x: j * GS, y: i * GS }),
  },
};

globalThis.CONFIG = {
  Canvas: {
    polygonBackends: {
      move:  { testCollision: (a, b) => WALLS(a, b) },
      sight: { testCollision: (a, b) => WALLS(a, b) },
    },
  },
};

globalThis.game = {
  user: { isGM: true, id: "gm" },
  users: { activeGM: { id: "gm" } },
  actors: { get: (id) => ACTORS[id] ?? null },
  settings: { get: () => "" },
};

const ACTORS = {};
const mkActor = (id, level, rank, { mig = 8, dex = 8 } = {}) => (ACTORS[id] = {
  id, name: id,
  system: { props: {
    level: String(level), npc_rank: rank,
    mig_current: mig, dex_current: dex,
  } },
});

// ── Imports (after stubs) ───────────────────────────────────────────────────

const grid    = await import("./sm-grid.js");
const lattice = await import("./sm-lattice.js");
const vision  = await import("./sm-vision.js");
const stateM  = await import("./sm-state.js");
const actions = await import("./sm-actions.js");
const ai      = await import("./sm-enemy-ai.js");
const { TUNE_DEFAULTS, ALERT, AI } = await import("./sm-constants.js");

const TUNE = { ...TUNE_DEFAULTS };

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = (typeof got === "number" && typeof want === "number")
    ? Math.abs(got - want) < 1e-6 : got === want;
  if (ok) { pass++; console.log(` ok   ${label}`); }
  else    { fail++; console.log(`FAIL  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const C = (i, j) => ({ i, j });

// ── Grid & facing ───────────────────────────────────────────────────────────
console.log("\n── grid & facing ──");

eq("east is +j", grid.directionBetween(C(5, 5), C(5, 8)), "E");
eq("south is +i", grid.directionBetween(C(5, 5), C(8, 5)), "S");
eq("north-west", grid.directionBetween(C(5, 5), C(3, 3)), "NW");
eq("same cell has no direction", grid.directionBetween(C(5, 5), C(5, 5)), null);
eq("diagonals cost one (chebyshev)", grid.cellDistance(C(0, 0), C(3, 3)), 3);
eq("adjacency includes diagonals", grid.isAdjacent(C(5, 5), C(6, 6)), true);
eq("a square cell has 8 neighbours", grid.neighbours(C(5, 5)).length, 8);

// Arcs: a guard facing East at (5,5).
eq("dead ahead is front",  grid.relativeArc(C(5, 5), "E", C(5, 9)), "front");
eq("directly behind is rear", grid.relativeArc(C(5, 5), "E", C(5, 1)), "rear");
eq("straight up is flank",  grid.relativeArc(C(5, 5), "E", C(1, 5)), "flank");
eq("45° off is still front", grid.relativeArc(C(5, 5), "E", C(4, 6)), "front");
eq("angle off facing, behind", Math.round(grid.angleOffFacing(C(5, 5), "E", C(5, 1))), 180);

// ── Lattice & pathing ───────────────────────────────────────────────────────
console.log("\n── lattice & pathing ──");

WALLS = () => false;
lattice.invalidateLattice();
lattice.buildLattice(scene);

let reach = lattice.reachable(C(5, 5), 1);
eq("1 step reaches 8 cells + origin", reach.size, 9);

reach = lattice.reachable(C(5, 5), 2);
eq("2 steps reach a 5x5 block", reach.size, 25);

reach = lattice.reachable(C(5, 5), 5);
// The stub map is 10x10, and every corner is within chebyshev 5 of (5,5) —
// so the whole board is reachable, and the map edge clamps it, not the budget.
eq("reachability is clamped by the map edge", reach.size, 100);

// A wall across column 6 — nothing may cross from j<6 into j>=6 on row 5.
WALLS = (a, b) => (a.x < 600 && b.x >= 600) || (a.x >= 600 && b.x < 600);
lattice.invalidateLattice();
lattice.buildLattice(scene);
reach = lattice.reachable(C(5, 5), 5);
const crossed = [...reach.values()].some((n) => n.cell.j >= 6);
eq("a wall is not walked through", crossed, false);
eq("but the near side is still reachable", reach.size > 1, true);

eq("line of sight is blocked by the same wall",
  lattice.hasLineOfSight(C(5, 5), C(5, 8)), false);
eq("line of sight is clear along the wall",
  lattice.hasLineOfSight(C(5, 5), C(8, 5)), true);

WALLS = () => false;
lattice.invalidateLattice();
lattice.buildLattice(scene);

const path = lattice.findPath(C(2, 2), C(2, 6));
eq("A* finds a 4-step path", path.length, 4);
eq("  ending at the goal", grid.sameCell(path.at(-1), C(2, 6)), true);

const step = lattice.stepToward(C(2, 2), C(2, 9), 3);
eq("stepToward spends its whole budget", grid.cellDistance(C(2, 2), step.cell), 3);

// A solid prop blocks its cells.
scene.tiles = [{
  id: "crate1", x: 500, y: 500, width: 100, height: 100, hidden: false,
  flags: { "fabula-ultima-companion": { stealthProp: { enabled: true, solid: true, cover: true } } },
}];
lattice.invalidateLattice();
lattice.buildLattice(scene);
eq("a solid prop makes its cell impassable", lattice.cellRecord(C(5, 5))?.passable, false);
eq("  and marks it as cover", lattice.cellRecord(C(5, 5))?.cover, true);
eq("an unflagged neighbour stays open", lattice.cellRecord(C(5, 6))?.passable, true);
scene.tiles = [];
lattice.invalidateLattice();
lattice.buildLattice(scene);

// ── Vision ──────────────────────────────────────────────────────────────────
console.log("\n── vision & detection ──");

let s = vision.evaluateSight(C(5, 5), "E", C(5, 7), TUNE);
eq("seen straight ahead at range 2", s.seen, true);
eq("  and auto-spotted inside detection range", s.autoSpot, true);

s = vision.evaluateSight(C(5, 5), "E", C(5, 3), TUNE);
eq("not seen behind (outside suspicion radius? no — proximity)", s.arc, "rear");
eq("  rear at range 2 registers only as proximity", s.reason, "proximity");

s = vision.evaluateSight(C(5, 5), "E", C(5, 20), TUNE);
eq("far outside range is unseen", s.seen, false);
eq("  reason", s.reason, "out-of-range");

s = vision.evaluateSight(C(5, 5), "W", C(5, 7), TUNE);
eq("facing away, target behind → not auto-spotted", s.autoSpot, false);

// Cover reduces the awareness a sighting generates without blocking it.
scene.tiles = [{
  id: "crate2", x: 700, y: 500, width: 100, height: 100, hidden: false,
  flags: { "fabula-ultima-companion": { stealthProp: { enabled: true, solid: false, cover: true } } },
}];
lattice.invalidateLattice();
lattice.buildLattice(scene);
const covered = vision.evaluateSight(C(5, 5), "E", C(5, 7), TUNE);
eq("cover suppresses the auto-spot", covered.autoSpot, false);
scene.tiles = [];
lattice.invalidateLattice();
lattice.buildLattice(scene);

// A wall between guard and party hides them entirely.
WALLS = (a, b) => (a.x < 600 && b.x >= 600) || (a.x >= 600 && b.x < 600);
s = vision.evaluateSight(C(5, 5), "E", C(5, 7), TUNE);
eq("a wall hides the party completely", s.seen, false);
eq("  reason", s.reason, "wall");
WALLS = () => false;

// ── Alert vs awareness ──────────────────────────────────────────────────────
console.log("\n── alert & awareness ──");

const sm = stateM.emptyState();
sm.enemies.g1 = stateM.emptyEnemy("g1", C(5, 5), "E");
sm.enemies.g2 = stateM.emptyEnemy("g2", C(9, 9), "W");

eq("starts at Stealth", sm.alert, ALERT.STEALTH);
eq("Stealth opens a fight with Advantage", stateM.engagementFor(sm.alert), "advantage");

stateM.shiftAlert(sm, 1, "test");
eq("raised once → Neutral", sm.alert, ALERT.NEUTRAL);
eq("  Neutral is a normal fight", stateM.engagementFor(sm.alert), "normal");

stateM.shiftAlert(sm, 1, "test");
eq("raised twice → Alert", sm.alert, ALERT.ALERT);
eq("  Alert means the party is ambushed", stateM.engagementFor(sm.alert), "ambush");

stateM.shiftAlert(sm, 5, "test");
eq("cannot go past Alert", sm.alert, ALERT.ALERT);
stateM.shiftAlert(sm, -9, "test");
eq("cannot go below Stealth", sm.alert, ALERT.STEALTH);

// Per-enemy awareness moves ONE guard, not the room.
stateM.bumpAwareness(sm, "g1", TUNE.suspiciousAt, TUNE, C(5, 6));
eq("crossing the suspicion threshold → SUSPICIOUS", sm.enemies.g1.ai, AI.SUSPICIOUS);
eq("  the other guard is untouched", sm.enemies.g2.ai, AI.PATROL);
eq("  and the scene tier has not moved", sm.alert, ALERT.STEALTH);

stateM.bumpAwareness(sm, "g1", TUNE.searchAt, TUNE, C(5, 6));
eq("crossing the search threshold → SEARCH (not CHASE, below Alert)", sm.enemies.g1.ai, AI.SEARCH);
eq("  and it remembers where it last saw them", grid.sameCell(sm.enemies.g1.lastKnownCell, C(5, 6)), true);

sm.alert = ALERT.ALERT;
sm.enemies.g2.awareness = 0;
sm.enemies.g2.ai = AI.PATROL;
stateM.bumpAwareness(sm, "g2", TUNE.searchAt, TUNE, C(9, 8));
eq("at Alert the same threshold gives CHASE", sm.enemies.g2.ai, AI.CHASE);
sm.alert = ALERT.STEALTH;

// Decay walks states back down.
sm.enemies.g1.ai = AI.SUSPICIOUS;
sm.enemies.g1.awareness = TUNE.suspiciousAt;
stateM.decayAwareness(sm, TUNE, new Set());
eq("a guard who saw nothing cools off", sm.enemies.g1.awareness, TUNE.suspiciousAt - TUNE.awarenessDecay);
eq("  and drops back to PATROL", sm.enemies.g1.ai, AI.PATROL);

sm.enemies.g1.awareness = TUNE.awarenessMax;
stateM.decayAwareness(sm, TUNE, new Set(["g1"]));
eq("a guard who DID see keeps its awareness", sm.enemies.g1.awareness, TUNE.awarenessMax);

// ── Takedown ────────────────────────────────────────────────────────────────
console.log("\n── takedown ──");

const leader = mkActor("pc", 20, null);
mkActor("mook", 20, "soldier");
mkActor("elite", 20, "elite");
scene.tokens = [
  { id: "t_mook", actorId: "mook", disposition: -1, hidden: false, x: 500, y: 600, width: 1, height: 1 },
  { id: "t_elite", actorId: "elite", disposition: -1, hidden: false, x: 500, y: 600, width: 1, height: 1 },
];
scene.tokens.get = (id) => scene.tokens.find((t) => t.id === id);

const td = stateM.emptyState();
td.enemies.t_mook = stateM.emptyEnemy("t_mook", C(5, 6), "E");   // facing east, party to its west
td.enemies.t_elite = stateM.emptyEnemy("t_elite", C(5, 6), "E");

let g = actions.takedownCheck(td, td.enemies.t_mook, C(5, 5), leader, TUNE, { scene });
eq("rear takedown is legal", g.ok, true);
eq("  arc is rear", g.arc, "rear");
// An evenly-matched target sits at the base: same level, same MIG+DEX.
eq("  an even match is the base DL", g.dl, TUNE.takedownBaseDl);

// The Stealth bonus is a bonus to the ROLL, not a discount on the DL, so the
// player sees it named on the check card. The DL itself must not move.
eq("  being unnoticed is a roll bonus, not a cheaper DL", g.stealthBonus, TUNE.takedownStealthBonus);

td.alert = ALERT.NEUTRAL;
const gNeutral = actions.takedownCheck(td, td.enemies.t_mook, C(5, 5), leader, TUNE, { scene });
eq("Neutral drops the bonus", gNeutral.stealthBonus, 0);
eq("  but the DL is unchanged by it", gNeutral.dl, g.dl);

td.alert = ALERT.ALERT;
eq("Alert forbids takedowns entirely",
  actions.takedownCheck(td, td.enemies.t_mook, C(5, 5), leader, TUNE, { scene }).ok, false);
td.alert = ALERT.STEALTH;

td.enemies.t_mook.facing = "W";  // now facing the party
eq("a guard facing you cannot be taken down",
  actions.takedownCheck(td, td.enemies.t_mook, C(5, 5), leader, TUNE, { scene }).ok, false);
td.enemies.t_mook.facing = "E";

eq("a distant guard cannot be taken down",
  actions.takedownCheck(td, td.enemies.t_mook, C(0, 0), leader, TUNE, { scene }).ok, false);

// ── The OFFER must mirror the AUTHORITY ───────────────────────────
//
// sm-ui decides whether to show Takedown with its own predicate (adjacency +
// line of sight + arc). That predicate and takedownCheck have to agree, or the
// menu offers something the GM then refuses — which is what produced a lit
// target tile that did nothing when clicked. This pins the shared rule: for
// every facing, "the UI would offer it" and "the authority allows it" match.
console.log("\n── offer mirrors authority ──");

const arcState = stateM.emptyState();
arcState.enemies.a = stateM.emptyEnemy("a", C(5, 6), "E");
const partyAt = C(5, 5);   // due WEST of the guard

for (const facing of ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]) {
  arcState.enemies.a.facing = facing;
  const authority = actions.takedownCheck(
    arcState, arcState.enemies.a, partyAt, leader, TUNE, { scene }).ok;
  // The exact predicate sm-ui.takedownCandidates() applies.
  const offered =
    grid.cellDistance(partyAt, arcState.enemies.a.cell, scene) <= TUNE.takedownRange &&
    lattice.hasLineOfSight(partyAt, arcState.enemies.a.cell, scene) &&
    grid.relativeArc(arcState.enemies.a.cell, facing, partyAt, TUNE.coneHalfAngle) !== "front";
  eq("  facing " + facing + ": offer and authority agree", offered, authority);
}

// ── What actually moves the DL now ─────────────────────────────────────────
// Rank no longer contributes. The target's level and raw physicality against
// the leader's do, both signed, so the same guard is harder for a weaker
// character and easier for a stronger one.
td.alert = ALERT.STEALTH;

mkActor("bigger", 26, "soldier", { mig: 10, dex: 10 });
scene.tokens.push({ id: "t_big", actorId: "bigger", disposition: -1, hidden: false,
                    x: 500, y: 600, width: 1, height: 1 });
td.enemies.t_big = stateM.emptyEnemy("t_big", C(5, 6), "E");
const gBig = actions.takedownCheck(td, td.enemies.t_big, C(5, 5), leader, TUNE, { scene });
eq("a higher-level, stronger target is a harder takedown", gBig.dl > g.dl, true);

mkActor("weaker", 14, "soldier", { mig: 6, dex: 6 });
scene.tokens.push({ id: "t_weak", actorId: "weaker", disposition: -1, hidden: false,
                    x: 500, y: 600, width: 1, height: 1 });
td.enemies.t_weak = stateM.emptyEnemy("t_weak", C(5, 6), "E");
const gWeak = actions.takedownCheck(td, td.enemies.t_weak, C(5, 5), leader, TUNE, { scene });
eq("a weaker, lower-level target is an easier one", gWeak.dl < g.dl, true);

// The clamps are the playability guarantee: a wildly mismatched pairing must
// still produce a roll worth making rather than an auto-pass or a wall.
mkActor("titan", 200, "champion", { mig: 12, dex: 12 });
scene.tokens.push({ id: "t_titan", actorId: "titan", disposition: -1, hidden: false,
                    x: 500, y: 600, width: 1, height: 1 });
td.enemies.t_titan = stateM.emptyEnemy("t_titan", C(5, 6), "E");
eq("an absurdly stronger target clamps to the maximum",
  actions.takedownCheck(td, td.enemies.t_titan, C(5, 5), leader, TUNE, { scene }).dl,
  TUNE.takedownDlMax);

mkActor("rat", 1, "soldier", { mig: 6, dex: 6 });
scene.tokens.push({ id: "t_rat", actorId: "rat", disposition: -1, hidden: false,
                    x: 500, y: 600, width: 1, height: 1 });
td.enemies.t_rat = stateM.emptyEnemy("t_rat", C(5, 6), "E");
eq("an absurdly weaker one clamps to the minimum",
  actions.takedownCheck(td, td.enemies.t_rat, C(5, 5), leader, TUNE, { scene }).dl,
  TUNE.takedownDlMin);

// ── Enemy AI ────────────────────────────────────────────────────────────────
console.log("\n── enemy AI ──");

const aiState = stateM.emptyState();
aiState.__config = { routes: {}, facings: {} };
aiState.enemies.g = stateM.emptyEnemy("g", C(5, 5), "E");
aiState.party.cell = C(5, 12);

// PATROL with no route: meander around its post, never chase. Wandering is
// probabilistic, so sample until it moves rather than asserting one roll.
let moved = null, held = false;
for (let i = 0; i < 40 && (!moved || !held); i++) {
  const r = ai.decideActivation(aiState, aiState.enemies.g, C(5, 12), TUNE, { scene });
  if (r.move) moved = r; else held = true;
}
eq("an unrouted guard sometimes drifts", !!moved, true);
eq("  and sometimes holds", held, true);
eq("  it never strays past its leash", 
  moved ? grid.cellDistance(moved.move, aiState.enemies.g.anchor) <= TUNE.wanderLeash : true, true);
let intent = ai.decideActivation(aiState, aiState.enemies.g, C(5, 12), TUNE, { scene });

// SUSPICIOUS investigates the SPOT, not the party. It walks to where it thought
// something was, and resolves there one way or the other — a guard that bolted
// at your real position made suspicion indistinguishable from being caught.
aiState.enemies.g.ai = AI.SUSPICIOUS;
aiState.enemies.g.cell = C(5, 5);
aiState.enemies.g.lastKnownCell = C(5, 9);
aiState.enemies.g.facing = "E";
intent = ai.decideActivation(aiState, aiState.enemies.g, C(15, 15), TUNE, { scene });
eq("a suspicious guard walks to the suspicion point", !!intent.move, true);
eq("  heading for the point, not the party", intent.move.i, 5);
eq("  and not yet resolved", intent.resolved, false);

// Standing on the point with nothing to see: drop it entirely.
aiState.enemies.g.cell = C(5, 9);
aiState.enemies.g.facing = "E";
intent = ai.decideActivation(aiState, aiState.enemies.g, C(25, 25), TUNE, { scene });
eq("arriving and finding nothing drops the suspicion", intent.ai, AI.PATROL);
eq("  flagged resolved so the latch clears", intent.resolved, true);

// Standing on the point WITH the party in view: commit.
aiState.enemies.g.ai = AI.SUSPICIOUS;
aiState.enemies.g.cell = C(5, 9);
aiState.enemies.g.facing = "E";
aiState.enemies.g.lastKnownCell = C(5, 9);
intent = ai.decideActivation(aiState, aiState.enemies.g, C(5, 10), TUNE, { scene });
eq("arriving and seeing them commits to the hunt",
  intent.ai === AI.CHASE || intent.ai === AI.SEARCH, true);

// SEARCH goes to the LAST KNOWN cell, not the true one. The whole trick.
aiState.enemies.g.ai = AI.SEARCH;
aiState.enemies.g.cell = C(5, 5);             // stand away from the lead
aiState.enemies.g.lastKnownCell = C(5, 9);
aiState.enemies.g.facing = "W";               // cannot see the party
intent = ai.decideActivation(aiState, aiState.enemies.g, C(9, 9), TUNE, { scene });
eq("a searching guard heads for the last KNOWN cell", intent.move.j > 5, true);
eq("  not toward the party's real row", intent.move.i, 5);

// CHASE paths at the truth.
aiState.alert = ALERT.ALERT;
aiState.enemies.g.ai = AI.CHASE;
aiState.enemies.g.cell = C(5, 5);
intent = ai.decideActivation(aiState, aiState.enemies.g, C(9, 9), TUNE, { scene });
eq("a chasing guard closes on the real position", intent.move.i > 5, true);

// Contact is enemy-initiated: a chasing guard reaching the party triggers it.
aiState.enemies.g.cell = C(9, 7);
intent = ai.decideActivation(aiState, aiState.enemies.g, C(9, 9), TUNE, { scene });
eq("reaching the party is contact", intent.contact, true);

// ── Escalation is gated on a REAL sighting ──────────────────────────────────
//
// The regression this guards: escalation used to branch on sight.seen, which
// is true for a merely suspicious reading too. A patrolling guard that caught
// a glimpse at four cells therefore jumped straight to SEARCH and pathed at
// the party's exact tile — so stepping behind cover could not help, because
// being glimpsed had already handed over the position.
console.log("\n── glimpse vs sighting ──");

const esc = stateM.emptyState();
esc.__config = { routes: {}, facings: {} };
esc.enemies.g = stateM.emptyEnemy("g", C(5, 5), "E");
esc.enemies.g.ai = AI.PATROL;
esc.party.cell = C(5, 8);

// Three cells out, in the cone, past spottedRange: a glimpse.
// (Not four — the stub map is unlit, and the dark penalty takes a four-cell
// reading all the way down to "none". Three is the band this rule is about.)
const glimpse = vision.evaluateSight(C(5, 5), "E", C(5, 8), TUNE, { scene });
eq("three cells out in the cone is a glimpse, not a sighting", glimpse.level, "suspicious");
eq("  and specifically NOT spotted", glimpse.spotted, false);

let e1 = ai.decideActivation(esc, esc.enemies.g, C(5, 8), TUNE, { scene });
eq("a glimpse makes a patrolling guard suspicious", e1.ai, AI.SUSPICIOUS);
eq("  it does NOT jump to the hunt", e1.ai === AI.SEARCH || e1.ai === AI.CHASE, false);

// One cell out, in the cone: an actual sighting.
esc.enemies.g.ai = AI.PATROL;
esc.enemies.g.cell = C(5, 5);
esc.enemies.g.lastKnownCell = null;
const seenClose = vision.evaluateSight(C(5, 5), "E", C(5, 6), TUNE, { scene });
eq("one cell out in the cone IS a sighting", seenClose.spotted, true);
let e2 = ai.decideActivation(esc, esc.enemies.g, C(5, 6), TUNE, { scene });
eq("a real sighting does commit to the hunt",
  e2.ai === AI.SEARCH || e2.ai === AI.CHASE, true);

// ── Patrol walks, pursuit runs ──────────────────────────────────────────────
console.log("\n── patrol tempo ──");

eq("patrol speed is below the hunting speed", TUNE.patrolMove < TUNE.enemyMove, true);

const tempo = stateM.emptyState();
tempo.__config = { routes: {}, facings: {} };
tempo.enemies.g = stateM.emptyEnemy("g", C(2, 2), "E");
tempo.enemies.g.ai = AI.SEARCH;
tempo.enemies.g.lastKnownCell = C(2, 25);      // a long way off
tempo.enemies.g.facing = "W";                  // cannot see the party
const hunt = ai.decideActivation(tempo, tempo.enemies.g, C(9, 9), TUNE, { scene });
eq("a hunting guard covers more ground than a patrol would",
  hunt.move ? grid.cellDistance(C(2, 2), hunt.move) > TUNE.patrolMove : false, true);
eq("  but never more than its full speed",
  hunt.move ? grid.cellDistance(C(2, 2), hunt.move) <= TUNE.enemyMove : false, true);

// ── Glimpses cannot stack into a hunt ───────────────────────────────────────
//
// The player-facing complaint this encodes: "I move behind an object but an
// unsuspicious enemy still bolts straight at me." Two causes, both here.
// A suspicious reading is worth up to 3 and searchAt is 4, so crossing a
// distant cone for two cells used to tip a patrolling guard into SEARCH; and
// the lead was rewritten to the party's CURRENT cell on every step of the
// walk, so the guard ended up knowing precisely where the party stopped.
console.log("\n── glimpses do not stack ──");

const gl = stateM.emptyState();
gl.enemies.g = stateM.emptyEnemy("g", C(5, 5), "E");

for (let i = 0; i < 8; i++) {
  stateM.bumpAwareness(gl, "g", 3, TUNE, C(5, 8), { ceiling: TUNE.searchAt - 1 });
}
eq("no pile of glimpses reaches the hunting threshold",
  gl.enemies.g.awareness < TUNE.searchAt, true);
eq("  the guard is suspicious, never searching", gl.enemies.g.ai, AI.SUSPICIOUS);

// A real sighting is uncapped and still commits.
stateM.bumpAwareness(gl, "g", TUNE.searchAt, TUNE, C(5, 8));
eq("a real sighting still tips it into the hunt", gl.enemies.g.ai, AI.SEARCH);

// A later glimpse must not calm a guard that has already seen you.
const hot = gl.enemies.g.awareness;
stateM.bumpAwareness(gl, "g", 1, TUNE, null, { ceiling: TUNE.searchAt - 1 });
eq("a capped bump never talks a guard DOWN", gl.enemies.g.awareness >= hot, true);

// Giving up drops the lead, so the next scare does not send them somewhere
// they already searched.
const drop = stateM.emptyState();
drop.enemies.g = stateM.emptyEnemy("g", C(5, 5), "E");
drop.enemies.g.ai = AI.SUSPICIOUS;
drop.enemies.g.awareness = TUNE.suspiciousAt;
drop.enemies.g.lastKnownCell = C(5, 8);
drop.enemies.g.raisedOnce = true;
stateM.decayAwareness(drop, TUNE, new Set());
eq("giving up returns the guard to its round", drop.enemies.g.ai, AI.PATROL);
eq("  and discards the stale lead", drop.enemies.g.lastKnownCell, null);
eq("  and unlatches, so a NEW approach can startle it again",
  drop.enemies.g.raisedOnce, false);

// Activation priority: the guard who knows the most acts first.
const prio = stateM.emptyState();
prio.enemies.calm = stateM.emptyEnemy("calm", C(1, 1), "E");
prio.enemies.hot  = stateM.emptyEnemy("hot",  C(20, 20), "E");
prio.enemies.hot.ai = AI.CHASE;
prio.enemies.hot.awareness = 5;
eq("the hunting guard activates before the near-but-calm one",
  ai.pickActivation(prio, C(1, 2), { scene })?.tokenId, "hot");

// Join radius decides who is dragged into a triggered fight.
const jf = stateM.emptyState();
jf.enemies.near = stateM.emptyEnemy("near", C(5, 5), "E");
jf.enemies.far  = stateM.emptyEnemy("far",  C(30, 30), "E");
eq("only nearby enemies join the conflict",
  ai.conflictParticipants(jf, C(5, 6), TUNE, { scene }).map((e) => e.tokenId).join(), "near");

// ── Two-tier detection ──────────────────────────────────────────────────────
// The split that made movement playable: suspicion costs a tier once and lets
// you keep walking; only a real sighting halts the move.
console.log("\n── detection tiers ──");

let d = vision.evaluateSight(C(5, 5), "E", C(5, 6), TUNE);
eq("adjacent in-cone is spotted outright", d.level, "spotted");
eq("  and halts a walk", d.spotted, true);

d = vision.evaluateSight(C(5, 5), "E", C(5, 8), TUNE);
eq("in-cone past spotted range is only suspicious", d.level, "suspicious");
eq("  and does NOT halt a walk", d.spotted, false);

d = vision.evaluateSight(C(5, 5), "E", C(5, 12), TUNE);
eq("past the tightened vision range is nothing", d.level, "none");

// Cover downgrades a would-be spot to mere suspicion.
scene.tiles = [{
  id: "c3", x: 600, y: 500, width: 100, height: 100, hidden: false,
  flags: { "fabula-ultima-companion": { stealthProp: { enabled: true, solid: false, cover: true } } },
}];
lattice.invalidateLattice(); lattice.buildLattice(scene);
eq("cover downgrades a spot", vision.evaluateSight(C(5, 5), "E", C(5, 6), TUNE).spotted, false);
scene.tiles = []; lattice.invalidateLattice(); lattice.buildLattice(scene);

// Hide is one flat number per tier now, not a stack that reached DL 22.
eq("hide DL at stealth", TUNE.hideDlByAlert.stealth, 10);
eq("hide DL at neutral", TUNE.hideDlByAlert.neutral, 13);
eq("hide DL at alert",   TUNE.hideDlByAlert.alert, 15);

// A stupored guard is not a valid takedown target — otherwise escaping a
// fight would hand the party a free kill on the enemies they just ran from.
const stTd = stateM.emptyState();
stTd.enemies.t_mook = stateM.emptyEnemy("t_mook", C(5, 6), "E");
let g2 = actions.takedownCheck(stTd, stTd.enemies.t_mook, C(5, 5), leader, TUNE, { scene });
eq("an alert guard can be taken down", g2.ok, true);
stTd.enemies.t_mook.stupor = 1;
g2 = actions.takedownCheck(stTd, stTd.enemies.t_mook, C(5, 5), leader, TUNE, { scene });
eq("a stupored guard cannot", g2.ok, false);
eq("  and says why", /reeling/i.test(g2.reason), true);

// The suspicion latch: one tier per guard, cleared only when it gives up.
const ls = stateM.emptyState();
ls.enemies.g1 = stateM.emptyEnemy("g1", C(5, 5), "E");
eq("a fresh guard has not yet cost a tier", ls.enemies.g1.raisedOnce, false);
ls.enemies.g1.raisedOnce = true;
ls.enemies.g1.mark = "suspect";
ls.enemies.g1.ai = AI.SUSPICIOUS;
ls.enemies.g1.awareness = 0;
stateM.decayAwareness(ls, TUNE, new Set());
eq("giving up clears the latch", ls.enemies.g1.raisedOnce, false);
eq("  and drops the mark", ls.enemies.g1.mark, null);

// ── Scan / Dash scaling ─────────────────────────────────────────────────────
// Both buy a quantity off a roll, clamped so a fumble still does something and
// a crit does not trivialise the map.
console.log("\n── scan & dash scaling ──");

const scanR = (total) => Math.max(TUNE.scanRadiusMin, Math.min(TUNE.scanRadiusMax,
  Math.round(TUNE.scanRadiusBase + (total - TUNE.scanAverageRoll) * TUNE.scanRadiusPerPoint)));
eq("scan on an average roll is the baseline", scanR(TUNE.scanAverageRoll), TUNE.scanRadiusBase);
eq("a bad scan still sees something", scanR(1) >= TUNE.scanRadiusMin, true);
eq("a great scan is capped", scanR(99), TUNE.scanRadiusMax);
eq("scan scales upward with the roll", scanR(20) > scanR(10), true);

const dashG = (total) => Math.max(TUNE.dashGainMin, Math.min(TUNE.dashGainMax,
  Math.round(TUNE.dashGainBase + (total - TUNE.dashAverageRoll) * TUNE.dashGainPerPoint)));
eq("dash on an average roll is the baseline", dashG(TUNE.dashAverageRoll), TUNE.dashGainBase);
eq("dash never gives less than 1", dashG(1), TUNE.dashGainMin);
eq("dash never gives more than 5", dashG(99), TUNE.dashGainMax);
eq("dash is inside the brief's 1-5 band",
  [1, 8, 10, 14, 25].every((r) => dashG(r) >= 1 && dashG(r) <= 5), true);

// ── Concealment ─────────────────────────────────────────────────────────────
// Hiding is a defence against being FOUND, not invisibility.
console.log("\n── concealment ──");

eq("tighter ranges", `${TUNE.spottedRange}/${TUNE.suspicionRadius}/${TUNE.visionRange}`, "2/3/5");

eq("a bare pass is Concealed", stateM.concealTierFor(0, TUNE), 1);
eq("margin 5 is Well Hidden",  stateM.concealTierFor(5, TUNE), 2);
eq("margin 10 is Vanished",    stateM.concealTierFor(10, TUNE), 3);

// Tier 1 counts as cover: a guard at spotted range no longer sees outright.
const bare = vision.evaluateSight(C(5, 5), "E", C(5, 6), TUNE, { concealTier: 0 });
const hid1 = vision.evaluateSight(C(5, 5), "E", C(5, 6), TUNE, { concealTier: 1 });
eq("unconcealed at 1 cell is spotted", bare.spotted, true);
eq("Concealed is NOT spotted there",   hid1.spotted, false);

// Tier 2 blocks suspicion outright. Compared against an UNCONCEALED party at
// the same tile, so the assertion does not depend on how dark the cell is.
const open2 = vision.evaluateSight(C(5, 5), "E", C(5, 8), TUNE, { concealTier: 0 });
const hid2  = vision.evaluateSight(C(5, 5), "E", C(5, 8), TUNE, { concealTier: 2 });
eq("in the open at 3 cells you are suspected", open2.level, "suspicious");
eq("Well Hidden at the same tile is not",      hid2.level, "none");

// Lifecycle.
const cs = stateM.emptyState();
eq("starts unconcealed", stateM.concealTier(cs), 0);
stateM.setConcealment(cs, 2, TUNE, { hidInCover: true });
eq("set to tier 2", stateM.concealTier(cs), 2);
eq("  with a duration", cs.party.conceal.roundsLeft, TUNE.concealDuration);

eq("a tick does not end it early", stateM.tickConcealment(cs), false);
eq("  but the last one does", stateM.tickConcealment(cs), true);
eq("  and clears the tier", stateM.concealTier(cs), 0);

stateM.setConcealment(cs, 3, TUNE);
eq("being seen breaks it", stateM.breakConcealment(cs, "seen"), true);
eq("  tier cleared", stateM.concealTier(cs), 0);
eq("breaking twice is a no-op", stateM.breakConcealment(cs, "again"), false);

// A well-hidden party makes searchers give up faster.
const ds = stateM.emptyState();
ds.enemies.s1 = stateM.emptyEnemy("s1", C(9, 9), "E");
ds.enemies.s1.ai = AI.SEARCH;
ds.enemies.s1.awareness = TUNE.awarenessMax;
stateM.setConcealment(ds, 2, TUNE);
const before = ds.enemies.s1.awareness;
stateM.decayAwareness(ds, TUNE, new Set());
eq("searchers shed extra awareness while you are well hidden",
  before - ds.enemies.s1.awareness, TUNE.awarenessDecay + TUNE.concealSearchDecay);

// ── Stupor ──────────────────────────────────────────────────────────────────
// The breather running away buys: skipped, not deleted.
console.log("\n── stupor ──");

const ss = stateM.emptyState();
ss.enemies.a = stateM.emptyEnemy("a", C(4, 4), "E");
ss.enemies.b = stateM.emptyEnemy("b", C(6, 6), "E");
ss.enemies.a.ai = AI.CHASE; ss.enemies.a.awareness = 6;

eq("nobody starts stupored", stateM.isStupored(ss.enemies.a), false);
eq("stupor applies to the named guards", stateM.applyStupor(ss, ["a"], TUNE), 1);
eq("  the guard is stupored", stateM.isStupored(ss.enemies.a), true);
eq("  and is no longer hunting", ss.enemies.a.ai, AI.PATROL);
eq("  awareness wiped", ss.enemies.a.awareness, 0);
eq("  the other guard is untouched", stateM.isStupored(ss.enemies.b), false);

// A stupored guard is passed over; the budget moves to the next in priority.
eq("activation skips the stupored one",
  ai.pickActivation(ss, C(5, 5), { scene })?.tokenId, "b");

stateM.tickStupor(ss);
eq("one round clears it", stateM.isStupored(ss.enemies.a), false);
eq("  and it can act again",
  !!ai.pickActivation(ss, C(4, 5), { scene }), true);

eq("stupor never touches a defeated guard",
  (() => { ss.enemies.b.defeated = true; return stateM.applyStupor(ss, ["b"], TUNE); })(), 0);

// ── Hide talks a hunt down ──────────────────────────────────────────────────
console.log("\n── hide downgrade ──");
eq("the downgrade threshold is an absolute roll", TUNE.hideDowngradeRoll, 13);
eq("scatter radius keeps them near but wrong", TUNE.hideScatterRadius, 4);

// ── Connectivity ────────────────────────────────────────────────────────────
// A spawn must land in the party's OWN walled region. Picking by distance
// alone will happily choose a sealed-off band the guard can never leave.
console.log("\n── connectivity ──");

WALLS = () => false;
lattice.invalidateLattice(); lattice.buildLattice(scene);
eq("an open map is one region", lattice.connectedCells(C(5, 5)).size, 100);

// Seal column 5 completely: nothing may cross between j<5 and j>=5.
WALLS = (a, b) => (a.x < 500 && b.x >= 500) || (a.x >= 500 && b.x < 500);
lattice.invalidateLattice(); lattice.buildLattice(scene);
const near = lattice.connectedCells(C(5, 2));
eq("a sealing wall splits the map", near.size < 100, true);
eq("  cells on our side are connected", lattice.isConnected(C(5, 2), C(7, 3)), true);
eq("  cells past the wall are NOT", lattice.isConnected(C(5, 2), C(5, 8)), false);
eq("  and the far side is invisible to the flood", near.has("5,8"), false);

WALLS = () => false;
lattice.invalidateLattice(); lattice.buildLattice(scene);

// A stupored guard is out of play: it neither acts nor observes.
console.log("\n── stupor is total ──");
const os = stateM.emptyState();
os.enemies.z = stateM.emptyEnemy("z", C(5, 5), "E");
os.enemies.z.stupor = 1;
eq("a stupored guard is filtered from the observer list",
  stateM.enemyRecords(os).filter((e) => !stateM.isStupored(e)).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
