// ============================================================================
// Animation run scope — a late oni:animationEnd from an earlier show must not
// resolve a later action's damage gate or end-watch.
//
//     node scripts/battle-director/anim-run-scope.test.mjs
//     SRC=<file> node ...   (lift the gate/watch from another copy, e.g. HEAD, to see RED)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
//     SCOPE=<file> node ...  (use another copy of anim-run-scope.js, e.g. the pre-fix one, to see RED)
import { pathToFileURL } from "node:url";
const scope = await import(process.env.SCOPE ? pathToFileURL(process.env.SCOPE).href : "./anim-run-scope.js");
const { beginAnimRun, endBelongsToRun, _resetAnimRuns } = scope;
const closeAnimRun = scope.closeAnimRun ?? (() => {});
const startBelongsToRun = scope.startBelongsToRun ?? endBelongsToRun;

const SRC = readFileSync(process.env.SRC ?? fileURLToPath(new URL("./director-animation.js", import.meta.url)), "utf8").split(String.fromCharCode(13)).join("");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL", n); } };

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  const end = SRC.indexOf("\n}\n", start);
  if (start < 0) throw new Error("not found " + name);
  return SRC.slice(start, end + 2);
}
function makeHooks() {
  const m = new Map();
  return {
    on: (n, h) => m.set(n, [...(m.get(n) ?? []), h]),
    off: (n, h) => m.set(n, (m.get(n) ?? []).filter((x) => x !== h)),
    callAll: (n, d) => { for (const h of [...(m.get(n) ?? [])]) h(d); },
  };
}
const Hooks = makeHooks();
const fns = new Function("Hooks", "endBelongsToRun", "beginAnimRun", "closeAnimRun", "startBelongsToRun",
  `${lift("waitForDamageMoment")}\n${lift("armAnimationEndWatch")}\nreturn { waitForDamageMoment, armAnimationEndWatch };`)(Hooks, endBelongsToRun, beginAnimRun, closeAnimRun, startBelongsToRun);
const tick = () => new Promise((r) => setTimeout(r, 5));
const state = (p) => { let s = false; p.then(() => { s = true; }); return () => s; };

// pure helper
_resetAnimRuns();
const A = beginAnimRun("actA"), B = beginAnimRun("actB");
ok("helper: own id matches", endBelongsToRun({ animRunId: B }, B));
ok("helper: stale id rejected", !endBelongsToRun({ animRunId: A }, B));
ok("helper: id-less ok for current", endBelongsToRun({}, B));
ok("helper: id-less rejected for superseded", !endBelongsToRun({}, A));

// (a) stale end from run A does not resolve run B's gate or watch
_resetAnimRuns();
const runA = beginAnimRun("actA");
const watchA = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000 });
const runB = watchA.runId === runA ? beginAnimRun("actB") : watchA.runId; // current code mints in arm; see below
const watchB = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000 });
const idB = watchB.runId ?? runB;
const gateB = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: idB }));
Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas", animRunId: runA });
await tick();
ok("(a) stale end does not resolve B's gate", !gateB());
ok("(a) stale end does not settle B's watch", !watchB.settled());
// (b) the matching end does
Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas", animRunId: idB });
await tick();
ok("(b) matching end resolves B's gate", gateB());
ok("(b) matching end settles B's watch", watchB.settled());

// (c) id-less end resolves the current run (legacy)
_resetAnimRuns();
const watchC = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000 });
const gateC = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: watchC.runId }));
Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas" });
await tick();
ok("(c) id-less end resolves current gate", gateC());
ok("(c) id-less end settles current watch", watchC.settled());

