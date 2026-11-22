// node scripts/battle-director/force-skip-guard.test.mjs
// GM Next Turn must never wedge the FSM (STANDALONE_REACTION_WINDOW / early DECLARE).
globalThis.Hooks = { on() {}, once() {}, callAll() {}, off() {} };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
import assert from "node:assert/strict";
const { STATES } = await import("./states.js");
const { INTENTS } = await import("./intents.js");
const { BattleDirector } = await import("./director.js");
const { forceSkipRefusal, stillInEntry, REACTION_WINDOW_BUSY } = await import("./force-skip-guard.js");

// 1. Refusal map: SRW + FAW + TURN_START refuse; ordinary states do not.
assert.ok(forceSkipRefusal(STATES.STANDALONE_REACTION_WINDOW) === REACTION_WINDOW_BUSY);
assert.ok(forceSkipRefusal(STATES.FREE_ACTION_WINDOW));
assert.ok(forceSkipRefusal(STATES.TURN_START));
assert.equal(forceSkipRefusal(STATES.DECLARE), null);
assert.equal(forceSkipRefusal(STATES.TARGET), null);

// 2. Epoch bumps on every entry.
const mk = (handlers) => new BattleDirector({ payload: {}, stateHandlers: handlers });
{
  const d = mk({});
  const e0 = d._stateEpoch;
  await d.transitionTo(STATES.DECLARE);
  assert.equal(d._stateEpoch, e0 + 1);
  assert.ok(stillInEntry(d, STATES.DECLARE, e0 + 1));
  await d.transitionTo(STATES.TURN_END);
  assert.ok(!stillInEntry(d, STATES.DECLARE, e0 + 1));
}

// 3. Late compose: forced TURN_END while DECLARE.onEnter awaits its autopilot decide.
async function scenario(useGuard) {
  const log = { armed: false, reachedSrw: false };
  const stuck = new Promise(() => {}); // a compose that never resolves (open menu)
  let releaseDecide;
  const decide = new Promise((r) => { releaseDecide = r; });
  const handlers = {
    [STATES.DECLARE]: {
      async onEnter(d) {
        const epoch = d._stateEpoch;
        await decide; // autopilot decide
        if (useGuard && !stillInEntry(d, STATES.DECLARE, epoch)) return;
        log.armed = true;
        await stuck; // manual compose, holds the dispatch lock
      },
    },
    [STATES.TURN_END]: { async onEnter(d) { d.enqueue({ type: INTENTS.INTERNAL_DONE }); } },
    [STATES.STANDALONE_REACTION_WINDOW]: { async onEnter() { log.reachedSrw = true; } },
  };
  const d = mk(handlers);
  // DECLARE entered under the dispatch lock, like the real FSM.
  d.dispatch({ type: "X" }); // no-op intent, just to occupy the lock path shape
  const entering = d.transitionTo(STATES.DECLARE); // not awaited: onEnter is pending
  await new Promise((r) => setTimeout(r, 5));
  // lock-free force, exactly what forceNextTurn does
  await d.transitionTo(STATES.TURN_END);
  releaseDecide();
  await new Promise((r) => setTimeout(r, 30));
  return { ...log, state: d.state };
}
const old = await scenario(false);
const fixed = await scenario(true);
assert.equal(old.armed, true, "old logic opens the compose after leaving DECLARE (the wedge)");
assert.equal(fixed.armed, false, "guarded DECLARE must not arm compose after a forced skip");
assert.equal(fixed.reachedSrw, true, "TURN_END INTERNAL_DONE must flow on");
console.log("force-skip-guard ok");
process.exit(0);
