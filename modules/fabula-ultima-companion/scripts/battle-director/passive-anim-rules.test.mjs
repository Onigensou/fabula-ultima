// node scripts/battle-director/passive-anim-rules.test.mjs
// Passive fallback beats (mockup v4, 2026-11-04).
import assert from "node:assert/strict";
import { composePassiveBeats, mergeBeats, hitElement } from "./passive-anim-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const OWNER = "Actor.kirin", ALLY = "Actor.wolf", FOE = "Actor.keren", FOE2 = "Actor.hina";
const sameSide = (u) => u === ALLY;
const rec = (kind, applied, row = {}, extra = {}) => ({ kind, row, res: { ok: true, kind, applied, ...extra } });

t("Lightning Charge: an MP grant to the owner → blue MP lines on the owner", () => {
  const r = composePassiveBeats([rec("chain", []), rec("grant", [{ actorUuid: OWNER, resource: "mp", delta: 4 }])], { ownerActorUuid: OWNER });
  assert.deepEqual(r.beats, [{ k: "mp", recipients: [OWNER] }]);
});
t("Earthen Wire: follow-up damage → a redirect arc onto the real (random) recipient, by element", () => {
  const r = composePassiveBeats([
    rec("adjust_damage", []), rec("targeting", []),
    rec("deal_damage", [{ actorUuid: FOE2, amount: 26, element: "bolt", final: 26, direction: "loss" }]),
  ], { ownerActorUuid: "Actor.obsidrax", redirect: true });
  assert.deepEqual(r.beats, [{ k: "redirect", recipients: [FOE2], element: "bolt" }]);
});
t("damage outside a damage reaction is a plain hit", () => {
  const r = composePassiveBeats([rec("deal_damage", [{ actorUuid: FOE, amount: 10, element: "Fire" }])], { ownerActorUuid: OWNER });
  assert.deepEqual(r.beats, [{ k: "damage", recipients: [FOE], element: "fire" }]);
});
t("AE tags decide buff vs debuff", () => {
  const tag = (e) => (e.name === "Haste" ? "buff" : e.name === "Slow" ? "debuff" : null);
  const r = composePassiveBeats([rec("apply_ae", [{ actorUuid: FOE, name: "Slow" }, { actorUuid: OWNER, name: "Haste" }])], { ownerActorUuid: OWNER, aeTagOf: tag });
  assert.deepEqual(r.beats.map((b) => [b.k, b.recipients]), [["debuff", [FOE]], ["buff", [OWNER]]]);
});
t("a status condition: the owner's side reads as a buff, the other side as a debuff", () => {
  const r = composePassiveBeats([rec("apply_ae", [{ actorUuid: ALLY, name: "Flying" }, { actorUuid: FOE, name: "Dazed" }])], { ownerActorUuid: OWNER, sameSide, aeTagOf: () => "status" });
  assert.deepEqual(r.beats.map((b) => [b.k, b.recipients]), [["buff", [ALLY]], ["debuff", [FOE]]]);
});
t("an untagged, non-status AE is bookkeeping (a Spent / Ready marker): nothing shows", () => {
  const r = composePassiveBeats([rec("apply_ae", [{ actorUuid: OWNER, name: "Ninja Log Spent" }])], { ownerActorUuid: OWNER, aeTagOf: () => null });
  assert.equal(r.skipped, "nothing-visible");
});
t("a counter gaining charges (Grave Points) or a refresh in place shows nothing", () => {
  const tag = () => "buff";
  const r = composePassiveBeats([rec("apply_ae", [
    { actorUuid: OWNER, aeId: "x", name: "Grave Points", chargesAdded: 1, newCharges: 3 },
    { actorUuid: OWNER, aeId: "y", name: "Haste", refreshedInPlace: true },
  ])], { ownerActorUuid: OWNER, aeTagOf: tag });
  assert.equal(r.skipped, "nothing-visible");
});
t("removed / unchanged AE entries show nothing", () => {
  const r = composePassiveBeats([rec("apply_ae", [{ actorUuid: FOE, removed: "Burn" }, { actorUuid: FOE, unchanged: true }])], { ownerActorUuid: OWNER });
  assert.equal(r.skipped, "nothing-visible");
});
t("HP grant = heal; a zero or negative grant shows nothing", () => {
  const r = composePassiveBeats([rec("grant", [{ actorUuid: OWNER, resource: "hp", delta: 12 }, { actorUuid: FOE, resource: "hp", delta: 0 }])], { ownerActorUuid: OWNER });
  assert.deepEqual(r.beats, [{ k: "heal", recipients: [OWNER] }]);
  assert.equal(composePassiveBeats([rec("grant", [{ actorUuid: OWNER, resource: "ip", delta: 1 }])]).skipped, "nothing-visible");
});
t("cleanse (remove debuffs) → white lines; dispel (remove buffs) → debuff lines", () => {
  assert.equal(composePassiveBeats([rec("remove_tagged_ae", [ALLY], { filter_tag: "debuff" })]).beats[0].k, "cleanse");
  assert.equal(composePassiveBeats([rec("remove_tagged_ae", [{ actorUuid: FOE }], { filter_tag: "buff" })]).beats[0].k, "debuff");
});
t("a chain that plays its own animation or performs an action: the fallback stays out", () => {
  assert.equal(composePassiveBeats([rec("play_animation", []), rec("deal_damage", [{ actorUuid: FOE, amount: 9 }])]).skipped, "own-animation");
  assert.equal(composePassiveBeats([rec("free_action", [])]).skipped, "own-animation");
});
t("rows that did not run (condition false) show nothing", () => {
  const r = composePassiveBeats([{ kind: "apply_ae", row: {}, res: { ok: true, applied: [], skipped: true } }]);
  assert.equal(r.skipped, "nothing-visible");
});
t("invisible-only passives (damage tweaks, keywords) show nothing", () => {
  assert.equal(composePassiveBeats([rec("adjust_damage", []), rec("apply_action_keyword", [])]).skipped, "nothing-visible");
});
t("same beat on several recipients is one beat; at most three beats", () => {
  const r = composePassiveBeats([
    rec("apply_ae", [{ actorUuid: FOE }, { actorUuid: FOE2 }]),
    rec("grant", [{ actorUuid: OWNER, resource: "hp", delta: 5 }, { actorUuid: OWNER, resource: "mp", delta: 5 }]),
    rec("deal_damage", [{ actorUuid: FOE, amount: 5, element: "ice" }]),
  ], { ownerActorUuid: OWNER, aeTagOf: () => "debuff" });
  assert.equal(r.beats.length, 3);
  assert.deepEqual(r.beats[0], { k: "debuff", recipients: [FOE, FOE2] });
});
t("repeat fires merge: three Lightning Charges = one MP beat", () => {
  const one = [{ k: "mp", recipients: [OWNER] }];
  assert.deepEqual(mergeBeats(mergeBeats(one, one), one), one);
  assert.deepEqual(mergeBeats(one, [{ k: "buff", recipients: [ALLY] }]).map((b) => b.k), ["mp", "buff"]);
});
t("elements normalize; unknown → physical", () => {
  assert.equal(hitElement("Lightning"), "bolt");
  assert.equal(hitElement(""), "physical");
});
console.log(`\n${n} passed`);
