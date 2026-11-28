// ============================================================================
// token-tint grade mode (the Zombie look, approved 2026-11-28) — pure checks.
//
//     node scripts/battle-director/token-tint-grade.test.mjs
//
// Bare Node, no Foundry: the colour matrix, its fade, and the parity rules —
//   * neutral values are the identity (the sprite as drawn), so no other status changes;
//   * the "mul" blend at strength s is exactly today's multiply wash lerp(white, C, s);
//   * the locked Zombie config reproduces the mockup's own maths (spot pixels).
// The shader / blur is GPU work and is checked in the sandbox, not here.
// ============================================================================

globalThis.Hooks = globalThis.Hooks ?? { on() {}, once() {}, callAll() {} };
const T = await import("./token-tint.js");
const SC = await import("./status-cues.js").catch(() => null);
const B = await import("./status-cues-back.js");

let pass = 0, fail = 0;
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
function ok(label, cond, info = "") { if (cond) pass++; else { fail++; console.error(`FAIL  ${label} ${info}`); } }
const apply = (M, c) => [0, 1, 2].map((i) => M[i * 4] * c[0] + M[i * 4 + 1] * c[1] + M[i * 4 + 2] * c[2] + M[i * 4 + 3]);
const allNear = (a, b, e = 1e-6) => a.length === b.length && a.every((v, i) => near(v, b[i], e));

// ── neutral = identity ─────────────────────────────────────────────────────
ok("neutral matrix = identity", allNear(T.buildGradeMatrix({}), T.IDENTITY_3X4));
for (const blend of ["mul", "col", "scr"]) {
  ok(`neutral (${blend}, str 0) = identity`, allNear(T.buildGradeMatrix({ blend, tint: [0.3, 0.5, 0.9], str: 0 }), T.IDENTITY_3X4, 1e-9));
}
const neutralSpec = T.makeGradeSpec({ tintHex: "#a99fbe", hue: 0, str: 0, gamma: 1, glow: 0, glowPx: 0 });
const n1 = T.gradeAt(neutralSpec, 1);
ok("neutral spec at p=1: identity, gamma 1, no glow", allNear(n1.matrix, T.IDENTITY_3X4, 1e-9) && n1.exponent === 1 && n1.glowA === 0);

// ── multiply parity with today's wash (mesh.tint = lerp(WHITE, colour, strength)) ──
for (const [col, s] of [[[1, 0.788, 0.576], 0.35], [[0.651, 0.898, 0.541], 0.42], [[0.663, 0.788, 1], 0.38]]) {
  const M = T.buildGradeMatrix({ blend: "mul", tint: col, str: s });
  const want = col.map((c) => 1 + (c - 1) * s);
  for (const px of [[1, 1, 1], [0.2, 0.5, 0.8], [0.9, 0.1, 0.3]]) {
    ok(`mul parity ${col} @${s} on ${px}`, allNear(apply(M, px), px.map((v, i) => v * want[i]), 1e-9));
  }
}

// ── fade ───────────────────────────────────────────────────────────────────
const Z = T.makeGradeSpec({ blend: "col", sat: 2, con: 1, drain: 0, exp: 0.64, tintHex: "#a99fbe", hue: 60, str: 1, bright: 0, gamma: 1.38, glow: 1, glowPx: 6.5, refH: 250 });
const z0 = T.gradeAt(Z, 0), z1 = T.gradeAt(Z, 1), zh = T.gradeAt(Z, 0.5);
ok("p=0 is the sprite as drawn", allNear(z0.matrix, T.IDENTITY_3X4) && z0.exponent === 1 && z0.glowA === 0);
ok("p=1 is the full grade", allNear(z1.matrix, Z.matrix) && near(z1.exponent, 1 / 1.38) && z1.glowA === 1);
ok("p=.5 halfway (mockup lerp + gamma 1/(1+(g-1)p))", near(zh.exponent, 1 / 1.19) && near(zh.glowA, 0.5)
  && allNear(zh.matrix, Z.matrix.map((v, i) => (T.IDENTITY_3X4[i] + v) / 2)));

