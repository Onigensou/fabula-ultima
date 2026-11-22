// ============================================================================
// DirectorCombat: turn priority + grantTurnsThisRound (Army of the Damned S1).
//
//     node scripts/battle-director/director-combat-priority.test.mjs
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

function combatant(id, side, { turns = 1, statuses = [], pin = null } = {}) {
  const c = Object.create(DirectorCombatant.prototype);
  const actor = { appliedEffects: statuses.map((n) => ({ name: n })), system: { props: { activation: turns } } };
  const tokenDoc = { actor, getFlag: (_ns, k) => (k === "turnsPerRound" && pin !== null ? pin : undefined) };
  Object.assign(c, {
    id, name: id, side, actorUuid: `Actor.${id}`, tokenUuid: `Token.${id}`,
    actorDoc: actor, tokenDoc,
    turnsPerRound: pin ?? turns, turnsRemaining: pin ?? turns, flags: {}, phaseLock: null, turnPriority: null,
  });
  c.isDefeatedLive = () => !!c.defeated;
  return c;
}

function combat(units, { firstSide = "party" } = {}) {
  const dc = new DirectorCombat({ scene: { id: "S", name: "S" } });
  dc.engagement = "normal";
  dc.firstSide = firstSide;
  for (const u of units) dc.combatants.push(u);
  dc.start();
  dc.round = 1;
  return dc;
}

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
const frags = () => ["F1", "F2", "F3"].map((n) => combatant(n, "enemy", { pin: 0 }));
const party4 = () => ["P1", "P2", "P3", "P4"].map((n) => combatant(n, "party"));

// 1. Army order.
{
  const units = [...party4(), combatant("Boss", "enemy", { turns: 4 }), ...frags()];
  const dc = combat(units, { firstSide: "enemy" });
  let armed = false;
  const seq = playRound(dc, (c) => {
    if (c.name === "Boss" && !armed) {
      armed = true;
      for (const f of dc.combatants.filter((x) => x.name.startsWith("F"))) {
        dc.grantTurnsThisRound(f, { turns: 1, priority: 10 });
      }
    }
  });
  eq("1 Army sequence", seq, ["Boss", "P1", "F1", "P2", "F2", "P3", "F3", "P4", "Boss", "Boss", "Boss"]);
}

// 2. Phases.
{
  const delayed = combatant("FD", "enemy", { pin: 0, statuses: ["Delay"] });
  const normal = combatant("E1", "enemy");
  const dc = combat([combatant("P1", "party"), normal, delayed], { firstSide: "enemy" });
  dc.grantTurnsThisRound(delayed, { priority: 10 });
  eq("2a delayed holder does not jump the phase", dc.eligibleOnSide("enemy").map((c) => c.name), ["E1"]);
}
{
  const boss = combatant("Boss", "enemy", { statuses: ["Quicken"], turns: 2 });
  const f = combatant("F1", "enemy", { pin: 0 });
  const dc = combat([combatant("P1", "party"), boss, f], { firstSide: "enemy" });
  const tier = dc.speedTierOf(boss);
  dc.grantTurnsThisRound(f, { priority: 10, phaseTier: tier });
  eq("2b phaseTier = caster's tier: fragment acts in the Quicken phase",
    [dc.currentPhaseTier(), dc.eligibleOnSide("enemy").map((c) => c.name)], [tier, ["F1"]]);
}

// 3. Stale priority.
{
  const f1 = combatant("F1", "enemy", { pin: 0 });
  const f2 = combatant("F2", "enemy", { pin: 0 });
  const boss = combatant("Boss", "enemy", { turns: 2 });
  const dc = combat([combatant("P1", "party"), boss, f1, f2], { firstSide: "enemy" });
  dc.grantTurnsThisRound(f1, { priority: 10 });
  eq("3a active priority this round", [dc.turnPriorityOf(f1), dc.turnPriorityOf(f2)], [10, 0]);
  dc.round = 2;
  f1.turnsRemaining = 1;
  eq("3b stale priority reads 0", dc.turnPriorityOf(f1), 0);
  eq("3b stale priority does not narrow", dc.eligibleOnSide("enemy").map((c) => c.name).sort(), ["Boss", "F1"]);
  dc.round = 1; dc.pendingRoundWrap = true; f1.turnsRemaining = 1;
  dc.beginPendingRound();
  eq("3c next round: fragments back to 0 turns", [f1.turnsRemaining, f2.turnsRemaining, boss.turnsRemaining], [0, 0, 2]);
}

// 4. Defeated holder.
{
  const f1 = combatant("F1", "enemy", { pin: 0 });
  const boss = combatant("Boss", "enemy", { turns: 2 });
  const dc = combat([combatant("P1", "party"), boss, f1], { firstSide: "enemy" });
  dc.grantTurnsThisRound(f1, { priority: 10 });
  eq("4a holder narrows the side", dc.eligibleOnSide("enemy").map((c) => c.name), ["F1"]);
  f1.defeated = true;
  eq("4b defeated holder: group falls back to the rest", dc.eligibleOnSide("enemy").map((c) => c.name), ["Boss"]);
  eq("4c party side unaffected", dc.eligibleOnSide("party").map((c) => c.name), ["P1"]);
  boss.turnsRemaining = 0;
  eq("4d empty side stays empty", dc.eligibleOnSide("enemy"), []);
}

// 5. Persistence round-trip (pure part) + source wiring.
{
  const c = combatant("F1", "enemy", { pin: 0 });
  const dc = combat([combatant("P1", "party"), c]);
  dc.grantTurnsThisRound(c, { priority: 10 });
  const sc = JSON.parse(JSON.stringify({ turnPriority: c.turnPriority ?? null, turnsRemaining: c.turnsRemaining }));
  const restored = (sc.turnPriority && typeof sc.turnPriority === "object") ? sc.turnPriority : null;
  eq("5a JSON round-trip keeps turnPriority + turnsRemaining", [restored, sc.turnsRemaining], [{ round: 1, value: 10 }, 1]);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./persistence.js", import.meta.url), "utf8");
  eq("5b persistence saves + restores turnPriority",
    [/turnPriority: c\.turnPriority \?\? null/.test(src), /combatant\.turnPriority = /.test(src)], [true, true]);
}

// 6. Defeated grant refused; revoke helper.
{
  const f = combatant("F1", "enemy", { pin: 0 });
  const dc = combat([combatant("P1", "party"), f]);
  f.defeated = true;
  eq("6a grant on defeated returns false", [dc.grantTurnsThisRound(f, { priority: 10 }), f.turnsRemaining, f.turnPriority], [false, 0, null]);
  f.defeated = false;
  eq("6b grant ok", dc.grantTurnsThisRound(f, { priority: 10 }), true);
  eq("6c revokeGrant clears turns + priority", [dc.revokeGrant(f), f.turnsRemaining, f.turnPriority], [true, 0, null]);
  eq("6d revoke again is a no-op", dc.revokeGrant(f), false);
  eq("6e revoked fragment is not eligible", dc.eligibleOnSide("enemy"), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
