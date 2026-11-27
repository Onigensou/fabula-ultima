// node scripts/battle-director/skill-formulas-conflict-hp.test.mjs
// CONFLICT_OBJECT_HP_<ID>: sum of CURRENT HP of living conflict objects of one kind.
import assert from "node:assert/strict";
globalThis.CONFIG ??= { statusEffects: [] };
globalThis.foundry ??= { utils: {} };
globalThis.foundry.utils.getProperty ??= (o, p) => String(p).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
globalThis.Hooks ??= { once() {}, on() {}, callAll() {} };
const NS = "fabula-ultima-companion";
const obj = (kind, hp) => ({ flags: { [NS]: { conflictObject: kind } }, system: { props: { current_hp: hp } } });
const tok = (id, actor) => ({ id, actor });
const setScene = (tokens, combatants = []) => {
  globalThis.game = { combat: { combatants }, user: { isGM: true }, actors: { get: () => null }, scenes: { active: { tokens } } };
};
const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
const run = (f) => evaluateFormula(f, buildSkillResolver({ actor: { name: "Nidhogg" }, payload: null, skill: null }), -99);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("sums current HP of living fragments", () => {
  setScene([tok("a", obj("soul-fragment", 120)), tok("b", obj("soul-fragment", 90)), tok("c", obj("soul-fragment", 0)), tok("d", obj("lightning-crystal", 500))]);
  assert.equal(run("CONFLICT_OBJECT_HP_SOUL_FRAGMENT"), 210);
  assert.equal(run("CONFLICT_OBJECT_COUNT_SOUL_FRAGMENT"), 2);
  assert.equal(run("CONFLICT_OBJECT_HP_LIGHTNING_CRYSTAL"), 500);
});
t("overflow counts whole; gate compares", () => {
  setScene([tok("a", obj("soul-fragment", 300)), tok("b", obj("soul-fragment", 5))]);
  assert.equal(run("CONFLICT_OBJECT_HP_SOUL_FRAGMENT >= 200"), 1);
  assert.equal(run("CONFLICT_OBJECT_HP_SOUL_FRAGMENT >= 306"), 0);
});
t("deduped across roster + scene tokens (same token id)", () => {
  const a = obj("soul-fragment", 50);
  setScene([tok("a", a)], [{ tokenId: "a", actor: a }]);
  assert.equal(run("CONFLICT_OBJECT_HP_SOUL_FRAGMENT"), 50);
});
t("none / unknown kind / typo read 0 (>= gate fails closed)", () => {
  setScene([]);
  assert.equal(run("CONFLICT_OBJECT_HP_SOUL_FRAGMENT"), 0);
  setScene([tok("a", obj("soul-fragment", 99))]);
  assert.equal(run("CONFLICT_OBJECT_HP_SOUL_FRAGMNT >= 1"), 0);
  assert.equal(run("CONFLICT_OBJECT_HP_"), 0);
});
t("TOP_HP: max over fragments, dead ignored, overflow whole, 0 when none", () => {
  setScene([tok("a", obj("soul-fragment", 120)), tok("b", obj("soul-fragment", 310)), tok("c", obj("soul-fragment", 0)), tok("d", obj("lightning-crystal", 500))]);
  assert.equal(run("CONFLICT_OBJECT_TOP_HP_SOUL_FRAGMENT"), 310);
  assert.equal(run("CONFLICT_OBJECT_TOP_HP_LIGHTNING_CRYSTAL"), 500);
  assert.equal(run("CONFLICT_OBJECT_HP_SOUL_FRAGMENT"), 430);
  assert.equal(run("CONFLICT_OBJECT_TOP_HP_SOUL_FRAGMENT >= 100"), 1);
  setScene([tok("c", obj("soul-fragment", 0))]);
  assert.equal(run("CONFLICT_OBJECT_TOP_HP_SOUL_FRAGMENT"), 0);
  setScene([]);
  assert.equal(run("CONFLICT_OBJECT_TOP_HP_SOUL_FRAGMENT"), 0);
  assert.equal(run("CONFLICT_OBJECT_TOP_HP_SOUL_FRAGMNT >= 1"), 0);
  assert.equal(run("CONFLICT_OBJECT_TOP_HP_"), 0);
});
console.log(`${n} passed`);
