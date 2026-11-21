// Node checks for Nidhogg's return, phase 2's stage (return-stage.js, pure): the smoke painter's inputs it computes
// from his sprite are the mockup page's exactly; laid on another spot they move with him; his glowing parts and the
// roar's rings paint what the mockup's own code paints.
//   node modules/fabula-ultima-companion/scripts/sealing-crystal/return-stage.test.mjs
//
// The page's inputs: fixtures/return-smoke.json (captured in the page, WP2). The mockup's own code for the parts and
// the rings is read from tools/nidhogg-return-mockup/work/script.js and run here on the same painter library, so a
// change to either side shows. The sprite: the token's image (= the mockup's nidhogg.png, same bytes).
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { returnStage, spriteFrame, underRuns, frameOn, viewOf, REST_VIEW, CROP, STAGE, EWm, EHm, MG, PX, PARTS, PART_KEYS, isGlow, glowPart, paintRings, ringsBox, RING_FRAME, RING_C, boxBlurRGBA } from "./return-stage.js";
import { premultiply } from "./crystal-painter.js";
import { ROAR } from "./nidhogg-return.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/return-smoke.json", import.meta.url), "utf8"));
const SRC = fs.readFileSync(ROOT + "tools/nidhogg-return-mockup/work/script.js", "utf8");

