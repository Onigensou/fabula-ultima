// Bare-Node harness for the Soul Tithe FX (no Foundry, no PIXI).
//   node scripts/conflict-event/soul-fx/soul-fx-effects.test.mjs [--perf]
// Runs every approved effect start to finish on stand-in silhouettes the size of
// a party sprite at the battle view, drawing each layer into its own tight
// frame at 30 fps, the way the runtime does. Checks: nothing throws, nothing
// draws NaN, every layer goes quiet by the end, the beat constants match the
// effects, it is deterministic, and the idle fire loops seamlessly.
import { createFrame, clearFrame, painterFor } from "../../battle-director/pixel-entrance/pixelfx/core/index.js";
import { makeSil, placeSil, makeSoulFlame, FLAME_LOOP } from "./soul-fx-lib.js";
import { makeTithe, makeCalling, makeDestroy, TITHE, CALLING, DESTROY } from "./soul-fx-effects.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.error(`FAIL ${name} ${extra}`); } };
const PERF = process.argv.includes("--perf");

// a stand-in party sprite: head, ears, torso, arms, legs (~62 x 140 effect px)
function body(x0, y0) {
  const w = 64, h = 142, mask = new Uint8Array(w * h), pixels = new Uint32Array(w * h);
  const inE = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const on = inE(x, y, 32, 26, 15, 16) || inE(x, y, 22, 9, 4, 9) || inE(x, y, 42, 9, 4, 9) || inE(x, y, 32, 72, 17, 30)
      || inE(x, y, 13, 70, 5, 22) || inE(x, y, 51, 70, 5, 22) || inE(x, y, 25, 115, 6, 26) || inE(x, y, 39, 115, 6, 26);
    if (!on) continue;
    mask[y * w + x] = 1;
    const v = 90 + ((x * 7 + y * 13) % 120);
    pixels[y * w + x] = ((255 << 24) | (v << 16) | (v << 8) | v) >>> 0;
  }
  return makeSil({ x: x0, y: y0, w, h, mask, pixels });
}
const owner = body(780, 120), frag = body(130, 150);
const S = { owner, frag, bob: () => 0 };

function bad(frame) {
  for (const a of [frame.color, frame.light]) for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) return true;
  return false;
}

/** Run one effect the runtime's way: 1/120 s steps, layers drawn at 30 fps. */
function run(fx, label) {
  const frames = new Map(), cost = new Map(), drawn = new Map();
  let threw = null, nan = false;
  const DT = 1 / 120, steps = Math.ceil((fx.D + 0.5) / DT);
  let lastF = -1;
  for (let i = 0; i < steps; i++) {
    try { fx.update(DT); } catch (e) { threw = e; break; }
    const f = Math.floor(((i + 1) * DT) * 30);
    if (f === lastF) continue;
    lastF = f;
    for (const L of fx.layers) {
      let b;
      try { b = L.bounds(); } catch (e) { threw = e; break; }
      if (!b) continue;
      const w = Math.ceil(b.x1 - b.x0) + 2, h = Math.ceil(b.y1 - b.y0) + 2;
      ok(`${label}/${L.id} bounds finite`, [b.x0, b.y0, w, h].every(Number.isFinite) && w > 0 && h > 0, JSON.stringify(b));
      const fr = createFrame(w, h, Math.floor(b.x0), Math.floor(b.y0));
      const t0 = performance.now();
      try { L.draw(painterFor(clearFrame(fr))); } catch (e) { threw = e; break; }
      const dt = performance.now() - t0;
      cost.set(L.id, [...(cost.get(L.id) ?? []), dt]);
      drawn.set(L.id, (drawn.get(L.id) ?? 0) + fr.color.reduce((n, c) => n + (c ? 1 : 0), 0));
      frames.set(L.id, Math.max(frames.get(L.id) ?? 0, w * h));
      if (bad(fr)) nan = true;
    }
    if (threw) break;
  }
  ok(`${label} runs without throwing`, !threw, threw?.stack ?? "");
  ok(`${label} draws no NaN`, !nan);
  for (const L of fx.layers) ok(`${label}/${L.id} quiet at the end`, L.bounds() === null);
  for (const L of fx.layers) ok(`${label}/${L.id} drew something`, (drawn.get(L.id) ?? 0) > 0);
  if (PERF) for (const [id, c] of cost) {
    const s = [...c].sort((a, b) => a - b), avg = c.reduce((a, b) => a + b, 0) / c.length;
    console.log(`  ${label}/${id}: ${c.length} frames, avg ${avg.toFixed(2)} ms, p95 ${s[Math.floor(s.length * 0.95)].toFixed(2)}, max ${s[s.length - 1].toFixed(2)}, peak texture ${frames.get(id)} px`);
  }
  return { cost };
}

