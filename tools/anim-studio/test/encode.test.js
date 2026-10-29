"use strict";
// anim-studio — the Chain cue checks in lib/encode.js (2026-10-29): a Chain N
// script with no oni.hit() plays its strikes on the fixed beat, and oni.hit()
// in the OUTER script throws (`oni` lives only in the inner). Plain node.

const assert = require("assert");
const { validate, chainCueWarnings } = require("../lib/encode");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// An outer script in the house shape: pseudo.play with a String.raw inner.
const BT = "`";
const outer = (inner, outerExtra = "") => [
  "(async () => {",
  outerExtra,
  `  const inner = String.raw${BT}`,
  inner,
  `${BT};`,
  "  await game.ONI.pseudo.play({ scriptId: \"anim-studio/test\", scriptSource: inner, params: { strikes: payload.strikes } });",
  "})();",
].join("\n");

const CUED = outer("for (const s of oni.strikes) { oni.hit({ index: s.index }); await oni.hitstop(80); }\noni.fireDone();");
const UNCUED = outer("await wait(300);\noni.fireDone();");

t("a cued script validates clean as a Chain 3", () => {
  const r = validate(CUED, { chain: 3, beatMs: 550 });
  assert.strictEqual(r.ok, true, r.errors.join("; "));
  assert.deepStrictEqual(r.warnings, []);
});

t("an uncued script warns as a Chain 3, with the beat", () => {
  const w = chainCueWarnings(UNCUED, { chain: 3, beatMs: 550 });
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /Chain 3: the script never calls oni\.hit\(\)/);
  assert.match(w[0], /550 ms beat/);
});

t("no Chain count → no cue warning (an ordinary action needs no cues)", () => {
  assert.deepStrictEqual(chainCueWarnings(UNCUED), []);
  assert.deepStrictEqual(chainCueWarnings(UNCUED, { chain: 1 }), []);
});

t("a cue only in a comment does not count", () => {
  const commented = outer("// oni.hit() on contact\n/* oni.hit() */\noni.fireDone();");
  assert.strictEqual(chainCueWarnings(commented, { chain: 2 }).length, 1);
});

t("a URL in the inner is not mistaken for a comment", () => {
  const url = outer("const u = \"https://x/y.webm\"; oni.hit();\noni.fireDone();");
  assert.deepStrictEqual(chainCueWarnings(url, { chain: 2 }), []);
});

t("oni.hit() in the OUTER script warns even without a Chain count", () => {
  const w = chainCueWarnings(outer("oni.fireDone();", "  oni.hit();"));
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /OUTER script/);
});

t("a script with no String.raw inner is checked whole", () => {
  assert.deepStrictEqual(chainCueWarnings("oni.hit();", { chain: 2 }), []);
  assert.strictEqual(chainCueWarnings("await wait(10);", { chain: 2 }).length, 1);
});

t("validate keeps its old one-argument form", () => {
  const r = validate(UNCUED);
  assert.strictEqual(r.ok, true, r.errors.join("; "));
  assert.deepStrictEqual(r.warnings, []);
});

console.log(`\nencode: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
