// Node checks: Nidhogg's return, phase 1 (return-close.js) against the approved mockup (tools/nidhogg-return-mockup
// v21, its default chips). fixtures/return-close.json was read from the mockup page itself (a probe copy exposing
// crystalAt / lightAt / glintAt / frontAt / sAt / edgeAt; page time t = 5.0, Stage 1, Length 3.6): sha256 of its crystal
// buffers after the close-in pass, of the star's buffers, and its numbers.
// Run: node return-close.test.mjs
import fs from "node:fs";
import { createHash } from "node:crypto";
import { makeCrystal, crystalMesh } from "./crystal-render.js";
import { makeCrystalPainter, FRAME, LOOK, premultiply } from "./crystal-painter.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { returnPlan, returnState, RETURN_DEFAULTS } from "./nidhogg-return.js";
import { frontAt, sAt, edgeAt, closeLook, closeTables, closeIn, glintAt, star, heartY, rref, MOCK_FRAME, STAR, dim, BAY } from "./return-close.js";
import { SOUL_UP_FX } from "./nidhogg-fall.js";

let pass = 0, fail = 0;
const ok = (c, m, got) => { if (c) pass++; else { fail++; console.log("FAIL", m, got === undefined ? "" : JSON.stringify(got)); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const sha = (u32) => createHash("sha256").update(new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength)).digest("hex");
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/return-close.json", import.meta.url), "utf8"));
const P = returnPlan(), mesh = crystalMesh(LOOK.seed);

// ── the geometry: the mockup's heart, unit and farthest pixel; the game frame's heart ──
ok(near(heartY(mesh, MOCK_FRAME.FLOOR), FX.heartFY, 1e-9), "heart row in the mockup's frame = the page's heartFY 287.8", heartY(mesh, MOCK_FRAME.FLOOR));
ok(near(rref(mesh), FX.RREF, 1e-9), "RREF = the page's (crystal height x 0.55 = 136.4)", rref(mesh));
ok(near(heartY(mesh, FRAME.FLOOR), FRAME.FLOOR - SOUL_UP_FX, 1e-9) && FRAME.FLOOR === 424, "game frame: FLOOR 424, heart 306.8 = FLOOR - SOUL_UP_FX", heartY(mesh, FRAME.FLOOR));
const mockTab = closeTables({ ...MOCK_FRAME, mesh });
ok(mockTab.dmax === FX.DMAX && Math.fround(RETURN_DEFAULTS.dmax) === FX.DMAX, "dmax of the mockup's frame = the page's DMAX = the clock's default", [mockTab.dmax, FX.DMAX]);

// ── the curves ──
for (const [T, f] of FX.fronts) ok(near(frontAt(T, P.len), f, 1e-9), `frontAt(${T}) = the page's`, [frontAt(T, P.len), f]);
for (const [f, s] of FX.sAts) ok(near(sAt(f), s, 1e-9), `sAt(${f}) = the page's`, [sAt(f), s]);
for (const [f, e] of FX.edges) ok(near(edgeAt(f), e, 1e-12), `edgeAt(${f}) = the page's`, [edgeAt(f), e]);
for (const [T, S] of FX.glint) {
  const g = glintAt(T - P.gone);
  // (the page's T ran by += 0.05, the fixture rounds it: at the very end the page read S 0 where the rounded T is out)
  ok(S == null || S === 0 ? g == null || g.S === 0 : g != null && near(g.S, S, 1e-12), `glint at T ${T}: S = the page's ${S}`, g);
}
{
  // the clock's close / glintU feed these exactly as the page's crystalAt / glintAt read T
  const s = returnState(3.0, P), L = closeLook(s.close.lastK);
  ok(near(s.close.front, frontAt(3.0, P.len), 1e-12), "returnState(3.0).close.front = frontAt(3.0)");
  ok(near(L.flameK, 1.35, 1e-12) && near(L.flameSee, 0.85, 1e-12), "past coreAt the soul burns +35 % and shows 85 %", L);
  ok(near(closeLook(0).flameSee, 0.4) && closeLook(0).flameK === 1, "at the start: the look the user chose (flameSee 0.4, flameK 1)");
  ok(returnState(P.gone, P).close === null && near(returnState(P.gone - 0.449, P).glintU, -0.449, 1e-9) && returnState(P.gone - 0.451, P).glintU === null, "close ends at gone; the light is born 0.45 s before", returnState(P.gone - 0.449, P).glintU);
}

// ── the light: strength only falls once the core is gone; full at gone ──
{
  ok(near(glintAt(0).S, 1, 1e-12), "the star is at full strength the moment the core is gone", glintAt(0));
  ok(glintAt(-0.46) === null && glintAt(AFTER_GLINT()) === null, "no star before gone - 0.45 or after gone + 2.6");
  let rise = true, prev = -1;
  for (let u = -0.45; u <= 0; u += 0.01) { const S = glintAt(u)?.S ?? 0; if (S < prev - 1e-12) rise = false; prev = S; }
  ok(rise, "born inside the last of the core: it only grows until the core is gone");
  // "then only weakens": the fade envelope falls; the waver rides it but never lifts it back to full
  let peak = 0;
  for (let u = 0.35; u < 2.6; u += 0.01) peak = Math.max(peak, glintAt(u).S);
  ok(peak < 1, "after the first moment it never comes back to full", peak);
  ok(glintAt(2.55).S < 0.05, "near the end it is almost out", glintAt(2.55));
}
function AFTER_GLINT() { return 2.6; }

// ── the dither: 4 steps, ordered 4 x 4 ──
{
  const buf = new Uint32Array([0xff808080]);
  dim(buf, 0, 0, 0, 0.5); ok(buf[0] === ((0xff000000 | (64 << 16) | (64 << 8) | 64) >>> 0), "dim 0.5 at the dither's darkest cell = half (stepped)", buf[0].toString(16));
  ok(BAY.length === 16 && near(BAY[0], 0.5 / 16) && near(BAY[1], 8.5 / 16), "Bayer 4 x 4 thresholds");
}

// ── the close-in pass on the mockup's own frame: byte-identical to the page ──
const drawSt = (T, x) => {
  const lastK = T == null ? 0 : returnState(T, P).close.lastK, L = closeLook(lastK);
  return { mesh, cx: x.CX, floorY: x.FLOOR, stage: 1, stageT: -1e9, hitT: null, reveal: 1, opaque: 0, flameK: L.flameK, glass: 0.95, flameSee: L.flameSee,
    turn: 12, rage: 1.8, rays: 2, rayColor: "green", rayMotion: "still", glow: true, floorClip: false };
};
{
  const cr = makeCrystal(MOCK_FRAME.W, MOCK_FRAME.H);
  const f0 = cr.draw(FX.plain.t, drawSt(null, MOCK_FRAME));
  ok(sha(f0.color) === FX.plain.col && sha(f0.light) === FX.plain.lig, "the renderer alone = the page's crystal at t 5 (no close-in)");
  for (const c of FX.close) {
    const f = cr.draw(c.t, drawSt(c.T, MOCK_FRAME));
    closeIn(f.color, f.light, mockTab, frontAt(c.T, P.len));
    ok(sha(f.color) === c.col && sha(f.light) === c.lig, `close-in at T ${c.T} (front ${c.front.toFixed(3)}): color + light = the page's`, [sha(f.color).slice(0, 12), c.col.slice(0, 12)]);
  }
}

// ── the game's frame (608 x 548, CX 304, FLOOR 424) ──
// The renderer itself is not shift-invariant (measured: moving cx by 1 px changes ~270 of its pixels, by 24 px ~3.7 k:
// sub-pixel geometry), so the game's crystal is not the page's pixel for pixel, before any of this. What must hold is
// that the dark falls on the SAME pixels of the crystal: the game frame's pass on its crystal = the mockup frame's pass
// on that same crystal moved into the mockup's frame (the overlap: mockup cols 0..559, rows 0..528).
const crop = (buf) => { const o = new Uint32Array(560 * 529); for (let y = 0; y < 529; y++) o.set(buf.subarray((y + 19) * FRAME.W + 24, (y + 19) * FRAME.W + 24 + 560), y * 560); return o; };
const intoMock = (buf) => { const o = new Uint32Array(MOCK_FRAME.W * MOCK_FRAME.H); o.set(crop(buf).subarray(0, 560 * 529)); return o; };
{
  ok(FRAME.CX - MOCK_FRAME.CX === 24 && FRAME.FLOOR - MOCK_FRAME.FLOOR === 19, "the game frame = the mockup's shifted by (24, 19)");
  const cr = makeCrystal(FRAME.W, FRAME.H), tab = closeTables({ ...FRAME, mesh }), painter = makeCrystalPainter();
  for (const c of FX.close) {
    const f = cr.draw(c.t, drawSt(c.T, FRAME));
    const mc = intoMock(f.color), ml = intoMock(f.light);
    closeIn(mc, ml, mockTab, frontAt(c.T, P.len));
    closeIn(f.color, f.light, tab, frontAt(c.T, P.len));
    let diff = 0; const gc = crop(f.color), gl = crop(f.light);
    for (let i = 0; i < gc.length; i++) if (gc[i] !== mc[i] || gl[i] !== ml[i]) diff++;
    ok(diff === 0, `game frame, T ${c.T}: the dark falls on the same crystal pixels as in the mockup's frame (dither too)`, diff);
    // and through the painter (what the Worker runs): st.close, flameK / flameSee as the show sends them
    const s = returnState(c.T, P), L = closeLook(s.close.lastK);
    const out = painter.draw({ t: c.t, st: { stage: 1, stageT: -1e9, hitT: null, reveal: 1, opaque: 0, flameK: L.flameK, flameSee: L.flameSee, floorClip: false, close: { front: s.close.front } } });
    const pc = new Uint32Array(FRAME.W * FRAME.H), pl = new Uint32Array(FRAME.W * FRAME.H);
    premultiply(f.color, pc, FRAME.W, FRAME.H); premultiply(f.light, pl, FRAME.W, FRAME.H);
    ok(sha(new Uint32Array(out.color)) === sha(pc) && sha(new Uint32Array(out.light)) === sha(pl), `painter st.close at T ${c.T} = the pass (premultiplied)`);
  }
  // no close: the painter is untouched (the idle crystal, the fall, the death)
  const a = painter.draw({ t: 5, st: { stage: 1 } }), b = makeCrystalPainter().draw({ t: 5, st: { stage: 1, close: null } });
  ok(sha(new Uint32Array(a.color)) === sha(new Uint32Array(b.color)), "st.close null = no pass");
  // the end of the close: nothing of the crystal is left
  const f = cr.draw(5, drawSt(P.gone - 1e-6, FRAME));
  closeIn(f.color, f.light, tab, frontAt(P.gone, P.len));
  let left = 0; for (let i = 0; i < f.color.length; i++) if ((f.color[i] & 0xffffff) || (f.light[i] & 0xffffff)) left++;
  ok(left === 0, "at gone the front has closed it to black", left);
  // the core stays bright while it shrinks: at T 2.6 (front ~0.054, the core a third of its radius) its middle is kept
  // at full (m = 1); the front reaches the heart itself only at T ~2.91 and closes it over the last 0.7 s
  const g = cr.draw(5, drawSt(2.6, FRAME)), g0 = Uint32Array.from(g.color);
  closeIn(g.color, g.light, tab, frontAt(2.6, P.len));
  const hy = Math.floor(heartY(mesh, FRAME.FLOOR));
  let kept = 0, lit = 0;
  for (let y = hy - 1; y <= hy + 1; y++) for (let x = FRAME.CX - 1; x <= FRAME.CX + 1; x++) { const i = y * FRAME.W + x; if (g0[i] & 0xffffff) { lit++; if (g.color[i] === g0[i]) kept++; } }
  ok(lit > 0 && kept === lit, "T 2.6: the core's middle is still at full brightness", { lit, kept });
  ok(frontAt(2.9, P.len) > 0 && frontAt(2.92, P.len) < 0, "the front reaches the heart at ~2.91 s", [frontAt(2.9, P.len), frontAt(2.92, P.len)]);
}

// ── the star: the page's star frame, pixel for pixel ──
{
  const fr = createFrame(STAR.W, STAR.H, FX.bFrame.ox, FX.bFrame.oy);
  ok(FX.bFrame.w === STAR.W && FX.bFrame.h === STAR.H, "the star frame = the page's 220 x 130");
  for (const s of FX.stars) {
    const g = glintAt(s.T - P.gone);
    if (!s.on) { ok(!g || g.S <= 0.015, `T ${s.T}: no star, as on the page`); continue; }
    clearFrame(fr);
    star(painterFor(fr), g.S, FX.heart);
    ok(sha(fr.color) === s.col && sha(fr.light) === s.lig, `star at T ${s.T.toFixed(2)} (S ${s.S.toFixed(3)}) = the page's`);
    // the game draws it at the frame's middle (origin 0): the same pixels, shifted
    const gf = createFrame(STAR.W, STAR.H);
    star(painterFor(gf), g.S, { x: STAR.W / 2, y: STAR.H / 2 });
    const hx = Math.round(FX.heart.x) - FX.bFrame.ox, hy = Math.round(FX.heart.y) - FX.bFrame.oy;
    ok(hx === STAR.W / 2 && hy === STAR.H / 2 && sha(gf.color) === s.col && sha(gf.light) === s.lig, `star at T ${s.T.toFixed(2)}: the game's middle-of-frame draw = the page's`, { hx, hy });
  }
}

// ── cost (this PC, Node): the pass over the game frame ──
{
  const cr = makeCrystal(FRAME.W, FRAME.H), tab = closeTables({ ...FRAME, mesh });
  const f = cr.draw(5, drawSt(1.0, FRAME));
  const n = 30, t0 = performance.now();
  for (let i = 0; i < n; i++) closeIn(f.color, f.light, tab, frontAt(1.0, P.len));
  const ms = (performance.now() - t0) / n;
  const t1 = performance.now(); closeTables({ ...FRAME, mesh }); const tabMs = performance.now() - t1;
  console.log(`cost: close-in pass ${ms.toFixed(2)} ms / frame; tables ${tabMs.toFixed(1)} ms once`);
  ok(ms < 8, "the pass costs < 8 ms a frame", ms);
}

console.log(`return-close: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
