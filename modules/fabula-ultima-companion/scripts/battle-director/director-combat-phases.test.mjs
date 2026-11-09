// ============================================================================
// DirectorCombat — Quicken / Delay phases, the Free Round, held summon actions.
//
//     node scripts/battle-director/director-combat-phases.test.mjs
//
// User rulings (2026-11-09):
//   • A round plays QUICKEN → NORMAL → DELAY. Sides alternate inside a phase and
//     the alternation carries straight across a phase border.
//   • Quicken + Delay together → Normal. Multi-activation → all turns move.
//   • A status applied mid-round moves an un-acted creature at once; one that
//     already acted this round keeps its phase until next round.
//   • Ambush / Advantage → a Free Round (round 0) for the favoured side, ALL
//     activations; Round 1 is a normal round.
//   • A summon with no turn of its own acts at the END of its phase.
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
function combatant(id, side, { turns = 1, statuses = [] } = {}) {
  const c = Object.create(DirectorCombatant.prototype);
  const actor = { appliedEffects: statuses.map((n) => ({ name: n })), system: { props: { activation: turns } } };
  Object.assign(c, {
    id, name: id, side, actorUuid: `Actor.${id}`, tokenUuid: `Token.${id}`,
    actorDoc: actor, tokenDoc: { actor },
    turnsPerRound: turns, turnsRemaining: turns, flags: {}, phaseLock: null,
  });
  c.isDefeatedLive = () => false;
  return c;
}
const setStatuses = (c, list) => { c.actorDoc.appliedEffects = list.map((n) => ({ name: n })); };

function combat(units, { firstSide = "party", engagement = "normal" } = {}) {
  const dc = new DirectorCombat({ scene: { id: "S", name: "S" } });
  dc.engagement = engagement;
  dc.firstSide = firstSide;
  for (const u of units) dc.combatants.push(u);
  dc.start();
  dc.round = 1;
  return dc;
}

// One turn the way TURN_START + TURN_END run it: pick the first eligible on the
// current side (swap sides when that side has nobody in this phase), lock its
// phase, then advance. Returns the name, or null when the round is over.
function takeTurn(dc, hook = null) {
  let pool = dc.eligibleOnSide(dc.currentSide);
  if (!pool.length) {
    const other = dc._otherSide(dc.currentSide);
    if (dc.eligibleOnSide(other).length) { dc.currentSide = other; pool = dc.eligibleOnSide(other); }
  }
  if (!pool.length) return null;
  const c = pool[0];
  dc.currentCombatantId = c.id;
  dc.lockPhase(c);
  if (hook) hook(c);
  dc.nextTurn();
  return c.name;
}
function playRound(dc, hook) {
  const seq = [];
  for (let g = 0; g < 50; g++) {
    const n = takeTurn(dc, hook);
    if (!n) break;
    seq.push(n);
    if (dc.pendingRoundWrap) break;
  }
  return seq;
}

// ── 1. Phase order + alternation across borders (option B) ─────────────────
{
  const dc = combat([
    combatant("Hina", "party", { statuses: ["Quicken"] }),
    combatant("Keren", "party"),
    combatant("Zarg", "party", { statuses: ["Delay"] }),
    combatant("SlimeA", "enemy"),
    combatant("Gigas", "enemy", { statuses: ["Delay"] }),
  ]);
  eq("Quicken → Normal → Delay, sides keep alternating across borders",
    playRound(dc), ["Hina", "SlimeA", "Keren", "Gigas", "Zarg"]);
}
{
  // Your example: a Quickened enemy, enemy wins initiative → Enemy A first.
  const dc = combat([
    combatant("Keren", "party"),
    combatant("EnemyA", "enemy", { statuses: ["Quicken"] }),
    combatant("EnemyB", "enemy"),
  ], { firstSide: "enemy" });
  eq("Quickened enemy leads; the phase border does not double a side",
    playRound(dc), ["EnemyA", "Keren", "EnemyB"]);
}
{
  // Party wins initiative but only the enemy is Quickened: the enemy still acts
  // first (the party has nobody in the Quicken phase), then alternation resumes.
  const dc = combat([
    combatant("Keren", "party"), combatant("Blanche", "party"),
    combatant("EnemyA", "enemy", { statuses: ["Quicken"] }), combatant("EnemyB", "enemy"),
  ], { firstSide: "party" });
  eq("party leads, but the Quicken phase is enemy-only",
    playRound(dc), ["EnemyA", "Keren", "EnemyB", "Blanche"]);
}

