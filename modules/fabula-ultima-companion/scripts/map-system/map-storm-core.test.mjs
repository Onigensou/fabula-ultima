// ============================================================================
// Map storm: pure-half harness.
//
//     node scripts/map-system/map-storm-core.test.mjs
//
// Bare Node, no Foundry. The load-bearing cases: no flag / no zones = no storm,
// "below" never draws bolts or clips, timings stay inside their ranges.
// ============================================================================

import { readStormConfig, nextDelayMs, pickStrike, patternFor, levelAt, patternLength, makeBolt, thunderFor, DEFAULT_SOUNDS } from "./map-storm-core.js";

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log("FAIL", label); } };
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

// off cases
ok("no flag", readStormConfig(undefined) === null);
ok("not an object", readStormConfig("storm") === null);
ok("disabled", readStormConfig({ enabled: false, zones: [{ x: [0, 1], y: [0, 1] }] }) === null);
ok("no zones", readStormConfig({ mode: "above" }) === null);
ok("bad zones only", readStormConfig({ zones: [{ x: [0], y: "a" }] }) === null);

// above
const solid = [[0, 0], [100, 0], [100, 100]];
const A = readStormConfig({ mode: "above", zones: [{ x: [20, 250], y: [380, 640] }, { x: [20, 200], y: [1050, 1400], sheet: true, far: 0.7 }], solid });
ok("above mode", A.mode === "above");
ok("above defaults every", A.every[0] === 6 && A.every[1] === 14);
ok("above keeps solid", A.solid.length === 3);
ok("above default sounds", A.sounds === DEFAULT_SOUNDS && A.sounds.length === 5);
ok("above zone sheet flag", A.zones[0].sheet === false && A.zones[1].sheet === true);
ok("above far floor", readStormConfig({ zones: [{ x: [0, 1], y: [0, 1], far: 0 }] }).zones[0].far === 0.3);
ok("reversed pair sorted", readStormConfig({ zones: [{ x: [9, 1], y: [5, 2] }] }).zones[0].x[0] === 1);

// below
const B = readStormConfig({ mode: "below", zones: [{ x: [250, 650], y: [1150, 1350] }], solid });
ok("below drops solid", B.solid === null);
ok("below zones are sheet", B.zones[0].sheet === true);
ok("below quieter", B.volume < A.volume && B.rate[1] < A.rate[0]);
ok("below flash softer", B.flash < A.flash);

// timing
ok("delay lo", nextDelayMs(A, () => 0) === 6000);
ok("delay hi", nextDelayMs(A, () => 0.999999) <= 14000 && nextDelayMs(A, () => 0.999999) > 13900);
ok("every min 1 s", readStormConfig({ every: [0, 0], zones: [{ x: [0, 1], y: [0, 1] }] }).every[0] === 1);

// strikes land inside their zone
for (let i = 0; i < 200; i++) {
  const s = pickStrike(A);
  const z = A.zones.find((q) => s.x >= q.x[0] && s.x <= q.x[1] && s.y >= q.y[0] && s.y <= q.y[1]);
  if (!z) { ok("strike in a zone", false); break; }
}
ok("strike rand=1 stays in range", (() => { const s = pickStrike(A, () => 0.9999999); return s.x <= 200 && s.y <= 1400; })());

// patterns
const bolt = patternFor(A, { sheet: false }), sheet = patternFor(A, { sheet: true }), below = patternFor(B, { sheet: true });
ok("bolt peaks at 1", levelAt(bolt, 0) === 1);
ok("between keys interpolates", Math.abs(levelAt(bolt, 30) - 0.625) < 1e-9);
ok("after end is 0", levelAt(bolt, patternLength(bolt) + 1) === 0);
ok("sheet softer", levelAt(sheet, 0) < levelAt(bolt, 0));
ok("below differs", below !== sheet && patternLength(below) === 400);

// bolt geometry
const bl = makeBolt(100, 500, seq(0.5, 0.1, 0.9, 0.3, 0.7));
ok("bolt starts above the map", bl.main[0][1] < 0);
ok("bolt ends at its y", bl.main[bl.main.length - 1][1] === 500);
ok("bolt descends", bl.main.every((p, i) => i === 0 || p[1] >= bl.main[i - 1][1]));

// thunder
const tn = thunderFor(A, { sheet: false, far: 1 }, () => 0);
ok("thunder near delay", tn.delayMs === 300 && tn.volume === A.volume && tn.src === A.sounds[0]);
const tf = thunderFor(A, { sheet: true, far: 2 }, () => 1);
ok("sheet thunder later + quieter", tf.delayMs === 900 + 1300 * 2 && tf.volume < A.volume);
ok("below thunder pitched down", thunderFor(B, { sheet: true, far: 1 }, () => 0.5).rate < 0.8);

console.log(`map-storm-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
