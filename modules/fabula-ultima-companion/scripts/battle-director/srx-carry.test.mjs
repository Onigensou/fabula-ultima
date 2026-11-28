// node scripts/battle-director/srx-carry.test.mjs
// Bug #17 (2026-11-28): a second reaction ask on the same creature opened pre-skipped.
import assert from "node:assert/strict";
import { srxKeyOf, srxIsUseReopen, srxCarryOver, srxOpenRows, srxNeedsAutoPass } from "./srx-carry.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const cand = (id, mode = "ask") => ({ carrierUuid: `Item.${id}`, rowKey: "r0", carrierName: id, mode });
const PL = cand("painful-lesson");
const OTHER = cand("other");
const entry = (over = {}) => ({ srx: true, closed: false, busy: false, pending: null, candidates: [PL], disabled: new Map(), skipped: new Set(), history: [], onPass: () => {}, ...over });

// ── carry-over decision ──────────────────────────────────────────────────────
t("live repro: ask 1 passed (pending null, PL skipped) → ask 2 starts clean", () => {
  const prev = entry({ closed: true, lastAction: "Passed", skipped: new Set([srxKeyOf(PL)]) });
  assert.equal(srxIsUseReopen(prev), false);
  const { history, skipped } = srxCarryOver(prev, [PL]);
  assert.deepEqual(history, []);
  assert.equal(skipped.size, 0);
  assert.equal(srxOpenRows(entry({ skipped })).length, 1, "ask 2 has its row to answer");
});
t("no prev / prev not an srx entry → fresh", () => {
  for (const prev of [undefined, null, { srx: false, pending: PL, skipped: new Set(["x"]) }]) {
    const r = srxCarryOver(prev, [PL]);
    assert.deepEqual(r.history, []);
    assert.equal(r.skipped.size, 0);
  }
});
t("Use re-open, the used reaction landed (no longer offered) → history gains Applied, skips kept", () => {
  const prev = entry({ closed: true, lastAction: "Applied", candidates: [PL, OTHER], pending: OTHER, skipped: new Set(["Item.x::r0"]) });
  assert.equal(srxIsUseReopen(prev), true);
  const r = srxCarryOver(prev, [PL]);
  assert.deepEqual(r.history, [{ c: OTHER, status: "Applied" }]);
  assert.deepEqual([...r.skipped], ["Item.x::r0"]);
});
t("Use re-open, the used reaction still offered (cancelled) → no Applied row", () => {
  const prev = entry({ closed: true, candidates: [PL, OTHER], pending: OTHER, history: [{ c: PL, status: "Applied" }] });
  const r = srxCarryOver(prev, [PL, OTHER]);
  assert.deepEqual(r.history, [{ c: PL, status: "Applied" }]);
});
t("carried skipped set is a copy, not the prev entry's Set", () => {
  const prev = entry({ pending: OTHER, skipped: new Set(["a"]) });
  const r = srxCarryOver(prev, [PL]);
  r.skipped.add("b");
  assert.deepEqual([...prev.skipped], ["a"]);
});

// ── open rows + zero-open-rows safety net ─────────────────────────────────────
t("open rows skip auto, disabled and skipped ones", () => {
  const a = cand("a"), b = cand("b", "on"), c = cand("c"), d = cand("d");
  const e = entry({ candidates: [a, b, c, d], disabled: new Map([[srxKeyOf(c), "No MP"]]), skipped: new Set([srxKeyOf(d)]) });
  assert.deepEqual(srxOpenRows(e), [a]);
});
t("old bug shape (every row pre-skipped, Pass available) → auto-pass", () => {
  assert.equal(srxNeedsAutoPass(entry({ skipped: new Set([srxKeyOf(PL)]) })), true);
});
t("only auto / unusable rows, or no rows at all → auto-pass", () => {
  assert.equal(srxNeedsAutoPass(entry({ candidates: [cand("x", "on")] })), true);
  assert.equal(srxNeedsAutoPass(entry({ disabled: new Map([[srxKeyOf(PL), "Used"]]) })), true);
  assert.equal(srxNeedsAutoPass(entry({ candidates: [] })), true);
});
t("a row to answer → no auto-pass", () => {
  assert.equal(srxNeedsAutoPass(entry()), false);
});
t("no onPass, closed, busy, Use in flight, or a live player deciding → no auto-pass", () => {
  const dead = { skipped: new Set([srxKeyOf(PL)]) };
  assert.equal(srxNeedsAutoPass(entry({ ...dead, onPass: null })), false);
  assert.equal(srxNeedsAutoPass(entry({ ...dead, closed: true })), false);
  assert.equal(srxNeedsAutoPass(entry({ ...dead, busy: true })), false);
  assert.equal(srxNeedsAutoPass(entry({ ...dead, pending: PL })), false);
  assert.equal(srxNeedsAutoPass(entry(dead), { theirs: true }), false);
  assert.equal(srxNeedsAutoPass(null), false);
});

console.log(`srx-carry: ${n} passed`);