/** A minimal PNG reader (8-bit RGBA, not interlaced: the dragon's image). */
function readPng(file) {
  const b = fs.readFileSync(file);
  let o = 8, W = 0, H = 0, idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString("ascii", o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { W = d.readUInt32BE(0); H = d.readUInt32BE(4); if (d[8] !== 8 || d[9] !== 6 || d[12] !== 0) throw new Error("not 8-bit RGBA"); }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = new Uint8ClampedArray(W * H * 4), S = W * 4;
  for (let y = 0; y < H; y++) {
    const f = raw[y * (S + 1)], row = raw.subarray(y * (S + 1) + 1, (y + 1) * (S + 1));
    for (let x = 0; x < S; x++) {
      const a = x >= 4 ? out[y * S + x - 4] : 0, up = y ? out[(y - 1) * S + x] : 0, c = x >= 4 && y ? out[(y - 1) * S + x - 4] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      out[y * S + x] = v & 255;
    }
  }
  return { width: W, height: H, data: out };
}
/** A function's source in the mockup (from its `function name(` / `const name =` to the matching brace). */
function mockupSource(start) {
  const i = SRC.indexOf(start);
  if (i < 0) throw new Error("mockup: " + start + " not found");
  let j = SRC.indexOf("{", i), depth = 0;
  for (; j < SRC.length; j++) { if (SRC[j] === "{") depth++; else if (SRC[j] === "}" && --depth === 0) break; }
  return SRC.slice(i, j + 1);
}

const sprite = readPng(ROOT + "tools/nidhogg-return-mockup/nidhogg.png");
ok(sprite.width === 859 && sprite.height === 837, "the sprite read: 859 x 837");

// ── 1. the painter's inputs at the mockup's spot = the page's ──
const I = FX.inputs, st = returnStage(sprite);
ok(st.smoke.W === I.W && st.smoke.H === I.H && EWm === I.W && EHm === I.H, `buffers ${st.smoke.W} x ${st.smoke.H} = ${I.W} x ${I.H}`);
ok(JSON.stringify(st.smoke.cam) === JSON.stringify(I.cam), "cam = the page's CAMm");
ok(st.smoke.at.Z === I.at.Z && st.smoke.at.X === I.at.X, "at = the page's FEET");
ok(["cx", "cy", "X", "Y", "Z"].every((k) => st.smoke.src[k] === I.src[k]), "src = the page's MOUTH (exactly)");
ok(st.smoke.genW === I.genW && st.smoke.seed === I.seed, "genW / seed");
ok(st.smoke.body.lobes.length === I.body.lobes.length, `the stand over him: ${st.smoke.body.lobes.length} billows = ${I.body.lobes.length}`);
ok(JSON.stringify(st.smoke.body) === JSON.stringify(I.body), "the stand over him = the page's, billow for billow");
const runs = underRuns(st.smoke.under);
ok(JSON.stringify(runs) === JSON.stringify(FX.underRLE), `the cull mask = the page's (${runs.length} runs)`);
ok(JSON.stringify(REST_VIEW) === JSON.stringify(I.view), `the rest view ${JSON.stringify(REST_VIEW)} = the page's`);
ok(JSON.stringify(st.rect) === JSON.stringify((({ x, y, w, h }) => ({ x, y, w, h }))(spriteFrame(859, 837))), "the default rect is the mockup's sprite rect");
const F0 = frameOn(STAGE);
ok(F0.x === CROP.x && Math.abs(F0.y - CROP.y) < 1e-9 && F0.k === 1, `frameOn(the Great Seal's stage) = the crop (${F0.x}, ${F0.y}, k ${F0.k})`);
const F2 = frameOn({ x: 0, y: 0, w: 3364, h: 1576 });
ok(F2.k === 2 && Math.abs(F2.y - (788 - 946.125)) < 1e-9, "frameOn: a stage twice as wide scales the frame by 2");
ok(JSON.stringify(viewOf(-2000, -2000, 9000, 9000)) === JSON.stringify({ x0: 0, x1: EWm, y0: 0, y1: EHm }), "viewOf clamps to the buffers");

// ── 2. laid on another spot, everything of his moves with him ──
{
  const S0 = spriteFrame(859, 837), dx = -160;
  const sh = returnStage(sprite, { x: S0.x + dx, y: S0.y, w: S0.w, h: S0.h });
  ok(Math.abs(sh.mouth.cx - (st.mouth.cx + dx)) < 1e-9 && Math.abs(sh.mouth.cy - st.mouth.cy) < 1e-9, "shifted 160 px left: his mouth with him");
  ok(Math.abs(sh.smoke.at.Z - st.smoke.at.Z) < 1e-9, "shifted sideways: his depth unchanged");
  const s = sh.smoke.body.lobes, s0 = st.smoke.body.lobes, dX = dx / PX / (I.cam.F / (st.smoke.at.Z - 0.4));
  ok(s.length === s0.length && s.every((q, i) => Math.abs(q.X - (s0[i].X + dX)) < 1e-6 && q.Y === s0[i].Y), `the stand over him shifted with him (${s.length} billows, dX ${dX.toFixed(3)} m)`);
  // the cull mask: shifted by 80 buffer px (where both lie inside the view)
  let same = 0, diff = 0;
  for (let y = 0; y < EHm; y++) for (let x = MG + 1; x < EWm - 81; x++) { if (st.smoke.under[y * EWm + x + 80] === sh.smoke.under[y * EWm + x]) same++; else diff++; }
  ok(diff === 0 && same > 0, `the cull mask shifted with him (${diff} differ)`);
  const lo = returnStage(sprite, { x: S0.x, y: S0.y + 40, w: S0.w, h: S0.h });
  ok(lo.smoke.at.Z < st.smoke.at.Z && lo.feet.y === st.feet.y + 40, "40 px lower: nearer the camera");
  const sm = returnStage(sprite, { x: S0.x, y: S0.y, w: S0.w * 0.98, h: S0.h * 0.98 });
  ok(sm.DK < st.DK && sm.smoke.body.lobes.length > 0, "drawn smaller: the frame follows his size");
  const fl = returnStage(sprite, null, -1);
  ok(Math.abs(fl.mouth.cx - (S0.x + (S0.x + S0.w) - st.mouth.cx)) < 1e-6 && fl.facing === -1, "facing the other way: his mouth mirrored about his middle");
}

// ── 3. his glowing parts = the mockup's isGlow + PARTS ──
{
  const isGlowM = new Function("sprite", "return " + mockupSource("(i) => { const d = sprite.data")).call(null, sprite);
  const PARTSM = new Function("return (" + mockupSource("const PARTS = {").replace("const PARTS = ", "") + ")")();
  ok(JSON.stringify(Object.keys(PARTSM)) === JSON.stringify(PART_KEYS), "parts: eyes, mouth, claws (as the mockup)");
  for (const k of PART_KEYS) {
    const g = glowPart(sprite, k);
    let bad = 0, lit = 0;
    for (let y = 0; y < sprite.height; y++) for (let x = 0; x < sprite.width; x++) {
      const i = (y * sprite.width + x) * 4, want = isGlowM(i) && PARTSM[k](x, y), mine = isGlow(sprite.data, i) && PARTS[k](x, y);
      const inBox = g && x >= g.x0 && y >= g.y0 && x < g.x0 + g.w && y < g.y0 + g.h, a = inBox ? g.data[((y - g.y0) * g.w + (x - g.x0)) * 4 + 3] : 0;
      if (want !== mine || (want ? a !== sprite.data[i + 3] : a !== 0)) bad++;
      if (want) lit++;
    }
    ok(g && bad === 0 && lit > 20, `part ${k}: ${lit} glowing px, cropped ${g?.w} x ${g?.h}, = the mockup's (${bad} differ)`);
  }
}

// ── 4. the roar's rings = the mockup's drawRoar ──
{
  const W = EWm, H = EHm, rF = createFrame(W, H), noop = () => {};
  const canvasStub = { putImageData: noop, drawImage: noop, set imageSmoothingEnabled(v) { /* */ }, set globalCompositeOperation(v) { /* */ } };
  const MOUTH = { cx: st.mouth.cx, cy: st.mouth.cy };
  // the mockup's own numbers (the game's clock must hold the same)
  const ROAR_M = new Function("return (" + mockupSource("const ROAR = {").replace("const ROAR = ", "") + ")")(), FACE_M = Number(/const FACE_PX = ([0-9]+)/.exec(SRC)[1]);
  ok(["len", "rings", "every", "speed", "life"].every((k) => ROAR_M[k] === ROAR[k]) && FACE_M === ROAR.facePx, "the clock's ROAR = the mockup's");
  const drawRoarM = new Function("rF", "painterFor", "clearFrame", "MOUTH", "PX", "MG", "ROAR", "RING_C", "rX", "rLX", "ctx", "rImg", "rLImg", "rC", "rLC", "EWm", "EHm", "FACE_PX",
    "return " + mockupSource("function drawRoar(tau)"))(rF, painterFor, clearFrame, MOUTH, PX, MG, ROAR_M, RING_C, canvasStub, canvasStub, canvasStub, null, null, null, null, W, H, FACE_M);
  const mine = createFrame(W, H), small = createFrame(RING_FRAME.W, RING_FRAME.H, Math.round(st.ring.x) - RING_FRAME.W / 2, Math.round(st.ring.y) - RING_FRAME.H / 2);
  let frames = 0, bad = 0, badSmall = 0, outside = 0, lit = 0;
  for (let i = 0; i <= 60; i++) {
    const tau = i / 30;
    clearFrame(rF); drawRoarM(tau);
    clearFrame(mine); const any = paintRings(painterFor(mine), tau, st.ring.x, st.ring.y);
    clearFrame(small); paintRings(painterFor(small), tau, st.ring.x, st.ring.y);
    frames++;
    for (let p = 0; p < W * H; p++) { if (rF.color[p] !== mine.color[p] || rF.light[p] !== mine.light[p]) bad++; if (rF.color[p]) lit++; }
    // the small frame round his mouth holds every ring pixel
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x, sx = x - small.ox, sy = y - small.oy, inS = sx >= 0 && sy >= 0 && sx < small.w && sy < small.h;
      if (!inS) { if (mine.color[p] || mine.light[p]) outside++; continue; }
      const q = sy * small.w + sx;
      if (small.color[q] !== mine.color[p] || small.light[q] !== mine.light[p]) badSmall++;
    }
    if (tau > ROAR.rings * ROAR.every + ROAR.life) ok(!any, "no ring after the last has faded");
  }
  ok(bad === 0 && lit > 1000, `rings: ${frames} frames (tau 0..2) = the mockup's drawRoar (${bad} px differ, ${lit} lit)`);
  ok(badSmall === 0 && outside === 0, `rings: the ${RING_FRAME.W} x ${RING_FRAME.H} frame round his mouth holds them all (${outside} outside, ${badSmall} differ)`);
  // facing the other way: mirrored about his mouth
  const a = createFrame(W, H), b = createFrame(W, H), mx = 400, my = 280;
  paintRings(painterFor(a), 0.3, mx, my, 1); paintRings(painterFor(b), 0.3, mx, my, -1);
  let strongR = 0, strongL = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = b.color[y * W + x]; if (v && (v >>> 24) === 255) { if (x > mx) strongR++; else strongL++; } }
  ok(strongL > strongR, `facing -1: the rings are stronger on the left (${strongL} solid px left, ${strongR} right)`);
}

