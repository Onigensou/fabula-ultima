// node scripts/battle-director/gain-coalesce.test.mjs
import assert from "node:assert/strict";
import { createGainCoalescer } from "./gain-coalesce.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
function harness() {
  const out = [], timers = [];
  const push = createGainCoalescer({ emit: (g) => out.push({ ...g }), setTimer: (fn) => timers.push(fn) });
  return { out, push, flush: () => { while (timers.length) timers.shift()(); } };
}

t("Lightning Charge x3 on the Kirin = one +15 MP, not three +5", () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.push({ tokenUuid: "kirin", resource: "mp", amount: 5 });
  h.flush();
  assert.deepEqual(h.out, [{ tokenUuid: "kirin", resource: "mp", amount: 15, count: 3 }]);
});
t("different resources on one creature stay separate (MP and the overflow shield)", () => {
  const h = harness();
  h.push({ tokenUuid: "kirin", resource: "mp", amount: 5 });
  h.push({ tokenUuid: "kirin", resource: "shield", amount: 3 });
  h.flush();
  assert.deepEqual(h.out.map((g) => [g.resource, g.amount]), [["mp", 5], ["shield", 3]]);
});
t("different creatures stay separate (Turbo Remedy heals each ally on its own)", () => {
  const h = harness();
  h.push({ tokenUuid: "a", resource: "hp", amount: 25 });
  h.push({ tokenUuid: "b", resource: "hp", amount: 25 });
  h.flush();
  assert.equal(h.out.length, 2);
});
t("a Chain strike (cascade) is never merged and floats at once", () => {
  const h = harness();
  h.push({ tokenUuid: "a", resource: "hp", amount: 9, cascade: 1 });
  h.push({ tokenUuid: "a", resource: "hp", amount: 9, cascade: 2 });
  assert.equal(h.out.length, 2);
});
t("a move that opted out (separateNumbers) keeps one float per gain", () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.push({ tokenUuid: "kirin", resource: "mp", amount: 5, noMerge: true });
  assert.deepEqual(h.out.map((g) => g.amount), [5, 5, 5]);
});
t("a gain after the window closes starts a new number", () => {
  const h = harness();
  h.push({ tokenUuid: "a", resource: "hp", amount: 4 }); h.flush();
  h.push({ tokenUuid: "a", resource: "hp", amount: 6 }); h.flush();
  assert.deepEqual(h.out.map((g) => g.amount), [4, 6]);
});
t("zero / negative / tokenless gains float nothing", () => {
  const h = harness();
  h.push({ tokenUuid: "a", amount: 0 }); h.push({ tokenUuid: "a", amount: -3 }); h.push({ amount: 5 });
  h.flush();
  assert.equal(h.out.length, 0);
});
console.log(`\n${n} passed`);
