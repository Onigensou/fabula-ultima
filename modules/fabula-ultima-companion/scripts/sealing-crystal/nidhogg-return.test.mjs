// Node checks: Nidhogg's return clock (nidhogg-return.js) against the approved mockup (tools/nidhogg-return-mockup,
// v21, its default chips). The mockup page's own plan(3.6), read headless on 2026-11-15 (window.__nt.plan(3.6)):
//   { glassAt 0.9278729795241124, coreAt 2.1010392153191435, gone 3.6, black 6.2, p2 8.2, pierce 11.35,
//     clear 14.122982298692442, end 15.75 }
// and brk.doneAt = 2.7729822986924413 (fixtures/return-smoke.json, the page's own makeBreakSmoke).
// Run: node nidhogg-return.test.mjs
import fs from "node:fs";
import {
  RETURN_DEFAULTS, returnPlan, returnBeats, returnBeatList, returnState, camAt, glowAt, hudAt, shakeAt, closeK, frontAt, sAt,
  GL, ROAR, CLOSE, BURST, HUD, CAMF, AFTER, lateStartAt, LATE_MIN, returnSfx, returnBed,
} from "./nidhogg-return.js";
import { makeCueTrack, cueStart } from "../shared/sfx-cues.js";
import { bedVolume } from "./nidhogg-fall.js";
import { makeReturnSmoke } from "./return-smoke.js";
import { underFromRuns } from "./return-painter.js";

