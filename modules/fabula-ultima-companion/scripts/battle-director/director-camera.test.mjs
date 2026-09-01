// ============================================================================
// Battle Director — camera regression harness.
//
//     node scripts/battle-director/director-camera.test.mjs
//
// Bare Node, no Foundry. The pure half of director-camera takes plain objects
// and an explicit viewport, which is what makes this possible — keep it that
// way.
//
// The load-bearing assertions are the legacy-equivalence ones. If a scene
// without the stage flag ever resolved to anything other than its own full
// rect, all fifteen existing conflict scenes would silently reframe and their
// token layouts would drift.
// ============================================================================

import {
  resolveStage,
  computeRestView,
  clampView,
  focusView,
  pivotShift,
} from "./director-camera.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const near = (label, got, want, tol = 0.01) => {
  const ok = Math.abs(got - want) <= tol;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${got}\n        want ${want}`}`);
};
const ok = (label, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${label}`);
};

// Fixtures --------------------------------------------------------------
const LEGACY_RECT = { x: 0, y: 0, w: 1682, h: 788 };          // pre-v2 scene
const V2_STAGE    = { x: 439, y: 241, w: 1682, h: 788 };      // Valley et al
const V2_CANVAS   = { x: 0, y: 0, width: 2560, height: 1270 };
const LEGACY_CANVAS = { x: 0, y: 0, width: 1682, height: 788 };
const HD = { w: 1920, h: 1080 };

console.log("\n── resolveStage ──");

eq("no flag falls back to the scene rect, marked non-explicit",
  resolveStage(null, LEGACY_RECT),
  { x: 0, y: 0, w: 1682, h: 788, explicit: false });

eq("a complete flag wins and is marked explicit",
  resolveStage(V2_STAGE, { x: 0, y: 0, w: 2560, h: 1270 }),
  { x: 439, y: 241, w: 1682, h: 788, explicit: true });

eq("a partial flag is rejected in favour of the fallback",
  resolveStage({ x: 439, y: 241, w: 1682 }, LEGACY_RECT),
  { x: 0, y: 0, w: 1682, h: 788, explicit: false });

eq("a zero-area flag is rejected",
  resolveStage({ x: 0, y: 0, w: 0, h: 788 }, LEGACY_RECT),
  { x: 0, y: 0, w: 1682, h: 788, explicit: false });

// Number(null) is 0 and Number("") is 0 — a half-written flag must NOT be
// accepted as a complete rect whose origin happens to be zero.
eq("a null field is rejected, not coerced to 0",
  resolveStage({ x: 439, y: null, w: 1682, h: 788 }, LEGACY_RECT),
  { x: 0, y: 0, w: 1682, h: 788, explicit: false });

eq("a blank field is rejected, not coerced to 0",
  resolveStage({ x: 439, y: "", w: 1682, h: 788 }, LEGACY_RECT),
  { x: 0, y: 0, w: 1682, h: 788, explicit: false });

eq("garbage is rejected",
  resolveStage({ x: 439, y: "abc", w: 1682, h: 788 }, LEGACY_RECT),
  { x: 0, y: 0, w: 1682, h: 788, explicit: false });

eq("numeric strings ARE accepted — these flags get hand-authored",
  resolveStage({ x: "439", y: "241", w: "1682", h: "788" }, LEGACY_RECT),
  { x: 439, y: 241, w: 1682, h: 788, explicit: true });

eq("a padded legacy scene falls back to its padding origin, not (0,0)",
  resolveStage(null, { x: 440, y: 220, w: 1682, h: 788 }),
  { x: 440, y: 220, w: 1682, h: 788, explicit: false });

ok("a malformed scene still yields a finite rect",
  Object.values(resolveStage(null, null)).slice(0, 4).every(Number.isFinite));

console.log("\n── computeRestView: contain, not cover ──");

{
  // Stage is 2.13:1, viewport 1.78:1 → width binds, height gets bleed.
  const v = computeRestView(V2_STAGE, HD);
  near("scale contains the stage width", v.scale, 1920 / 1682);
  near("pivot is the stage centre x", v.x, 439 + 841);
  near("pivot is the stage centre y", v.y, 241 + 394);
  ok("the whole stage width is visible", HD.w / v.scale >= V2_STAGE.w - 0.01);
  ok("the visible height exceeds the stage (bleed fills it)", HD.h / v.scale > V2_STAGE.h);
}

{
  // Ultrawide: now HEIGHT binds and the bleed fills the sides instead.
  const v = computeRestView(V2_STAGE, { w: 3440, h: 1440 });
  near("ultrawide contains the stage height", v.scale, 1440 / 788);
  ok("the whole stage height is visible", 1440 / v.scale >= V2_STAGE.h - 0.01);
  ok("the visible width exceeds the stage", 3440 / v.scale > V2_STAGE.w);
}

console.log("\n── clampView: cover the canvas, pin the pivot ──");

{
  // The live battle-end bug: aim past the right edge of a legacy scene.
  const bad = { x: 1587, y: 400, scale: 1.7 };
  const v = clampView(bad, LEGACY_CANVAS, HD);
  const halfW = HD.w / v.scale / 2;
  ok("pivot pulled back inside the canvas", v.x + halfW <= LEGACY_CANVAS.width + 0.01);
  ok("pivot moved left of where it was aimed", v.x < bad.x);
}

{
  // Same shot on a v2 canvas: barely clipped, so barely moved.
  const v = clampView({ x: 2026, y: 640, scale: 1.7 }, V2_CANVAS, HD);
  ok("v2 canvas absorbs almost all of the same overshoot", 2026 - v.x < 60);
}

{
  // Zoomed out past the canvas — scale must be RAISED to cover it.
  const v = clampView({ x: 1280, y: 635, scale: 0.2 }, V2_CANVAS, HD);
  near("scale raised to the cover fit", v.scale, Math.max(1920 / 2560, 1080 / 1270));
  ok("no void horizontally", HD.w / v.scale <= V2_CANVAS.width + 0.01);
  ok("no void vertically", HD.h / v.scale <= V2_CANVAS.height + 0.01);
}

{
  // Exactly-fills case: bounds collapse, must land dead centre not NaN.
  const scale = Math.max(1920 / 2560, 1080 / 1270);
  const v = clampView({ x: 0, y: 0, scale }, V2_CANVAS, HD);
  ok("degenerate bounds stay finite", Number.isFinite(v.x) && Number.isFinite(v.y));
  near("degenerate bounds centre the pivot", v.y, 635, 1);
}

console.log("\n── focusView: stage-space intent ──");

{
  // The same intent on two very different windows must frame the same way
  // RELATIVE to the stage — that is the whole point of broadcasting intent.
  const args = { stage: V2_STAGE, canvasRect: V2_CANVAS };
  const big = focusView({ point: { x: 1280, y: 635 }, zoom: 1.5 }, { ...args, viewport: HD });
  const small = focusView({ point: { x: 1280, y: 635 }, zoom: 1.5 }, { ...args, viewport: { w: 1280, h: 720 } });
  near("both clients show the same stage width", HD.w / big.scale, 1280 / small.scale, 1);
}

{
  const v = focusView({ point: { x: 1280, y: 635 }, zoom: 1 }, {
    stage: V2_STAGE, canvasRect: V2_CANVAS, viewport: HD,
  });
  near("zoom 1 is the rest framing", v.scale, computeRestView(V2_STAGE, HD).scale);
}

{
  const v = focusView({ point: null, zoom: 1 }, {
    stage: V2_STAGE, canvasRect: V2_CANVAS, viewport: HD,
  });
  near("a missing point falls back to the stage centre", v.x, 1280);
}

console.log("\n── legacy equivalence (load-bearing) ──");

{
  const stage = resolveStage(null, LEGACY_RECT);
  eq("legacy stage IS the scene rect", { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, LEGACY_RECT);
  ok("legacy scenes are not marked explicit, so rest framing stays opt-in",
    stage.explicit === false);

  // computeLayout scales anchors by stage.w/1682 and stage.h/788 — on a legacy
  // scene both must be exactly 1 and the origin exactly 0, or every token moves.
  eq("layout scale factors collapse to identity",
    { sx: stage.w / 1682, sy: stage.h / 788, ox: stage.x, oy: stage.y },
    { sx: 1, sy: 1, ox: 0, oy: 0 });
}

console.log("\n── reserved insets: nothing hides behind the chat box ──");

{
  // A 300px sidebar on a 1920x1027 window. Without the reserve the stage is
  // contained in the FULL window, so its right edge sits under the chat box —
  // roughly 260 canvas px of every conflict stage.
  const HD_OPEN = { w: 1920, h: 1027, insets: { top: 0, right: 300, bottom: 0, left: 0 } };
  const HD_SHUT = { w: 1920, h: 1027, insets: { top: 0, right: 0, bottom: 0, left: 0 } };

  const open = computeRestView(V2_STAGE, HD_OPEN);
  const shut = computeRestView(V2_STAGE, HD_SHUT);

  near("reserving the sidebar shrinks the fit", open.scale, Math.min(1620 / 1682, 1027 / 788));
  ok("a reserved fit is smaller than an unreserved one", open.scale < shut.scale);

  // The whole point: the stage has to land inside the VISIBLE rect.
  const half = (V2_STAGE.w * open.scale) / 2;
  const stageCentreScreenX = 1920 / 2 - (open.x - (V2_STAGE.x + V2_STAGE.w / 2)) * open.scale;
  ok("stage right edge clears the sidebar", stageCentreScreenX + half <= 1920 - 300 + 0.5);
  ok("stage left edge stays on screen", stageCentreScreenX - half >= -0.5);

  ok("no insets means no pivot shift", shut.x === V2_STAGE.x + V2_STAGE.w / 2);
  ok("a right inset pushes the pivot right", open.x > V2_STAGE.x + V2_STAGE.w / 2);
}

{
  // The shift is scale-dependent: the same chrome is fewer world units when
  // zoomed in. Getting this wrong offsets every cinematic by a drifting amount.
  const ins = { top: 0, right: 300, bottom: 0, left: 0 };
  near("shift at scale 1 is half the inset", pivotShift(ins, 1).x, 150);
  near("shift halves when the scale doubles", pivotShift(ins, 2).x, 75);
  eq("no insets, no shift", pivotShift(null, 1), { x: 0, y: 0 });
  eq("a zero scale cannot divide", pivotShift(ins, 0), { x: 0, y: 0 });
}

{
  // Legacy guard: a viewport with NO insets field must behave exactly as it
  // did before this existed, or every shipped conflict scene reframes.
  const before = computeRestView(V2_STAGE, { w: 1920, h: 1027 });
  eq("an inset-less viewport is unchanged",
    { x: before.x, y: before.y },
    { x: V2_STAGE.x + V2_STAGE.w / 2, y: V2_STAGE.y + V2_STAGE.h / 2 });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