// ── 4b. WP6: the show paints the rings straight into its texture buffers, inside ringsBox only, no premultiply.
//    Driven the show's way (clear the last box's rows, paint, upload last box U this box) against the full-frame
//    path (clear all, paint, premultiply): the buffer and the uploaded texture are the same pixels on every frame. ──
{
  const { W: RW, H: RH } = RING_FRAME, mx = 412.4, my = 301.7, ox = Math.round(mx) - RW / 2, oy = Math.round(my) - RH / 2;
  const full = createFrame(RW, RH, ox, oy), pc = new Uint32Array(RW * RH), pl = new Uint32Array(RW * RH);
  const dir = createFrame(RW, RH, ox, oy), gpuC = new Uint32Array(RW * RH), gpuL = new Uint32Array(RW * RH);
  let last = null, badBuf = 0, badTex = 0, notId = 0, outBox = 0, frames = 0, painted = 0, saved = 0;
  for (const facing of [1, -1]) for (let i = 0; i <= 70; i++) {
    const tau = i / 30;
    clearFrame(full); paintRings(painterFor(full), tau, mx, my, facing);
    const cR = premultiply(full.color, pc, RW, RH), lR = premultiply(full.light, pl, RW, RH);
    for (let q = 0; q < RW * RH; q++) if (pc[q] !== full.color[q] || pl[q] !== full.light[q]) notId++;
    const box = ringsBox(tau, mx, my, RW, RH, ox, oy);
    if (last) { dir.color.fill(0, last[1] * RW, (last[3] + 1) * RW); dir.light.fill(0, last[1] * RW, (last[3] + 1) * RW); }
    if (box) paintRings(painterFor(dir), tau, mx, my, facing);
    const u = box && last ? [Math.min(box[0], last[0]), Math.min(box[1], last[1]), Math.max(box[2], last[2]), Math.max(box[3], last[3])] : (box ?? last);
    if (u) for (let y = u[1]; y <= u[3]; y++) for (let x = u[0]; x <= u[2]; x++) { const q = y * RW + x; gpuC[q] = dir.color[q]; gpuL[q] = dir.light[q]; }
    last = box; frames++;
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const q = y * RW + x;
      if (dir.color[q] !== pc[q] || dir.light[q] !== pl[q]) badBuf++;
      if (gpuC[q] !== pc[q] || gpuL[q] !== pl[q]) badTex++;
      if ((pc[q] || pl[q]) && !(box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3])) outBox++;
    }
    if (cR || lR) painted++;
    saved += box ? 1 - ((box[2] - box[0] + 1) * (box[3] - box[1] + 1)) / (RW * RH) : 1;
    if (!box) ok(!cR && !lR, `ringsBox null only when nothing is painted (tau ${tau.toFixed(3)})`);
  }
  ok(notId === 0, `rings: the premultiply is the identity on ring pixels (${notId} px differ)`);
  ok(outBox === 0, `rings: ringsBox holds every painted pixel (${outBox} outside)`);
  ok(badBuf === 0 && badTex === 0 && painted > 20, `rings direct (WP6) = the full-frame path on ${frames} frames: buffer ${badBuf}, texture ${badTex} px differ (${painted} frames with rings)`);
  console.log(`  rings box: ${(100 * saved / frames).toFixed(0)}% of the frame left alone on average`);
}

// ── 5. the halo blur fallback: keeps the light's mass, spreads it ──
{
  const w = 61, h = 61, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 28; y <= 32; y++) for (let x = 28; x <= 32; x++) { const i = (y * w + x) * 4; d[i] = 100; d[i + 1] = 255; d[i + 2] = 120; d[i + 3] = 255; }
  const mass = (q) => { let s = 0; for (let i = 3; i < q.length; i += 4) s += q[i]; return s; };
  const m0 = mass(d);
  boxBlurRGBA(d, w, h, 7.5);
  const m1 = mass(d), c = d[(30 * w + 30) * 4 + 3], edge = d[(30 * w + 45) * 4 + 3];
  ok(Math.abs(m1 - m0) / m0 < 0.03, `blur keeps the mass (${m0} -> ${m1.toFixed(0)})`);
  ok(c < 255 && c > edge && edge > 0, `blur spreads it (centre ${c}, 15 px out ${edge})`);
  ok(d[(30 * w + 40) * 4 + 1] > d[(30 * w + 40) * 4], "blur keeps the colour (green over red)");
}

console.log(`${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