// the three effects
run(makeTithe(S), "tithe");
run(makeTithe(S, { merge: true }), "tithe-merge");
run(makeCalling(S), "calling");
run(makeDestroy(S), "destroy");

// beat constants the rules rely on
ok("tithe D", makeTithe(S).D === TITHE.END);
ok("tithe merge D", makeTithe(S, { merge: true }).D === TITHE.END_MERGE);
ok("calling D", makeCalling(S).D === CALLING.END);
{
  const d = makeDestroy(S);
  ok("destroy FIRST matches", Math.abs(d.FIRST - DESTROY.FIRST) < 1e-9, `${d.FIRST} vs ${DESTROY.FIRST}`);
  ok("destroy END matches", Math.abs(d.D - DESTROY.END) < 1e-9);
  ok("destroy pays before it ends", DESTROY.FIRST > 0.6 && DESTROY.FIRST < DESTROY.END);
  // the removal's defeat style must outlast the show (a GM who does not draw waits its totalMs)
  const { DEFEAT_STYLES } = await import("../../battle-director/defeat-styles.js");
  ok("soul_release covers the Destroyed show", DEFEAT_STYLES.soul_release?.totalMs >= DESTROY.END * 1000, `${DEFEAT_STYLES.soul_release?.totalMs} vs ${DESTROY.END * 1000}`);
}

// the fragment is hidden until the arrival, then revealed from the feet up, then fully shown
{
  const fx = makeTithe(S);
  const at = (t) => { while (fx.__t === undefined || fx.__t < t - 1e-9) { fx.update(1 / 120); fx.__t = (fx.__t ?? 0) + 1 / 120; } return fx.state(); };
  ok("tithe: fragment not shown before arrival", at(1.0).frag.show === 0);
  ok("tithe: fragment hidden at arrival", at(TITHE.ARRIVE + 0.1).frag.revealY === Infinity);
  const mid = at(TITHE.ARRIVE + 0.45).frag.revealY;
  ok("tithe: reveal is inside the body mid-way", mid > frag.y && mid < frag.y + frag.h, String(mid));
  ok("tithe: fully revealed by REVEALED", at(TITHE.REVEALED + 0.01).frag.revealY < frag.y);
  ok("tithe: idle fire reaches full", at(TITHE.END - 0.01).frag.flameK > 0.99);
}

// the body copies draw on a FLOATING fragment too: a fractional float once dropped every
// raw pixel write (blendPx), so the arrival's body never showed in battle and the token popped in
{
  const Sf = { owner, frag, bob: () => -12.37 };
  const countAt = (fx, id, t) => {
    let n = 0;
    while (n * (1 / 120) < t - 1e-9) { fx.update(1 / 120); n++; }
    const L = fx.layers.find((l) => l.id === id), b = L.bounds();
    const fr = createFrame(Math.ceil(b.x1 - b.x0) + 2, Math.ceil(b.y1 - b.y0) + 2, Math.floor(b.x0), Math.floor(b.y0));
    L.draw(painterFor(clearFrame(fr)));
    let tr = 0;
    for (const c of fr.color) { const a = c >>> 24; if (a && a < 255) tr++; }
    return tr;
  };
  ok("tithe: the reveal copy draws on a floating fragment", countAt(makeTithe(Sf), "frag", TITHE.ARRIVE + 0.5) > 200);
  ok("destroy: the body copy draws on a floating fragment", countAt(makeDestroy(Sf), "frag", 0.1) > 500);
}

