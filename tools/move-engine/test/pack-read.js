"use strict";
// lib/pack.js readRun: a battle's damage-number stream → the skill's strikes.   node test/pack-read.js
const assert = require("assert/strict");
const { readRun } = require("../lib/pack.js");
const T = "Scene.s.Token.t", C = "Scene.s.Token.c";
const loss = (amount, cascade, extra = {}) => ({ kind: "loss", token: T, resource: "hp", amount, cascade, crit: false, element: "fire", affinity: "RS", ...extra });
const miss = (cascade) => ({ kind: "miss", token: T, cascade });
// a recorded Sonic Blow battle (11-22 runner): 4 of 8 land for 2, then the caster's NEXT action (its own spend) is ignored
const real = [{ kind: "spend", token: C, resource: "mp", amount: 30 }, loss(2, 1), loss(2, 2), miss(3), miss(4), miss(5), loss(2, 6), miss(7), loss(2, 8),
  { kind: "spend", token: C, resource: "mp", amount: 5 }, loss(31, null), { kind: "loss", token: T, resource: "mp", amount: 12 }];
let r = readRun(real, 8);
assert.deepEqual(r.strikes, [2, 2, null, null, null, 2, null, 2]); assert.equal(r.total, 8); assert.equal(r.perfect, false); assert.equal(r.element, "fire"); assert.equal(r.affinity, "RS");
// all land + a Perfect bonus number → perfect, the bonus counted in the total
const perfect = [{ kind: "spend", token: C, resource: "mp", amount: 30 }, ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => loss(3, k)), loss(12, 9)];
r = readRun(perfect, 8);
assert.deepEqual(r.strikes, Array(8).fill(3)); assert.deepEqual(r.extra, [12]); assert.equal(r.total, 36); assert.equal(r.perfect, true);
// a crit flag anywhere marks the run
r = readRun([{ kind: "spend", token: C }, loss(5, 1, { crit: true }), miss(2)], 2);
assert.equal(r.crit, true); assert.deepEqual(r.strikes, [5, null]);
console.log("pack readRun: all tests pass");
