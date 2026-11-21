// Node checks: Nidhogg's battle opening, beats 1-2 (the leak, his eyes) — the plan, the frame grid, the leak and the
// eyes against the mockup v3 they were ported from (pixel for pixel, when tools/nidhogg-opening-mockup/ is on this
// machine), the Worker protocol, the crackOut seam's numbers and the painter's cost. Run: node crack-out.test.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CRACK_OUT_LOOK, crackOutPlan, crackOutPhase, paintsAt, eyesAt, effectGrid, strokesFromCracks, boxOf, makeCrackOutPainter, leakBands, LEAK_WARM_TS,
  EYES_MS, LEAK_MS, CRACK_OUT_MS, READY_WAIT_MS, FALLBACK_FADE_MS,
} from "./crack-out-painter.js";
import { makeLeak } from "./crack-out-leak.js";
import { EYE_T, EYES_DARK, EYES_END } from "./crack-out-eyes.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL", m); } else console.log("ok  ", m); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, "../../../../tools/nidhogg-opening-mockup");

// ── the plan (the mockup's timeline on the crack-out's clock, the user's picks) ──
const P = crackOutPlan();
ok(CRACK_OUT_LOOK.seeds === 5 && CRACK_OUT_LOOK.dur === 3.6, "the user's picks: 5 first points, 3.6 s to black");
ok(near(P.leak, 0.15), "the first leak 0.15 s after the break (the mockup: 0.75 s after the impact; the break is 0.6 s after it)");
ok(near(P.black - P.leak, 3.6) && near(P.allBlack, P.black + 0.02), "black 3.6 s after the first leak; beat 1 over 0.02 s later (as the mockup)");
ok(near(P.eyes, P.black + 1.0) && near(P.dark, P.eyes + EYES_DARK) && near(P.eyesEnd, P.eyes + EYES_END), "eyes 1.0 s after black, dark EYES_DARK (3.55 s) after the eyes (as the mockup's plan)");
ok(near(EYES_DARK, 3.55) && EYE_T.open === 0.4 && EYE_T.hold === 1.35 && EYE_T.recede === 1.8, "the eyes' beat: open 0.4, hold 1.35, recede 1.8 (= 3.55 s)");
ok(crackOutPhase(0, P) === "hold" && crackOutPhase(0.2, P) === "leak" && crackOutPhase(P.allBlack, P) === "black"
  && crackOutPhase(P.eyes - 0.001, P) === "black" && crackOutPhase(P.eyes, P) === "eyes" && crackOutPhase(P.dark, P) === "dark", "phases: hold, leak, black, eyes, dark");
ok(!paintsAt(0.1, P) && paintsAt(P.leak - 0.01, P) && paintsAt(P.black, P) && !paintsAt(P.allBlack, P), "the leak paints the mockup's window [leak - 0.01, black + 0.02)");
ok(!eyesAt(P.allBlack, P) && !eyesAt(P.eyes - 0.001, P) && eyesAt(P.eyes, P) && eyesAt(P.eyesEnd - 0.001, P) && !eyesAt(P.eyesEnd, P), "the eyes paint the mockup's window [eyes, eyes + EYES_END)");
if (existsSync(resolve(MOCK, "work/script.js"))) {
  const s = readFileSync(resolve(MOCK, "work/script.js"), "utf8");
  ok(/leak = imp \+ 0\.75, black = leak \+ st\.dur, eyes = black \+ 1\.0, dark = eyes \+ EYES_DARK/.test(s) && /if \(T >= P\.eyes && T <= P\.eyes \+ EYES_END\)/.test(s) && /brow: false/.test(s),
    "the mockup's own plan is still eyes = black + 1.0, dark = eyes + EYES_DARK, drawn while T in [eyes, eyes + EYES_END], brow off");
}

