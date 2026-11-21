// Node checks for Nidhogg's return, WP5 (return-look.js, pure): the camera's view frames the screen as the mockup's
// flat camera does; his look's glow, its dark and the eye's burst are the mockup's own.
//   node modules/fabula-ultima-companion/scripts/sealing-crystal/return-look.test.mjs
//
// The mockup's own code (camAt, eyeBurst, the closing beat's numbers) is read from
// tools/nidhogg-return-mockup/work/script.js and run here on the same painter library, so a change to either side shows.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { returnView, screenOf, lookGlow, DIM, dimAlpha, dimPixels, LOOK_FRAME, lookFrameAt, IG, EMB, eyeBurst, floorPoints, fitFloor, shiftOf, rectMap, frameMatrix, mapPoint, unmapPoint } from "./return-look.js";
import { returnPlan, camAt, CAMF, CLOSE, BURST, closeK, throb } from "./nidhogg-return.js";
import { CROP, frameOn, STAGE, returnStage, spriteFrame } from "./return-stage.js";
import { createFrame, clearFrame, painterFor, Rng } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { firePuff, ember } from "../battle-director/pixel-entrance/pixelfx/fx/fire/_lib.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = fs.readFileSync(ROOT + "tools/nidhogg-return-mockup/work/script.js", "utf8");
function mockupSource(start) {
  const i = SRC.indexOf(start);
  if (i < 0) throw new Error("mockup: " + start + " not found");
  let j = SRC.indexOf("{", i), depth = 0;
  for (; j < SRC.length; j++) { if (SRC[j] === "{") depth++; else if (SRC[j] === "}" && --depth === 0) break; }
  return SRC.slice(i, j + 1);
}
const objOf = (start) => new Function("return (" + mockupSource(start).replace(/^const \w+ = /, "") + ")")();

// ── 1. the camera: the game's view puts every point where the mockup's flat camera puts it ──
{
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const smoothV = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };
  const CC = { x: CROP.w / 2, y: CROP.h / 2 };
  const CAMF_M = new Function("CROP", "return (" + mockupSource("const CAMF = {").replace("const CAMF = ", "") + ")")(CROP);
  ok(CAMF_M.face.x === CAMF.face.x && CAMF_M.face.y === CAMF.face.y && CAMF_M.s === CAMF.s && CAMF_M.creep === CAMF.creep && CAMF_M.wide === CAMF.wide
    && CAMF_M.out === CAMF.out && CAMF_M.back === CAMF.back && near(CAMF_M.at.x, CAMF.at.fx * CROP.w) && near(CAMF_M.at.y, CAMF.at.fy * CROP.h), "the clock's CAMF = the mockup's");
  const camAtM = new Function("st", "CC", "CAMF", "clamp", "smoothV", "return " + mockupSource("function camAt(T, P)"))({ cam: true }, CC, CAMF_M, clamp, smoothV);
  const P = returnPlan();
  // the mockup's frame on the Great Seal, rest view on a 1920 x 1080 window with no sidebar (r = 1920 / 1682) and with
  // a 300 px sidebar (the rest view shifted right by 150 / r scene px; the mockup's screen = the visible rect)
  const F = frameOn(STAGE), r = 1920 / STAGE.w, stageC = { x: F.x + CROP.w / 2, y: F.y + CROP.h / 2 };
  // (the mockup's screen middle is 0.06 px off the stage's: its crop height is rounded to 946)
  ok(near(F.k, 1) && near(stageC.x, STAGE.x + STAGE.w / 2) && near(stageC.y, STAGE.y + STAGE.h / 2, 0.1), "the frame's middle = the stage's middle");
  for (const shift of [0, 150]) {
    const rest = { x: stageC.x + shift / r, y: stageC.y, scale: r };
    let worst = 0, n = 0;
    for (let T = P.black - 0.5; T <= P.pierce + CAMF.back + 0.3; T += 0.05) {
      const cm = camAtM(T, P), cg = camAt(T, P);
      ok(near(cm.s, cg.s, 1e-12), `camAt s at ${T.toFixed(2)}`);
      const v = returnView(cg, { rest, F, face: { x: F.x + CAMF.face.x, y: F.y + CAMF.face.y } });
      for (const q of [{ x: 0, y: 0 }, { x: CAMF.face.x, y: CAMF.face.y }, { x: CROP.w, y: CROP.h }, { x: 300, y: 700 }]) {
        // the mockup: screen = (q - A) s + P (mockup px from its top-left), drawn at r screen px per mockup px; the game:
        // (Q - pivot) scale from the window's middle; the visible middle sits `shift` px left of the window's
        const ms = { x: ((q.x - cm.ax) * cm.s + cm.px - CC.x) * r, y: ((q.y - cm.ay) * cm.s + cm.py - CC.y) * r };
        const gs = screenOf({ x: F.x + q.x, y: F.y + q.y }, v);
        worst = Math.max(worst, Math.hypot(gs.x + shift - ms.x, gs.y - ms.y)); n++;
      }
    }
    ok(worst < 1e-6, `the game's view = the mockup's camera on screen (sidebar ${shift * 2} px; ${n} points, worst ${worst.toExponential(1)} px)`);
    const r0 = returnView({ s: 1, k: 0 }, { rest, F, face: { x: 1, y: 2 } });
    ok(r0.x === rest.x && r0.y === rest.y && r0.scale === rest.scale, "k 0, s 1: the rest view exactly");
  }
  // pushed in: his head (wherever he stands) at 0.42 of the visible width, mid-height, 2x
  const rest = { x: stageC.x, y: stageC.y, scale: r }, face = { x: 650, y: 610 };
  const v = returnView({ s: 2, k: 1 }, { rest, F, face }), f = screenOf(face, v);
  ok(near(f.x, (0.42 - 0.5) * 1920, 1e-6) && near(f.y, 0, 1e-6) && near(v.scale, 2 * r), `pushed in: his head at 0.42 W (${(f.x / 1920 + 0.5).toFixed(4)}), mid-height, 2x`);
}