let pass = 0, fail = 0;
const ok = (c, m, got) => { if (c) pass++; else { fail++; console.log("FAIL", m, got === undefined ? "" : JSON.stringify(got)); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ── the defaults are the mockup's chips ──
ok(RETURN_DEFAULTS.len === 3.6 && RETURN_DEFAULTS.pause === 2 && RETURN_DEFAULTS.burstN === 220 && RETURN_DEFAULTS.smokeHz === 60 && RETURN_DEFAULTS.ringHz === 30, "defaults: len 3.6, pause 2, burst 220, smoke 60 fps (at most), rings 30", RETURN_DEFAULTS);

// ── the plan = the mockup page's plan(3.6) ──
const PAGE = { glassAt: 0.9278729795241124, coreAt: 2.1010392153191435, gone: 3.6, black: 6.2, p2: 8.2, pierce: 11.35, clear: 14.122982298692442, end: 15.75 };
const P = returnPlan();
for (const [k, v] of Object.entries(PAGE)) ok(near(P[k], v), `plan.${k} = the page's ${v}`, P[k]);
ok(near(P.pierce, 11.35), "pierce 11.35 s from the start with len 3.6 / pause 2");
ok(near(P.look, 11.35 + 1.6) && near(P.burst, 11.35 + 1.6 + 0.22), "the look at tau 1.6, the eye's burst 0.22 s into it", [P.look, P.burst]);

// ── doneAt: the default is the ported smoke's at the mockup's inputs ──
{
  const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/return-smoke.json", import.meta.url), "utf8")), I = FX.inputs;
  const brk = makeReturnSmoke(I.W, I.H, { cam: I.cam, at: I.at, src: I.src, seed: I.seed, body: I.body, under: underFromRuns(FX.underRLE, I.W * I.H), genW: I.genW });
  ok(brk.doneAt === RETURN_DEFAULTS.doneAt, "RETURN_DEFAULTS.doneAt = makeReturnSmoke(mockup inputs).doneAt", [brk.doneAt, RETURN_DEFAULTS.doneAt]);
  const Q = returnPlan({ doneAt: brk.doneAt });
  ok(near(Q.clear, PAGE.clear) && near(Q.end, PAGE.end), "the plan from that doneAt = the page's", Q);
}

// ── other chips move the beats as the page does ──
{
  const A = returnPlan({ len: 2.6, pause: 1 }), B = returnPlan({ len: 4.6, pause: 3 });
  ok(near(A.gone, 2.6) && near(A.black, 5.2) && near(A.p2, 6.2) && near(A.pierce, 9.35), "len 2.6 / pause 1", A);
  ok(near(B.pierce, 4.6 + 2.6 + 3 + 3.15), "len 4.6 / pause 3", B);
  ok(near(returnPlan({ doneAt: 4.5 }).end, 11.35 + 5.1), "a long smoke pushes the end (doneAt + 0.6)");
  ok(near(returnPlan({ doneAt: 1 }).end, 11.35 + 4.4), "a short smoke: the look sets the end (closeEnd + 0.6)");
}

// ── the beats the rules follow ──
const B = returnBeats(P);
ok(B.hidden === P.gone && B.reveal === P.pierce && B.end === P.end, "beats: hidden = gone (the core is gone), reveal = pierce (the roar)", B);
ok(B.hidden < B.reveal && B.reveal < B.end, "hidden before reveal before the end");

// ── the state, phase by phase ──
const at = (T) => returnState(T, P);
ok(at(0).phase === "close" && at(3.59).phase === "close" && at(3.6).phase === "light", "close until the core is gone, then its last light");
ok(at(6.2).phase === "black" && at(8.19).phase === "black" && at(8.2).phase === "glow", "black for the pause, then his glow");
ok(at(11.349).phase === "glow" && at(11.35).phase === "roar", "the roar at the pierce");
ok(at(P.look + 1e-9).phase === "look" && at(P.end - 0.01).phase === "after" && at(P.end).phase === "done", "the look, the tail, done", [at(P.look + 1e-9).phase, at(P.end - 0.01).phase]);
ok(!at(3.59).hidden && at(3.6).hidden && !at(11.34).revealed && at(11.35).revealed && !at(15.74).done && at(15.75).done, "hidden / revealed / done flags flip on the beats");
ok(at(1).close && at(3.6).close === null, "phase 1's close-in state until the core is gone");
ok(near(at(0).close.front, P.dmax) && near(frontAt(P.len, P.len), -0.07), "the front: from the farthest pixel to fully gone (-EDGE_CORE) at len");
ok(near(sAt(frontAt(1.3, 3.6)) * 3.6, 1.3, 1e-9), "sAt inverts frontAt");
ok(at(0).close.lastK === 0 && at(P.coreAt).close.lastK === 1, "the soul burns brighter from glassAt to coreAt");
ok(at(3.6 - AFTER.lead + 1e-9).glintU !== null && at(3.6 - AFTER.lead - 0.01).glintU === null && at(3.6 + 2.59).glintU !== null && at(6.2).glintU === null, "the star lives [gone - 0.45, gone + 2.6)");
ok(at(11.35).smoke && !at(11.34).smoke && at(P.clear + 0.59).smoke && !at(P.clear + 0.6).smoke, "the smoke [pierce, clear + 0.6)");
ok(at(8.19).glow === null && at(8.2).glow.eyes === 0 && at(8.2 + GL.unveil).glow.eyes > 0.99, "the glow comes up out of nothing over the unveil", at(8.2 + GL.unveil).glow);
{
  const g = at(11.3).glow, h = at(11.36).glow;
  ok(g.mouth > g.eyes, "the wind-up: the mouth burns brightest", g);
  ok(h.mouth > g.mouth * 0.9, "the roar's burst of light", [g.mouth, h.mouth]);
  ok(at(11.35 + 0.36).glow.mouth === 0, "the glow gone once he is uncovered (tau 0.35)");
}
ok(at(11.36).rings && !at(11.35 + ROAR.rings * ROAR.every + ROAR.life + 0.01).rings, "the rings while the roar lasts");
ok(near(at(11.35).flash, 0) && at(11.4).flash > 0 && at(11.55).flash === 0, "the break's flash: 0.2 s");
ok(near(at(P.look + 1e-12).lookU, 0, 1e-9) && near(at(P.look + CLOSE.up).look, 1) && at(P.look + CLOSE.up + CLOSE.hold + CLOSE.down + 0.01).lookU === null, "the look: up 0.4 / hold 1.0 / down 0.8");
ok(near(at(P.look + BURST.t).burstF, 0), "the eye bursts 0.22 s into the look");
ok(closeK(-0.1) === 0 && closeK(1) === 1, "closeK");

// ── the HUD: out over 0.3 s, back over the last 0.5 s ──
ok(hudAt(0, P) === 1 && near(hudAt(HUD.out, P), 0) && hudAt(8, P) === 0 && near(hudAt(P.end - HUD.back, P), 0) && near(hudAt(P.end, P), 1), "HUD 1 -> 0 by 0.3 s, back 0.5 s before the end", [hudAt(0.15, P), hudAt(P.end - 0.25, P)]);

// ── the camera ──
{
  const c0 = camAt(6.2, P), c1 = camAt(8.6, P), c2 = camAt(11.349, P), c3 = camAt(11.35 + CAMF.out, P), c4 = camAt(11.35 + CAMF.back, P);
  ok(c0.s === 1 && c0.k === 0, "no camera move before the black + 0.2", c0);
  ok(near(c1.s, CAMF.s) && near(c1.k, 1), "pushed in 2.0x on his face by p2 + 0.4", c1);
  ok(near(c2.s, CAMF.creep, 1e-3), "crept to 2.12x by the roar", c2);
  ok(near(c3.s, CAMF.wide) && near(c3.k, 0), "pulled back to 0.92x in 0.5 s", c3);
  ok(c4.s === 1 && c4.k === 0, "back on the battle camera by tau 1.5", c4);
  ok(camAt(3, P).s === 1, "phase 1: the battle camera");
}

// ── the shake: a rumble in the wind-up, 7 px at the roar, eased off ──
ok(shakeAt(8, P).amp === 0 && near(shakeAt(8.2 + GL.windup - 0.001, P).amp, 1.6, 1e-3) && shakeAt(11.4, P).amp === 7 && shakeAt(11.35 + 0.15 + ROAR.len + 0.3, P).amp === 0, "shake");

// ── the caption list is the mockup's beat list ──
{
  const L = returnBeatList(P);
  ok(L.length === 16 && L[0][0] === 0 && L.at(-1)[1] === "His eye bursts into flame", "16 beats, as the page (camera + look on)", L.length);
  ok(L.every(([t], i) => i === 0 || t >= L[i - 1][0] - 1e-9 || L[i - 1][1].startsWith("The arena")), "in order (the page lists the look after the clear)");
}

// ── a late start (WP7): the second it starts at, from the GM's start and now (server ms) ──
{
  const t0 = 1_700_000_000_000;
  ok(lateStartAt(t0, t0, P) === 0 && near(lateStartAt(t0, t0 + 9500, P), 9.5), "late start = (now - start) s", lateStartAt(t0, t0 + 9500, P));
  ok(lateStartAt(t0, t0 - 800, P) === 0, "a start in the future (clock skew) = 0");
  ok(lateStartAt(undefined, t0, P) === 0 && lateStartAt(0, t0, P) === 0, "no start = 0 (an old spec)");
  ok(near(lateStartAt(t0, t0 + (P.end - LATE_MIN - 0.01) * 1000, P), P.end - LATE_MIN - 0.01, 1e-6) && lateStartAt(t0, t0 + (P.end - LATE_MIN) * 1000, P) === null && lateStartAt(t0, t0 + 60000, P) === null, "nothing left to show in its last LATE_MIN s / after the end = null");
  const s = returnState(lateStartAt(t0, t0 + 9500, P), P);
  ok(s.phase === returnState(9.5, P).phase && s.hud === 0, "a late start lands on that second's phase, the HUD hidden", [s.phase, s.hud]);
}

// ── the sound: the user's picks in the mockup's audition (v23, db picks/current, 2026-11-16) — only these four ──
{
  const S = returnSfx(P), by = Object.fromEntries(S.map((c) => [c.file, c]));
  ok(S.length === 3, "three one-shots (every other moment silent, as picked)", S.map((c) => c.file));
  ok(near(by["Soundboard/Monster4.ogg"]?.beat, P.pierce) && by["Soundboard/Monster4.ogg"].vol === 0.75, "the roar (Monster4, 0.75) on the pierce", by["Soundboard/Monster4.ogg"]);
  ok(near(by["Soundboard/Darkness3.ogg"]?.beat, P.look) && by["Soundboard/Darkness3.ogg"].vol === 0.45, "his look (Darkness3, 0.45)", by["Soundboard/Darkness3.ogg"]);
  ok(near(by["Soundboard/Fire1.ogg"]?.beat, P.burst) && by["Soundboard/Fire1.ogg"].vol === 0.55, "the eye's burst (Fire1, 0.55)", by["Soundboard/Fire1.ogg"]);
  // the loudest moment lands on the beat: start = beat - peak (peaks measured by the mockup's sfx-fetch)
  ok(near(cueStart(by["Soundboard/Monster4.ogg"]), P.pierce - 0.15) && near(cueStart(by["Soundboard/Fire1.ogg"]), P.burst - 0.35), "starts = beat - peak");
  const B = returnBed(P);
  ok(B.file === "BGS/Darkness.ogg" && B.vol === 0.45 && near(B.from, 0.02) && near(B.to, P.gone), "the bed: BGS/Darkness 0.45 while the dark closes in (0.02 .. gone)", B);
  ok(bedVolume(B, 0) === 0 && near(bedVolume(B, 1.5), 0.45) && bedVolume(B, P.gone) === 0 && bedVolume(B, P.gone - 0.6) < 0.45, "bed: fades in, full, fades out by the core's end");
  // played from 0 at 60 fps: each fires once, at its start; a late start (9.5 s) fires nothing it jumped past
  const fired = [], tr = makeCueTrack(S);
  for (let t = 0; t <= P.end; t += 1 / 60) tr.step(t, (c) => fired.push([c.file, +t.toFixed(3)]));
  ok(fired.length === 3 && fired.every(([f, t]) => Math.abs(t - cueStart(by[f])) < 1 / 60 + 1e-9), "from 0: three cues, each within a frame of its start", fired);
  const late = [], tr2 = makeCueTrack(S);
  for (let t = 12.5; t <= P.end; t += 1 / 60) tr2.step(t, (c) => late.push(c.file));
  ok(JSON.stringify(late) === JSON.stringify(["Soundboard/Darkness3.ogg", "Soundboard/Fire1.ogg"]), "a late start at 12.5 s: no roar (jumped past), the look + burst still play", late);
}

console.log(`${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
