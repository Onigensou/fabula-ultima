// Node checks for the smoke perf pass (2026-11-16): every speed-up is PIXEL-IDENTICAL to the code it replaced.
//   node modules/fabula-ultima-companion/scripts/sealing-crystal/smoke-cloud.test.mjs
// 1. blendPixel's fast paths (empty destination, a = 1) = the general blend formula, over the domain used and more
// 2. the steps' density cuts = ceil((1 - exp(-d dens)) * 6), for EVERY float32 density up to 2 / dens (both dens used)
// 3. box frames: the box clear = a whole clear, premultiplyBox + DstTrack = a whole premultiply, frame after frame
// 4. the fall smoke in 2 and 3 bands, joined (as the show joins them, takeBand) = the one-painter frame, buffers AND rects;
//    cloudFast's bands (only their own rows + 3 worked out) = the whole frame's rows, random smokes, random cuts
// 5. warm-up draws (the return painter's warm draws) change nothing that is painted after them
// The replays of the real-GPU runs (tools/staging-world/smoke-perf-node.mjs + smoke-ident-compare.mjs) hash every
// frame of the real fixtures before / after on top of this.
import crypto from "node:crypto";
import { blendPixel, stepCuts, stepAt, stepOf, cloudFast } from "./smoke-cloud.js";
import { BoxPainter, makeBoxFrame, premultiplyBox, DstTrack, takeBand, resetTake, unionBox } from "./box-frame.js";
import { premultiply } from "./crystal-painter.js";
import { makeFallPainter, smokeBands } from "./fall-painter.js";
import { FALL } from "./fall-smoke.js";
import { makeReturnPainter } from "./return-painter.js";
import { createFrame, clearFrame, painterFor, Rng } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const sha = (b) => crypto.createHash("sha256").update(new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength)).digest("hex");
const R = new Rng(20261116), u32 = () => (Math.floor(R.next() * 65536) * 65536 + Math.floor(R.next() * 65536)) >>> 0;
const t0 = performance.now();

// ── 1. blendPixel = the general formula (the code before the pass, verbatim) ──
{
  const general = (d, c, a) => {
    const da = (d >>> 24) / 255, oa = a + da * (1 - a), k = a / oa, k1 = 1 - k;
    return (((oa * 255) & 255) << 24) | (((((c >>> 16) & 255) * k + ((d >>> 16) & 255) * k1) & 255) << 16)
      | (((((c >>> 8) & 255) * k + ((d >>> 8) & 255) * k1) & 255) << 8) | ((((c & 255) * k + (d & 255) * k1) & 255));
  };
  // the alphas used: steps mode s/6 (s 1..6) x fade 1 (fall, return); plus random a in (0.004, 1] and a few edges
  const A = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1, 0.0040001, 0.5, 0.999999, Math.min(1, 6 / 6)];
  let bad = 0, n = 0;
  // exhaustive per channel: every channel value of c (all three at once) x every destination alpha byte x the alphas
  for (const a of A) for (let da = 0; da < 256; da++) for (let v = 0; v < 256; v++) {
    const c = (0xff << 24) | (v << 16) | (((v * 7) & 255) << 8) | ((v * 13) & 255), d = (da << 24) | (u32() & 0xffffff);
    n++; if (blendPixel(d, c, a) !== general(d, c, a)) bad++;
  }
  // random: any d, any c, any a in (0.004, 1], an eighth of them over an empty destination, an eighth at a = 1
  for (let i = 0; i < 3e6; i++) {
    const r = i & 7, a = r === 1 ? 1 : 0.004 + 0.996 * R.next() + 1e-12, d0 = u32(), d = r === 0 ? d0 & 0xffffff : d0, c = u32();
    n++; if (blendPixel(d, c, a) !== general(d, c, a)) bad++;
  }
  ok(bad === 0, `blendPixel = the general blend (${bad} of ${n} differ)`);
}

