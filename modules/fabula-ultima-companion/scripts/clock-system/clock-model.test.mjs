// ============================================================================
// Clock System — model regression harness.
//
//     node scripts/clock-system/clock-model.test.mjs
//
// Runs in bare Node: no Foundry, no browser, no game world. That is only
// possible because clock-model.js is pure, and keeping this runnable is the
// reason to keep it pure. Exits non-zero on failure.
//
// The load-bearing assertions are the pole-ownership ones — "players push a
// teardown clock DOWN", "an unclaimed pole clamps and never resolves". Those
// encode the single-axis/two-pole claim the whole system rests on.
// ============================================================================

import * as M from "./clock-model.js";
import * as C from "./clock-const.js";
const { preset, applyDelta, applySet, applyResolve, applyReopen, signFor, resolutionFor, makeClock } = M;
const { SIDE, POLE, OUTCOME, CLOCK_STATE } = C;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── shapes ────────────────────────────────────────────────────────────────
const prog = preset.progress({ id: "p", name: "Ritual Stopped", sections: 6 });
eq("progress starts empty", prog.value, 0);
eq("progress high pole = players/success", [prog.poles.high.side, prog.poles.high.outcome], ["players", "success"]);
eq("progress low pole unclaimed", prog.poles.low, null);

const threat = preset.threat({ id: "t", name: "Ambushed!" });
eq("threat sections default 4", threat.sections, 4);
eq("threat starts empty", threat.value, 0);
eq("threat high pole = gm/failure", [threat.poles.high.side, threat.poles.high.outcome], ["gm", "failure"]);

const tear = preset.teardown({ id: "d", name: "Ceiling Support", sections: 6 });
eq("teardown starts FULL", tear.value, 6);
eq("teardown low pole = players/success", [tear.poles.low.side, tear.poles.low.outcome], ["players", "success"]);
eq("teardown high pole unclaimed", tear.poles.high, null);

const strug = preset.struggle({ id: "s", name: "Tug", sections: 8 });
eq("struggle starts centered", strug.value, 4);
eq("struggle both poles claimed", [strug.poles.high.side, strug.poles.low.side], ["players", "gm"]);
const strugOdd = preset.struggle({ id: "s2", name: "Odd", sections: 7 });
eq("struggle odd sections centers low", strugOdd.value, 3);
const strugExplicit = preset.struggle({ id: "s3", name: "Explicit", sections: 8, value: 6 });
eq("struggle explicit value wins", strugExplicit.value, 6);

// ── direction: the core claim ─────────────────────────────────────────────
eq("players push progress UP", signFor(prog, SIDE.PLAYERS), +1);
eq("gm has no pole on progress", signFor(prog, SIDE.GM), 0);
eq("gm pushes threat UP", signFor(threat, SIDE.GM), +1);
eq("players push teardown DOWN", signFor(tear, SIDE.PLAYERS), -1);
eq("struggle: players up, gm down", [signFor(strug, SIDE.PLAYERS), signFor(strug, SIDE.GM)], [+1, -1]);
eq("direction override beats ownership", signFor(prog, SIDE.PLAYERS, POLE.LOW), -1);

// ── advancement + clamping ────────────────────────────────────────────────
let r = applyDelta(prog, { side: SIDE.PLAYERS, sections: 2, cause: "check" });
eq("progress +2", [r.previous, r.clock.value, r.delta], [0, 2, 2]);
eq("no resolution mid-clock", r.resolution, null);
eq("history appended", r.clock.history.length, 1);
eq("input not mutated", prog.value, 0);

r = applyDelta(r.clock, { side: SIDE.PLAYERS, sections: -1, cause: "turn back" });
eq("turn back (negative) pulls away from pole", [r.previous, r.clock.value, r.delta], [2, 1, -1]);

r = applyDelta(prog, { side: SIDE.PLAYERS, sections: 99 });
eq("clamps at sections", r.clock.value, 6);
eq("axis delta reported after clamp", r.delta, 6);
eq("full progress resolves high/players/success", [r.resolution.pole, r.resolution.side, r.resolution.outcome], ["high", "players", "success"]);
eq("state flips to resolved", r.clock.state, CLOCK_STATE.RESOLVED);

