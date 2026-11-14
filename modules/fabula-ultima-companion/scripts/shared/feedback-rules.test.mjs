// node scripts/shared/feedback-rules.test.mjs
import assert from "node:assert/strict";
import { statusLines, statusSound, damageSound, flashKey, affinityTag, DAMAGE_SFX } from "./feedback-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const P = ["h", "k", "b", "z"];
const e = (actorId, actorName, status, kind = "inflict") => ({ actorId, actorName, status, kind });

t("one member, one status", () => {
  assert.deepEqual(statusLines([e("z", "Zarg", "Slow")], P), ["Zarg is inflicted with {st:Slow}!"]);
});
t("held says until the next battle", () => {
  assert.deepEqual(statusLines([e("z", "Zarg", "Slow", "held")], P), ["Zarg is inflicted with {st:Slow} until the next battle!"]);
});
t("members with the same statuses share a line", () => {
  assert.deepEqual(statusLines([e("h", "Hina", "Slow"), e("z", "Zarg", "Slow"), e("h", "Hina", "Dazed"), e("z", "Zarg", "Dazed")], P),
    ["Hina and Zarg are inflicted with {st:Slow} and {st:Dazed}!"]);
});
t("different sets get their own lines", () => {
  assert.deepEqual(statusLines([e("h", "Hina", "Slow"), e("z", "Zarg", "Slow"), e("z", "Zarg", "Dazed")], P),
    ["Hina is inflicted with {st:Slow}!", "Zarg is inflicted with {st:Slow} and {st:Dazed}!"]);
});
t("all four members = The party (singular verb)", () => {
  const all = P.map((id) => e(id, id.toUpperCase(), "Weak"));
  assert.deepEqual(statusLines(all, P), ["{p:The party} is inflicted with {st:Weak}!"]);
  assert.deepEqual(statusLines(P.map((id) => e(id, id, "Swift", "buff")), P), ["{p:The party} gains {st:Swift}!"]);
  assert.deepEqual(statusLines(P.map((id) => e(id, id, "Slow", "removed")), P), ["{p:The party} recovers from {st:Slow}!"]);
});
t("kinds never share a line, in a fixed order", () => {
  const lines = statusLines([e("k", "Keren", "Slow", "immune"), e("h", "Hina", "Swift", "buff"), e("z", "Zarg", "Slow", "held"), e("z", "Zarg", "Weak")], P);
  assert.deepEqual(lines, [
    "Zarg is inflicted with {st:Weak}!",
    "Zarg is inflicted with {st:Slow} until the next battle!",
    "Hina gains {st:Swift}!",
    "Keren is immune to {st:Slow}.",
  ]);
});
t("removed: recover from", () => {
  assert.deepEqual(statusLines([e("h", "Hina", "Slow", "removed"), e("z", "Zarg", "Slow", "removed")], P), ["Hina and Zarg recover from {st:Slow}!"]);
});
t("three names use commas; no party list = never The party; junk dropped", () => {
  assert.deepEqual(statusLines([e("h", "Hina", "Slow"), e("k", "Keren", "Slow"), e("b", "Blanche", "Slow"), e("x", "", ""), null], []),
    ["Hina, Keren and Blanche are inflicted with {st:Slow}!"]);
});
t("status sound: battle's generic beats, inflicted wins, immune-only silent", () => {
  assert.equal(statusSound(["buff", "inflict"]), "down");
  assert.equal(statusSound(["held"]), "down");
  assert.equal(statusSound(["buff", "immune"]), "up");
  assert.equal(statusSound(["removed"]), "up");
  assert.equal(statusSound(["immune"]), null);
});
t("damage sound: one per batch, strongest result wins", () => {
  assert.equal(damageSound({ affinities: ["NE", "VU"] }), DAMAGE_SFX.weak);
  assert.equal(damageSound({ affinities: ["AB", "NE"] }), DAMAGE_SFX.hit);
  assert.equal(damageSound({ affinities: ["RS", "IM"] }), DAMAGE_SFX.resist);
  assert.equal(damageSound({ affinities: ["IM", "AB"] }), null);
  assert.equal(damageSound({ kind: "heal" }), DAMAGE_SFX.heal);
  assert.equal(damageSound({ resource: "mp" }), DAMAGE_SFX.mpLoss);
});
t("flash key + affinity tags", () => {
  assert.equal(flashKey({ element: "Bolt" }), "bolt");
  assert.equal(flashKey({ kind: "heal", element: "fire" }), "heal");
  assert.equal(flashKey({ resource: "mp" }), "mpLoss");
  assert.deepEqual(["VU", "RS", "IM", "AB", "NE"].map(affinityTag), ["weak", "resist", "immune", "absorb", null]);
});
console.log(`feedback-rules: ${n} passed`);
