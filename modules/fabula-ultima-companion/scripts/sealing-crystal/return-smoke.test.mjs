// Node checks for Nidhogg's return smoke (pure parts): the game's port (return-smoke.js + smoke-cloud.js) renders
// PIXEL-IDENTICAL to the approved mockup, and the Worker painter "return" (return-painter.js) hands back the same
// frames, premultiplied.
//   node modules/fabula-ultima-companion/scripts/sealing-crystal/return-smoke.test.mjs
//
// fixtures/return-smoke.json: makeBreakSmoke's exact inputs on the mockup page (tools/nidhogg-return-mockup v21:
// cam = CAMm, at = FEET, src = MOUTH, body = the stand of billows over his sprite, under = underDragon as run lengths,
// genW = EW, the rest framing's view) and the SHA-256 of every 1/30 s frame [back, front, veil] from tau 0 to doneAt,
// rendered IN THE PAGE (headless Chromium) by the mockup's own code, for the rest view and for view = null. Made
// 2026-11-15 from a scratch copy of the page with a probe that exposed those inputs and hashed brk.draw /
// brk.drawVeil frames (the page's semantics: back/front cleared each frame, the veil drawn into one kept buffer).
// Regenerate only if the MOCKUP changes; a failure here after an edit to the game files is a regression.
import fs from "node:fs";
import crypto from "node:crypto";
import { makeReturnSmoke, returnVeil } from "./return-smoke.js";
import { makeReturnPainter, underFromRuns, RETURN_LAYERS } from "./return-painter.js";
import { premultiply } from "./crystal-painter.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const sha = (u32) => crypto.createHash("sha256").update(new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength)).digest("hex");

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/return-smoke.json", import.meta.url), "utf8"));
const I = FX.inputs, W = I.W, H = I.H, N = W * H;
const under = underFromRuns(FX.underRLE, N);
ok(FX.underRLE.reduce((a, b) => a + b, 0) === N, "under mask: the runs cover the buffer");
const opts = { cam: I.cam, at: I.at, src: I.src, seed: I.seed, body: I.body, under, genW: I.genW };
const VIEWS = { rest: I.view, full: null };

// ── 1. the port renders what the mockup page rendered, every frame, every layer ──
const direct = {};   // view mode -> per frame [back, front, veil] Uint32Array copies (for the painter check)
{
  const brk = makeReturnSmoke(W, H, opts);
  ok(brk.count === I.count, `billow count ${brk.count} = mockup ${I.count}`);
  ok(brk.doneAt === I.doneAt, `doneAt ${brk.doneAt} = mockup ${I.doneAt}`);
  const frames = Math.ceil(brk.doneAt * 30) + 1;
  ok(frames === FX.frames, `frames ${frames} = ${FX.frames}`);
  for (const [vm, view] of Object.entries(VIEWS)) {
    const b = createFrame(W, H), f = createFrame(W, H), v = createFrame(W, H), want = FX.hashes[vm], keep = [];
    let bad = 0;
    for (let i = 0; i < frames; i++) {
      const tau = i / 30;
      brk.drawVeil(v.color, tau, view);
      clearFrame(b); clearFrame(f);
      brk.draw(painterFor(b), painterFor(f), tau, view);
      const got = [sha(b.color), sha(f.color), sha(v.color)];
      for (let k = 0; k < 3; k++) if (got[k] !== want[i][k]) { bad++; if (bad <= 5) console.log(`  ${vm} tau ${tau.toFixed(3)} ${RETURN_LAYERS[k]} differs`); }
      keep.push([b.color.slice(), f.color.slice(), v.color.slice()]);
    }
    direct[vm] = keep;
    ok(bad === 0, `view ${vm}: ${frames} frames x 3 layers identical to the mockup page (${bad} differ)`);
    const lit = keep.filter((fr) => fr[0].some((p) => p) || fr[1].some((p) => p)).length;
    ok(lit > frames / 3, `view ${vm}: the smoke is really drawn (${lit} frames with smoke)`);
  }
}

