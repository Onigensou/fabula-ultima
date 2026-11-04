// ============================================================================
// Wisps — bare-Node harness.
//
//     node scripts/battle-director/particles/wisps.test.mjs
//
// A fake 2D context that throws where a browser throws: a colour string it
// cannot parse (an exponent like "1e-7"), a negative or NaN radius, NaN
// coordinates. The two mockup bugs this module came out of were exactly those
// (a trail read before its second point; a colour in exponent form), so every
// frame of a whole burst is drawn through it.
// ============================================================================

import { Wisp, Vapour, WispBurst, scheduleWisps, pickWispColour, wispAlpha, WISP_PALETTES } from "./wisps.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++; console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

// Seeded rng, so every run draws the same wisps.
function seeded(seed = 1) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const COLOUR = /^rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+|1\.0+)\)$/;
function fakeCtx() {
  const num = (...v) => { for (const n of v) if (!Number.isFinite(n)) throw new Error(`non-finite coordinate ${n}`); };
  const colour = (c) => { if (typeof c === "string" && !COLOUR.test(c) && !c.startsWith("rgb(")) throw new SyntaxError(`bad colour "${c}"`); };
  const grad = () => ({ addColorStop(o, c) { num(o); colour(c); } });
  const ctx = {
    calls: 0, depth: 0,
    save() { this.depth++; }, restore() { this.depth--; },
    translate: num, rotate: num, scale: num,
    beginPath() {}, moveTo: num, lineTo: num, stroke() { this.calls++; }, fill() { this.calls++; },
    arc(x, y, r) { num(x, y, r); if (r < 0) throw new RangeError("negative radius"); },
    createRadialGradient(x0, y0, r0, x1, y1, r1) { num(x0, y0, r0, x1, y1, r1); if (r0 < 0 || r1 < 0) throw new RangeError("negative radius"); return grad(); },
    createLinearGradient: (...v) => { num(...v); return grad(); },
    set strokeStyle(v) { colour(v); }, set fillStyle(v) { colour(v); },
    globalCompositeOperation: "source-over", lineCap: "butt", lineWidth: 1,
  };
  return ctx;
}

/* ── alpha strings ───────────────────────────────────────────────────────── */

eq("tiny alpha never prints as an exponent", wispAlpha(1e-9), "0.000");
eq("negative alpha clamps to 0", wispAlpha(-0.5), "0.000");
eq("alpha above 1 clamps", wispAlpha(3), "1.000");
eq("NaN alpha is 0", wispAlpha(NaN), "0.000");
eq("a normal alpha", wispAlpha(0.4567), "0.457");

/* ── colours ─────────────────────────────────────────────────────────────── */

for (const [name, list] of Object.entries(WISP_PALETTES)) {
  ok(`${name}: non-empty`, list.length > 0);
  ok(`${name}: every entry is "r,g,b"`, list.every((s) => /^\d{1,3},\d{1,3},\d{1,3}$/.test(s)));
}
{
  const r = seeded(3);
  ok("palette pick comes from the palette", WISP_PALETTES.crimson.includes(pickWispColour("crimson", r)));
  ok("unknown palette falls back to spirit", WISP_PALETTES.spirit.includes(pickWispColour("nope", r)));
  ok("rnd() of exactly 1 stays in range", WISP_PALETTES.spirit.includes(pickWispColour("spirit", () => 0.9999999999)));
  ok("pixel-tinted colour is r,g,b", /^\d{1,3},\d{1,3},\d{1,3}$/.test(pickWispColour("spirit", r, [10, 200, 40])));
}

/* ── schedule ────────────────────────────────────────────────────────────── */

{
  const s = scheduleWisps({ count: 12, fromMs: 300, spawnOverMs: 400, lifeMs: [700, 900], palette: "crimson" }, seeded(7));
  eq("schedule: count", s.length, 12);
  ok("schedule: sorted by release", s.every((w, i) => i === 0 || s[i - 1].at <= w.at));
  ok("schedule: releases inside the window", s.every((w) => w.at >= 300 && w.at <= 700));
  ok("schedule: lives inside the range", s.every((w) => w.life >= 700 && w.life <= 900));
  ok("schedule: starts on the body", s.every((w) => Math.abs(w.x) <= 0.26 && w.y >= -0.37 && w.y <= 0.41));
  ok("schedule: crimson colours", s.every((w) => WISP_PALETTES.crimson.includes(w.rgb)));
  eq("schedule: same seed, same burst", JSON.stringify(scheduleWisps({ count: 5 }, seeded(9))), JSON.stringify(scheduleWisps({ count: 5 }, seeded(9))));
}

/* ── motion ──────────────────────────────────────────────────────────────── */

{
  const w = new Wisp({ x: 0.1, y: 0.2, life: 1200, rnd: seeded(4) });
  const y0 = w.y;
  let alive = true, frames = 0;
  while (alive && frames < 500) { alive = w.update(16); frames++; }
  ok("a wisp rises", w.y < y0 - 0.3);
  ok("a wisp burns out at its life", !alive && Math.abs(frames * 16 - 1200) <= 16);
  ok("its trail is capped", w.trail.length <= 20);
  const v = new Vapour({ x: 0, y: 0.3, rnd: seeded(2) });
  v.update(500);
  ok("vapour rises", v.y < 0.3);
}

/* ── drawing a whole burst, every frame ──────────────────────────────────── */

{
  const ctx = fakeCtx(), r = { x: 400, y: 300, h: 120 };
  const burst = new WispBurst(scheduleWisps({ count: 20, fromMs: 0, spawnOverMs: 600, lifeMs: [500, 1300], palette: "crimson" }, seeded(11)), seeded(12));
  let threw = null, t = 0, frames = 0;
  try {
    // uneven frame times, including a 0 ms frame
    while (burst.alive && frames < 2000) { const dt = [16, 0, 33, 7, 50][frames % 5]; t += dt; burst.step(t, dt); burst.draw(ctx, r); frames++; }
  } catch (e) { threw = e.message; }
  eq("a full burst draws without a canvas error", threw, null);
  ok("the burst ends", !burst.alive);
  ok("it drew something", ctx.calls > 100);
  eq("save/restore balanced", ctx.depth, 0);
}
{
  // the first frame of a wisp: a one-point trail (the mockup's crash)
  const ctx = fakeCtx(), w = new Wisp({ rnd: seeded(5) });
  let threw = null;
  try { w.update(16); w.draw(ctx, { x: 10, y: 10, h: 50 }); w.age = 0; w.trail = [[0, 0]]; w.draw(ctx, { x: 10, y: 10, h: 50 }); } catch (e) { threw = e.message; }
  eq("one-point trail draws", threw, null);
}
{
  const ctx = fakeCtx(), w = new Wisp({ rnd: seeded(6) });
  w.update(16);
  let threw = null;
  try { w.draw(ctx, { x: 0, y: 0, h: 0 }); w.draw(ctx, null); new Vapour().draw(ctx, { x: 0, y: 0, h: 0 }); } catch (e) { threw = e.message; }
  eq("a zero-height or missing rect draws nothing and does not throw", threw, null);
}
{
  // near the very end of its life, alpha is tiny: must not be an exponent
  const ctx = fakeCtx(), w = new Wisp({ life: 1000, rnd: seeded(8) });
  w.update(16); w.update(16); w.age = 1000 - 1e-7;
  let threw = null;
  try { w.draw(ctx, { x: 50, y: 50, h: 80 }); } catch (e) { threw = e.message; }
  eq("a last-instant wisp draws", threw, null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