// (d) SAME caster, two open runs: a newer run claims the first id-less end (superseded rule);
//     once it settles, the older run is the newest open one and the next id-less end settles it
//     (one end settles one run — nothing waits on the failsafe).
_resetAnimRuns();
const watchD1 = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000 });
const gateD1 = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: watchD1.runId }));
const watchD2 = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000 });
Hooks.callAll("oni:animationEnd", {});
await tick();
ok("(d) id-less end ignored by the superseded (same-caster) gate", !gateD1());
ok("(d) id-less end ignored by the superseded (same-caster) watch", !watchD1.settled());
ok("(d) id-less end hits the newest same-caster watch", watchD2.settled());
Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas" });
await tick();
ok("(d) next id-less end settles the older run's gate", gateD1());
ok("(d) next id-less end settles the older run's watch", watchD1.settled());

// (g) NESTED run by ANOTHER caster minted while the outer's end is pending (timing_offset outer;
//     RESOLVE plays a crisis heal / card reaction / passive by someone else). The outer's
//     id-less end must still settle the outer — the 45 s failsafe regression.
{
  _resetAnimRuns();
  const outer = fns.armAnimationEndWatch("Scene.s.Token.hina", { timeoutMs: 60000 });
  const og = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: outer.runId, casterTokenUuid: "Scene.s.Token.hina" }));
  Hooks.callAll("oni:animationStart", { sourceTokenId: "hina" }); // legacy id-less start
  await tick();
  ok("(g) outer id-less start passes the offset gate", og());
  const nested = fns.armAnimationEndWatch("Scene.s.Token.keren", { timeoutMs: 60000 });
  const ng = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: nested.runId, casterTokenUuid: "Scene.s.Token.keren" }));
  // an id'd end of the nested run carrying the OUTER caster's source is still rejected by the outer
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "hina", animRunId: nested.runId });
  await tick();
  ok("(g) id'd mismatch rejected by the outer", !outer.settled());
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "hina", animRunId: "someone#99" });
  await tick();
  ok("(g) foreign id rejected by the outer", !outer.settled());
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "hina" }); // the outer's legacy id-less end
  await tick();
  ok("(g) outer's id-less end settles the outer while a nested other-caster run is open", outer.settled());
  ok("(g) ...and does not settle the nested watch", !nested.settled());
  ok("(g) ...nor the nested gate", !ng());
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "keren" });
  await tick();
  ok("(g) nested id-less end settles the nested watch", nested.settled());
  ok("(g) nested id-less end resolves the nested gate", ng());
}
{
  // (g2) nested other-caster run minted while the outer still waits for its offset start
  _resetAnimRuns();
  const outer = fns.armAnimationEndWatch("Scene.s.Token.hina", { timeoutMs: 60000 });
  const og = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: outer.runId, casterTokenUuid: "Scene.s.Token.hina" }));
  fns.armAnimationEndWatch("Scene.s.Token.keren", { timeoutMs: 60000 });
  Hooks.callAll("oni:animationStart", { sourceTokenId: "hina" });
  await tick();
  ok("(g2) outer id-less start still passes its gate with another caster's run open", og());
}
{
  // (g3) same caster, newer run: still supersedes (legacy rule) — also for starts
  _resetAnimRuns();
  const r1 = beginAnimRun("s1", "Scene.s.Token.cas");
  const g1 = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: r1 }));
  beginAnimRun("s2", "Scene.s.Token.cas");
  Hooks.callAll("oni:animationStart", { sourceTokenId: "cas" });
  await tick();
  ok("(g3) same-caster newer run supersedes an id-less start", !g1());
  ok("(g3) helper: other caster's newer run does not supersede", (() => {
    _resetAnimRuns();
    const a = beginAnimRun("a", "Scene.s.Token.x"); beginAnimRun("b", "Scene.s.Token.y");
    return endBelongsToRun({ sourceTokenId: "x" }, a) && !endBelongsToRun({ sourceTokenId: "y" }, a);
  })());
  ok("(g3) helper: id'd end never crosses runs", (() => {
    _resetAnimRuns();
    const a = beginAnimRun("a", "Scene.s.Token.x"); const b = beginAnimRun("b", "Scene.s.Token.y");
    return !endBelongsToRun({ sourceTokenId: "x", animRunId: b }, a) && !endBelongsToRun({ animRunId: a }, b);
  })());
  ok("(g3) helper: source-less id-less end -> newest open run of any caster", (() => {
    _resetAnimRuns();
    const a = beginAnimRun("a", "Scene.s.Token.x"); const b = beginAnimRun("b", "Scene.s.Token.y");
    const e = {};
    return endBelongsToRun(e, b) && !endBelongsToRun(e, a);
  })());
}