// ── 2. his head: the mockup's CAMF.face on his sprite, laid where he is drawn ──
{
  const sprite = { width: 859, height: 837, data: new Uint8ClampedArray(859 * 837 * 4) };
  const st = returnStage(sprite);
  ok(near(st.face.x, CAMF.face.x, 1e-9) && near(st.face.y, CAMF.face.y, 1e-9), `at the mockup's spot his head is CAMF.face (${st.face.x.toFixed(3)}, ${st.face.y.toFixed(3)})`);
  const S0 = spriteFrame(859, 837), R = { x: S0.x - 157, y: S0.y + 20, w: S0.w * 0.983, h: S0.h * 0.983 };
  const s2 = returnStage(sprite, R, 1);
  ok(near(s2.face.x, R.x + R.w - s2.faceUV.u * (R.w / 859), 1e-9) && near(s2.face.y, R.y + s2.faceUV.v * (R.h / 837), 1e-9), "moved and scaled with his sprite");
  ok(s2.faceUV.u > 100 && s2.faceUV.u < 250 && s2.faceUV.v > 400 && s2.faceUV.v < 560, `his head in his sprite: (${s2.faceUV.u.toFixed(1)}, ${s2.faceUV.v.toFixed(1)}) near his eye (154, 477)`);
}

// ── 3. his look: the glow, the throb, the dark ──
{
  const C_M = objOf("const CLOSE = {"), B_M = objOf("const BURST = {");
  ok(["at", "up", "hold", "down", "dim"].every((k) => C_M[k] === CLOSE[k]) && ["t", "emit", "smoulder"].every((k) => B_M[k] === BURST[k]), "the clock's CLOSE / BURST = the mockup's");
  const cap = (a) => (a <= 0.004 ? 0 : Math.min(1, a));
  let bad = 0;
  for (let u = -0.1; u <= 2.4; u += 0.01) {
    const S = closeK(u), b = throb(u), g = lookGlow(S, b);
    const want = { eyes: [cap(0.85 * S * b), cap(0.6 * S * b), cap(S)], mouth: [cap(0.4 * S * b), 0, cap(0.65 * S)] };
    for (const k of ["eyes", "mouth"]) for (let i = 0; i < 3; i++) if (!near(g[k][i], want[k][i], 1e-12)) bad++;
    if (g.claws.some((v) => v !== 0)) bad++;
  }
  ok(bad === 0, `lookGlow = the mockup's drawClosing strengths (${bad} off)`);
  const g = lookGlow(1, throb(CLOSE.up + 0.15));
  ok(g.eyes[0] === 1 && g.eyes[1] > 0.6 && g.mouth[0] > 0.4, "the throb lifts the halos (capped at 1)");
  // the dark: the mockup's canvas gradient (inner circle r0 clear, stops 0 / 0.3 / 1 at 0 / 0.62 dim / dim)
  ok(near(DIM.r1, Math.hypot(CROP.w, CROP.h) * 0.6) && DIM.r0 === 90, "the dark's radii = the mockup's (90, 0.6 x the screen's diagonal)");
  const grad = (r, S) => { const t = (r - 90) / (DIM.r1 - 90); const a = t <= 0 ? 0 : t < 0.3 ? 0.62 * CLOSE.dim * S * (t / 0.3) : t < 1 ? 0.62 * CLOSE.dim * S + (CLOSE.dim * S - 0.62 * CLOSE.dim * S) * ((t - 0.3) / 0.7) : CLOSE.dim * S; return a; };
  let worst = 0;
  for (let r = 0; r < 2500; r += 7) for (const S of [0.3, 1]) worst = Math.max(worst, Math.abs(dimAlpha(r, S) - grad(r, S)));
  ok(worst < 1e-12, `dimAlpha = the mockup's gradient (worst ${worst})`);
  const N = 128, d = dimPixels(N);
  ok(d[((N / 2) * N + N / 2) * 4 + 3] === 0 && d[3] === 255 && d[((N / 2) * N + N - 1) * 4 + 3] === 255 && d.every((v, i) => i % 4 === 3 || v === 0), "the texture: clear at his head, full at its edge, black");
  const mid = Math.round(N / 2 + (90 + 0.3 * (DIM.r1 - 90)) / (2 * DIM.r1) * (N / 2));
  ok(Math.abs(d[((N / 2) * N + mid) * 4 + 3] - 0.62 * 255) < 8, `0.3 of the way out: 0.62 of the dark (${d[((N / 2) * N + mid) * 4 + 3]})`);
}

