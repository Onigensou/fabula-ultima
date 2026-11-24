import assert from "node:assert/strict";
import { hpBarSegments, segmentsFromFractions, layerPercents, hasOverflow, overflowColorCss, OVERFLOW_COLOR } from "./hp-overflow.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// below max: identical to the classic bar
let s = hpBarSegments(30, 100);
near(s.fill, 0.3); near(s.over, 0.3); near(s.total, 0.3); near(s.len, 1);
let p = layerPercents(s); near(p.fill, 30); near(p.over, 30); near(p.total, 30);
// below max + shield: shield stacks right of the fill, clipped at the end
s = hpBarSegments(60, 100, 25); near(s.total, 0.85); near(s.shield, 0.25);
s = hpBarSegments(90, 100, 40); near(s.total, 1); near(s.shield, 0.1); near(s.len, 1);
// at max: full, no overflow
s = hpBarSegments(100, 100); near(s.fill, 1); near(s.over, 1); near(s.len, 1);
assert.equal(hasOverflow(100, 100), false);
// above max: bar length = HP; fill = Max/HP, overflow = the rest
assert.equal(hasOverflow(150, 100), true);
s = hpBarSegments(150, 100); near(s.len, 1.5);
p = layerPercents(s); near(p.fill, 100 / 1.5); near(p.over, 100); near(p.total, 100);
// above max + shield: grows to HP + shield, shield never clipped
s = hpBarSegments(150, 100, 50); near(s.len, 2);
p = layerPercents(s); near(p.fill, 50); near(p.over, 75); near(p.total, 100);
// fractions (floating bar payload) agree
s = segmentsFromFractions(1.5, 0.5); near(s.len, 2); near(s.fill, 1);
// tween frame: same layout rendered at a larger len shrinks proportionally
p = layerPercents(hpBarSegments(150, 100), 3); near(p.over, 50);
// bad input
s = hpBarSegments(10, 0); near(s.len, 1); near(s.total, 0);
s = hpBarSegments(-5, 100); near(s.fill, 0);
assert.ok(overflowColorCss.includes(OVERFLOW_COLOR));
console.log("hp-overflow tests passed");