// ── 2. the step cuts: exhaustive over float32 densities [0.05, 2 / dens] for the dens in use ──
{
  const F = new Float32Array(1), I = new Int32Array(F.buffer), bits = (v) => { F[0] = v; return I[0]; };
  for (const dens of [4, 3.4]) {
    const c = stepCuts(dens), lo = bits(0.05), hi = bits(2 / dens) + 1;
    let bad = 0, first = null;
    for (let b = lo; b <= hi; b++) {
      I[0] = b; const d = F[0];
      if (stepAt(d, c) !== stepOf(d, dens)) { bad++; first ??= d; }
    }
    ok(bad === 0, `dens ${dens}: the cuts give exp's step for all ${hi - lo + 1} float32 densities 0.05..${(2 / dens).toFixed(3)} (${bad} differ, first ${first})`);
    ok(c[6] < 2 / dens && Math.exp(-2) < 1 / 6 - 0.03, `dens ${dens}: past 2 / dens the step is 6 (cut 6 = ${c[6]})`);
    // and a sample far past it
    let far = 0; for (let i = 0; i < 2e5; i++) { const d = Math.fround(2 / dens + R.next() * 200); if (stepAt(d, c) !== stepOf(d, dens)) far++; }
    ok(far === 0, `dens ${dens}: past 2 / dens, 200k random densities agree`);
  }
}

// ── 3. box frames over a random run of frames (painter shapes, light, direct writes with markC) ──
{
  const W = 213, H = 157, N = W * H, bf = makeBoxFrame(W, H), ref = createFrame(W, H);
  const tc = new DstTrack(W, H), tl = new DstTrack(W, H);
  let cb = null, lb = null, bad = 0, badR = 0, frames = 0;
  const paint = (p, k, rr) => {
    // the same random scene for both frames: shapes, glows, puts; sometimes nothing at all
    const n = k % 7 === 3 ? 0 : 1 + Math.floor(rr.next() * 6);
    for (let i = 0; i < n; i++) {
      const x = rr.range(-40, W + 40), y = rr.range(-40, H + 40), r = rr.range(1, 50), col = (0xff << 24) | Math.floor(rr.next() * 0xffffff);
      const kind = Math.floor(rr.next() * 5);
      if (kind === 0) p.circle(x, y, r, col, rr.next());
      else if (kind === 1) p.glow(x, y, r, col, 0.6);
      else if (kind === 2) p.disc(x, y, r, col, 0.5);
      else if (kind === 3) p.put(Math.floor(x), Math.floor(y), (Math.floor(rr.next() * 255) << 24) | 0x123456, 1);
      else {
        // straight writes, as the fall's engulf does, marked
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(W - 1, x0 + Math.floor(r)), y1 = Math.min(H - 1, y0 + Math.floor(r / 2));
        if (x0 <= x1 && y0 <= y1) { p.markC?.(x0, y0, x1, y1); for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) p.C[yy * W + xx] = 0xff000000 | (xx * yy); }
      }
    }
  };
  for (let k = 0; k < 120; k++) {
    const p = bf.begin();
    // the box clear left the frame all zeros
    if (k % 10 === 0) { let nz = 0; for (let i = 0; i < N; i++) if (bf.frame.color[i] || bf.frame.light[i]) nz++; ok(nz === 0, `frame ${k}: the box clear leaves no pixel`); }
    paint(p, k, new Rng(k + 1));
    const box = bf.end();
    clearFrame(ref); paint(painterFor(ref), k, new Rng(k + 1));
    // a buffer handed back is sometimes lost (a new one, all zeros)
    const c = tc.out(k % 11 === 5 ? null : cb, bf.frame.color, box.c), l = tl.out(k % 13 === 7 ? null : lb, bf.frame.light, box.l);
    cb = c.u32.buffer; lb = l.u32.buffer;
    const rc = new Uint32Array(N), rl = new Uint32Array(N), rcR = premultiply(ref.color, rc, W, H), rlR = premultiply(ref.light, rl, W, H);
    frames++;
    if (sha(c.u32) !== sha(rc) || sha(l.u32) !== sha(rl) || sha(bf.frame.color) !== sha(ref.color) || sha(bf.frame.light) !== sha(ref.light)) bad++;
    if (JSON.stringify([c.rect, l.rect]) !== JSON.stringify([rcR, rlR])) badR++;
  }
  ok(bad === 0, `box frames: ${frames} random frames, frame + premultiplied buffers = whole clear + whole premultiply (${bad} differ)`);
  ok(badR === 0, `box frames: the non-empty rects equal (${badR} differ)`);
  // a painter that does not know the handed buffer premultiplies it whole
  const t = new DstTrack(4, 2), dirty = new Uint32Array(8).fill(0xffffffff), src = new Uint32Array(8);
  const o = t.out(dirty.buffer, src, null);
  ok(o.rect === null && o.u32.every((v) => v === 0), "DstTrack: an unknown handed-back buffer is cleaned whole");
  ok(JSON.stringify(unionBox([1, 2, 3, 4], null)) === "[1,2,3,4]" && unionBox(null, "full") === "full", "unionBox");
}

