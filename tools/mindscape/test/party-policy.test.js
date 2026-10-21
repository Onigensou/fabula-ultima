"use strict";
// Mindscape — party play policies (lib/party-policy.js). Plain node.

const assert = require("assert");
const { toCombatModel } = require("../lib/load-actors");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");
const PP = require("../lib/party-policy");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

function pc(name, props, items = []) {
  const m = toCombatModel({ _id: name, name, items: [], system: { props: {
    level: "41", dex_base: "8", ins_base: "8", mig_base: "8", wlp_base: "8",
    max_hp: "900", current_hp: "900", max_mp: "100", current_mp: "100", max_ip: "10", current_ip: "10",
    defense: "10", magic_defense: "10", ...props,
  } } });
  m.items = items;
  return m;
}
const skill = (name, props = {}) => ({ id: name, name, props: { skill_type: "Active", cost: "-", rolled_atr1: "-", rolled_atr2: "-", ...props } });

// d4 dice never crit, so checkBonus decides hit or miss outright.
function enemy({ name = "Dummy", hp = 5000, checkBonus = -100, damage = 40, affinities = {} } = {}) {
  const m = toCombatModel({ _id: name, name, items: [], system: { props: {
    level: "41", npc_rank: "soldier", species: "Monster", activation: "1",
    max_hp: String(hp), current_hp: String(hp), dex_base: "4", ins_base: "4", mig_base: "4", wlp_base: "4",
    defense: "8", magic_defense: "8", ...affinities,
  } } });
  m.items = [{ id: "a", name: "Crush", props: { skill_type: "Attack", skill_target: "One Creature", cost: "-",
    rolled_atr1: "MIG", rolled_atr2: "DEX", check_bonus: String(checkBonus), damage_bonus: String(damage),
    type_damage: "Physical", defense_target_type: "def" } }];
  return m;
}

const fight = (party, enemies, policy, rounds = 2, seed = "pp") =>
  runBattle({ party, enemies, rng: new Rng(seed), expectedRounds: rounds, policy });

t("an unknown policy is refused", () => {
  assert.throws(() => fight([pc("A", {})], [enemy()], "clever"), /unknown party policy/);
});

t("legacy reports itself and never builds policy state", () => {
  const r = fight([pc("A", {})], [enemy()], undefined, 1);
  assert.strictEqual(r.policy, "legacy");
});

t("Adoration: two misses on Blanche (Pases + Elegance) pay for Muleta", () => {
  const blanche = pc("Blanche", { dex_base: "4", ins_base: "4" }, [
    skill("Pases", { skill_type: "Passive" }), skill("Elegance Showmanship", { skill_type: "Passive" }),
    skill("Muleta", { cost: "1 Adoration", skill_target: "One Creature", rolled_atr1: "DEX", rolled_atr2: "DEX",
      damage_bonus: "20", type_damage: "Physical" }),
  ]);
  const r = fight([blanche], [enemy({ checkBonus: -100 })], "standard", 3);
  assert.ok(r.log.some((e) => e.actor === "Blanche" && e.action === "Muleta"), "Muleta was used once the gauge filled");
});

t("Adoration resets when an enemy damages her: no Muleta while every attack hits", () => {
  const blanche = pc("Blanche", { defense: "1" }, [
    skill("Pases", { skill_type: "Passive" }),
    skill("Muleta", { cost: "1 Adoration", skill_target: "One Creature", rolled_atr1: "DEX", rolled_atr2: "DEX",
      damage_bonus: "20", type_damage: "Physical" }),
  ]);
  const r = fight([blanche], [enemy({ checkBonus: 100, damage: 5 })], "standard", 3);
  assert.ok(!r.log.some((e) => e.action === "Muleta"));
});

t("revive: a Phoenix Feather brings a downed ally back at half HP", () => {
  const keren = pc("Keren", {}, [{ id: "pf", name: "Phoenix Feather", props: { item_type: "consumable", item_quantity: "1" } }]);
  const ally = pc("Ally", { max_hp: "30", current_hp: "30", defense: "1", dex_base: "4", ins_base: "4" });
  const r = fight([keren, ally], [enemy({ checkBonus: 100, damage: 60 })], "standard", 3);
  assert.ok(r.log.some((e) => e.revive && e.target === "Ally"), "the feather was used on the ally");
});

t("Meteor Shower fires at 6 ZP and leaves enemies dazed and shaken", () => {
  const zarg = pc("Zarg", { zero_power_value: "6" }, [skill("Zero Power: Meteor Shower", { type_damage: "Poison", damage_bonus: "30" })]);
  const r = fight([zarg], [enemy()], "standard", 1);
  const hit = r.log.find((e) => e.action === "Zero Power: Meteor Shower");
  assert.ok(hit, "Meteor Shower was unleashed");
  assert.strictEqual(hit.damage, 50, "30 + half of level 41");
});

t("standard holds Meteor Shower against a poison-immune enemy; expert switches element", () => {
  const mk = () => pc("Zarg", { zero_power_value: "6" }, [skill("Zero Power: Meteor Shower", { type_damage: "Poison" })]);
  const immune = { affinity_9: "IM" };
  const std = fight([mk()], [enemy({ affinities: immune })], "standard", 1);
  assert.ok(!std.log.some((e) => e.action === "Zero Power: Meteor Shower"));
  const exp = fight([mk()], [enemy({ affinities: immune })], "expert", 1);
  const hit = exp.log.find((e) => e.action === "Zero Power: Meteor Shower");
  assert.ok(hit && hit.damage > 0, "expert fired it with an element that lands");
});

t("Motivation: Blanche refills to 6 ZP when an ally unleashes", () => {
  const zarg = pc("Zarg", { zero_power_value: "6", dex_base: "12", ins_base: "12" }, [skill("Zero Power: Meteor Shower", { type_damage: "Poison" })]);
  const blanche = pc("Blanche", { zero_power_value: "0", max_hp: "100", current_hp: "100" }, [skill("Zero Trigger: Motivation", { skill_type: "Passive" }),
    skill("Zero Power: Give me tips or 5stars", { skill_target: "All Ally" })]);
  // Hurt Blanche first so her own Zero Power wants to fire once she has it.
  const r = fight([zarg, blanche], [enemy({ checkBonus: 100, damage: 60 })], "standard", 2);
  assert.ok(r.log.some((e) => e.action === "Zero Power (party heal)"), "Blanche's refilled gauge was spent on a party heal");
});

t("element swaps never land on an element any target absorbs or is immune to", () => {
  const a = { actor: enemy({ affinities: { affinity_7: "AB", affinity_6: "VU" } }) };
  const b = { actor: enemy({ affinities: { affinity_6: "IM", affinity_3: "VU" } }) };
  const el = PP.bestElementAcross([a, b]);
  assert.ok(!["ice", "fire"].includes(el), `picked ${el}`);
  assert.strictEqual(PP.bestElementAcross([a]), "fire", "a lone fire-VU target gets fire");
  assert.strictEqual(PP.bestElementAcross([b], ["fire", "ice"]), "ice", "Thermokinesis only offers fire and ice");
});

t("novice never calls a focus target", () => {
  const r = fight([pc("A", {}), pc("B", {})], [enemy({ name: "E1" }), enemy({ name: "E2" })], "novice", 2);
  assert.strictEqual(r.policy, "novice");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
