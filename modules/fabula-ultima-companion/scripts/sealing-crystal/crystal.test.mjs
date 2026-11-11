// Sealing Crystal — Node checks for the ported painter (no Foundry, no DOM).
//   node scripts/sealing-crystal/crystal.test.mjs           checks
//   node scripts/sealing-crystal/crystal.test.mjs --perf    + paint cost per stage
import { makeCrystalPainter, FRAME, premultiply } from "./crystal-painter.js";
import { DEATH, ENDING, ENDING_BLACK_AT, endingScreen } from "./crystal-death.js";

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log("FAIL", msg); } };

// crackStage (leaf): what the host draws AND what Nidhogg's kit reads (BOSS_STAGE) — 75 / 50 / 25 %.
const { crackStage } = await import("./crack-stage.js");
ok([[100, 100, 0], [76, 100, 0], [75, 100, 1], [51, 100, 1], [50, 100, 2], [26, 100, 2], [25, 100, 3], [0, 100, 3]].every(([h, m, s]) => crackStage(h, m) === s), "crackStage reads 75 / 50 / 25 %");
ok(crackStage(5, 0) === 0 && crackStage("x", 100) === 0, "crackStage: no max / no HP reads intact");
const runtimeSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("./crystal-runtime.js", import.meta.url), "utf8"));
ok(/from "\.\/crack-stage\.js"/.test(runtimeSrc) && !/r <= 0\.25/.test(runtimeSrc), "the runtime draws from the shared crackStage, no copy of its own");

