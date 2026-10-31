// ============================================================================
// Pixel entrance styles — table, selection and floor harness.
//
//     node scripts/battle-director/pixel-entrance-styles.test.mjs
//
// Bare Node, no Foundry. Covers the pure half: the style table and how the
// entrance reads it, the dash's start / glint maths, and the floor maps the
// effects draw their floor parts through. The renderer itself (PIXI, the 3D
// camera, the token) belongs in a live capture, not here.
//
// The load-bearing assertions are the flat-floor ones: with no 3D camera,
// floor.js must draw EXACTLY what pixelfx's own band / floorRing draw, pixel
// for pixel, because the approved mockup was drawn with those. (The effect
// modules themselves were checked pixel-identical to the mockup's on the
// whole timeline when they were ported.)
// ============================================================================

import { PIXEL_ENTRANCE_STYLES, FRAME_PAD, fadeReveal, dashSpan } from "./pixel-entrance-styles.js";
import { entranceStyleFromFlags, planEntrance, DEFAULT_ENTRANCE_STYLE, ENTRANCE_MODULE_ID, ENTRANCE_STYLE_FLAG } from "./boss-entrance-fx.js";
import { GATHER_STYLES } from "./gather-styles.js";
import { createFrame, createFx, band as pfxBand, Painter } from "./pixel-entrance/pixelfx/core/index.js";
import { floorRing as pfxRing } from "./pixel-entrance/pixelfx/fx/arcane/_lib.js";
import { VOID } from "./pixel-entrance/pixelfx/fx/shadow/_lib.js";
import { makeFloor, band, ring } from "./pixel-entrance/floor.js";
import * as voidDash from "./pixel-entrance/void-dash.js";
import * as blinkInHd from "./pixel-entrance/blink-in-hd.js";
import * as summonCircleHd from "./pixel-entrance/summon-circle-hd.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};
const ok = (label, cond) => eq(label, !!cond, true);
const withStyle = (s) => ({ [ENTRANCE_MODULE_ID]: { [ENTRANCE_STYLE_FLAG]: s } });
const MODULES = { "void-dash": voidDash, "blink-in-hd": blinkInHd, "summon-circle-hd": summonCircleHd };

/* ── The table ───────────────────────────────────────────────────────────── */

eq("three styles", Object.keys(PIXEL_ENTRANCE_STYLES), ["voidDash", "blinkFeathers", "summonCircle"]);
for (const [k, s] of Object.entries(PIXEL_ENTRANCE_STYLES)) {
  ok(`${k}: names a shipped effect`, MODULES[s.module]);
  ok(`${k}: renderer is pixel`, s.renderer === "pixel");
  ok(`${k}: VOID palette (the approved one)`, s.palette === "VOID");
  ok(`${k}: totalMs is the effect's own length`, Math.abs(s.totalMs / 1000 - MODULES[s.module].meta.duration) < 1e-9);
  ok(`${k}: no key shared with the gathers`, !Object.prototype.hasOwnProperty.call(GATHER_STYLES, k));
  ok(`${k}: has a label`, typeof s.label === "string" && s.label.length > 0);
  // the creature is fully shown by the end, or the hand-off to the token pops
  const end = s.reveal.mode === "module" ? MODULES[s.module].reveal(s.totalMs / 1000) : fadeReveal(s.reveal, s.totalMs / 1000);
  eq(`${k}: fully revealed at the end`, [end.a, end.rise, end.shadow], [1, 1, 1]);
}
// the approved reveal beats
eq("dash shows at 0.33 s", [fadeReveal(PIXEL_ENTRANCE_STYLES.voidDash.reveal, 0.329).a, fadeReveal(PIXEL_ENTRANCE_STYLES.voidDash.reveal, 0.351).a], [0, 1]);
eq("blink shows at 0.48 s", fadeReveal(PIXEL_ENTRANCE_STYLES.blinkFeathers.reveal, 0.48).a, 0);
ok("circle: hidden before the flash, rising after", summonCircleHd.reveal(0.79).a === 0 && summonCircleHd.reveal(0.81).a === 1 && summonCircleHd.reveal(0.9).rise < 1);
ok("no flame trail on the dash (rejected by the user)", !/flame|fire/i.test(JSON.stringify(PIXEL_ENTRANCE_STYLES.voidDash)));

/* ── Selection ───────────────────────────────────────────────────────────── */

for (const k of Object.keys(PIXEL_ENTRANCE_STYLES)) eq(`flag ${k} reads as itself`, entranceStyleFromFlags(withStyle(k)), k);
eq("typo'd pixel style → fade", entranceStyleFromFlags(withStyle("voiddash")), DEFAULT_ENTRANCE_STYLE);
{
  const styles = { a: "fade", b: "voidDash", c: "summonCircle" };
  const plan = planEntrance(["a", "b", "c"], (id) => styles[id], () => false);
  eq("pixel styles enter with the group, not fading", plan, { queue: [], fading: ["a"], descending: [{ id: "b", style: "voidDash" }, { id: "c", style: "summonCircle" }] });
}

/* ── The dash's start and glint ──────────────────────────────────────────── */

// the mockup: feet 362 px from the left edge, glint 80 px inside it, 73 px wide
eq("mockup span", dashSpan({ edge: 362, inset: 80, bodyW: 73 }), { from: -460, glint: -282 });
{
  const far = dashSpan({ edge: 1100, inset: 80, bodyW: 73 });
  ok("far from the edge: starts off-screen", -far.from >= 1100 + 73 / 2);
  eq("far from the edge: glint 80 px inside it", far.glint, -1020);
  const near = dashSpan({ edge: 60, inset: 80, bodyW: 73 });
  ok("hugging the edge: the glint keeps clear of the body", near.glint <= -146 && near.glint >= near.from);
}

