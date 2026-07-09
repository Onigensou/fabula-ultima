// ============================================================================
// Clock System — check-advancement regression harness (RAW p.53).
//
//     node scripts/clock-system/clock-check.test.mjs
//
// Bare Node, no Foundry. Includes the rulebook's own worked example as a test:
// Valea rolls a 6 against DL 10 and the GM fills TWO sections of "Ambushed!" —
// one for the failure, one for missing by three or more.
// ============================================================================

import * as CH from "./clock-check.js";
import * as M from "./clock-model.js";
import * as C from "./clock-const.js";

const { readCheck, marginBonus, checkSections, sideAdvancingOn, previewCheck, applyCheck, applyCheckToMany } = CH;
const { preset } = M;
const { SIDE, OUTCOME, CLOCK_STATE } = C;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── readCheck ─────────────────────────────────────────────────────────────
eq("meets DL exactly = success", readCheck({ result: 10, difficulty: 10 }).outcome, "success");
eq("under DL = failure", readCheck({ result: 9, difficulty: 10 }).outcome, "failure");
eq("margin is absolute", [readCheck({ result: 16, difficulty: 10 }).margin, readCheck({ result: 4, difficulty: 10 }).margin], [6, 6]);
eq("opposed: strictly greater wins", readCheck({ result: 12, opposedResult: 11 }).outcome, "success");
eq("opposed: tie is a failure, margin 0", [readCheck({ result: 11, opposedResult: 11 }).outcome, readCheck({ result: 11, opposedResult: 11 }).margin], ["failure", 0]);
eq("opposed beats difficulty when both given", readCheck({ result: 12, difficulty: 20, opposedResult: 11 }).outcome, "success");
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
eq("no bar to clear is an error", throws(() => readCheck({ result: 10 })), true);
eq("non-numeric result is an error", throws(() => readCheck({ result: "x", difficulty: 5 })), true);

// ── margin tiers (RAW: 6+ replaces the 3+ bonus, not stacks) ──────────────
eq("margin 0..2 → +0", [0, 1, 2].map(marginBonus), [0, 0, 0]);
eq("margin 3..5 → +1", [3, 4, 5].map(marginBonus), [1, 1, 1]);
eq("margin 6+ → +2 (not +3)", [6, 7, 20].map(marginBonus), [2, 2, 2]);

// ── checkSections ─────────────────────────────────────────────────────────
eq("plain success = 1 section", checkSections({ outcome: "success", margin: 0 }).sections, 1);
eq("success by 3 = 2 sections", checkSections({ outcome: "success", margin: 3 }).sections, 2);
eq("success by 6 = 3 sections", checkSections({ outcome: "success", margin: 6 }).sections, 3);
eq("failed check fills nothing on a success clock", checkSections({ outcome: "failure", margin: 9, advanceOn: "success" }).sections, 0);
eq("failed check fills a threat clock", checkSections({ outcome: "failure", margin: 0, advanceOn: "failure" }).sections, 1);

// opportunity: opt-in, and only when the matching die result earned it
eq("crit alone does nothing without spending", checkSections({ outcome: "success", margin: 0, isCritical: true }).sections, 1);
eq("crit + spend = +2", checkSections({ outcome: "success", margin: 0, isCritical: true, spendOpportunity: true }).sections, 3);
eq("crit + spend + margin 6 = 1+2+2", checkSections({ outcome: "success", margin: 6, isCritical: true, spendOpportunity: true }).sections, 5);
eq("fumble + spend on a threat clock = +2", checkSections({ outcome: "failure", margin: 0, advanceOn: "failure", isFumble: true, spendOpportunity: true }).sections, 3);
eq("fumble opportunity cannot be spent on a success", checkSections({ outcome: "success", margin: 0, isFumble: true, spendOpportunity: true }).opportunitySpent, false);
eq("crit opportunity cannot be spent on a failure", checkSections({ outcome: "failure", margin: 0, advanceOn: "failure", isCritical: true, spendOpportunity: true }).opportunitySpent, false);
eq("spending unearned opportunity is worth 0, not an error", checkSections({ outcome: "success", margin: 0, spendOpportunity: true }).sections, 1);

// ── sideAdvancingOn — the derivation that removes the branching ───────────
const prog   = preset.progress({ id: "p", name: "Escape Route", sections: 6 });
const threat = preset.threat({ id: "t", name: "Ambushed!" });
const tear   = preset.teardown({ id: "d", name: "Ceiling", sections: 6 });
const strug  = preset.struggle({ id: "s", name: "Ritual", sections: 8 });

eq("progress takes successes only", [sideAdvancingOn(prog, "success"), sideAdvancingOn(prog, "failure")], ["players", null]);
eq("threat takes failures only", [sideAdvancingOn(threat, "success"), sideAdvancingOn(threat, "failure")], [null, "gm"]);
eq("teardown takes successes only", [sideAdvancingOn(tear, "success"), sideAdvancingOn(tear, "failure")], ["players", null]);
eq("struggle takes both", [sideAdvancingOn(strug, "success"), sideAdvancingOn(strug, "failure")], ["players", "gm"]);