// (h) SAME caster, the outer ENDS while the nested show is still loading (armed, not started) —
//     measured on Staging (st-nested-anim-run-scope B): the end is the outer's, and the nested
//     show's own start must still reach the nested offset gate (no 35 s gate failsafe).
{
  _resetAnimRuns();
  const C = "Scene.s.Token.hina";
  const outer = fns.armAnimationEndWatch(C, { timeoutMs: 60000 });
  const og = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: outer.runId, casterTokenUuid: C }));
  Hooks.callAll("oni:animationStart", { sourceTokenId: "hina" });
  await tick();
  ok("(h) outer start passes the outer gate", og());
  const nested = fns.armAnimationEndWatch(C, { timeoutMs: 60000 });
  const ng = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: nested.runId, casterTokenUuid: C }));
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "hina" }); // outer's end, nested not started yet
  await tick();
  ok("(h) end before the nested start settles the OUTER", outer.settled());
  ok("(h) ...not the still-loading nested watch", !nested.settled());
  Hooks.callAll("oni:animationStart", { sourceTokenId: "hina" }); // nested show starts
  await tick();
  ok("(h) nested start reaches the nested offset gate", ng());
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "hina" });
  await tick();
  ok("(h) nested end settles the nested watch", nested.settled());
}
{
  // (h2) default-timing runs (no gate listens to starts): the watch still records the start, so an
  //      end that arrives before a newer same-caster run starts goes to the started one.
  _resetAnimRuns();
  const C = "Scene.s.Token.cas";
  const w1 = fns.armAnimationEndWatch(C, { timeoutMs: 60000 });
  Hooks.callAll("oni:animationStart", { sourceTokenId: "cas" });
  const w2 = fns.armAnimationEndWatch(C, { timeoutMs: 60000 });
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas" });
  await tick();
  ok("(h2) end goes to the started run (default timing)", w1.settled() && !w2.settled());
}


// (e) offset gate: scoped by run id on oni:animationStart
{
  _resetAnimRuns();
  const run1 = beginAnimRun("o1");
  const g1 = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: run1 }));
  Hooks.callAll("oni:animationStart", { animRunId: "someone-else#9" });
  await tick();
  ok("(e) start from another run does not trigger the offset gate", !g1());
  Hooks.callAll("oni:animationStart", { animRunId: run1 });
  await tick();
  ok("(e) matching start triggers the offset gate", g1());

  _resetAnimRuns();
  const run2 = beginAnimRun("o2");
  const g2 = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: run2 }));
  Hooks.callAll("oni:animationStart", {});
  await tick();
  ok("(e) id-less start triggers the CURRENT run's offset gate (legacy)", g2());

  _resetAnimRuns();
  const run3 = beginAnimRun("o3");
  const g3 = state(fns.waitForDamageMoment("timing_offset", 0, { timeoutMs: 60000, runId: run3 }));
  beginAnimRun("o4");
  Hooks.callAll("oni:animationStart", {});
  await tick();
  ok("(e) id-less start ignored by a superseded offset gate", !g3());
  Hooks.callAll("oni:animationStart", { animRunId: run3 }); // clean up
  await tick();
}

