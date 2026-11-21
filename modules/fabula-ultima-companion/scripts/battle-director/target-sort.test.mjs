// ============================================================================
// targeting row `target_sort` (A3) — sortTargetPool.
//
//     node scripts/battle-director/target-sort.test.mjs
//
// Beheading reads "the lowest marked player": round_end → marked players →
// exact 1 + lowest_hp. A passive targeting row returns its WHOLE pool, so the
// sort must also narrow to `count` or "exact 1" kills every marked player.
// ============================================================================

globalThis.Hooks = globalThis.Hooks ?? { on() {}, once() {}, callAll() {} };
const { sortTargetPool, TARGET_SORT_KEYS } = await import("./skill-targeting.js");

let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

const tok = (id, cur, max) => ({ uuid: id, actor: { system: { props: { current_hp: cur, max_hp: max } } } });
const pool = [tok("A", 40, 100), tok("B", 12, 30), tok("C", 12, 120), tok("D", 90, 90)];
const ids = (p) => p.map((t) => t.uuid);

check("keys", TARGET_SORT_KEYS, ["lowest_hp", "highest_hp", "lowest_hp_pct"]);
check("lowest_hp exact 1 (tie keeps pool order)", ids(sortTargetPool(pool, "lowest_hp", 1)), ["B"]);
check("lowest_hp count 2",                         ids(sortTargetPool(pool, "lowest_hp", 2)), ["B", "C"]);
check("highest_hp count 1",                        ids(sortTargetPool(pool, "highest_hp", 1)), ["D"]);
check("lowest_hp_pct count 1 (C 10%)",             ids(sortTargetPool(pool, "lowest_hp_pct", 1)), ["C"]);
// A and B are both 40% — the tie keeps pool order.
check("lowest_hp_pct full order",                  ids(sortTargetPool(pool, "lowest_hp_pct", 9)), ["C", "A", "B", "D"]);
check("case/space tolerant",                       ids(sortTargetPool(pool, " Lowest_HP ", 1)), ["B"]);
check("blank = same array (no-op)",                sortTargetPool(pool, "", 1) === pool, true);
check("unknown key = same array (no-op)",          sortTargetPool(pool, "random", 1) === pool, true);
check("does not mutate input",                     ids(pool), ["A", "B", "C", "D"]);
check("count > pool returns all sorted",           ids(sortTargetPool(pool, "highest_hp", 10)), ["D", "A", "B", "C"]);
check("empty pool",                                sortTargetPool([], "lowest_hp", 1), []);
check("no max_hp → pct 1",                         ids(sortTargetPool([tok("X", 5, 0), tok("Y", 50, 100)], "lowest_hp_pct", 1)), ["Y"]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
