// Node checks: the battle opening's close-up smoke (pure). Run: node opening-smoke.test.mjs
import { makeCloseupSmoke, OPENING_SMOKE, OPENING_SMOKE_LIT, CLOSE_SMOKE } from "./opening-smoke.js";
import { cloudFast } from "./smoke-cloud.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL", m); } else console.log("ok  ", m); };
const W = 320, H = 180, subj = { x: 0.3, y: 0.58 };
const A = makeCloseupSmoke(W, H, { seed: 11, dir: 1 }), B = makeCloseupSmoke(W, H, { seed: 11, dir: 1 });
ok(JSON.stringify(A.lobesAt(4.2, subj)) === JSON.stringify(B.lobesAt(4.2, subj)), "deterministic from (seed, t)");
const counts = []; for (let t = 3; t < 7.6; t += 0.25) counts.push(A.lobesAt(t, subj).length / 3);
ok(Math.min(...counts) >= 10, `never an empty frame (fewest wisps ${Math.min(...counts)}, most ${Math.max(...counts)})`);
ok(A.lobesAt(5, subj).every((q) => q.b === CLOSE_SMOKE.lit && q.w === 0 && q.a > 0 && q.a <= 1 && q.r > 0), "lobes with a little light of their own (grey-green tones, never black discs), soft weights");
// drift: on average the wisps move with dir (right for +1, left for -1)
const meanDx = (g) => { let s = 0, n = 0; for (const w of g.wisps) { s += w.vx; n++; } return s / n; };
ok(meanDx(A) > 0 && meanDx(makeCloseupSmoke(W, H, { seed: 23, dir: -1 })) < 0, "the claw's wisps drift right, the wing's left");
// rendered: soft, see-through, and the subject stays readable
const f = createFrame(W, H);
const render = (t) => { clearFrame(f); cloudFast(painterFor(f), A.lobesAt(t, subj), OPENING_SMOKE, OPENING_SMOKE_LIT, { dens: CLOSE_SMOKE.dens, max: CLOSE_SMOKE.max, steps: CLOSE_SMOKE.steps }); };
let cover = 0, near = 0, nearN = 0, far = 0, farN = 0, maxA = 0;
for (const t of [3.5, 4.5, 5.5, 6.5]) {
  render(t);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = (f.color[y * W + x] >>> 24) / 255;
    if (a > 0.05) cover++;
    maxA = Math.max(maxA, a);
    const d = Math.hypot((x - subj.x * W) / 1.35, y - subj.y * H) / H;
    if (d < 0.12) { near += a; nearN++; } else if (d > 0.4) { far += a; farN++; }
  }
}
cover /= 4 * W * H;
ok(cover > 0.25 && cover < 0.9, `the smoke covers a good part of the frame, not all of it (${(cover * 100).toFixed(0)} %)`);
ok(maxA <= CLOSE_SMOKE.max + 0.01, `never fully opaque (max alpha ${maxA.toFixed(2)})`);
ok(near / nearN < 0.5 * (far / farN), `the subject's oval is clear: mean alpha near ${(near / nearN).toFixed(3)} vs far ${(far / farN).toFixed(3)}`);
// (dev) dump one frame for a look: node opening-smoke.test.mjs --dump <file.raw>
if (process.argv[2] === "--dump") { const fs = await import("node:fs"); render(5); fs.writeFileSync(process.argv[3], Buffer.from(f.color.buffer)); }
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);