// ── 2. Both statuses = Normal; dispel one → the other applies ──────────────
{
  const both = combatant("Both", "party", { statuses: ["Quicken", "Delay"] });
  const dc = combat([both, combatant("E", "enemy")]);
  eq("Quicken + Delay acts in Normal", dc.speedTierOf(both), 0);
  setStatuses(both, ["Delay"]);
  eq("Quicken dispelled → Delay takes effect at the next pick", dc.speedTierOf(both), -1);
}

// ── 3. Multi-activation: all turns move ─────────────────────────────────────
{
  const dc = combat([
    combatant("Elite", "enemy", { turns: 3, statuses: ["Delay"] }),
    combatant("Keren", "party"), combatant("Zarg", "party"),
  ], { firstSide: "enemy" });
  eq("a Delayed 3-activation elite takes all three turns in the Delay phase",
    playRound(dc), ["Keren", "Zarg", "Elite", "Elite", "Elite"]);
}

// ── 4. Mid-round application ────────────────────────────────────────────────
{
  const keren = combatant("Keren", "party");
  const zarg = combatant("Zarg", "party");
  const slime = combatant("Slime", "enemy");
  const gigas = combatant("Gigas", "enemy");
  const dc = combat([keren, zarg, slime, gigas]);
  // Keren's turn Delays the Slime (un-acted → moves now) and Zarg's... no — Gigas
  // acts after; then Gigas Delays Keren, who already acted (→ next round).
  const seq = playRound(dc, (c) => {
    if (c.name === "Keren") setStatuses(slime, ["Delay"]);
    if (c.name === "Gigas") setStatuses(keren, ["Delay"]);
  });
  eq("un-acted creature Delayed mid-round moves to the Delay phase at once",
    seq, ["Keren", "Gigas", "Zarg", "Slime"]);
  eq("a creature that already acted keeps its phase this round", keren.phaseLock.tier, 0);
  dc.beginPendingRound();
  eq("…and the Delay applies next round", dc.speedTierOf(keren), -1);
}
{
  // A multi-activation creature that Quickens itself on its first turn keeps
  // its remaining turns in the phase it started in.
  const elite = combatant("Elite", "enemy", { turns: 2 });
  const dc = combat([elite, combatant("Keren", "party")], { firstSide: "enemy" });
  const seq = playRound(dc, (c) => { if (c.name === "Elite") setStatuses(elite, ["Quicken"]); });
  eq("self-applied Quicken does not move the rest of this round's turns",
    seq, ["Elite", "Keren", "Elite"]);
}

// ── 5. Free Round ───────────────────────────────────────────────────────────
{
  const elite = combatant("Elite", "enemy", { turns: 4 });
  const dc = new DirectorCombat({ scene: { id: "S", name: "S" } });
  dc.engagement = "ambush";
  for (const u of [combatant("Keren", "party"), combatant("Zarg", "party"), elite]) dc.combatants.push(u);
  dc.start();
  eq("ambush → Free Round pending", dc.freeRoundPending, true);
  dc.enterFreeRound();
  eq("Free Round is round 0", [dc.round, dc.freeRound], [0, true]);
  eq("surprised side has no turns", dc.combatants.filter((c) => c.side === "party").map((c) => c.turnsRemaining), [0, 0]);
  eq("Free Round: the elite takes all 4 activations", playRound(dc), ["Elite", "Elite", "Elite", "Elite"]);
  eq("Free Round ends with a pending wrap", dc.pendingRoundWrap, true);
  dc.beginPendingRound();
  eq("Round 1 follows, free flag cleared, everyone's turns back",
    [dc.round, dc.freeRound, dc.combatants.map((c) => c.turnsRemaining)], [1, false, [1, 1, 4]]);
}
{
  const dc = new DirectorCombat({ scene: { id: "S", name: "S" } });
  dc.engagement = "normal";
  dc.combatants.push(combatant("Keren", "party"), combatant("E", "enemy"));
  dc.start();
  eq("normal engagement → no Free Round", [dc.freeRoundPending, dc.enterFreeRound()], [false, false]);
}