// ── 4. the fall smoke in bands = one painter (synthetic sprite, both falls, every 1/30 s through the smoke) ──
{
  const w = 120, h = 110, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, d = Math.hypot(x - 60, (y - 55) * 1.2); if (d < 50) { const g = d < 14; data[i] = g ? 40 : 120; data[i + 1] = g ? 220 : 60; data[i + 2] = g ? 90 : 50; data[i + 3] = 255; } }
  const W = 400, H = 240, base = { layer: "smoke", W, H, img: { width: w, height: h, data }, x0: 120, y0: 40, k: 1.4, mirror: true };
  for (const [kind, nb] of [["first", 2], ["repeat", 2], ["first", 3], ["repeat", 3]]) {
    const one = makeFallPainter({ ...base, kind }), bands = smokeBands(H, nb), parts = bands.map((band) => makeFallPainter({ ...base, kind, band }));
    // the sprites the show joins them into (crystal-host-lib bufferSprite: u8 + res.dirty)
    const spr = () => ({ u8: new Uint8Array(W * H * 4), res: { dirty() {} }, last: null });
    const sC = spr(), sL = spr();
    let so = {}, sp = parts.map(() => ({})), bad = 0, badR = 0, frames = 0;
    for (let T = 0; T < FALL[kind].settleTo + 0.1; T += 1 / 30) {
      const a = one.draw({ T, color: so.color, light: so.light }); so = a;
      const b = parts.map((p, i) => p.draw({ T, color: sp[i].color, light: sp[i].light })); sp = b;
      bands.forEach((band, i) => { takeBand(sC, b[i].color, b[i].cRect, W, band); takeBand(sL, b[i].light, b[i].lRect, W, band); });
      const cR = b.reduce((r, x) => unionBox(r, x.cRect), null), lR = b.reduce((r, x) => unionBox(r, x.lRect), null);
      frames++;
      if (sha(new Uint8Array(a.color)) !== sha(sC.u8) || sha(new Uint8Array(a.light)) !== sha(sL.u8)) bad++;
      if (JSON.stringify([a.cRect, a.lRect]) !== JSON.stringify([cR, lR])) badR++;
    }
    ok(bad === 0, `${kind} fall: ${frames} frames, ${nb} bands joined (takeBand) = one painter (${bad} differ)`);
    ok(badR === 0, `${kind} fall, ${nb} bands: the joined rects = one painter's (${badR} differ)`);
  }
  // cloudFast in bands of every split, random smoke: each band's rows = the whole frame's
  let bad = 0, n = 0;
  for (let k = 0; k < 40; k++) {
    const rr = new Rng(900 + k), FW = 180, FH = 130, list = [];
    for (let i = 0, m = 5 + Math.floor(rr.next() * 60); i < m; i++) list.push({ x: rr.range(-20, FW + 20), y: rr.range(-20, FH + 20), r: rr.range(2, 40), a: rr.range(0.1, 1), b: rr.next() < 0.3 ? 0 : rr.range(0, 0.8), k: 0, ph: i, age: 0, w: rr.next() < 0.5 ? 0 : rr.range(0, 1) });
    const ramp = [0xff000000, 0xff101010, 0xff202a20, 0xff304030, 0xff406040, 0xff508050, 0xff60a060], opts = { dens: k % 2 ? 4 : 3.4, max: 1, lit: 1.4, steps: k % 5 !== 4 };
    const whole = createFrame(FW, FH); if (k % 3 === 0) whole.color.fill(0xff000000);
    cloudFast(painterFor(whole), list, ramp, ramp, { ...opts, frameH: FH });
    // two bands at a random cut, or three at two (each band works out only its rows and the 3 above)
    const c1 = 1 + Math.floor(rr.next() * (FH - 2)), c2 = c1 + 1 + Math.floor(rr.next() * (FH - c1 - 1));
    for (const [y0, y1] of (k % 2 ? [[0, c1], [c1, FH]] : [[0, c1], [c1, c2], [c2, FH]]).filter(([a, b]) => b > a)) {
      const f = createFrame(FW, y1 - y0, 0, y0); if (k % 3 === 0) f.color.fill(0xff000000);
      cloudFast(new BoxPainter(f), list, ramp, ramp, { ...opts, frameH: FH });
      n++; if (sha(f.color) !== sha(whole.color.subarray(y0 * FW, y1 * FW))) bad++;
    }
  }
  ok(bad === 0, `cloudFast bands: ${n} bands of random smokes = the whole frame's rows (${bad} differ)`);
  // switching one painter <-> bands mid-show: resetTake makes the next frames whole again
  const s = { u8: new Uint8Array(4 * 4 * 4).fill(9), res: { dirty() {} }, last: null };
  resetTake(s, 4, 4);
  takeBand(s, new Uint32Array(8).buffer, null, 4, [0, 2]); takeBand(s, new Uint32Array(8).buffer, null, 4, [2, 4]);
  ok(s.u8.every((v) => v === 0), "resetTake: the bands' first frames overwrite every row");
}

