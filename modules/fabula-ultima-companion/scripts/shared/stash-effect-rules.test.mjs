// node scripts/shared/stash-effect-rules.test.mjs
import assert from "node:assert/strict";
import { isPartyStashActor, stashSuppressesEffect } from "./stash-effect-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

const stash = { documentName: "Actor", system: { props: { member_id_1: "abc", member_id_2: "" } } };
const pc = { documentName: "Actor", system: { props: { max_hp: 50, isEquipped: false } } };
const itemOn = (actor) => ({ documentName: "Item", parent: actor });
const aeOn = (parent) => ({ documentName: "ActiveEffect", parent });

t("party DB actor is recognised by its roster field, even when empty", () => {
  assert.equal(isPartyStashActor(stash), true);
  assert.equal(isPartyStashActor({ system: { props: { member_id_1: "" } } }), true);
  assert.equal(isPartyStashActor(pc), false);
  assert.equal(isPartyStashActor(null), false);
  assert.equal(isPartyStashActor({ system: {} }), false);
});

t("item effects on the stash are suppressed", () => {
  assert.equal(stashSuppressesEffect(aeOn(itemOn(stash))), true);
});

t("item effects on a character are left to the normal rules", () => {
  assert.equal(stashSuppressesEffect(aeOn(itemOn(pc))), false);
});

t("effects sitting on the stash actor itself are not touched", () => {
  assert.equal(stashSuppressesEffect(aeOn(stash)), false);
});

t("world items (no owning actor) and junk input are not suppressed", () => {
  assert.equal(stashSuppressesEffect(aeOn(itemOn(null))), false);
  assert.equal(stashSuppressesEffect(aeOn({ documentName: "Item", parent: { documentName: "Compendium" } })), false);
  assert.equal(stashSuppressesEffect(null), false);
  assert.equal(stashSuppressesEffect({}), false);
});

console.log(`\n${n} passed`);
