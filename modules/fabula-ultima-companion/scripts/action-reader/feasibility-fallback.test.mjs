// node scripts/action-reader/feasibility-fallback.test.mjs
const { pickFallbackPool, reachesNobody, resolveTargetsWithRetry } = await import("./feasibility-fallback.js");
let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}
const mk = (n, free, survey) => ({ n, free, targetSurvey: survey });
const isFree = (c) => c.free;
const names = (r) => r.pool.map((c) => c.n);
const none = { ok: true, available: 0 }, some = { ok: true, available: 2 };

check("reachesNobody ok+0", reachesNobody(mk("a", true, none)), true);
check("reachesNobody no survey fails open", reachesNobody(mk("a", true, null)), false);
check("reachesNobody not-ok fails open", reachesNobody(mk("a", true, { ok: false, available: 0 })), false);

check("melee unreachable + free ranged reachable -> ranged",
  names(pickFallbackPool([mk("Claw", true, none), mk("Tail", true, none), mk("Bow", true, some)], isFree)), ["Bow"]);
check("self/no-survey free action counts reachable",
  names(pickFallbackPool([mk("Claw", true, none), mk("Guard", true, undefined)], isFree)), ["Guard"]);
check("all free unreachable -> legacy (same pool, Do Nothing path unchanged)",
  names(pickFallbackPool([mk("Claw", true, none), mk("Tail", true, none), mk("WB", false, some)], isFree)), ["Claw", "Tail"]);
check("no free at all -> all available (legacy)",
  names(pickFallbackPool([mk("WB", false, some), mk("X", false, none)], isFree)), ["WB", "X"]);
check("all reachable free -> identical pool (no pick change)",
  names(pickFallbackPool([mk("A", true, some), mk("B", true, some)], isFree)), ["A", "B"]);
check("gated action not resurrected: helper only sees the passed pool",
  names(pickFallbackPool([mk("Claw", true, none)], isFree)), ["Claw"]);
check("empty -> empty", names(pickFallbackPool([], isFree)), []);

// ---- cost: unaffordable never chosen by the fallback pool ----
const mkc = (n, free, survey, costShort) => ({ n, free, targetSurvey: survey, costShort });
check("unaffordable spell excluded from step 3 -> empty pool (Do Nothing / GM hand-off)",
  names(pickFallbackPool([mkc("Soulflare", false, some, true)], isFree)), []);
check("affordable non-free kept, unaffordable dropped",
  names(pickFallbackPool([mkc("Soulflare", false, some, true), mkc("Bolt", false, some, false)], isFree)), ["Bolt"]);
check("free action still wins over cost-short spell",
  names(pickFallbackPool([mkc("Claw", true, some, false), mkc("Soulflare", false, some, true)], isFree)), ["Claw"]);

// ---- autopilot-level: stubbed matcher + memory (mirrors matchAndPick's applyAntiRepeat/record) ----
function rig({ rows, reach, cooldowns = {} }) {
  const mem = {}; // usedRounds
  const state = { stamps: [], round: 1 };
  const ctx = {};
  const pick = async (c, o = {}) => {
    c.pendingActionMemory = null;
    const ex = new Set(o.excludeActions ?? []);
    const pool = rows.filter((r) => !ex.has(r) && !(cooldowns[r] > 0 && mem[r] != null && state.round - mem[r] < cooldowns[r]));
    const chosen = pool[0];
    c.chosenAction = chosen ? { name: chosen } : null;
    if (chosen && o.recordMemory !== false) {
      if (o.deferMemory) c.pendingActionMemory = chosen;
      else { mem[chosen] = state.round; state.stamps.push(chosen); }
    }
  };
  const commit = async (c) => { const p = c.pendingActionMemory; c.pendingActionMemory = null; if (p) { mem[p] = state.round; state.stamps.push(p); } };
  const resolveTargets = async (c) => { c.chosenTargets = reach[c.chosenAction.name] ? ["t"] : []; };
  const activate = async (grant = false) => {
    ctx.chosenAction = null; ctx.chosenTargets = [];
    const logs = [];
    await pick(ctx, grant ? { recordMemory: false } : { deferMemory: true });
    const ok = await resolveTargetsWithRetry(ctx, { pick, resolveTargets, commit, grant, log: (m) => logs.push(m) });
    return { ok, chosen: ctx.chosenAction?.name ?? null, logs };
  };
  return { activate, mem, state };
}
{
  const r = rig({ rows: ["Claw", "Breath"], reach: { Claw: false, Breath: true }, cooldowns: { Breath: 2 } });
  const a = await r.activate();
  check("(a) retry pick performed + stamped, empty pick not", [a.ok, a.chosen, r.state.stamps], [true, "Breath", ["Breath"]]);
  check("(a) retry log fired", a.logs.length, 1);
  r.state.round = 2;
  const b = await r.activate();
  check("(b) cooldown action picked by retry is blocked next activation (Claw reaches nobody -> Do Nothing)", [b.ok, r.state.stamps], [false, ["Breath"]]);
}
{
  const r = rig({ rows: ["Claw"], reach: { Claw: false } });
  const a = await r.activate();
  check("(c) nothing reachable -> no pick, no stamp (Do Nothing path)", [a.ok, r.state.stamps], [false, []]);
}
{
  const r = rig({ rows: ["Claw", "Breath"], reach: { Claw: true, Breath: true } });
  const a = await r.activate();
  check("(d) first pick reachable -> performed, stamped once, no retry log", [a.ok, a.chosen, r.state.stamps, a.logs.length], [true, "Claw", ["Claw"], 0]);
}
{
  const r = rig({ rows: ["Claw", "Breath"], reach: { Claw: false, Breath: true } });
  const a = await r.activate(true);
  check("(e) grant consult: no retry, no stamp, ends empty", [a.ok, a.chosen, r.state.stamps, a.logs.length], [false, "Claw", [], 0]);
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