/* ── Floor maps ──────────────────────────────────────────────────────────── */

const frameEq = (a, b) => a.color.every((v, i) => v === b.color[i]) && a.light.every((v, i) => v === b.light[i]);
const paint = (fn) => { const f = createFrame(220, 120); const p = new Painter(f); p.place(110, 60); fn(p); return f; };
const RAMP = [VOID[3], VOID[5], VOID[6], "#ffffff"];
for (const sy of [0.2, 0.24, 0.3]) {
  const F = makeFloor(null, sy);
  for (const [r, th] of [[6, 2], [34, 3], [72, 6]]) {
    const near = (g) => Math.sin(g) >= 0;
    ok(`flat band sy ${sy} r ${r} = pixelfx band`, frameEq(paint((p) => pfxBand(p, 0, 0, r, sy, th, 0.9, RAMP, near, true)), paint((p) => band(p, F, 0, 0, r, th, 0.9, RAMP, near, true))));
    ok(`flat ring sy ${sy} r ${r} = pixelfx floorRing`, frameEq(paint((p) => pfxRing(p, 0, 0, r, sy, VOID[6], 0.8)), paint((p) => ring(p, F, 0, 0, r, VOID[6], 0.8))));
  }
  const F2 = makeFloor(null, sy, 9);
  ok(`flat ring on a lowered line (floorDy 9, sy ${sy}) = pixelfx`, frameEq(paint((p) => pfxRing(p, 0, 9, 40, sy, VOID[6], 0.8, (g) => Math.sin(g) < 0)), paint((p) => ring(p, F2, 0, 0, 40, VOID[6], 0.8, (g) => Math.sin(g) < 0))));
}
{
  const F = makeFloor(null, 0.3, 5);
  eq("flat: at() is the mockup's squash", F.at(10, 20), [10, 5 + 6]);
  eq("flat: inv() undoes at()", F.inv(...F.at(-7, 13)).map((v) => Math.round(v * 1e9) / 1e9), [-7, 13]);
  eq("flat: the dash comes from the left", F.front(), [1, 0]);
  // a camera turned 30° round the creature: the floor's x axis drawn toward the viewer
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const T = makeFloor({ ex: [c, 0.37 * s], ez: [-s, 0.37 * c] }, 0.3);
  eq("turned: inv() undoes at()", T.inv(...T.at(12, -30)).map((v) => Math.round(v * 1e9) / 1e9), [12, -30]);
  const d = T.front(), sx = T.at(d[0], d[1])[0];
  ok("turned: the front direction is drawn furthest to the right", [0, 1, 2, 3, 4, 5].every((i) => { const a = (i / 6) * Math.PI * 2; return T.at(Math.cos(a), Math.sin(a))[0] <= sx + 1e-9; }));
}

/* ── Effects stay inside their frames (flat and under a turned camera) ──── */
// The frame the runtime draws: the layout plus FRAME_PAD all round.

function actor(w, h) {
  const mask = new Uint8Array(w * h), pix = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = (x - w / 2) / (w / 2), ny = (y - h / 2) / (h / 2);
    if (nx * nx + ny * ny < 1) { mask[y * w + x] = 1; pix[y * w + x] = (0xff000000 | ((x * 3) & 255) << 16 | ((y * 5) & 255) << 8 | 200) >>> 0; }
  }
  return { mask: { w, h, data: mask }, pixels: pix, x: -Math.floor(w / 2), y: -h, w, h, k: 2, head: [0, -h], chest: [0, Math.round(-h * 0.68)] };
}
const FLOORS = {
  flat: null,
  "3D rest": { ex: [1, 0], ez: [0, 0.37] },
  "3D turned": { ex: [0.87, 0.18], ez: [-0.5, 0.32] },
};
const CASES = [
  ["voidDash", actor(73, 69), { from: -460, glint: -282, dust: ["#a8794a", "#c99a64", "#e2bd8a"] }],
  ["blinkFeathers", actor(91, 106), {}],
  ["summonCircle", actor(122, 173), { floorDy: 9 }],
];
for (const [key, A, extra] of CASES) {
  const cfg = PIXEL_ENTRANCE_STYLES[key], mod = MODULES[cfg.module];
  for (const [fname, floor] of Object.entries(FLOORS)) {
    const o = { ...mod.meta.options, ...cfg.options, palette: VOID, ...extra, actor: A, floor };
    const L = mod.layout(o), [w, h] = L.size.map((v) => Math.ceil(v) + 2 * FRAME_PAD), [ox, oy] = L.origin.map((v) => v + FRAME_PAD);
    // draw into a frame twice the size with the layout's box in the middle; nothing may land outside the box
    const W = w * 2, H = h * 2, bx = Math.floor(w / 2), by = Math.floor(h / 2);
    const fx = createFx(mod, { ...o, x: ox + bx, y: oy + by });
    const big = createFrame(W, H);
    let outside = 0, drawn = 0, threw = null;
    try {
      for (let t = 0; t < mod.meta.duration; t += 1 / 30) {
        fx.update(1 / 30);
        big.color.fill(0); big.light.fill(0);
        fx.draw(big);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!big.color[i] && !(big.light[i] & 0xffffff)) continue;
          drawn++;
          if (x < bx || y < by || x >= bx + w || y >= by + h) outside++;
        }
      }
    } catch (e) { threw = e.message; }
    eq(`${key} / ${fname}: runs its whole length`, threw, null);
    ok(`${key} / ${fname}: draws something`, drawn > 1000);
    ok(`${key} / ${fname}: stays inside its frame (${outside} of ${drawn} px outside)`, outside === 0);
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
