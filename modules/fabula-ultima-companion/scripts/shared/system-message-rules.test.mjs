// node scripts/shared/system-message-rules.test.mjs
// System Message Panel — pure rules (mockup v2, 2026-11-10).
import assert from "node:assert/strict";
import { DEFAULTS, parseMarkup, plainText, holdMs, typeMs, normalizeMessage } from "./system-message-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("user-picked defaults: slide + fade, auto, size cfg (scaled after the in-game look)", () => {
  assert.equal(DEFAULTS.enter, "slide");
  assert.equal(DEFAULTS.advance, "auto");
  assert.deepEqual([DEFAULTS.widthPct, DEFAULTS.fontPx1080, DEFAULTS.heightScale, DEFAULTS.topPct], [38, 18, 0.9, 14.5]);
  assert.ok(DEFAULTS.maxQueueAgeMs > 0);
});
t("markup: names, up, down, flat; plain text between", () => {
  assert.deepEqual(parseMarkup("A's resistance to {w:Swords} {up:increased}!"), [
    { t: "A's resistance to " }, { t: "Swords", cls: "kw" }, { t: " " }, { t: "increased", cls: "up" }, { t: "!" },
  ]);
  assert.deepEqual(parseMarkup("{down:decreased}{flat:x}").map((p) => p.cls), ["down", "flat"]);
});
t("markup: an unknown tag or a stray brace stays literal", () => {
  assert.equal(plainText("a {b:c} {w:d"), "a {b:c} {w:d");
});
t("hold follows length, never under the minimum", () => {
  assert.equal(holdMs("Hi"), DEFAULTS.minHoldMs);
  const long = "x".repeat(60);
  assert.equal(holdMs(long), DEFAULTS.holdBaseMs + 60 * DEFAULTS.holdPerCharMs);
  assert.equal(holdMs("{w:Swords}"), holdMs("Swords"));     // markup does not count
});
t("typing time counts visible characters at the panel pace", () => {
  assert.equal(typeMs("{w:abcd}", { ...DEFAULTS, cps: 40 }), 100);
});
t("kinds: system/alert/speech appear all at once, narration types (user note 11-10)", () => {
  assert.equal(normalizeMessage("x").reveal, "instant");
  assert.equal(normalizeMessage({ kind: "alert", text: "x" }).reveal, "instant");
  assert.equal(normalizeMessage({ kind: "speech", text: "x" }).reveal, "instant");
  assert.equal(normalizeMessage({ kind: "narration", text: "x" }).reveal, "type");
});
t("per-line options override the defaults; junk falls back", () => {
  const m = normalizeMessage({ text: "x", reveal: "type", advance: "press", enter: "open", hold: 2500 });
  assert.deepEqual([m.reveal, m.advance, m.enter, m.hold], ["type", "press", "open", 2500]);
  const j = normalizeMessage({ text: "x", kind: "shout", enter: "spin", advance: "later", hold: -1 });
  assert.deepEqual([j.kind, j.enter, j.advance, j.hold], ["system", "slide", "auto", null]);
});
t("speech keeps its speaker; other kinds carry none unless given", () => {
  assert.equal(normalizeMessage({ kind: "speech", speaker: "Rakshasa", text: "x" }).speaker, "Rakshasa");
  assert.equal(normalizeMessage("x").speaker, null);
});

console.log(`system-message-rules: ${n} passed`);
