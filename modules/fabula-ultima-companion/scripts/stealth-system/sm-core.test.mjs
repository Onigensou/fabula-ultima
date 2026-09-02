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
const mkActor = (id, level, rank) => (ACTORS[id] = {
  id, name: id, system: { props: { level: String(level), npc_rank: rank } },
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
// base 7 + rank 0 + level 0 - rear 2 - stealth 1 = 4 → clamped to the min of 6
eq("  DL clamps at the minimum", g.dl, TUNE.takedownDlMin);

td.alert = ALERT.NEUTRAL;
const gNeutral = actions.takedownCheck(td, td.enemies.t_mook, C(5, 5), leader, TUNE, { scene });
eq("Neutral loses the stealth bonus (DL no lower than Stealth's)", gNeutral.dl >= g.dl, true);

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

const gElite = actions.takedownCheck(td, td.enemies.t_elite, C(5, 5), leader, TUNE, { scene });
eq("an elite is a harder takedown than a soldier", gElite.dl > g.dl, true);

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

// SUSPICIOUS: turn toward the stimulus and hold. This is the round the party
// gets to break line of sight, so movement here would be a real design bug.
aiState.enemies.g.ai = AI.SUSPICIOUS;
aiState.enemies.g.lastKnownCell = C(5, 9);
intent = ai.decideActivation(aiState, aiState.enemies.g, null, TUNE, { scene });
eq("a suspicious guard does NOT approach", intent.move, null);
eq("  it turns toward the stimulus", intent.facing, "E");

// SEARCH goes to the LAST KNOWN cell, not the true one. The whole trick.
aiState.enemies.g.ai = AI.SEARCH;
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

d = vision.evaluateSight(C(5, 5), "E", C(5, 11), TUNE);
eq("far in-cone is only suspicious", d.level, "suspicious");
eq("  and does NOT halt a walk", d.spotted, false);

d = vision.evaluateSight(C(5, 5), "E", C(5, 30), TUNE);
eq("well out of range is nothing", d.level, "none");

// Cover downgrades a would-be spot to mere suspicion.
scene.tiles = [{
  id: "c3", x: 600, y: 500, width: 100, height: 100, hidden: false,
  flags: { "fabula-ultima-companion": { stealthProp: { enabled: true, solid: false, cover: true } } },
}];
lattice.invalidateLattice(); lattice.buildLattice(scene);
eq("cover downgrades a spot", vision.evaluateSight(C(5, 5), "E", C(5, 6), TUNE).spotted, false);
scene.tiles = []; lattice.invalidateLattice(); lattice.buildLattice(scene);

// Hide is one flat number per tier now, not a stack that reached DL 22.
eq("hide DL at stealth", TUNE.hideDlByAlert.stealth, 8);
eq("hide DL at neutral", TUNE.hideDlByAlert.neutral, 10);
eq("hide DL at alert",   TUNE.hideDlByAlert.alert, 12);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