// ── 2. the painter, driven the way crystal-worker.js drives it (its real onmessage, a fake `self`) ──
{
  const posted = [];
  globalThis.self = { postMessage: (msg, transfer = []) => posted.push(structuredClone(msg, { transfer })) };
  await import("./crystal-worker.js");
  const send = (m, transfer = []) => globalThis.self.onmessage({ data: structuredClone(m, { transfer }) });
  for (const [vm, view] of Object.entries(VIEWS)) {
    const id = "ret-" + vm;
    posted.length = 0;
    send({ type: "init", id, W, H, painter: "return", returnSmoke: { ...opts, under: { runs: FX.underRLE } } });
    ok(posted[0]?.type === "ready" && posted[0].id === id, `worker: ${vm} painter ready`);
    let bufs = {}, bad = 0, badPm = 0, badRect = 0, errs = 0, reused = 0, ms = 0, worst = 0;
    const tmp = new Uint32Array(N);
    for (let i = 0; i < FX.frames; i++) {
      posted.length = 0;
      send({ type: "draw", id, seq: i, t: i / 30, T: i / 30, st: { T: i / 30, view }, ...bufs }, Object.values(bufs));
      const m = posted[0];
      if (!m || m.type !== "frame") { errs++; if (errs <= 3) console.log("  worker said", m?.type, m?.message); continue; }
      ms += m.ms; worst = Math.max(worst, m.ms);
      if (i > 0 && RETURN_LAYERS.every((k) => m.layers[k].byteLength === N * 4)) reused++;
      RETURN_LAYERS.forEach((k, j) => {
        const got = new Uint32Array(m.layers[k]), src = direct[vm][i][j];
        // the expected frame: task 1's frame premultiplied; the painter's veil is stateless, so outside the view
        // it is empty (the page's kept buffer held black there, off screen); inside it, the same pixels
        const exp = src.slice();
        if (k === "veil" && view && i > 0) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < view.x0 || x >= view.x1 || y < view.y0 || y >= view.y1) exp[y * W + x] = 0;
        const rect = premultiply(exp, tmp, W, H);
        if (sha(got) !== sha(tmp)) { bad++; if (bad <= 5) console.log(`  painter ${vm} frame ${i} ${k} differs`); }
        // and, where the mockup's frame is whole (back, front; the veil with no view), against the page's own
        // premultiplied hash in the fixture
        if ((k !== "veil" || !view || i === 0) && sha(got) !== FX.premultiplied[vm][i][j]) badPm++;
        if (JSON.stringify(rect) !== JSON.stringify(m.rects[k])) badRect++;
      });
      bufs = m.layers;   // handed back for reuse, as the host does
    }
    ok(errs === 0, `worker: ${vm}: no errors (${errs})`);
    ok(bad === 0, `worker: ${vm}: ${FX.frames} frames x 3 layers = the port's frames, premultiplied (${bad} differ)`);
    ok(badPm === 0, `worker: ${vm}: = the mockup page's premultiplied hashes (${badPm} differ)`);
    ok(badRect === 0, `worker: ${vm}: dirty boxes right (${badRect} wrong)`);
    ok(reused === FX.frames - 1, `worker: ${vm}: buffers handed back and reused (${reused})`);
    console.log(`  painter ${vm}: ${(ms / FX.frames).toFixed(1)} ms a frame on average, worst ${worst.toFixed(1)} ms (Node)`);
    send({ type: "drop", id });
  }
  delete globalThis.self;
}