const P = makeCrystalPainter();
const n = FRAME.W * FRAME.H;
function paint(t, st) {
  const out = P.draw({ t, st });
  return { C: new Uint32Array(out.color), L: new Uint32Array(out.light), ms: out.ms };
}
function extent(C, L) {
  let x0 = FRAME.W, y0 = FRAME.H, x1 = -1, y1 = -1, opaque = 0;
  for (let y = 0; y < FRAME.H; y++) for (let x = 0; x < FRAME.W; x++) {
    const i = y * FRAME.W + x, a = C[i] >>> 24;
    if (a === 255) opaque++;
    if (a || (L[i] & 0xffffff)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { x0, y0, x1, y1, opaque };
}
const lightSum = (L) => { let s = 0; for (let i = 0; i < n; i++) s += (L[i] & 255) + ((L[i] >>> 8) & 255) + ((L[i] >>> 16) & 255); return s; };

// 1. every stage paints a crystal standing on the feet, inside the frame, never touching its edge
const base = { stageT: -1e9, hitT: null, deathT: null };
const light = [];
for (let stage = 0; stage <= 3; stage++) {
  let box = null, L0 = 0;
  for (let k = 0; k < 24; k++) {
    const { C, L } = paint(k * 0.5, { ...base, stage });
    const e = extent(C, L);
    box = box ? { x0: Math.min(box.x0, e.x0), y0: Math.min(box.y0, e.y0), x1: Math.max(box.x1, e.x1), y1: Math.max(box.y1, e.y1), opaque: Math.min(box.opaque, e.opaque) } : e;
    L0 += lightSum(L);
  }
  light.push(L0);
  ok(box.opaque > 15000, `stage ${stage}: a solid crystal is painted (min opaque px ${box.opaque})`);
  ok(box.x0 > 2 && box.y0 > 2 && box.x1 < FRAME.W - 3 && box.y1 < FRAME.H - 3, `stage ${stage}: inside the frame with a margin over a full turn (${JSON.stringify(box)})`);
  ok(box.y1 > FRAME.FLOOR, `stage ${stage}: its floor light reaches below the feet (y1 ${box.y1} > ${FRAME.FLOOR})`);
}
// 2. the cracks' beams: more light at every stage
for (let s = 1; s <= 3; s++) ok(light[s] > light[s - 1] * 1.1, `stage ${s} gives off more light than stage ${s - 1} (${light[s]} vs ${light[s - 1]})`);

// 3. it turns: two moments a quarter turn apart differ
{
  const a = paint(0, { ...base, stage: 1 }).C, b = paint(3, { ...base, stage: 1 }).C;
  let d = 0; for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  ok(d > 5000, `it turns (px changed over 3 s: ${d})`);
}
// 4. a hit flashes it white for a moment, then debris flies
{
  const flash = paint(10.01, { ...base, stage: 1, hitT: 10, hitSide: 1 }).C;
  let white = 0; for (let i = 0; i < n; i++) if (flash[i] === 0xffffffff) white++;
  ok(white > 10000, `a hit flashes it white (${white} white px)`);
  const later = extent(...Object.values(paint(10.4, { ...base, stage: 1, hitT: 10, hitSide: 1 })).slice(0, 2));
  ok(later.opaque > 15000, "after the flash the crystal is back");
}
// 5. a new stage reveals its cracks and its beams burst out (light rises over the first 0.2 s)
{
  const at = (dt) => lightSum(paint(20 + dt, { ...base, stage: 2, stageT: 20 }).L);
  ok(at(0.2) > at(0.02) * 1.05, `the new stage's beams burst out (${at(0.02)} -> ${at(0.2)})`);
}
// 6. the death plays end to end without throwing, and the frames stay in the frame buffer
{
  let threw = null;
  try { for (let D = 0; D < DEATH.end; D += 0.37) paint(100 + D, { ...base, stage: 3, stageT: 50, deathT: 100, floorClip: false }); }
  catch (e) { threw = e; }
  ok(!threw, `the death paints from 0 to ${DEATH.end} s${threw ? ": " + threw.stack : ""}`);
}
// 7. the buffers handed back are reused (no new allocation)
{
  const o1 = P.draw({ t: 1, st: { ...base, stage: 0 } });
  const o2 = P.draw({ t: 1.1, st: { ...base, stage: 0 }, color: o1.color, light: o1.light });
  ok(o2.color === o1.color && o2.light === o1.light, "handed-back buffers are painted into");
  const o3 = P.draw({ t: 1.2, st: { ...base, stage: 0 }, color: new ArrayBuffer(16), light: null });
  ok(o3.color.byteLength === n * 4 && o3.light.byteLength === n * 4, "a wrong-size buffer is replaced");
}

// 8. the hand-off is premultiplied, and its box holds every non-empty pixel and nothing beyond
{
  const src = new Uint32Array(5 * 4), dst = new Uint32Array(20).fill(7);
  src[1 * 5 + 1] = ((128 << 24) | (0 << 16) | (100 << 8) | 255) >>> 0;   // r 255, g 100, a 128
  src[2 * 5 + 3] = 0xff112233;
  src[3 * 5 + 0] = 0x00ffffff;                                            // alpha 0: empty
  const r = premultiply(src, dst, 5, 4);
  ok(JSON.stringify(r) === "[1,1,3,2]", `box of the non-empty pixels (${JSON.stringify(r)})`);
  const v = dst[6];
  ok((v & 255) === 128 && ((v >>> 8) & 255) === 50 && (v >>> 24) === 128, `rgb x alpha (${(v & 255)}, ${(v >>> 8) & 255}, a ${v >>> 24})`);
  ok(dst[13] === 0xff112233 && dst[15] === 0 && dst[0] === 0, "opaque copied as is, empty and alpha-0 cleared");
  ok(premultiply(new Uint32Array(4), new Uint32Array(4), 2, 2) === null, "an empty frame has no box");
  // a painted frame: the box matches a scan of the result
  const out = P.draw({ t: 3, st: { ...base, stage: 2 } }), C = new Uint32Array(out.color);
  let x0 = FRAME.W, y0 = FRAME.H, x1 = -1, y1 = -1;
  for (let y = 0; y < FRAME.H; y++) for (let x = 0; x < FRAME.W; x++) if (C[y * FRAME.W + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  ok(JSON.stringify(out.cRect) === JSON.stringify([x0, y0, x1, y1]), `painted colour box ${JSON.stringify(out.cRect)} = scan ${JSON.stringify([x0, y0, x1, y1])}`);
  const area = (q) => (q[2] - q[0] + 1) * (q[3] - q[1] + 1);
  console.log(`  stage 2 boxes: colour ${(100 * area(out.cRect) / n).toFixed(0)}% / light ${(100 * area(out.lRect) / n).toFixed(0)}% of the frame`);
}

// 9. the director's removal waits for the show: the white clearing (not the last foe) or, as the battle's last foe,
//    the black (defeat style crystal_death covers the longer, ENDING_BLACK_AT)
{
  const { DEFEAT_STYLES } = await import("../battle-director/defeat-styles.js");
  const d = DEFEAT_STYLES.crystal_death;
  ok(d?.external === "crystal-death" && d.internal, "defeat style crystal_death is external, played by the crystal runtime");
  ok(ENDING_BLACK_AT > DEATH.whiteGone, `the ending's black (${ENDING_BLACK_AT} s) comes after the white would have cleared (${DEATH.whiteGone} s)`);
  ok(d?.totalMs >= ENDING_BLACK_AT * 1000 && d.totalMs <= ENDING_BLACK_AT * 1000 + 1000, `its totalMs (${d?.totalMs}) covers the ending's black (${ENDING_BLACK_AT * 1000})`);
  ok(d.startOnHit === true && d.stopsBgm === true && d.battleEnd?.quiet === true, "it starts on the killing blow, stops the music there, and asks for the quiet battle end");
}

// 10. the ending (the user, 2026-11-11): full white held ~5 s, then black, held
{
  const at = (D) => endingScreen(D);
  ok(at(DEATH.whiteFull - 0.1).white === null && at(DEATH.whiteFull - 0.1).black === 0, "before full white: the death's own white, no black");
  ok(at(DEATH.whiteFull).white === 1 && at(DEATH.whiteGone + 1).white === 1, "from full white on the white is held (it does not clear)");
  ok(ENDING.holdWhite >= 4.5 && ENDING.holdWhite <= 5.5, `the white holds ~5 s (${ENDING.holdWhite})`);
  ok(at(DEATH.whiteFull + ENDING.holdWhite - 0.01).black === 0, "no black during the hold");
  const mid = at(DEATH.whiteFull + ENDING.holdWhite + ENDING.toBlack / 2).black;
  ok(mid > 0.3 && mid < 0.7, `half way through the fade it is half black (${mid.toFixed(2)})`);
  ok(at(ENDING_BLACK_AT).black === 1 && at(ENDING_BLACK_AT + 300).black === 1, "black from ENDING_BLACK_AT on, and it stays");
}

if (process.argv.includes("--perf")) {
  for (let stage = 0; stage <= 3; stage++) {
    for (let k = 0; k < 20; k++) paint(k / 30, { ...base, stage });
    const N = 90; let s = 0;
    for (let k = 0; k < N; k++) s += paint(1 + k / 30, { ...base, stage }).ms;
    console.log(`perf stage ${stage}: ${(s / N).toFixed(2)} ms/frame`);
  }
  for (const [a, b] of [[10.8, 13.4], [13.5, 17], [17, 18.2]]) {
    const N = 40; let s = 0;
    for (let k = 0; k < N; k++) s += paint(200 + a + ((b - a) * k) / N, { ...base, stage: 3, stageT: 50, deathT: 200, floorClip: false }).ms;
    console.log(`perf death ${a}-${b} s: ${(s / N).toFixed(2)} ms/frame`);
  }
}

console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
