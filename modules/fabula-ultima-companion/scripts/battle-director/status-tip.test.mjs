// ============================================================================
// Status tooltip helpers — formatting, order, numerals.
//
//     node scripts/battle-director/status-tip.test.mjs
//
// The tooltip text is built from world descriptions and pushed into
// data-tooltip as HTML, so it must escape first and highlight second.
// ============================================================================
import assert from "node:assert/strict";
import { formatRulesText, sortRows, rowTurns, rowSpent, statusTipHTML } from "./status-tip.js";

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

console.log(`status-tip: ${n} groups passed`);