// ── the locked Zombie config vs the mockup's own maths ─────────────────────
// Tint: #a99fbe turned +60° (HSL). Mockup hueShift reference value:
const tint = T.hueShiftHsl([0xa9 / 255, 0x9f / 255, 0xbe / 255], 60);
ok("tint = #a99fbe +60°", allNear(tint, Z.tint, 1e-12));
ok("tint hue moved toward mauve (r > b > g)", tint[0] > tint[2] && tint[2] > tint[1], JSON.stringify(tint));
// keep-lightness at amount 1: a grey pixel g maps to L(g·sat·exp)·C/L(C) → grey keeps its lightness ×0.64
const L = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
for (const g of [0.2, 0.5, 0.9]) {
  const out = apply(Z.matrix, [g, g, g]);
  ok(`grey ${g}: lightness = ${g}×0.64`, near(L(out), g * 0.64, 1e-9));
  ok(`grey ${g}: hue = the tint`, near(out[0] / out[1], tint[0] / tint[1], 1e-9));
}
// rim = tint lightened 35% toward white, rounded to 8-bit like the mockup's rgba()
ok("rim colour", allNear(Z.rim, tint.map((x) => Math.round((x + (1 - x) * 0.35) * 255) / 255), 1e-12));

// ── miasma layout (status-cues-back) ───────────────────────────────────────
const M = { cov: 0.7, rate: 19, size: 2, spd: 2.5, mo: 0.4, mc: "96,58,140" };
const puffs = B.miasmaPuffs("tok1", M);
ok("19 puffs", puffs.length === 19);
const back = puffs.filter((p) => p.back).length;
ok("about a third behind (every 3rd body puff)", back >= 3 && back <= 7, `back=${back}`);
ok("puffs stay within coverage (feet → 70% × 92%)", puffs.every((p) => p.yb <= 0.7 * 0.92 + 0.011 && p.yb >= -0.03));
ok("deterministic per token", JSON.stringify(B.miasmaPuffs("tok1", M)) === JSON.stringify(puffs));
ok("2.5× drift speed: durations (3..4.8)/2.5", puffs.every((p) => p.d >= 1.2 - 1e-9 && p.d <= 1.92 + 1e-9));
const f0 = B.mistFrame(0, 0.4), f3 = B.mistFrame(0.3, 0.4), f7 = B.mistFrame(0.7, 0.4), f1 = B.mistFrame(1, 0.4);
ok("zbMist keyframes", near(f0.alpha, 0) && near(f0.scale, 0.6) && near(f3.alpha, 0.4) && near(f7.alpha, 0.32) && near(f1.alpha, 0) && near(f1.scale, 1.45));

// ── wash order: Zombie first ───────────────────────────────────────────────
if (SC?.ZOMBIE_LOOK) ok("ZOMBIE_LOOK locked values", JSON.stringify(SC.ZOMBIE_LOOK.grade) === JSON.stringify({ blend: "col", sat: 2, con: 1, drain: 0, exp: 0.64, tintHex: "#a99fbe", hue: 60, str: 1, bright: 0, gamma: 1.38, glow: 1, glowPx: 6.5, refH: 250 }));
if (SC?.BLEED_LOOK) ok("BLEED_LOOK locked values", JSON.stringify(SC.BLEED_LOOK) === JSON.stringify({ icon: "heart", line: "blade", side: "back", is: 44, ox: 70, oy: 31, gs: 76, ga: 0.85, pp: 1.4, lt: 2.4, la: -55 }));
if (!SC) console.log("  (status-cues.js not importable in bare Node; locked-value checks skipped)");

console.log(fail ? `token-tint-grade: ${fail} FAILED, ${pass} passed` : `token-tint-grade: all ${pass} passed`);
if (fail) process.exit(1);
