// ============================================================================
// Status tooltip helpers — formatting, order, numerals.
//
//     node scripts/battle-director/status-tip.test.mjs
//
// The tooltip text is built from world descriptions and pushed into
// data-tooltip as HTML, so it must escape first and highlight second.
// ============================================================================
import assert from "node:assert/strict";
import { formatRulesText, sortRows, rowTurns, rowSpent, statusTipHTML, arcanumMergeLine } from "./status-tip.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };

t("escapes before highlighting", () => {
  const s = formatRulesText("<script>alert(1)</script> Fire");
  assert.ok(!s.includes("<script>"));
  assert.ok(s.includes('class="fu-st-e e-fire"'));
});

t("attributes, actions, values, terms", () => {
  const s = formatRulesText("Decrease 【MIG】 by one stage. Cannot use the 【Spell】 Action. Accuracy −2, +10 Max HP");
  assert.ok(s.includes('<span class="fu-st-k stat">MIG</span>'));
  assert.ok(s.includes('<span class="fu-st-k act">Spell</span>'));
  assert.ok(s.includes('<span class="fu-st-k neg">−2</span>'));
  assert.ok(s.includes('<span class="fu-st-k pos">+10</span>'));
  assert.ok(s.includes('<span class="fu-st-k kw">one stage</span>'));
  assert.ok(s.includes('<span class="fu-st-k kw">Accuracy</span>'));
});

t("link markup collapses to its label", () => {
  const s = formatRulesText("Inflicts @UUID[Item.abc.ActiveEffect.x]{Burn} and @Status[Wet]");
  assert.ok(s.includes("Burn") && s.includes("Wet") && !s.includes("@UUID") && !s.includes("@Status"));
});

t("debuffs, buffs, ready, markers; stable inside a tier", () => {
  const rows = [
    { name: "Hot-Pot", tier: "marker" }, { name: "Guard", tier: "buff" }, { name: "Slow", tier: "debuff" },
    { name: "Ready A", tier: "ready" }, { name: "Burn", tier: "debuff" },
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.name), ["Slow", "Burn", "Guard", "Ready A", "Hot-Pot"]);
});

t("numerals only for turns / uses; spent = 0 charges", () => {
  assert.equal(rowTurns({ lifetime: { kind: "turns" }, short: "2 turns" }), 2);
  assert.equal(rowTurns({ lifetime: { kind: "uses" }, short: "1 use" }), 1);
  assert.equal(rowTurns({ lifetime: { kind: "battle" }, short: "Battle" }), null);
  assert.equal(rowSpent({ lifetime: { counter: "0/1" } }), true);
  assert.equal(rowSpent({ lifetime: { counter: "1/1" } }), false);
});

t("tooltip header carries the tier and never raw names", () => {
  const h = statusTipHTML({ name: "Bad <b>", img: "x.png", short: "2 turns", lifetime: { label: "2 turns left" }, description: "Taking Fire damage." }, { tier: "debuff" });
  assert.ok(h.includes("t-debuff") && h.includes("Debuff") && h.includes("Bad &lt;b&gt;"));
});

t("an escaped ampersand reaches the screen once-escaped", () => {
  const h = statusTipHTML({ name: "M", img: "x.png", description: "<p>Recover HP &amp; MP.</p>", sources: [] }, { tier: "buff" });
  assert.ok(h.includes("HP &amp; MP") && !h.includes("&amp;amp;"));
});

t("the merge status says what Dismiss will do now", () => {
  const ae = (f) => ({ flags: { "fabula-ultima-companion": { arcanumMerge: true, ...f } } });
  const plain = "Dismiss is offered at the start and end of your turn.";
  assert.equal(arcanumMergeLine({ flags: {} }, 3), "");
  assert.equal(arcanumMergeLine(ae({}), 3), plain);
  // One option: locked through the round it was stamped, then the normal line.
  const one = ae({ quickSummonOpts: ["cost"], quickSummonRound: 2 });
  assert.ok(arcanumMergeLine(one, 2).includes("you cannot dismiss until your next turn."));
  assert.ok(!arcanumMergeLine(one, 2).includes("only ends"));
  assert.equal(arcanumMergeLine(one, 3), plain);
  // Both options: the effect stays gone after the lock has passed.
  const both = ae({ quickSummonOpts: ["cost", "pulse"], quickSummonRound: 2, quickSummonNoDismissEffect: true });
  assert.ok(arcanumMergeLine(both, 2).includes("Dismiss then only ends the merge, with no damage."));
  assert.ok(arcanumMergeLine(both, 3).includes("Dismiss only ends the merge, with no damage."));
  // A client that has not heard the round yet: the stamp is recent, so say locked.
  assert.ok(arcanumMergeLine(one, NaN).includes("you cannot dismiss"));
});

console.log(`status-tip: ${n} groups passed`);