// ── previewCheck: pure, mutates nothing ───────────────────────────────────
let p = previewCheck(prog, { result: 14, difficulty: 10 });
eq("preview: success by 4 → 2 sections up", [p.sections, p.direction, p.from, p.to], [2, "high", 0, 2]);
eq("preview: reports margin + outcome", [p.outcome, p.margin], ["success", 4]);
eq("preview: nothing resolved yet", p.wouldResolve, null);
eq("preview did not mutate the clock", prog.value, 0);

p = previewCheck(prog, { result: 4, difficulty: 10 });
eq("preview: progress clock ignores a failure", [p.applies, p.sections, p.delta], [false, 0, 0]);
eq("preview: indifferent clock reports no side", p.side, null);

p = previewCheck(tear, { result: 19, difficulty: 10 });
eq("preview: teardown success moves DOWN", [p.direction, p.from, p.to], ["low", 6, 3]);

// A huge margin still only ever buys +2 — the sections come from the tier, not
// the size of the roll. So reach the pole from a clock that is already near it.
p = previewCheck(prog, { result: 30, difficulty: 10 });
eq("preview: margin is tiered, not scaled (1+2=3, not 20)", [p.sections, p.to], [3, 3]);

const nearlyDone = M.applyDelta(prog, { side: SIDE.PLAYERS, sections: 5 }).clock;
p = previewCheck(nearlyDone, { result: 30, difficulty: 10 });
eq("preview: clamps at the pole", [p.from, p.to], [5, 6]);
eq("preview: wouldResolve announces the win", [p.wouldResolve.pole, p.wouldResolve.outcome], ["high", "success"]);

const done = { ...prog, state: CLOCK_STATE.RESOLVED };
eq("preview: resolved clock never applies", previewCheck(done, { result: 20, difficulty: 10 }).applies, false);

// ── the RAW worked example (p.53) ─────────────────────────────────────────
// "Valea rolls a 6 on a Check with Difficulty Level 10. The GM fills two
//  sections on the 'Ambushed!' Clock — one for her failure, and another
//  because she failed the Check by three or more."
const valea = applyCheck(threat, { result: 6, difficulty: 10 });
eq("RAW example: two sections filled", valea.clock.value, 2);
eq("RAW example: the GM's side advanced", valea.preview.side, "gm");
eq("RAW example: 1 base + 1 margin", [valea.preview.base, valea.preview.marginSections], [1, 1]);

// ── struggle: bidirectional from a single call ────────────────────────────
// margins under 3 so these read as "one section, each way" and nothing else
const win = applyCheck(strug, { result: 12, difficulty: 10 });
eq("struggle: passed check pushes players' pole", [win.preview.side, win.clock.value], ["players", 5]);
const loss = applyCheck(strug, { result: 9, difficulty: 10 });
eq("struggle: failed check pushes the GM's pole", [loss.preview.side, loss.clock.value], ["gm", 3]);
const solid = applyCheck(strug, { result: 13, difficulty: 10 });
eq("struggle: win by 3 → 2 sections up", [solid.preview.sections, solid.clock.value], [2, 6]);
const rout = applyCheck(strug, { result: 1, difficulty: 10 });
eq("struggle: fail by 9 → 3 sections to the GM", [rout.clock.value, rout.preview.sections], [1, 3]);

// ── applyCheck plumbing ───────────────────────────────────────────────────
const two = applyCheck(prog, { result: 16, difficulty: 10, cause: "picked the lock" });
eq("applyCheck: 1 base + 2 margin = 3", two.clock.value, 3);
eq("applyCheck: history records the cause", two.clock.history.at(-1).cause, "picked the lock");
eq("applyCheck: carries the preview for narration", two.preview.marginSections, 2);
eq("applyCheck: no-op when the clock is indifferent", applyCheck(prog, { result: 1, difficulty: 10 }).noop, true);
eq("applyCheck: input untouched", prog.value, 0);

const finish = applyCheck(nearlyDone, { result: 30, difficulty: 10 });
eq("applyCheck: filling resolves", [finish.clock.state, finish.resolution.outcome], ["resolved", "success"]);

// ── paired group: one check, two clocks, zero branching (RAW p.54) ────────
const groupSpec = { id: "g", mode: "paired" };
const primary = preset.progress({ id: "gp", name: "Ritual Disrupted", sections: 6, group: { ...groupSpec, role: "primary" } });
const failure = preset.threat({ id: "gf", name: "Rift Opens", sections: 4, group: { ...groupSpec, role: "failure" } });

let [rp, rf] = applyCheckToMany([primary, failure], { result: 15, difficulty: 10 });
eq("paired: success advances the primary only", [rp.clock.value, rf.clock.value], [2, 0]);
eq("paired: the failure clock no-ops on a pass", rf.noop, true);

[rp, rf] = applyCheckToMany([primary, failure], { result: 8, difficulty: 10 });
eq("paired: failure advances the failure clock only", [rp.clock.value, rf.clock.value], [0, 1]);
eq("paired: the primary no-ops on a fail", rp.noop, true);
eq("paired: a bad miss fills the failure clock faster",
  applyCheckToMany([primary, failure], { result: 3, difficulty: 10 })[1].clock.value, 3);

