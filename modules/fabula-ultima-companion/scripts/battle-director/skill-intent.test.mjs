// node scripts/battle-director/skill-intent.test.mjs
import assert from "node:assert/strict";
import { classifyActionIntent } from "./skill-intent.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const skill = (props, effects = []) => ({
  system: { props: { ...props, effect_table: Object.fromEntries(effects.map((r, i) => [String(i), { $deleted: false, ...r }])) } },
});

// Nox Legion playtest 2026-11-20: Gravis Alta / Soul Sever / Revive / Zombie Plague
// were "aid", so Prophetic Defender, Protect and Illusory Shield never fired on them.
t("Gravis Alta (Spell, All Enemies, deal_damage on action_targets) is harmful", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "All Enemies", type_damage: "" },
    [{ effect_kind: "deal_damage", damage_amount: "floor(CUR_HP * 0.5)", target_ref: "action_targets" }])), "harmful");
});
t("Soul Sever (Active, deal_damage on hit_action_targets) is harmful", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Active", skill_target: "All Enemies" },
    [{ effect_kind: "conflict_event_action", target_ref: "self" }, { effect_kind: "deal_damage", target_ref: "hit_action_targets" }])), "harmful");
});
t("Revive on an Undead (Spell, One Enemy, deal_damage) is harmful", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "One Enemy" },
    [{ effect_kind: "deal_damage", target_ref: "action_targets" }])), "harmful");
});
t("Zombie Plague (All Enemies + apply_ae) is harmful: 'Enemies' now matches", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "All Enemies" },
    [{ effect_kind: "save_check", target_ref: "action_targets" }, { effect_kind: "apply_ae", target_ref: "save_failed_targets" }])), "harmful");
});
t("'Up to 99 Enemies' + apply_ae is harmful", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Active", skill_target: "Up to 99 Enemies" }, [{ effect_kind: "apply_ae" }])), "harmful");
});
t("self-only damage (recoil) on an enemy-targeted spell does not make it harmful", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "All Enemies" },
    [{ effect_kind: "deal_damage", target_ref: "self" }])), "aid");
});
t("a deleted deal_damage row is ignored", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "All Enemies" },
    [{ effect_kind: "deal_damage", target_ref: "action_targets", $deleted: true }])), "aid");
});
t("an ally-targeted damage row is not enemy-targeted: stays aid", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "One Ally" },
    [{ effect_kind: "deal_damage", target_ref: "action_targets" }])), "aid");
});
t("explicit action_intent still wins", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "All Enemies", action_intent: "neutral" },
    [{ effect_kind: "deal_damage", target_ref: "action_targets" }])), "neutral");
});
t("healing still classifies as aid", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Spell", skill_target: "One Creature", type_damage: "healing" })), "aid");
});
t("an Attack is harmful as before", () => {
  assert.equal(classifyActionIntent(skill({ skill_type: "Attack", skill_target: "One Creature", type_damage: "Physical" })), "harmful");
});
console.log(`${n} passed`);