// a FLYING owner (hover + bob) or one with an idle Float: everything tied to the owner is
// drawn where its sprite is, follows the bob live, and its foot (floor) stays on the ground.
// Before the fix the torn copy, strands, tether end and flamelet homes sat at the ground spot.
{
  const fresh = () => placeSil(owner, owner.x, owner.y);   // the effects move the owner in place
  const boxAt = (fx, id, t) => { let n = 0; while (n * (1 / 120) < t - 1e-9) { fx.update(1 / 120); n++; } return fx.layers.find((l) => l.id === id).bounds(); };
  const cases = [["tithe", makeTithe, "owner", 0.25], ["calling", makeCalling, "tether", 1.0], ["destroy", makeDestroy, "owner", DESTROY.FIRST + 0.05]];
  for (const [label, make, id, t] of cases) {
    const ground = boxAt(make({ owner: fresh(), frag, bob: () => 0 }), id, t);
    const Ho = fresh(), foot0 = Ho.foot[1];
    let lift = -24;
    const fx = make({ owner: Ho, frag, bob: () => 0, ownerBob: () => lift });
    const flown = boxAt(fx, id, t);
    ok(`${label}: a flying owner's ${id} layer is drawn at its lift`, flown.y0 < ground.y0 - 6, `${flown.y0} vs ${ground.y0}`);
    ok(`${label}: the owner's foot stays on the ground`, Ho.foot[1] === foot0);
    lift = -34; fx.update(1 / 120);
    const bobbed = fx.layers.find((l) => l.id === id).bounds();
    ok(`${label}: the owner's ${id} layer follows the bob live`, bobbed.y0 < flown.y0 - 4, `${bobbed.y0} vs ${flown.y0}`);
  }
  // the destroy's flamelets land in the chest where it is drawn: the owner glow moves with the bob
  {
    const hash = (fx, t) => { boxAt(fx, "owner", t); const L = fx.layers.find((l) => l.id === "owner"), b = L.bounds(); const fr = createFrame(Math.ceil(b.x1 - b.x0) + 2, Math.ceil(b.y1 - b.y0) + 2, Math.floor(b.x0), Math.floor(b.y0)); L.draw(painterFor(clearFrame(fr))); let top = fr.h; for (let y = 0; y < fr.h && top === fr.h; y++) for (let x = 0; x < fr.w; x++) if (fr.light[y * fr.w + x] || fr.color[y * fr.w + x]) { top = y; break; } return fr.oy + top; };
    const g = hash(makeDestroy({ owner: fresh(), frag, bob: () => 0 }), DESTROY.FIRST + 0.1);
    const f = hash(makeDestroy({ owner: fresh(), frag, bob: () => 0, ownerBob: () => -24 }), DESTROY.FIRST + 0.1);
    ok("destroy: the owner's light is drawn on the lifted body", f <= g - 18, `${f} vs ${g}`);
  }
}

// deterministic: the same effect twice draws the same pixels
{
  const shot = () => {
    const fx = makeTithe(S);
    for (let i = 0; i < 150; i++) fx.update(1 / 120);
    const L = fx.layers.find((l) => l.id === "owner"), b = L.bounds();
    const fr = createFrame(Math.ceil(b.x1 - b.x0) + 2, Math.ceil(b.y1 - b.y0) + 2, Math.floor(b.x0), Math.floor(b.y0));
    L.draw(painterFor(clearFrame(fr)));
    let h = 0;
    for (const c of fr.color) h = (Math.imul(h, 31) + c) | 0;
    return h;
  };
  ok("deterministic", shot() === shot());
}

// the idle fire loops: t and t + LOOP draw the same frame (what makes baking it legal)
{
  const fl = makeSoulFlame(frag, { gpuGlow: true });
  const ext = fl.extent, w = ext.x1 - ext.x0, h = ext.y1 - ext.y0;
  const draw = (t) => {
    const fr = createFrame(w, h, frag.x + ext.x0, frag.y + ext.y0), p = painterFor(clearFrame(fr));
    fl.drawBack(p, t, () => 0, 1, 0); fl.draw(p, t, () => 0, 1, 0, 1);
    return fr;
  };
  const a = draw(0.4), b = draw(0.4 + FLAME_LOOP);
  let same = true;
  for (let i = 0; i < a.color.length; i++) if (a.color[i] !== b.color[i] || a.light[i] !== b.light[i]) { same = false; break; }
  ok("idle fire is periodic", same);
  // nothing it draws falls outside the extent it reports
  let edge = 0;
  for (let t = 0; t < FLAME_LOOP; t += 1 / 15) {
    const fr = draw(t);
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (fr.color[y * w + x]) edge++;
    for (let x = 0; x < w; x++) if (fr.color[x]) edge++;
  }
  ok("idle fire fits its extent", edge === 0, `${edge} px on the border`);
  if (PERF) {
    const c = [];
    for (let t = 0; t < FLAME_LOOP; t += 1 / 30) { const t0 = performance.now(); draw(t); c.push(performance.now() - t0); }
    console.log(`  idle fire live: avg ${(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2)} ms per frame, frame ${w}x${h}`);
  }
}

console.log(`soul-fx: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
