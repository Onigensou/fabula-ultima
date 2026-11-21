// ============================================================================
// Battle stand — the per-actor battleStand flag (battle-stand.js).
//
//     node scripts/battle-director/battle-stand.test.mjs
//
// Checked against the real depth curve of the Great Seal (Valley_Battlemap003),
// the arena the flag was made for: keepSize really keeps the drawn size, the
// solver lands the point on the asked row, and the sprite maths matches the way
// depth-index.js plants a mesh.
// ============================================================================
import assert from "node:assert/strict";
import { readBattleStand, applyBattleStand, spritePointY, solveStandBack, keepSizeAnchor, baseFeetOf, BASE_SPOT_FLAG } from "./battle-stand.js";
import { resolvePreset, buildCamera, buildProjector, battlerScaleAt } from "./battle-stage-3d-rules.js";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok", name); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (eps ${eps})`);

// The Great Seal as a v2 scene: 1682x788 stage at a bleed offset (the shape does not matter to the maths).
const stage = { x: 439, y: 241, w: 1682, h: 788 };
const cfg = resolvePreset("worlds/x/Valley_Battlemap003.webp");
const cam = buildCamera(cfg, stage, 110);
const P = buildProjector(cfg, cam, stage);
const factorAt = (y) => battlerScaleAt(y, cam, P);

test("readBattleStand: nothing asked = null; keepSize defaults on", () => {
  assert.equal(readBattleStand(null), null);
  assert.equal(readBattleStand({}), null);
  assert.equal(readBattleStand({ back: 0, x: 0 }), null);
  assert.deepEqual(readBattleStand({ back: "120" }), { back: 120, x: 0, keepSize: true });
  assert.deepEqual(readBattleStand({ back: 50, x: -10, keepSize: false }), { back: 50, x: -10, keepSize: false });
});

test("applyBattleStand: no stand = unchanged", () => {
  assert.deepEqual(applyBattleStand({ centre: { x: 1, y: 2 }, stand: null }), { centre: { x: 1, y: 2 }, sizeK: 1, anchorY: 0.5 });
});

test("applyBattleStand: back moves up the stage by back * ky, x along by x * kx", () => {
  const r = applyBattleStand({ centre: { x: 800, y: 700 }, stand: { back: 100, x: 20, keepSize: false }, k: { x: 1.5, y: 2 } });
  assert.deepEqual(r.centre, { x: 830, y: 500 });
  assert.equal(r.sizeK, 1);
});

test("applyBattleStand keepSize: drawn size (texture scale x depth scale) unchanged", () => {
  const centre = { x: 744, y: 586 }, feetBelow = 82.5;
  for (const back of [40, 120, 200, -60]) {
    const r = applyBattleStand({ centre, stand: { back, x: 0, keepSize: true }, feetBelow, factorAt });
    near(r.sizeK * factorAt(r.centre.y + feetBelow), factorAt(centre.y + feetBelow), 1e-9, `back ${back}`);
    if (back > 0) assert.ok(r.sizeK > 1, "further back = scaled up");
  }
});

test("spritePointY: matches depth-index planting (bottom edge held, scaled from there)", () => {
  // depth-index: mesh.y = cy + (1 - a) * h0 * (1 - f), mesh height h0 * f, anchor a
  for (const a of [0.5, 1, 0.25]) for (const f of [1, 0.8, 0.6]) {
    const cy = 500, h0 = 800, meshY = cy + (1 - a) * h0 * (1 - f), top = meshY - a * h0 * f, bottom = top + h0 * f;
    near(spritePointY({ cy, h0, anchorY: a, f, v: 0 }), top, 1e-9, `top a${a} f${f}`);
    near(spritePointY({ cy, h0, anchorY: a, f, v: 1 }), bottom, 1e-9, `bottom a${a} f${f}`);
  }
});

test("keepSize: the sprite is drawn exactly as before, only back * ky higher (every point, every anchor)", () => {
  const cy = 586.5, feetBelow = 82.5, h0 = 803.9, f0 = factorAt(cy + feetBelow);
  for (const a of [0.5, 0.8, 0.3]) for (const back of [60, 110, 180]) {
    const r = applyBattleStand({ centre: { x: 0, y: cy }, stand: { back, x: 0, keepSize: true }, feetBelow, factorAt, anchorY: a });
    near(r.anchorY, keepSizeAnchor(a, r.sizeK), 1e-12);
    const f1 = factorAt(r.centre.y + feetBelow);
    for (const v of [0, 0.25, 470 / 837, 1]) {
      const before = spritePointY({ cy, h0, anchorY: a, f: f0, v });
      const after = spritePointY({ cy: r.centre.y, h0: h0 * r.sizeK, anchorY: r.anchorY, f: f1, v });
      near(after, before - back, 1e-9, `a${a} back${back} v${v}`);
    }
  }
  assert.equal(keepSizeAnchor(0.5, 1), 0.5);
  near(keepSizeAnchor(0.5, 2), 0.75, 1e-12);
});

test("solveStandBack: lands the point on the target row, and keeps the size", () => {
  const view = { y: 635, scale: 1.1415 }, screenH = 1080, cy = 586, feetBelow = 82.5, h0 = 804, v = 470 / 837;
  const f0 = factorAt(cy + feetBelow);
  const y0 = (spritePointY({ cy, h0, f: f0, v }) - view.y) * view.scale + screenH / 2;
  const target = y0 - 120;
  const s = solveStandBack({ targetY: target, view, screenH, cy, feetBelow, h0, v, factorAt });
  assert.ok(s, "solvable");
  near(s.y, target, 1e-6, "on target");
  assert.ok(s.back > 0, "further back");
  near(s.sizeK * s.f, f0, 1e-9, "same drawn size");
  // and it agrees with applyBattleStand + spritePointY
  const r = applyBattleStand({ centre: { x: 0, y: cy }, stand: { back: s.back, x: 0, keepSize: true }, feetBelow, factorAt });
  const yc = spritePointY({ cy: r.centre.y, h0: h0 * r.sizeK, anchorY: r.anchorY, f: factorAt(r.centre.y + feetBelow), v });
  near(s.back, (y0 - target) / view.scale, 1e-6, "rises by back * scale");
  near((yc - view.y) * view.scale + screenH / 2, target, 1e-6, "round trip");
});

test("solveStandBack: out of reach = null", () => {
  const view = { y: 635, scale: 1 };
  assert.equal(solveStandBack({ targetY: -5000, view, screenH: 1080, cy: 586, feetBelow: 82, h0: 800, v: 0.5, factorAt }), null);
});

test("baseFeetOf: a battleStand token's crystal spot is the UN-offset spot; no stand = unchanged", () => {
  const NS = "fabula-ultima-companion", g = 110, centre = { x: 840, y: 586 };
  const stand = readBattleStand({ back: 110 });
  const moved = applyBattleStand({ centre, stand, k: { x: 1, y: 1 } }).centre;
  assert.equal(moved.y, 586 - 110);
  const td = { x: moved.x - g, y: moved.y - g, width: 2, height: 2, flags: { [NS]: { [BASE_SPOT_FLAG]: { x: centre.x, y: centre.y } } } };
  // the offset feet would be moved.y + g; the crystal must use the formation feet
  assert.deepEqual(baseFeetOf(td, NS, g), { x: 840, y: 586 + g });
  const plain = { x: 100, y: 200, width: 1, height: 1, flags: {} };
  assert.deepEqual(baseFeetOf(plain, NS, g), { x: 100 + g / 2, y: 200 + g });
});

console.log(`${n} passed`);
