// node scripts/battle-director/grapple-rules.test.mjs
import assert from "node:assert/strict";
import { resolveSkin, DEFAULT_SKIN, freeSlot, slotPosition, sideOf, isAt, MAX_SLOTS } from "./grapple-rules.js";

let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok", name); };

t("unknown or missing skin falls back to the chain", () => {
  assert.equal(resolveSkin(undefined).id, DEFAULT_SKIN);
  assert.equal(resolveSkin("nope").id, "chain");
  assert.equal(resolveSkin(" Tentacle ").id, "tentacle");
  assert.equal(resolveSkin("tentacle_green").type, "tentacle");
  assert.equal(resolveSkin("iron").type, "chain");
});

t("free slot picks the lowest unused, caps at the last", () => {
  assert.equal(freeSlot([]), 0);
  assert.equal(freeSlot([0, 2]), 1);
  assert.equal(freeSlot([0, 1, 2, 3]), MAX_SLOTS - 1);
});

t("slot 0 stands just past the grappler's body edge, overlapping it", () => {
  // Roper on the mockup stage: centre 330, feet 480, sprite 308 wide; Keren 1x1 box 110, sprite 116x161
  const p = slotPosition({ grappler: { cx: 330, feetY: 480, spriteW: 308 }, held: { spriteW: 116, spriteH: 161, boxW: 110, boxH: 110 }, side: 1, index: 0, grid: 110, edge: 0.24 });
  const cx = p.x + 55, feet = p.y + 55 + 161 / 2;
  assert.ok(Math.abs(cx - (330 + 308 * 0.24 + 116 * 0.2)) < 1, "centre x " + cx);
  assert.ok(Math.abs(feet - 498) < 1, "feet " + feet);
  // its left edge is inside the grappler's sprite: they share the space
  assert.ok(cx - 58 < 330 + 154);
});

t("left side mirrors, grid scales the slot offsets", () => {
  const g = { cx: 1000, feetY: 500, spriteW: 200 }, h = { spriteW: 100, spriteH: 150, boxW: 100, boxH: 100 };
  const r = slotPosition({ grappler: g, held: h, side: 1, index: 1, grid: 220 });
  const l = slotPosition({ grappler: g, held: h, side: -1, index: 1, grid: 220 });
  assert.equal((r.x + 50) - 1000, 1000 - (l.x + 50));
  assert.equal(r.y, l.y);
  assert.equal((r.y + 50 + 75) - 500, -148);   // slot 1 dy -74 at grid 220
});

t("side + isAt", () => {
  assert.equal(sideOf(1300, 330), 1);
  assert.equal(sideOf(100, 330), -1);
  assert.ok(isAt({ x: 10, y: 10 }, { x: 12, y: 9 }));
  assert.ok(!isAt({ x: 10, y: 10 }, { x: 20, y: 10 }));
});

console.log(`grapple-rules: ${n} passed`);