// ── the seam's numbers ──
ok(LEAK_MS === Math.round(P.allBlack * 1000) && LEAK_MS === 3770, `beat 1 nominal ${LEAK_MS} ms`);
ok(EYES_MS === Math.round((P.dark - P.allBlack) * 1000) && EYES_MS === 4530, `beat 2 nominal ${EYES_MS} ms (all black to dark: 0.98 s of black + the eyes' 3.55 s)`);
ok(CRACK_OUT_MS === LEAK_MS + EYES_MS && CRACK_OUT_MS === Math.round(P.dark * 1000) && CRACK_OUT_MS === 8300, `CRACK_OUT_MS = beat 1 + beat 2 = the break to dark (${CRACK_OUT_MS} ms)`);
{ // a slow painter start delays the clock by up to READY_WAIT_MS - lead; no painter: the fallback fade (1.6 s), then
  // beat 2 on a clock set as if beat 1 had ended at allBlack
  const worstFallback = READY_WAIT_MS + FALLBACK_FADE_MS + EYES_MS, worstPainted = READY_WAIT_MS - P.leak * 1000 + CRACK_OUT_MS;
  const worst = Math.max(worstFallback, worstPainted);
  const bo = readFileSync(resolve(HERE, "../battle-director/battle-opening.js"), "utf8");
  ok(/race\(style\.crackOut\(ctx\), \(style\.crackOutMs \|\| 4000\) \+ 4000\)/.test(bo), "battle-opening.js still races the crack-out against crackOutMs + 4000");
  ok(worst < CRACK_OUT_MS + 4000, `worst case ${worst} ms (painted ${worstPainted}, fallback ${worstFallback}) < battle-opening's race (${CRACK_OUT_MS + 4000})`);
  ok(worst < 15000, "and < the shatter's CRACK_OUT_CAP (15 s)");
  ok(/crackedOut\(spec\.key, \(style\.crackOutMs \|\| 0\) \+ 6000\)/.test(bo) && worst < CRACK_OUT_MS + 6000, "and < the show's wait for the crack-out (crackOutMs + 6000)");
}
{ // the shatter hands the strokes (exact) as well as the segments
  const src = readFileSync(resolve(HERE, "../battle-transition/shatter-transition.js"), "utf8");
  ok(/ctx\.strokes\s+the same cracks as whole polylines/.test(src) && /strokes: geo\.strokes\.map\(/.test(src), "CRACK_OUT_CONTRACT lists ctx.strokes and the shatter's ctx carries it");
  const show = readFileSync(resolve(HERE, "nidhogg-awakening-show.js"), "utf8");
  ok(/crackOut: nidhoggCrackOut,/.test(show) && /crackOutMs: CRACK_OUT_MS,/.test(show), "the style registers the seam: crackOut + crackOutMs");
  const host = readFileSync(resolve(HERE, "nidhogg-crack-out.js"), "utf8");
  ok(/const host = new CrackOutHost\(ctx, stats\);\s*try \{\s*await crackOutLeak\(ctx, stats, host\);[\s\S]*await crackOutEyes\(ctx, host\);[\s\S]*\} finally \{ host\.close\(\); \}/.test(host), "the seam plays beat 1, then beat 2, on one host, and closes it (the painters dropped) at the end");
  const endLeak = host.match(/endLeak\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "", close = host.match(/close\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  ok(endLeak && !/ch\.drop/.test(endLeak) && /for \(const q of this\.parts\.slice\(1\)\) this\.#dropPart\(q\)/.test(endLeak) && /for \(const q of this\.parts\) this\.#dropPart\(q\)/.test(close),
    "when the leak ends only the bottom band's painter is dropped; the top band's (the eyes') stays until close");
  ok(/this\.parts = this\.bands\.map\(\(band, i\) => \(\{ i, lane: LEAK_LANE \+ i, band, ch: channel\(LEAK_LANE \+ i\)/.test(host) && /crackOut: \{ \.\.\.this\.#crackOutInit\(\), band: part\.band, eyes: part\.i === 0, warm: LEAK_WARM_TS \}/.test(host),
    "the leak's bands: one painter each, on lanes LEAK_LANE + i; part 0 also paints the eyes");
  ok(/if \(!this\.askParts\.every\(\(q\) => q\.got\)\) return;/.test(host) && /putImageData\(new ImageData\(new Uint8ClampedArray\(f\.color\), EW, bh\), 0, y0, r\[0\], r\[1\] - y0,/.test(host),
    "a leak frame shows once both bands of it are in, each put into its own rows");
  ok(/this\.lc = this\.#canvas\(\{ mixBlendMode: blend \}\)/.test(host) && /"plus-lighter"/.test(host) && /this\.ctx\.layer\.append\(this\.ec, this\.lc\)/.test(host), "beat 2: a colour canvas and a plus-lighter light canvas, appended (above the black plate)");
  ok(/q\.ch\.draw\(q\.id, seq, now \/ 1000, \{ T \}, buf, q\.i === 0 \? bufL : null\)/.test(host), "the light buffer is handed back like the colour one (to the eyes' painter)");
}

// ── the effect frame ──
const g1 = effectGrid(1920, 1080), g2 = effectGrid(2560, 1440), g3 = effectGrid(1366, 768), g4 = effectGrid(3840, 2160);
ok(g1.PX === 3 && g1.EW === 640 && g1.EH === 360, "1920 x 1080: 3 px a pixel, 640 x 360 (the mockup's)");
ok(g2.PX === 4 && g2.EW === 640 && g2.EH === 360, "2560 x 1440: 4 px, the same 640 x 360");
ok(g3.PX === 2 && g3.EW === 683 && g3.EH === 384, "1366 x 768: 2 px (whole pixels), 683 x 384");
ok(g4.PX === 6 && g4.EH === 360, "3840 x 2160: 6 px");

// ── boxOf ──
{ const b = new Uint32Array(5 * 4); b[1 * 5 + 2] = 1; b[3 * 5 + 4] = 7; ok(JSON.stringify(boxOf(b, 5, 4)) === "[2,1,4,3]" && boxOf(new Uint32Array(20), 5, 4) === null, "boxOf: the non-empty box, null when empty"); }

// ── the crack geometry: the mockup's copy of the shatter's buildGeometry, else a made-up star ──
let mock = null;
if (existsSync(resolve(MOCK, "fx/shatter-crack.js"))) {
  const u = (f) => pathToFileURL(resolve(MOCK, f)).href;
  mock = { crack: await import(u("fx/shatter-crack.js")), leak: await import(u("fx/leak-smoke.js")), eyes: await import(u("fx/eyes.js")), core: await import(u("pixelfx/core/index.js")) };
}
function geometry(W, H) {
  if (mock) {
    const sc = mock.crack.makeScene({ W, H, DPR: 1, st: mock.crack.STYLES.ink, els: {} });
    const geo = sc.buildGeometry();
    const segs = sc.toSegs(geo).map((sg) => ({ a: { x: sg.p.x, y: sg.p.y }, b: { x: sg.q.x, y: sg.q.y }, d0: sg.d0, d1: sg.d1, w0: sg.w0, w1: sg.w1, kind: sg.kind, radial: sg.cls === "radial" }));
    // what the shatter's ctx.strokes carries
    const strokes = geo.strokes.map((s) => ({ kind: s.kind, pts: s.pts.map((p) => ({ x: p.x, y: p.y })), width: s.width.slice() }));
    return { geo, segs, strokes, impact: geo.I, U: geo.U };
  }
  const I = { x: 0.47 * W, y: 0.5 * H }, U = Math.min(W, H), strokes = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + 0.3, pts = [];
    for (let i = 0; i <= 8; i++) { const r = 0.04 * U + i * 0.09 * U; pts.push({ x: I.x + Math.cos(a + 0.05 * Math.sin(i)) * r, y: I.y + Math.sin(a + 0.05 * Math.sin(i)) * r }); }
    strokes.push({ kind: "main", pts, width: pts.map(() => 3) });
  }
  for (const r of [0.2, 0.42]) { const pts = []; for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push({ x: I.x + Math.cos(a) * r * U, y: I.y + Math.sin(a) * r * U }); } strokes.push({ kind: "ring", pts, width: pts.map(() => 1.4) }); }
  return { geo: { I, U, strokes }, segs: null, strokes, impact: I, U };
}
console.log(mock ? "     (mockup found: pixel checks against it)" : "     (no mockup on this machine: a made-up crack, no pixel checks)");

const W = 1920, H = 1080, { PX, EW, EH } = effectGrid(W, H), G = geometry(W, H);

// ── the fallback: strokes rebuilt from the segments cover every segment ──
if (G.segs) {
  const back = strokesFromCracks(G.segs), n = back.reduce((s, k) => s + k.pts.length - 1, 0);
  ok(n === G.segs.length && back.every((s) => s.pts.length === s.width.length), `strokesFromCracks: every segment back in a stroke (${back.length} strokes, ${n} segments)`);
}

// ── the painter (as the Worker builds it) ──
const t0 = performance.now();
const painter = makeCrackOutPainter({ W: EW, H: EH, PX, strokes: G.strokes, impact: G.impact, U: G.U });
const buildMs = performance.now() - t0;
console.log(`     build ${buildMs.toFixed(0)} ms (in the Worker, before "ready"); ${painter.leak.nodes} nodes, ${painter.leak.puffs} puffs`);
ok(painter.leak.seedsAt.length === 5, "5 first points");
ok(painter.leak.seedsAt.every((s, k) => near(s.t, P.leak + k * 0.22, 1e-6)), "they open 0.22 s apart from the first leak");
ok(painter.draw({ T: P.leak - 0.05 }).cRect === null, "nothing drawn before the first leak (the cracked frame shows)");
{
  const f = painter.draw({ T: P.black });
  const px = new Uint32Array(f.color);
  let opaque = 0; for (let i = 0; i < px.length; i++) if (px[i] >>> 24 === 255) opaque++;
  ok(opaque === px.length, `at black every pixel is opaque (${opaque} / ${px.length})`);
  let lit = 0; for (let i = 0; i < px.length; i++) if (((px[i] & 255) + ((px[i] >>> 8) & 255) + ((px[i] >>> 16) & 255)) > 3 * 0x0a) lit++;
  ok(lit / px.length < 0.01, `and black: under 1 % of it lighter than #0a0a0a (${(100 * lit / px.length).toFixed(2)} %)`);
  ok(f.light.byteLength === 0 && f.lRect === null, "no light in beat 1");
}
{ // a handed-back buffer is reused and fully overwritten
  const a = painter.draw({ T: 2.0 }), b = painter.draw({ T: 0.05, color: a.color });
  ok(b.color === a.color && b.cRect === null && new Uint32Array(b.color).every((v) => v === 0), "the handed-back buffer is reused and cleared");
}

// ── pixel for pixel against the mockup ──
if (mock) {
  const mLeak = mock.leak.makeLeak({ geo: G.geo, W: EW, H: EH, PX, seeds: 5, start: P.leak, black: P.black });
  const gLeak = makeLeak({ geo: { strokes: G.strokes, I: G.impact, U: G.U }, W: EW, H: EH, PX, seeds: 5, start: P.leak, black: P.black });
  const mv = mock.core.createFrame(EW, EH), ms = mock.core.createFrame(EW, EH), gv = createFrame(EW, EH), gs = createFrame(EW, EH);
  let sameTwo = 0, n = 0, merged = 0, mergedOff = 0, worst = 0;
  for (let T = P.leak - 0.01; T < P.allBlack; T += 0.1) {
    n++;
    mock.core.clearFrame(mv); mock.core.clearFrame(ms); clearFrame(gv); clearFrame(gs);
    mLeak.draw(mock.core.painterFor(mv), mock.core.painterFor(ms), T);
    gLeak.draw(painterFor(gv), painterFor(gs), T);
    let same = true;
    for (let i = 0; i < mv.color.length; i++) if (mv.color[i] !== gv.color[i] || ms.color[i] !== gs.color[i]) { same = false; break; }
    if (same) sameTwo++;
    // the port's one frame against the mockup's two, composited as the canvas would (smoke source-over the veil)
    const one = new Uint32Array(painter.draw({ T }).color);
    for (let i = 0; i < one.length; i++) {
      const v = mv.color[i], s = ms.color[i], sa = (s >>> 24) / 255;
      let r = 0, g = 0, b = 0, a = 0;
      if (v >>> 24) { a = 1; }                                  // the veil is black, opaque
      if (sa > 0) { r = (s & 255) * sa; g = ((s >>> 8) & 255) * sa; b = ((s >>> 16) & 255) * sa; a = a ? 1 : sa; if (a < 1) { r = s & 255; g = (s >>> 8) & 255; b = (s >>> 16) & 255; } }
      const o = one[i], d = Math.max(Math.abs((o & 255) - r), Math.abs(((o >>> 8) & 255) - g), Math.abs(((o >>> 16) & 255) - b), Math.abs((o >>> 24) - Math.round(a * 255)) > 1 ? 99 : 0);
      if (d > 1.0001) mergedOff++;
      worst = Math.max(worst, d);
    }
    merged += one.length;
  }
  ok(sameTwo === n, `the ported leak paints the mockup's veil and smoke pixel for pixel (${sameTwo} / ${n} frames)`);
  ok(mergedOff === 0, `one frame = the mockup's two composited, within 1 level (worst ${worst.toFixed(2)}, ${mergedOff} px off of ${merged})`);
}

// ── the leak in BANDS (two painters on two lanes, joined by the host): the whole-frame painter's frame, pixel for pixel ──
const BANDS = leakBands(EH);
ok(JSON.stringify(BANDS) === JSON.stringify([[0, 180], [180, 360]]) && JSON.stringify(leakBands(384)) === "[[0,192],[192,384]]", `the leak's bands ${JSON.stringify(BANDS)}`);
const bandPainters = BANDS.map((band, i) => makeCrackOutPainter({ W: EW, H: EH, PX, strokes: G.strokes, impact: G.impact, U: G.U, band, eyes: i === 0 }));
{
  const join = (outs) => {
    const j = new Uint32Array(EW * EH); let rect = null, sizes = true;
    outs.forEach((f, b) => {
      const [y0, y1] = BANDS[b];
      if (f.color.byteLength !== EW * (y1 - y0) * 4 || JSON.stringify(f.band) !== JSON.stringify(BANDS[b])) sizes = false;
      j.set(new Uint32Array(f.color), y0 * EW);
      if (f.cRect) { if (f.cRect[1] < y0 || f.cRect[3] >= y1) sizes = false; rect = rect ? [Math.min(rect[0], f.cRect[0]), Math.min(rect[1], f.cRect[1]), Math.max(rect[2], f.cRect[2]), Math.max(rect[3], f.cRect[3])] : f.cRect.slice(); }
    });
    return { j, rect, sizes };
  };
  let n = 0, same = 0, shaped = 0, spares = [null, null];
  const Ts = [];
  for (let T = P.leak - 0.01; T < P.allBlack; T += 1 / 60) Ts.push(T);
  Ts.push(P.leak - 0.05, P.black, P.allBlack - 0.001);
  for (const T of Ts) {
    n++;
    const outs = bandPainters.map((p, b) => p.draw({ T, color: spares[b] }));
    spares = outs.map((f) => f.color);
    const w = painter.draw({ T }), wc = new Uint32Array(w.color), { j, rect, sizes } = join(outs);
    let eq = JSON.stringify(rect) === JSON.stringify(w.cRect);
    for (let i = 0; eq && i < j.length; i++) if (j[i] !== wc[i]) eq = false;
    if (eq) same++;
    if (sizes && outs.every((f) => f.light.byteLength === 0 && f.lRect === null)) shaped++;
  }
  ok(same === n, `the two bands joined = the whole-frame painter's leak, pixels and box, every 1/60 s (${same} / ${n} frames)`);
  ok(shaped === n, `each band frame is its rows only (W x band rows, its box inside them, no light): ${shaped} / ${n}`);
  // the eyes stay whole frames, painted by the top band's painter only
  const Te = P.eyes + 1.0, a = bandPainters[0].draw({ T: Te, color: spares[0] }), b = painter.draw({ T: Te }), e1 = bandPainters[1].draw({ T: Te });
  const ac = new Uint32Array(a.color), bc = new Uint32Array(b.color), al = new Uint32Array(a.light), bl = new Uint32Array(b.light);
  let eqE = a.band === null && a.color.byteLength === EW * EH * 4 && JSON.stringify(a.cRect) === JSON.stringify(b.cRect) && JSON.stringify(a.lRect) === JSON.stringify(b.lRect);
  for (let i = 0; eqE && i < ac.length; i++) if (ac[i] !== bc[i] || al[i] !== bl[i]) eqE = false;
  ok(eqE, "the top band's painter paints the eyes as whole frames, = the whole-frame painter (colour and light)");
  ok(e1.cRect === null && e1.light.byteLength === 0 && e1.color.byteLength === EW * (BANDS[1][1] - BANDS[1][0]) * 4, "the bottom band's painter (eyes: false) paints nothing in the eyes");
  if (mock) console.log("     (and the whole-frame painter = the mockup above, so the joined bands are the mockup's leak too)");
}

// ── beat 2, his eyes: empty outside their window, then pixel for pixel against the mockup ──
{
  const empty = [P.allBlack, P.allBlack + 0.5, P.eyes - 0.001, P.eyesEnd, P.dark + 0.5].map((T) => painter.draw({ T }));
  ok(empty.every((f) => f.cRect === null && f.lRect === null && f.light.byteLength === 0 && new Uint32Array(f.color).every((v) => v === 0)),
    "nothing painted between black and the eyes, at their end, or after dark (colour empty, no light)");
  const f = painter.draw({ T: P.eyes + 1.0 }), c = new Uint32Array(f.color), l = new Uint32Array(f.light);
  let left = 0, right = 0, lit = 0;
  for (let i = 0; i < c.length; i++) { if (c[i]) { if (i % EW < EW / 2) left++; else right++; } if (l[i]) lit++; }
  ok(left > 300 && right > 300 && Math.abs(left - right) <= 0.1 * left, `1.0 s in: both eyes drawn (${left} / ${right} px)`);
  ok(f.light.byteLength === EW * EH * 4 && Array.isArray(f.lRect) && Array.isArray(f.cRect) && lit > 1000, `and their light (${lit} px lit, box ${JSON.stringify(f.lRect)})`);
  ok(l.every((v) => v === 0 || v >>> 24 === 255), "light is straight RGBA, alpha 255 where lit");
  const back = painter.draw({ T: P.allBlack + 0.1, light: f.light });
  ok(back.light === f.light && back.lRect === null && new Uint32Array(back.light).every((v) => v === 0), "a handed-back light buffer comes back, cleared, outside the eyes");
}
if (mock) {
  const mF = mock.core.createFrame(EW, EH), gF = createFrame(EW, EH);
  let n = 0, same = 0, sameMod = 0, sameBrow = 0, nC = 0, nL = 0, firstOff = null;
  const Ts = [];
  for (let s = 0; s < EYES_END; s += 1 / 60) Ts.push(P.eyes + s);
  for (const s of [0, 0.001, EYE_T.open, EYE_T.open + EYE_T.hold, EYES_END - 0.001]) Ts.push(P.eyes + s);
  for (const T of Ts) {
    n++;
    const s = T - P.eyes;   // the mockup draws drawEyes(painterFor(eF), T - P.eyes, { W: EW, H: EH, brow: st.brow })
    mock.core.clearFrame(mF);
    mock.eyes.drawEyes(mock.core.painterFor(mF), s, { W: EW, H: EH, brow: false });
    const f = painter.draw({ T }), c = new Uint32Array(f.color), l = f.light.byteLength ? new Uint32Array(f.light) : new Uint32Array(EW * EH);
    let ok1 = true;
    for (let i = 0; i < c.length; i++) if (c[i] !== mF.color[i] || l[i] !== mF.light[i]) { ok1 = false; firstOff ??= { s, i }; break; }
    if (ok1) same++;
    for (let i = 0; i < c.length; i++) { if (c[i]) nC++; if (l[i]) nL++; }
    // the ported module on the game's core alone (and with the brow light ON, so drawBrow is checked too)
    for (const brow of [false, true]) {
      mock.core.clearFrame(mF); clearFrame(gF);
      mock.eyes.drawEyes(mock.core.painterFor(mF), s, { W: EW, H: EH, brow });
      (await import("./crack-out-eyes.js")).drawEyes(painterFor(gF), s, { W: EW, H: EH, brow });
      let eq = true;
      for (let i = 0; i < gF.color.length; i++) if (gF.color[i] !== mF.color[i] || gF.light[i] !== mF.light[i]) { eq = false; break; }
      if (eq) brow ? sameBrow++ : sameMod++;
    }
  }
  ok(same === n, `the painter's eye frames = the mockup's eyes, colour AND light, pixel for pixel (${same} / ${n} frames${firstOff ? `, first off at s ${firstOff.s.toFixed(3)} px ${firstOff.i}` : ""})`);
  ok(sameMod === n && sameBrow === n, `crack-out-eyes.js on the game's core = fx/eyes.js on the mockup's (brow off ${sameMod} / ${n}, brow on ${sameBrow} / ${n})`);
  ok(nC > 0 && nL > 0, `(and they are not empty: ${nC} colour, ${nL} light px over the frames)`);
}

// ── the Worker protocol (crystal-worker.js "crackout", as the host drives it) ──
{
  const out = [];
  globalThis.self = { postMessage: (m) => out.push(m) };
  await import("./crystal-worker.js");
  const send = (m) => globalThis.self.onmessage({ data: m });
  send({ type: "init", id: "c1", W: EW, H: EH, painter: "crackout", crackOut: { PX, strokes: G.strokes, impact: G.impact, U: G.U } });
  ok(out.at(-1)?.type === "ready" && out.at(-1)?.id === "c1", "the Worker builds the leak and answers ready");
  send({ type: "draw", id: "c1", seq: 1, t: 0, T: 2.0, st: { T: 2.0 } });
  const f = out.at(-1);
  ok(f?.type === "frame" && f.seq === 1 && f.color.byteLength === EW * EH * 4 && Array.isArray(f.cRect) && f.light.byteLength === 0, "draw { T } -> a frame: the colour buffer + its box, no light");
  send({ type: "draw", id: "c1", seq: 2, t: 0, T: 2.0, st: { T: 2.0 }, color: f.color });
  ok(out.at(-1)?.seq === 2 && out.at(-1).color === f.color, "the handed-back buffer is painted into again");
  // beat 2 through the SAME painter: colour + light, both handed back
  const Te = P.eyes + 0.8;
  send({ type: "draw", id: "c1", seq: 3, t: 0, T: Te, st: { T: Te }, color: f.color, light: null });
  const e = out.at(-1);
  ok(e?.seq === 3 && e.color === f.color && e.light.byteLength === EW * EH * 4 && Array.isArray(e.cRect) && Array.isArray(e.lRect), "the same painter paints the eyes: colour + light, both boxes");
  send({ type: "draw", id: "c1", seq: 4, t: 0, T: Te + 0.1, st: { T: Te + 0.1 }, color: e.color, light: e.light });
  ok(out.at(-1)?.seq === 4 && out.at(-1).color === e.color && out.at(-1).light === e.light, "both handed-back buffers are painted into again");
  send({ type: "drop", id: "c1" });
  const k = out.length; send({ type: "draw", id: "c1", seq: 5, t: 0, T: 2.0, st: { T: 2.0 } });
  ok(out.length === k, "dropped: no more frames");
  // a band painter (the host's bottom band: eyes off)
  send({ type: "init", id: "c2", W: EW, H: EH, painter: "crackout", crackOut: { PX, strokes: G.strokes, impact: G.impact, U: G.U, band: BANDS[1], eyes: false } });
  ok(out.at(-1)?.type === "ready" && out.at(-1)?.id === "c2", "a band painter: ready");
  send({ type: "draw", id: "c2", seq: 1, t: 0, T: 2.0, st: { T: 2.0 } });
  const fb = out.at(-1), bh = BANDS[1][1] - BANDS[1][0];
  ok(fb?.type === "frame" && fb.color.byteLength === EW * bh * 4 && Array.isArray(fb.cRect) && fb.cRect[1] >= BANDS[1][0], `its frames are its ${bh} rows, the box in the whole frame's rows`);
  send({ type: "drop", id: "c2" });
  // the JIT warm-up (crackOut.warm): frames drawn and thrown away before "ready"; the frames after it are the same
  send({ type: "init", id: "c3", W: EW, H: EH, painter: "crackout", crackOut: { PX, strokes: G.strokes, impact: G.impact, U: G.U, band: BANDS[0], eyes: true, warm: LEAK_WARM_TS } });
  const rd = out.at(-1);
  ok(rd?.type === "ready" && rd.id === "c3" && rd.warmMs > 0, `a warmed painter: ready after its ${LEAK_WARM_TS.length} warm-up frames (${rd?.warmMs?.toFixed(1)} ms)`);
  let sameW = 0;
  for (const T of [P.leak, 1.4, 2.19, 2.2, P.black]) {
    send({ type: "draw", id: "c3", seq: 1, t: 0, T, st: { T } });
    const a = new Uint32Array(out.at(-1).color), ref = new Uint32Array(bandPainters[0].draw({ T }).color);
    if (a.length === ref.length && a.every((v, i) => v === ref[i])) sameW++;
  }
  ok(sameW === 5, `and paints the same pixels as an unwarmed one (${sameW} / 5 frames)`);
  send({ type: "drop", id: "c3" });
}

// ── the cost of a frame (info: the Worker's budget at 60 fps is 16.7 ms; measured on the real GPU by the lead) ──
{
  // each window played `reps` times; per frame: the first pass (as played) and the least of the passes (the frame's own
  // cost, without what other processes on this machine take: a busy CPU inflates single passes several fold)
  const run = (a, b, reps) => {
    const first = [], best = [];
    let spare = null, spareL = null;
    for (let r = 0; r < reps; r++) {
      let i = 0;
      for (let T = a; T < b; T += 1 / 60, i++) {
        const f = painter.draw({ T, color: spare, light: spareL }); spare = f.color; spareL = f.light.byteLength ? f.light : spareL;
        if (!r) first.push(f.ms);
        best[i] = Math.min(best[i] ?? Infinity, f.ms);
      }
    }
    const st = (v) => { v = [...v].sort((x, y) => x - y); return { n: v.length, avg: v.reduce((s, x) => s + x, 0) / v.length, p95: v[Math.floor(v.length * 0.95)], worst: v.at(-1) }; };
    return { first: st(first), best: st(best) };
  };
  const L = run(P.leak - 0.01, P.allBlack, 3), E = run(P.eyes, P.eyesEnd, 5);
  const fmt = (r) => `avg ${r.avg.toFixed(2)} ms, p95 ${r.p95.toFixed(2)}, worst ${r.worst.toFixed(2)}`;
  console.log(`     info: the leak at 60 Hz, ${L.best.n} frames: per-frame best of 3 ${fmt(L.best)}; first pass ${fmt(L.first)} (Node, this machine)`);
  { // the bands (as the host paints them): the frame's cost is its slowest band, each frame best of 3
    const best = [];
    let sp = BANDS.map(() => null);
    for (let r = 0; r < 3; r++) {
      let i = 0;
      for (let T = P.leak - 0.01; T < P.allBlack; T += 1 / 60, i++) {
        const outs = bandPainters.map((p, b) => p.draw({ T, color: sp[b] })); sp = outs.map((f) => f.color);
        best[i] = Math.min(best[i] ?? Infinity, Math.max(...outs.map((f) => f.ms)));
      }
    }
    const v = [...best].sort((x, y) => x - y), B = { avg: v.reduce((s, x) => s + x, 0) / v.length, p95: v[Math.floor(v.length * 0.95)], worst: v.at(-1) };
    console.log(`     info: the leak in ${BANDS.length} bands, its slowest band a frame: best of 3 ${fmt(B)} (Node, this machine)`);
    ok(B.p95 < L.best.p95, `the bands' slowest p95 ${B.p95.toFixed(2)} ms < the whole frame's ${L.best.p95.toFixed(2)} ms`);
  }
  console.log(`     info: the eyes at 60 Hz, ${E.best.n} frames: per-frame best of 5 ${fmt(E.best)}; first pass ${fmt(E.first)} (Node, this machine)`);
  ok(E.best.worst < 16.7, `the eyes' worst frame (best of 5) ${E.best.worst.toFixed(2)} ms < 16.7 ms (60 fps; no split or cache needed)`);
}

console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