// ── 4. the eye's burst = the mockup's eyeBurst, pixel for pixel; mirrored it flies the other way ──
{
  const sprite = { width: 859, height: 837, data: new Uint8ClampedArray(859 * 837 * 4) };
  const st = returnStage(sprite), EYE = st.eye;
  const eF = createFrame(LOOK_FRAME.W, LOOK_FRAME.H, Math.round(EYE.x) - 140, Math.round(EYE.y) - 105);
  const o = lookFrameAt(EYE, 1);
  ok(o.ox === eF.ox && o.oy === eF.oy, `the frame round his eye = the mockup's (${o.ox}, ${o.oy})`);
  const mine = createFrame(LOOK_FRAME.W, LOOK_FRAME.H, o.ox, o.oy);
  const eyeBurstM = new Function("Rng", "firePuff", "ember", "st", "BURST", "EYE", "IG", "EMB",
    "return " + mockupSource("function eyeBurst(p, u)"))(Rng, firePuff, ember, { burstN: 220 }, objOf("const BURST = {"), EYE, IG, EMB);
  let frames = 0, bad = 0, lit = 0;
  for (let i = 0; i <= 70; i++) {
    const u = i / 30;
    clearFrame(eF); eyeBurstM(painterFor(eF), u);
    clearFrame(mine); eyeBurst(painterFor(mine), u, EYE, 220, 1);
    frames++;
    for (let p = 0; p < eF.color.length; p++) { if (eF.color[p] !== mine.color[p] || eF.light[p] !== mine.light[p]) bad++; if (mine.color[p]) lit++; }
  }
  ok(bad === 0 && lit > 1000, `eyeBurst = the mockup's (${frames} frames, ${lit} lit px, ${bad} differ)`);
  // the ramp: the mockup's colours
  const hexes = /const IG = \[([^\]]+)\]/.exec(SRC)[1].match(/#[0-9a-f]{6}/gi);
  ok(hexes.length === IG.length, "the burst's ramp has the mockup's 9 colours");
  // nothing painted outside the frame (a frame 3x as big round it holds nothing more), both facings
  for (const fs of [1, -1]) {
    const o2 = lookFrameAt(EYE, fs), big = createFrame(LOOK_FRAME.W * 3, LOOK_FRAME.H * 3, o2.ox - LOOK_FRAME.W, o2.oy - LOOK_FRAME.H);
    let out = 0, cx = 0, n = 0;
    for (let i = 0; i <= 70; i++) {
      clearFrame(big); eyeBurst(painterFor(big), i / 30, EYE, 220, fs);
      for (let y = 0; y < big.h; y++) for (let x = 0; x < big.w; x++) {
        const p = y * big.w + x;
        if (!big.color[p]) continue;
        const inF = x >= LOOK_FRAME.W && x < 2 * LOOK_FRAME.W && y >= LOOK_FRAME.H && y < 2 * LOOK_FRAME.H;
        if (!inF) out++;
        cx += x + big.ox - EYE.x; n++;
      }
    }
    ok(out < n * 0.002, `facing ${fs}: the burst stays in its frame (${out} of ${n} px out)`);
    ok(fs * (cx / n) < -10, `facing ${fs}: flung back, away from the party (mean dx ${(cx / n).toFixed(1)} effect px)`);
  }
  ok(eyeBurst(painterFor(mine), BURST.t - 0.01, EYE) === false && eyeBurst(painterFor(mine), BURST.t + 2.01, EYE) === false, "nothing before the burst or after it");
}