// unclaimed pole must CLAMP, never resolve
r = applyDelta(prog, { side: SIDE.PLAYERS, sections: -5 });
eq("progress already at 0 cannot go lower (no-op)", r.noop, true);
eq("progress at 0 stays active", prog.state, CLOCK_STATE.ACTIVE);

const midProg = applyDelta(prog, { side: SIDE.PLAYERS, sections: 3 }).clock;
r = applyDelta(midProg, { side: SIDE.PLAYERS, sections: -9 });
eq("progress emptied to 0 clamps, no resolution", [r.clock.value, r.resolution], [0, null]);
eq("...and stays ACTIVE", r.clock.state, CLOCK_STATE.ACTIVE);

// direction override composes as sign x magnitude — negative sections flip it back.
eq("direction:low + negative sections double-negates (pushes UP)",
  applyDelta(midProg, { side: SIDE.PLAYERS, sections: -1, direction: POLE.LOW }).clock.value, 4);
eq("direction:low + positive sections pushes DOWN",
  applyDelta(midProg, { side: SIDE.PLAYERS, sections: 1, direction: POLE.LOW }).clock.value, 2);

// teardown: players emptying it WINS
r = applyDelta(tear, { side: SIDE.PLAYERS, sections: 6 });
eq("teardown emptied by players", r.clock.value, 0);
eq("teardown resolves low/players/success", [r.resolution.pole, r.resolution.side, r.resolution.outcome], ["low", "players", "success"]);

// threat: gm filling it is a player FAILURE
r = applyDelta(threat, { side: SIDE.GM, sections: 4 });
eq("threat filled resolves high/gm/failure", [r.resolution.pole, r.resolution.side, r.resolution.outcome], ["high", "gm", "failure"]);

// struggle: both poles reachable from the middle
r = applyDelta(strug, { side: SIDE.GM, sections: 4 });
eq("struggle: gm drives to 0", r.clock.value, 0);
eq("struggle: gm win = failure", [r.resolution.pole, r.resolution.outcome], ["low", "failure"]);
r = applyDelta(strug, { side: SIDE.PLAYERS, sections: 4 });
eq("struggle: players drive to 8", r.clock.value, 8);
eq("struggle: player win = success", [r.resolution.pole, r.resolution.outcome], ["high", "success"]);

// ── no-ops ────────────────────────────────────────────────────────────────
eq("side owning no pole is a no-op", applyDelta(prog, { side: SIDE.GM, sections: 3 }).noop, true);
eq("zero sections is a no-op", applyDelta(prog, { side: SIDE.PLAYERS, sections: 0 }).noop, true);
const resolved = applyDelta(prog, { side: SIDE.PLAYERS, sections: 6 }).clock;
eq("resolved clock ignores further advances", applyDelta(resolved, { side: SIDE.PLAYERS, sections: -1 }).noop, true);

// ── set / resolve / reopen ────────────────────────────────────────────────
r = applySet(prog, 6, { cause: "gm override" });
eq("set to full resolves like filling", r.clock.state, CLOCK_STATE.RESOLVED);
eq("set records axis delta", r.delta, 6);
eq("set out of range clamps", applySet(prog, 99).clock.value, 6);
eq("set to same value is a no-op", applySet(prog, 0).noop, true);

const forced = applyResolve(prog, POLE.HIGH, { cause: "gm called it" });
eq("forced resolve snaps value to pole", forced.value, 6);
eq("forced resolve outcome", forced.resolution.outcome, "success");

const reopened = applyReopen(forced);
eq("reopen pulls one section off the pole", reopened.value, 5);
eq("reopen clears resolution", [reopened.state, reopened.resolution], ["active", null]);
const reopenedLow = applyReopen(applyResolve(tear, POLE.LOW));
eq("reopen from low pole lands at 1", reopenedLow.value, 1);

// ── validation ────────────────────────────────────────────────────────────
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
eq("no poles rejected", throws(() => makeClock({ id: "x", name: "n", poles: {} })), true);
eq("same side on both poles rejected", throws(() => makeClock({
  id: "x", name: "n",
  poles: { high: { side: "players", outcome: "success" }, low: { side: "players", outcome: "failure" } },
})), true);
eq("missing name rejected", throws(() => preset.progress({ id: "x" })), true);
eq("sections clamped to max", makeClock({ id: "x", name: "n", sections: 999, poles: { high: { side: "gm" } } }).sections, 24);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