[rp, rf] = applyCheckToMany([primary, failure], { result: 1, difficulty: 10, isFumble: true, spendOpportunity: true });
eq("paired: fumbled opportunity feeds the failure clock (1+2+2=4 → full)", rf.clock.value, 4);
eq("paired: and that resolves it as a player failure", [rf.clock.state, rf.resolution.outcome], ["resolved", "failure"]);

// ── panel-click direction: GM works the AXIS, a player declares a GOAL ─────
const { directionForClick, playerGoalDirection } = M;

eq("GM: left fills, right erases — progress", [directionForClick(prog, "left", true), directionForClick(prog, "right", true)], ["high", "low"]);
eq("GM: left fills, right erases — teardown", [directionForClick(tear, "left", true), directionForClick(tear, "right", true)], ["high", "low"]);
eq("GM: struggle left goes right (high)", directionForClick(strug, "left", true), "high");

eq("player goal: progress is to fill", playerGoalDirection(prog), "high");
eq("player goal: teardown is to EMPTY", playerGoalDirection(tear), "low");
eq("player goal: threat is to keep it empty", playerGoalDirection(threat), "low");
eq("player goal: struggle is their own pole", playerGoalDirection(strug), "high");

eq("player: left fills a progress clock", directionForClick(prog, "left", false), "high");
eq("player: left ERASES a teardown clock (the reversal)", directionForClick(tear, "left", false), "low");
eq("player: right fills a teardown clock", directionForClick(tear, "right", false), "high");
eq("player: left erases a threat clock", directionForClick(threat, "left", false), "low");
eq("player: right fills a threat clock", directionForClick(threat, "right", false), "high");
eq("player: struggle left drives their pole", directionForClick(strug, "left", false), "high");

// ── previewRoll / applyRoll: intent decides direction, not the poles ───────
const { previewRoll, applyRoll } = CH;

// A progress clock ignores failures under applyCheck. Under a DIRECTED roll it
// still ignores them by default — but because the failure POLICY says so.
let r = applyRoll(prog, { direction: "high", result: 14, difficulty: 10 });
eq("roll: pass by 4 fills 2 sections", [r.clock.value, r.preview.sections], [2, 2]);
eq("roll: direction is the one declared", r.preview.direction, "high");

r = applyRoll(prog, { direction: "high", result: 4, difficulty: 10 });
eq("roll: failureMode none → nothing moves", r.noop, true);

// A player rolling to ERASE a progress clock: intent beats poles.
const filled = M.applyDelta(prog, { side: "players", sections: 4 }).clock;
r = applyRoll(filled, { direction: "low", result: 14, difficulty: 10 });
eq("roll: a passed ERASE moves the clock DOWN", [r.preview.from, r.clock.value], [4, 2]);

// failureMode: erase
const risky = preset.progress({ id: "rk", name: "Risky", sections: 6, failure: { mode: "erase", sections: 2 } });
const riskyMid = M.applyDelta(risky, { side: "players", sections: 4 }).clock;
r = applyRoll(riskyMid, { direction: "high", result: 3, difficulty: 10 });
eq("failureMode erase: a miss costs ground", [r.preview.direction, r.clock.value], ["low", 2]);
eq("failureMode erase: the cost is fixed, not margin-scaled", r.preview.sections, 2);
eq("failureMode erase: reported as a failure", r.preview.passed, false);

r = applyRoll(riskyMid, { direction: "low", result: 3, difficulty: 10 });
eq("failureMode erase flips whatever was intended", [r.preview.intended, r.preview.direction], ["low", "high"]);

// a miss that would push past a pole clamps, and can RESOLVE against the roller
const brink = M.applyDelta(preset.threat({ id: "bk", name: "Brink", sections: 4, failure: { mode: "erase", sections: 3 } }), { side: "gm", sections: 2 }).clock;
r = applyRoll(brink, { direction: "low", result: 1, difficulty: 10 });
eq("a punished miss can fill a threat clock to the top", r.clock.value, 4);
eq("...and resolve it as a player failure", [r.clock.state, r.resolution.outcome], ["resolved", "failure"]);

// opportunity still applies on a directed pass
r = applyRoll(prog, { direction: "high", result: 10, difficulty: 10, isCritical: true, spendOpportunity: true });
eq("roll: crit opportunity adds 2 on a pass", r.preview.sections, 3);
r = applyRoll(prog, { direction: "high", result: 10, difficulty: 10, isFumble: true, spendOpportunity: true });
eq("roll: a fumble's opportunity cannot be spent on a pass", r.preview.sections, 1);

eq("roll: a resolved clock ignores rolls", applyRoll({ ...prog, state: "resolved" }, { direction: "high", result: 20, difficulty: 10 }).noop, true);
eq("previewRoll writes nothing", (previewRoll(prog, { direction: "high", result: 20, difficulty: 10 }), prog.value), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
