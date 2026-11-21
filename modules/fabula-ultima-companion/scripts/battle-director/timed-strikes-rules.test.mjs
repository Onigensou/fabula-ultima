// node scripts/battle-director/timed-strikes-rules.test.mjs
import assert from "node:assert/strict";
import { readTimedStrikeConfig, strikeDamage, finisherDamage, judgePress, tierOf, parseZone, autoPress } from "./timed-strikes-rules.js";

const cfg = readTimedStrikeConfig({ strike_count: "6", strike_hit_mult: "0.55", strike_miss_mult: "0.2", finisher_mult: "1.2" });
assert.equal(cfg.count, 6);
assert.deepEqual(cfg.zone, [0.7, 0.92]);
assert.equal(cfg.sweepMs, 460);   // the mockup's timing (user 2026-11-21)
assert.equal(cfg.gapMs, 70);
assert.equal(cfg.autoRate, 0.7);
// swing 10 (Lionheart Form I, HR 0)
assert.equal(strikeDamage(10, true, cfg), 6);   // round(5.5)
assert.equal(strikeDamage(10, false, cfg), 2);
assert.equal(finisherDamage(10, cfg), 12);
// swing 20 (Zarg-style +10 flat folded in once)
assert.equal(strikeDamage(20, true, cfg), 11);
assert.equal(strikeDamage(20, false, cfg), 4);
assert.equal(finisherDamage(20, cfg), 24);
assert.equal(judgePress(0.69, cfg.zone), false);
assert.equal(judgePress(0.70, cfg.zone), true);
assert.equal(judgePress(0.92, cfg.zone), true);
assert.equal(judgePress(null, cfg.zone), false);
assert.deepEqual([6, 5, 4, 3, 2, 0].map((h) => tierOf(h, 6)), ["Perfect", "Strong", "Okay", "Okay", "Fumble", "Fumble"]);
assert.deepEqual(parseZone("0.6-0.8"), [0.6, 0.8]);
assert.deepEqual(parseZone("junk"), [0.7, 0.92]);
let seq = [0.1, 0.5]; const rng = () => seq.shift();
const p = autoPress(cfg, rng); assert.equal(p.hit, true); assert.equal(judgePress(p.pos, cfg.zone), true);
seq = [0.9, 0.2, 0.5]; const m = autoPress(cfg, rng); assert.equal(m.hit, false); assert.equal(judgePress(m.pos, cfg.zone), false);
console.log("timed-strikes-rules: ok");