// ── WP5b: the smoke's frame laid on the 3D floor (fitFloor & co) ──
{
  const stage = { x: 439, y: 241, w: 1682, h: 788 }, feet = { x: 900, y: 860 };
  const pts = floorPoints(stage, feet);
  ok(pts.length === 26 && pts[0].x === feet.x && pts[0].y === feet.y, "floor points: his feet first, then a 5 x 5 grid");
  ok(pts.slice(1).every((q) => q.y >= stage.y + 0.6 * stage.h - 1e-9 && q.y <= stage.y + stage.h + 1e-9), "the grid lies on the floor rows (0.6 .. 1 of the stage)");
  // an affine is recovered exactly
  const A = { a: 1.04, b: 0.012, c: -0.03, d: 0.97, tx: 13.5, ty: -21.25 };
  const fit = fitFloor(pts, pts.map((q) => mapPoint(A, q)));
  ok(fit && ["a", "b", "c", "d", "tx", "ty"].every((k) => near(fit[k], A[k], 1e-9)), "an affine floor is fitted exactly");
  // a perspective floor (a homography): exact at his feet, best-fit elsewhere, far better than riding his feet alone
  const H = (q) => { const w = 1 + 1.2e-5 * (q.y - 600) + 2e-6 * (q.x - 1280); return { x: (1.02 * q.x + 0.01 * q.y + 4) / w, y: (0.99 * q.y - 3) / w }; };
  const dst = pts.map(H), fp = fitFloor(pts, dst), m0 = mapPoint(fp, feet);
  ok(near(m0.x, dst[0].x, 1e-9) && near(m0.y, dst[0].y, 1e-9), "exact at his feet");
  const errFit = Math.max(...pts.map((q, i) => Math.hypot(mapPoint(fp, q).x - dst[i].x, mapPoint(fp, q).y - dst[i].y)));
  const sh = shiftOf(dst[0].x - feet.x, dst[0].y - feet.y);
  const errShift = Math.max(...pts.map((q, i) => Math.hypot(mapPoint(sh, q).x - dst[i].x, mapPoint(sh, q).y - dst[i].y)));
  ok(errFit < errShift / 4, `perspective floor: the fit (${errFit.toFixed(2)} px) beats the feet-only shift (${errShift.toFixed(2)} px)`);
  // missing / degenerate points: no fit (the show keeps the shift)
  ok(fitFloor(pts, pts.map((q, i) => (i === 3 ? null : q))) === null, "a point the camera cannot project: no fit");
  ok(fitFloor([feet, { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }].map((q, i) => (i ? { x: feet.x + q.x, y: feet.y + q.y } : q)), [feet, feet, feet, feet]) === null, "collinear points: no fit");
  // the flat path is the old placement exactly (the frame at F + his rect's shift, scale F.k)
  const F = { x: 439, y: 241, k: 1.25 }, R0 = { x: -5, y: 34.3, w: 813, h: 792 }, R = { x: -2, y: 31.3, w: 813, h: 792 };
  const M = frameMatrix(shiftOf(R.x - R0.x, R.y - R0.y), F);
  ok(M.a === F.k && M.d === F.k && M.b === 0 && M.c === 0 && near(M.tx, F.x + 3) && near(M.ty, F.y - 3), "flat: position F + shift, scale F.k (unchanged)");
  // his own layers ride his sprite: a point laid on R0 lands on the same point of R
  const R2 = { x: 10, y: 50, w: 813 * 1.05, h: 792 * 1.05 }, rm = rectMap(R0, R2), q = { x: R0.x + 300, y: R0.y + 200 }, qm = mapPoint(rm, q);
  ok(near(qm.x, R2.x + 300 * 1.05) && near(qm.y, R2.y + 200 * 1.05), "rectMap: his sprite's point onto his drawn sprite");
  // frameMatrix = A after the frame; unmapPoint inverts
  const u = { x: 123.4, y: 56.7 }, Mf = frameMatrix(A, F), viaM = mapPoint(Mf, u), viaA = mapPoint(A, { x: F.x + F.k * u.x, y: F.y + F.k * u.y });
  ok(near(viaM.x, viaA.x, 1e-9) && near(viaM.y, viaA.y, 1e-9), "frameMatrix = the affine after the frame");
  const back = unmapPoint(Mf, viaM);
  ok(near(back.x, u.x, 1e-9) && near(back.y, u.y, 1e-9) && unmapPoint({ a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 }, u) === null, "unmapPoint inverts (null when singular)");
}

console.log(`${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
