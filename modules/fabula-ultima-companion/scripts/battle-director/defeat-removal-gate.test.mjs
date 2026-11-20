// node scripts/battle-director/defeat-removal-gate.test.mjs
import assert from "node:assert/strict";
import { createRemovalGate } from "./defeat-removal-gate.js";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ok", name); };
const tick = () => new Promise((r) => setImmediate(r));
function manualTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { if (id) timers[id - 1] = null; },
    fire: () => { for (const fn of timers.splice(0)) fn?.(); },
  };
}

// The race this guards (Nox Legion sims, 2026-11-20): Blanche's Muleta kills the
// last foe, its own Bleed rider then writes to the dying token while the defeat's
// delete is already on its way → "Token <id> does not exist!".
await t("a removal waits until the pass is done writing, then goes", async () => {
  const gate = createRemovalGate();
  const order = [];
  const g = gate.current();
  const removal = gate.wait(g).then((opened) => { order.push(`delete (opened=${opened})`); });
  await tick();
  order.push("rider writes Bleed to the dying token");   // same pass, after the kill
  await tick();
  assert.deepEqual(order, ["rider writes Bleed to the dying token"]);
  gate.release();                                         // drainPendingDefeats
  await removal;
  assert.deepEqual(order, ["rider writes Bleed to the dying token", "delete (opened=true)"]);
});

await t("deaths of one pass share a gate; the next pass gets a closed one", async () => {
  const gate = createRemovalGate();
  const a = gate.current(), b = gate.current();
  assert.equal(a, b);
  gate.release();
  const c = gate.current();
  assert.notEqual(c, a);
  assert.equal(a.isOpen, true);
  assert.equal(c.isOpen, false);
  assert.equal(await gate.wait(a), true);                 // already open: no wait
});

await t("a release with nothing scheduled is harmless", async () => {
  const gate = createRemovalGate();
  assert.equal(gate.release(), false);
  assert.equal(gate.current().isOpen, false);
});

await t("a pass that never releases does not strand the token", async () => {
  const tm = manualTimers();
  const gate = createRemovalGate({ maxWaitMs: 15000, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const p = gate.wait(gate.current());
  await tick();
  tm.fire();
  assert.equal(await p, false);
});

await t("an opened gate cancels its fallback timer", async () => {
  const tm = manualTimers();
  const gate = createRemovalGate({ setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const p = gate.wait(gate.current());
  gate.release();
  assert.equal(await p, true);
  assert.deepEqual(tm.timers.filter(Boolean), []);
});

console.log(`defeat-removal-gate: ${n} passed`);
