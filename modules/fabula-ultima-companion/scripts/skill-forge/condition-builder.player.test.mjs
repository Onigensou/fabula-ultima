// ============================================================================
// explainForPlayer — what a reaction card's When line may say.
//
//     node scripts/skill-forge/condition-builder.player.test.mjs
//
// The rule is an allow-list: engine plumbing never reaches a player, and a clause
// with no wording goes unsaid rather than printed raw.
// ============================================================================
import assert from "node:assert/strict";
import { parse, explain, explainForPlayer } from "./condition-builder.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };
const say = (f, opts) => explainForPlayer(parse(f), opts);

t("the two lines the mockup caught", () => {
  assert.equal(say("ARCANUM_DISMISS_LOCKED == 0"), "");
  assert.equal(say("TRIGGER_IS_SELF == 1 && ANY_TARGET_HAS_BURN == 1", { targetWord: "enemy" }), "an enemy has Burn");
});

t("the target word follows the caller, with the right article", () => {
  assert.equal(say("ANY_TARGET_HAS_BURN == 1"), "a target has Burn");
  assert.equal(say("ANY_TARGET_HAS_BURN == 1", { targetWord: "ally" }), "an ally has Burn");
  assert.equal(say("ANY_TARGET_HAS_BURN == 0", { targetWord: "enemy" }), "no enemy has Burn");
});

t("unknown identifiers and bookkeeping stay unsaid", () => {
  assert.equal(say("SOME_FUTURE_ENGINE_FLAG == 1"), "");
  assert.equal(say("AE_COUNT_BREACH_ARMED > 0"), "");
  assert.equal(say("AE_CHARGES_COUNTER_PASS >= 1"), "");
  assert.equal(say("STATUS_HAS_TAG_DEBUFF == 1"), "");
  assert.equal(say("HAS_SKILL_QUEENS_GAMBIT == 1"), "");
});

t("a known clause survives next to a hidden one", () => {
  assert.equal(say("ACTION_IS_ATTACK == 1 && AE_CHARGES_COUNTER_PASS >= 1"), "the action is an attack");
  assert.equal(say("USED_WEAPON_CATEGORY_IS_FLAIL == 1 && SUBJECT_IS_ALLY == 1"), "the creature is an ally");
});

t("an OR with an unspoken branch says nothing", () => {
  assert.equal(say("HAS_MARTIAL_ARMOR == 1 || HAS_SHIELD == 1"), "you wear martial armor or you have a shield");
  assert.equal(say("HAS_STATUS_CRISIS == 1 || MY_FOCUS_IN_CRISIS == 1"), "");
});

t("amounts only with a number on the right", () => {
  assert.equal(say("CUR_MP >= 10"), "you have at least 10 MP");
  assert.equal(say("CUR_HP > 10"), "you have more than 10 HP");
  assert.equal(say("CUR_MP >= ATTACK_CHECK_RESULT"), "");
});

t("flags read yes and no, whichever way they are written", () => {
  assert.equal(say("HAS_MARTIAL_ARMOR == 0"), "you wear no martial armor");
  assert.equal(say("HAS_STATUS_ENRAGED == 0"), "you are not Enraged");
  assert.equal(say("HAS_STATUS_CRISIS == 1"), "you are in Crisis");
  assert.equal(say("TARGET_SPECIES_IS_UNDEAD == 1"), "the target is an Undead");
});

t("the normal case goes unsaid, and nothing is said twice", () => {
  assert.equal(say("ACTION_ROLLS_ACCURACY == 1 && ATTACK_IS_CRIT == 0 && ATTACK_IS_FUMBLE == 0"), "");
  assert.equal(say("ATTACK_IS_CRIT == 1"), "the Check is a critical success");
  assert.equal(say("DAMAGE_IS_MP == 0 && TRIGGER_DAMAGE_IS_BOLT == 0"), "the damage is not Bolt");
  assert.equal(say("ACTION_IS_ATTACK == 1 && ATTACK_IS_MELEE == 1"), "the attack is melee");
  assert.equal(say("CUR_IP > 0"), "you have IP");
});

t("nothing to parse, nothing to say", () => {
  assert.equal(explainForPlayer(null), "");
  assert.equal(explainForPlayer(parse("(A == 1 || B == 1) && C == 1")), "");
});

t("the author's preview is unchanged", () => {
  assert.equal(explain(parse("TRIGGER_IS_SELF == 1")), "I triggered this");
});

console.log(`condition-builder.player: ${n} passed`);