// ── 6. Held summon actions ──────────────────────────────────────────────────
{
  const keren = combatant("Keren", "party");
  const minion = combatant("Minion", "party", { turns: 0, statuses: ["Delay"] });
  const dc = combat([keren, combatant("Zarg", "party"), combatant("Slime", "enemy"), minion]);
  playRound(dc, (c) => {
    if (c.name === "Keren") dc.holdSummonAction({ request: { r: 1 }, tier: -1, performerTokenUuid: minion.tokenUuid, name: "Minion", sourcePhase: dc.speedTierOf(keren) });
  });
  // playRound stops at the wrap; check what a mid-round window would have seen
  eq("Delay hold: released at the end of the round", dc.takeDueHeldActions().map((h) => h.name), ["Minion"]);
}
{
  const keren = combatant("Keren", "party");
  const minion = combatant("Minion", "party", { turns: 0, statuses: ["Delay"] });
  const dc = combat([keren, combatant("Zarg", "party"), combatant("Slime", "enemy"), minion]);
  dc.currentCombatantId = keren.id; dc.lockPhase(keren); dc.nextTurn();
  dc.holdSummonAction({ request: {}, tier: -1, performerTokenUuid: minion.tokenUuid, name: "Minion", sourcePhase: 0 });
  eq("Delay hold: NOT released mid-round", dc.takeDueHeldActions().length, 0);
}
{
  // Keren Quickened (last Quicken creature), minion Quickened → acts at the end
  // of THIS round's Quicken phase, i.e. right after her turn.
  const keren = combatant("Keren", "party", { statuses: ["Quicken"] });
  const minion = combatant("Minion", "party", { turns: 0, statuses: ["Quicken"] });
  const dc = combat([keren, combatant("Slime", "enemy"), minion]);
  dc.currentCombatantId = keren.id; dc.lockPhase(keren); dc.nextTurn();
  dc.holdSummonAction({ request: {}, tier: 1, performerTokenUuid: minion.tokenUuid, name: "Minion", sourcePhase: dc.speedTierOf(keren) });
  eq("Quicken hold during the Quicken phase: released as it ends", dc.takeDueHeldActions().length, 1);
}
{
  // Keren in Normal, minion Quickened → this round's Quicken phase is over, so
  // the action waits for next round's.
  const keren = combatant("Keren", "party");
  const minion = combatant("Minion", "party", { turns: 0, statuses: ["Quicken"] });
  const dc = combat([keren, combatant("Slime", "enemy"), minion]);
  dc.currentCombatantId = keren.id; dc.lockPhase(keren); dc.nextTurn();
  dc.holdSummonAction({ request: {}, tier: 1, performerTokenUuid: minion.tokenUuid, name: "Minion", sourcePhase: dc.speedTierOf(keren) });
  eq("Quicken hold after the Quicken phase: waits", dc.takeDueHeldActions().length, 0);
  playRound(dc);
  eq("…still waiting through the round end", dc.takeDueHeldActions().length, 0);
  dc.beginPendingRound();
  eq("…released at the start of next round (no Quicken creatures)", dc.takeDueHeldActions().length, 1);
}
{
  const keren = combatant("Keren", "party");
  const minion = combatant("Minion", "party", { turns: 0, statuses: ["Delay"] });
  const dc = combat([keren, combatant("Slime", "enemy"), minion]);
  dc.holdSummonAction({ request: {}, tier: -1, performerTokenUuid: minion.tokenUuid, name: "Minion" });
  minion.isDefeatedLive = () => true;
  playRound(dc);
  eq("a held action whose performer died is dropped", [dc.takeDueHeldActions().length, dc.heldSummonActions.length], [0, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
