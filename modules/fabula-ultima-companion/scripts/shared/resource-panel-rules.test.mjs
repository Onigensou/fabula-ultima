// node scripts/shared/resource-panel-rules.test.mjs
// Resource Panel — pure rules (approved 2026-11-10).
import assert from "node:assert/strict";
import { DEFAULTS, widthPct, normalizeRow, normalizePanel, band, amountLabel } from "./resource-panel-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("sits where System Message does", () => {
  assert.equal(DEFAULTS.topPct, 14.5);
  assert.equal(DEFAULTS.fontPx1080, 18);
});
t("width by card count: 4 = 38% (System Message width), fewer shrink", () => {
  assert.deepEqual([1, 2, 3, 4, 9, 0].map(widthPct), [12, 22, 31, 38, 38, 12]);
});
t("HP loss: amount, sign, no gain", () => {
  const r = normalizeRow({ name: "Hina", resource: "hp", before: 157, after: 146, max: 157 });
  assert.deepEqual([r.amount, r.gain, amountLabel(r)], [11, false, "−11"]);
});
t("heal: + sign; MP gets its unit", () => {
  assert.equal(amountLabel(normalizeRow({ before: 60, after: 110, max: 157 })), "+50");
  assert.equal(amountLabel(normalizeRow({ resource: "mp", before: 70, after: 50, max: 70 })), "−20 MP");
  assert.equal(amountLabel(normalizeRow({ resource: "IP", before: 3, after: 3, max: 6 })), "0");
});
t("unknown resource falls back to hp", () => assert.equal(normalizeRow({ resource: "zz" }).resource, "hp"));
t("caller tags: resist, immune, held, dr:N; junk dropped", () => {
  const r = normalizeRow({ before: 50, after: 49, max: 60, tags: ["resist", "dr:5", "dr:0", "nope", "held"] });
  assert.deepEqual(r.chips.map((c) => c.label), ["Resist", "DR −5", "Held at 1"]);
});
t("Crisis is worked out on an HP loss that crosses half max", () => {
  assert.deepEqual(normalizeRow({ before: 80, after: 64, max: 145 }).chips.map((c) => c.kind), ["cr"]);
  assert.equal(normalizeRow({ before: 60, after: 49, max: 157 }).chips.length, 0);
  assert.equal(normalizeRow({ resource: "mp", before: 80, after: 10, max: 100 }).chips.length, 0);
});
t("Held at 1 replaces the Crisis tag", () => {
  assert.deepEqual(normalizeRow({ before: 90, after: 1, max: 100, tags: ["held"] }).chips.map((c) => c.kind), ["one"]);
});
t("bad numbers are clamped, never NaN", () => {
  const r = normalizeRow({ before: "x", after: -4, max: 0 });
  assert.deepEqual([r.before, r.after, r.max], [0, 0, 1]);
});
t("panel: at most 4 cards, hold floor, width from count, label trimmed", () => {
  const p = normalizePanel({ label: " Healing Spring ", rows: [{}, {}, {}, {}, {}], hold: 10 });
  assert.deepEqual([p.rows.length, p.hold, p.widthPct, p.label], [4, 600, 38, "Healing Spring"]);
  assert.equal(normalizePanel({}).hold, DEFAULTS.holdMs);
});
t("bands match the battle HP bar", () => {
  assert.deepEqual([band(51, 100), band(50, 100), band(25, 100)], ["ok", "crisis", "low"]);
});

console.log(`resource-panel-rules: ${n} passed`);