// (f) default gate: caster check (same sourceTokenId test as the watch)
{
  _resetAnimRuns();
  const run = beginAnimRun("f1");
  const g = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: run, casterTokenUuid: "Scene.s.Token.cas" }));
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "other" });
  await tick();
  ok("(f) id-less end from another caster ignored", !g());
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "other", animRunId: run });
  await tick();
  ok("(f) even a matching-run end from another caster is ignored (mirrors the watch)", !g());
  Hooks.callAll("oni:animationEnd", {});
  await tick();
  ok("(f) source-less (legacy) end accepted", g());

  _resetAnimRuns();
  const run2 = beginAnimRun("f2");
  const g2 = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: run2, casterTokenUuid: "Scene.s.Token.cas" }));
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas" });
  await tick();
  ok("(f) own caster's end resolves", g2());

  _resetAnimRuns();
  const run3 = beginAnimRun("f3");
  const g3 = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: run3 }));
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "anyone" });
  await tick();
  ok("(f) no caster known: not filtered", g3());
}

// (g) re-gate fixes
{
  // g1: after a run settles, a preview-style gate (no runId) resolves on an id-less end promptly
  _resetAnimRuns();
  const r0 = beginAnimRun("g0", "Scene.s.Token.cas");
  const w0 = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000, actionId: "g0" });
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas" });
  await w0.promise; await tick();
  ok("(g1) currentAnimRunId never returns a closed run", scope.currentAnimRunId() !== r0);
  const bench = state(fns.waitForDamageMoment("default", 0, { timeoutMs: 60000, runId: null }));
  Hooks.callAll("oni:animationEnd", {});
  await tick();
  ok("(g1) preview/bench gate resolves on an id-less end after a settled run", bench());

  // g2: a source-less outer end is not eaten by another caster's sourced nested run
  _resetAnimRuns();
  const outer = fns.armAnimationEndWatch("Scene.s.Token.A", { timeoutMs: 60000, actionId: "o" });
  Hooks.callAll("oni:animationStart", {});
  const nested = fns.armAnimationEndWatch("Scene.s.Token.B", { timeoutMs: 60000, actionId: "n" });
  Hooks.callAll("oni:animationStart", { sourceTokenId: "B" });
  Hooks.callAll("oni:animationEnd", {});
  await tick();
  ok("(g2) source-less end settles the source-less outer", outer.settled());
  ok("(g2) ...and not the sourced nested run", !nested.settled());
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "B" });
  await tick();
  ok("(g2) nested settles on its sourced end", nested.settled());

  // g3: two same-caster id-less ends in ONE synchronous turn settle two runs
  _resetAnimRuns();
  const a = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000, actionId: "a" });
  const b = fns.armAnimationEndWatch("Scene.s.Token.cas", { timeoutMs: 60000, actionId: "b" });
  Hooks.callAll("oni:animationStart", { sourceTokenId: "cas" });
  Hooks.callAll("oni:animationStart", { sourceTokenId: "cas" });
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas" });
  Hooks.callAll("oni:animationEnd", { sourceTokenId: "cas" });
  await tick();
  ok("(g3) both runs settle after two sync id-less ends", a.settled() && b.settled());
}

// wiring: the run id reaches the script payload and the default emitter
ok("wiring: payload.animRunId published", /animRunId,\n\s*\};/.test(SRC) || SRC.includes("animRunId,"));
ok("wiring: default script emits animRunId", readFileSync(fileURLToPath(new URL("./action-anim-script.js", import.meta.url)), "utf8").includes("animRunId: P?.animRunId"));
ok("wiring: default script emits animRunId on START too", /animationStart[^\n]*animRunId: P\?\.animRunId/.test(readFileSync(fileURLToPath(new URL("./action-anim-script.js", import.meta.url)), "utf8")));
ok("wiring: no currentAnimRunId fallback (preview unscoped)", !SRC.includes("runId ?? currentAnimRunId()"));
ok("wiring: gate gets casterTokenUuid", SRC.includes("runId: animRunId, casterTokenUuid"));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
