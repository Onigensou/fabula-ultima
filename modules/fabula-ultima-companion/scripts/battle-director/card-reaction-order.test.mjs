// node scripts/battle-director/card-reaction-order.test.mjs
import assert from "node:assert/strict";
import { orderAcceptedForFire } from "./card-reaction-order.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const c = (id, phaseTrigger) => ({ id, phaseTrigger });
const ids = (a) => a.map((x) => x.id);

t("Spellweave: the performs_action spend fires before the completes_spell gain", () => {
  const a = [c("gain", "creature_completes_spell"), c("spend", "creature_performs_action")];
  assert.deepEqual(ids(orderAcceptedForFire(a)), ["spend", "gain"]);
});
t("completes entries land right after the LAST performs entry; others keep their order", () => {
  const a = [c("cs1", "creature_completes_spell"), c("cs2", "creature_completes_spell"), c("wd", "creature_will_deal_damage"),
    c("pa1", "creature_performs_action"), c("pa2", "creature_performs_action"), c("tg", "creature_targeted_by_action"), c("gd", "creature_guards")];
  assert.deepEqual(ids(orderAcceptedForFire(a)), ["wd", "pa1", "pa2", "cs1", "cs2", "tg", "gd"]);
});
t("no performs_action entry → the same array, untouched", () => {
  const a = [c("cs", "creature_completes_spell"), c("wd", "creature_will_deal_damage"), c("tg", "creature_targeted_by_action")];
  assert.equal(orderAcceptedForFire(a), a);
});
t("no completes_spell entry → the same array, untouched", () => {
  const a = [c("wd", "creature_will_deal_damage"), c("pa", "creature_performs_action")];
  assert.equal(orderAcceptedForFire(a), a);
});
t("already in order (completes after performs) → the same array", () => {
  const a = [c("pa", "creature_performs_action"), c("cs", "creature_completes_spell")];
  assert.equal(orderAcceptedForFire(a), a);
});
t("entries without phaseTrigger stay where they are", () => {
  const a = [c("cs", "creature_completes_spell"), { id: "x" }, c("pa", "creature_performs_action")];
  assert.deepEqual(ids(orderAcceptedForFire(a)), ["x", "pa", "cs"]);
});
t("empty / single / non-array pass through", () => {
  assert.deepEqual(orderAcceptedForFire([]), []);
  const one = [c("cs", "creature_completes_spell")]; assert.equal(orderAcceptedForFire(one), one);
  assert.equal(orderAcceptedForFire(null), null);
});
console.log(`card-reaction-order: ${n} passed`);
