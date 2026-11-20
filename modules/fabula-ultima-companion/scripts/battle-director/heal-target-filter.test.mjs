// node scripts/battle-director/heal-target-filter.test.mjs
// AI heals never target a creature the heal would hurt (user 2026-11-20: Kalina's
// Remedy kept landing on Zombie'd players as 50 damage).
import assert from "node:assert/strict";

globalThis.Hooks ??= { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game ??= { actors: { get: () => null }, settings: { get: () => null } };
const { restoresHp, withoutHealReversed } = await import("./target-survey.js");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const skill = (props, effects = []) => ({
  system: { props: { ...props, effect_table: Object.fromEntries(effects.map((r, i) => [String(i), { $deleted: false, ...r }])) } },
});
const actor = (name, { species = "humanoid", statuses = [] } = {}) => ({
  name, uuid: name,
  system: { props: { species, current_hp: 50 } },
  effects: statuses.map((s) => ({ name: s, disabled: false })),
  items: [],
});

t("Remedy (grant hp on action_targets) restores HP", () => {
  assert.equal(restoresHp(skill({ skill_type: "Active", skill_target: "One ally" },
    [{ effect_kind: "grant", grant_resource: "hp", grant_amount: "50", target_ref: "action_targets" }])), true);
});
t("a healing damage type restores HP", () => {
  assert.equal(restoresHp(skill({ skill_type: "Spell", type_damage: "Healing" })), true);
});
t("an MP grant does not count", () => {
  assert.equal(restoresHp(skill({}, [{ effect_kind: "grant", grant_resource: "mp", grant_amount: "20", target_ref: "action_targets" }])), false);
});
t("an HP grant to the caster only (a rider) does not count", () => {
  assert.equal(restoresHp(skill({ type_damage: "Physical" }, [{ effect_kind: "grant", grant_resource: "hp", grant_amount: "10", target_ref: "self" }])), false);
});
t("a deleted grant row does not count", () => {
  assert.equal(restoresHp(skill({}, [{ effect_kind: "grant", grant_resource: "hp", target_ref: "action_targets", $deleted: true }])), false);
});
t("an attack does not count", () => {
  assert.equal(restoresHp(skill({ skill_type: "Attack", type_damage: "Physical" })), false);
});

const roster = {
  Zarg: actor("Zarg"),
  Keren: actor("Keren", { statuses: ["Zombie"] }),
  Gigas: actor("Gigas", { species: "undead" }),
  Blanche: actor("Blanche"),
};
const pool = Object.keys(roster).map((k) => ({ actorUuid: k, name: k }));
t("Zombie'd and Undead creatures leave the heal pool", () => {
  assert.deepEqual(withoutHealReversed(pool, (u) => roster[u]).map((e) => e.name), ["Zarg", "Blanche"]);
});
t("everyone Zombie'd → empty pool (the row is not feasible)", () => {
  assert.deepEqual(withoutHealReversed([{ actorUuid: "Keren" }], (u) => roster[u]), []);
});
t("an entry whose actor can't be resolved is kept (fail-open on lookup only)", () => {
  assert.equal(withoutHealReversed([{ actorUuid: "Ghost" }], () => null).length, 1);
});
console.log(`${n} passed`);