// smokeBands: n bands that tile the rows, none empty
{
  let bad = 0;
  for (const H of [1, 2, 3, 7, 240, 514]) for (const n of [1, 2, 3]) {
    const b = smokeBands(H, n);
    if (b[0][0] !== 0 || b.at(-1)[1] !== H || b.some(([a, c], i) => c <= a || (i && b[i - 1][1] !== a)) || b.length > n) bad++;
  }
  ok(bad === 0, `smokeBands tiles the frame for 1-3 bands (${bad} bad)`);
}

// ── 5. warm-ups change nothing painted after them ──
{
  // the return painter: frames with warm draws in between = frames without
  const W = 300, H = 200, cam = { cx: 150, yh: -120, A: 2600, F: 640 }, at = { X: 0, Z: 14 };
  const mk = () => makeReturnPainter({ W, H, cam, at, src: { X: 0, Y: 3, Z: 14 }, seed: 5, genW: W, layers: ["back", "front"] });
  const a = mk(), b = mk();
  let sa = {}, sb = {}, bad = 0, frames = 0;
  for (let tau = 0; tau < 1.4; tau += 1 / 30) {
    const fa = a.draw({ T: tau, ...sa }); sa = fa.layers;
    if (frames % 3 === 0) { const wv = b.draw({ T: tau + 0.37, warm: true }); ok(wv.warm === true && !wv.layers, "return warm draw: nothing handed back"); }
    const fb = b.draw({ T: tau, ...sb }); sb = fb.layers;
    frames++;
    if (sha(new Uint8Array(fa.layers.back)) !== sha(new Uint8Array(fb.layers.back)) || sha(new Uint8Array(fa.layers.front)) !== sha(new Uint8Array(fb.layers.front)) || JSON.stringify(fa.rects) !== JSON.stringify(fb.rects)) bad++;
  }
  ok(bad === 0, `return: ${frames} frames with warm draws between = without (${bad} differ)`);
}

// ── 6. a fall REHEARSAL (crystal-worker.js "rehearse": a throwaway painter of another size, in the same Worker) changes
//       nothing a real fall painter paints, run before it or interleaved with its frames ──
{
  const w = 120, h = 110, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, d = Math.hypot(x - 60, (y - 55) * 1.2); if (d < 50) { data[i] = 120; data[i + 1] = d < 14 ? 220 : 60; data[i + 2] = 50; data[i + 3] = 255; } }
  const base = { layer: "smoke", kind: "first", img: { width: w, height: h, data }, x0: 120, y0: 40, k: 1.4, mirror: true };
  const W = 400, H = 240, band = smokeBands(H)[1];
  const run = (mid) => {
    const p = makeFallPainter({ ...base, W, H, band }), hs = [];
    let so = {};
    for (let T = 0; T < FALL.first.settleTo; T += 1 / 20) {
      mid?.(T);
      const a = p.draw({ T, color: so.color, light: so.light }); so = a;
      hs.push(sha(new Uint8Array(a.color)) + sha(new Uint8Array(a.light)) + JSON.stringify([a.cRect, a.lRect]));
    }
    return hs;
  };
  const plain = run(null);
  const reh = () => { const r = makeFallPainter({ ...base, W: 360, H: 300, band: smokeBands(300)[0] }); let s = {}; return (T) => { const o = r.draw({ T: T + 0.4, color: s.color, light: s.light }); s = o; }; };
  const before = reh(); for (let T = 0; T < FALL.first.settleTo; T += 1 / 16) before(T);
  const after = run(null), inter = run(reh());
  ok(after.every((x, i) => x === plain[i]), `fall rehearsal before: ${plain.length} frames = without`);
  ok(inter.every((x, i) => x === plain[i]), `fall rehearsal interleaved: ${plain.length} frames = without`);
}

console.log(`smoke-cloud.test: ${pass} pass, ${fail} fail (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