// ── 3. the painter by itself: reuse of the very buffers handed in, an empty frame's boxes, a bad view ──
{
  const p = makeReturnPainter({ W, H, ...opts });
  ok(p.count === I.count && p.doneAt === I.doneAt, "painter: count / doneAt");
  const a = p.draw({ T: 0.4, st: { view: I.view } });
  const b = p.draw({ T: 0.4, st: { view: I.view }, ...a.layers });
  ok(RETURN_LAYERS.every((k) => b.layers[k] === a.layers[k]), "painter: the handed-back ArrayBuffers are the ones written");
  ok(RETURN_LAYERS.every((k) => Array.isArray(b.rects[k])), "painter: smoke and veil at tau 0.4");
  const late = p.draw({ T: I.doneAt + 1, st: { view: I.view } });
  ok(late.rects.back === null && late.rects.front === null && late.rects.veil === null, "painter: nothing left after doneAt (+1 s)");
  const bad = p.draw({ T: 0.4, st: { view: { x0: NaN } } }), full = p.draw({ T: 0.4 });
  ok(RETURN_LAYERS.every((k) => sha(new Uint32Array(bad.layers[k])) === sha(new Uint32Array(full.layers[k]))), "painter: a malformed view = the whole buffer");
}

// ── 4. WP6: the layers painted apart (the show runs back and front in two Workers, the veil on the GPU) are the same
//    pixels as painted together; the veil field's edge test = the CPU veil's dirty box touching the buffers' edge;
//    the field's numbers are the painter's ──
{
  for (const [vm, view] of Object.entries(VIEWS)) {
    const all = makeReturnPainter({ W, H, ...opts }), parts = RETURN_LAYERS.map((k) => makeReturnPainter({ W, H, ...opts, layers: [k] }));
    ok(parts.every((p, j) => p.layers.length === 1 && p.layers[0] === RETURN_LAYERS[j]), `split ${vm}: one layer each`);
    let bad = 0, badRect = 0, badEdge = 0, extra = 0, edges = 0;
    const veil = returnVeil(W, H, opts);
    for (let i = 0; i < FX.frames; i++) {
      const T = i / 30, st = { T, view }, a = all.draw({ T, st });
      parts.forEach((p, j) => {
        const k = RETURN_LAYERS[j], b = p.draw({ T, st });
        if (Object.keys(b.layers).length !== 1) extra++;
        if (sha(new Uint32Array(b.layers[k])) !== sha(new Uint32Array(a.layers[k]))) bad++;
        if (JSON.stringify(b.rects[k]) !== JSON.stringify(a.rects[k])) badRect++;
      });
      const r = a.rects.veil, rectEdge = !!r && (r[0] <= 0 || r[1] <= 0 || r[2] >= W - 1 || r[3] >= H - 1);
      if (veil.edge(T, view) !== rectEdge) badEdge++;
      if (rectEdge) edges++;
    }
    ok(bad === 0 && badRect === 0 && extra === 0, `split ${vm}: ${FX.frames} frames, each layer painted alone = painted with the others (${bad} differ, ${badRect} boxes, ${extra} extra layers)`);
    ok(badEdge === 0 && edges >= (view ? 1 : 4) && edges < FX.frames, `veil field ${vm}: edge() = the CPU veil's box at the edge on every frame (${badEdge} wrong; at the edge on ${edges})`);
  }
  // the field = the painter's veil pixel for pixel (what the GPU shader computes, in float64 here)
  const veil = returnVeil(W, H, opts), sm = makeReturnSmoke(W, H, opts), C = new Uint32Array(N);
  let bad = 0;
  for (const T of [0.1, 0.4, 0.85, 1.6]) {
    C.fill(0); sm.drawVeil(C, T, null);
    const rc = veil.rc(T);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((C[y * W + x] >>> 24) !== veil.alpha8(veil.dist(x, y), rc, x, y)) bad++;
  }
  ok(bad === 0, `veil field: alpha8(dist) = drawVeil on 4 frames (${bad} px differ)`);
  ok(sm.veil.mx === veil.mx && sm.veil.k === veil.k && sm.veil.band === sm.P.band && veil.sq === sm.P.SQ, "veil field: the smoke's own numbers");
}

console.log(`${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
