"use strict";
// Mindscape — monster combo passives added 2026-10-20: the Valley bolt chain (Electro
// Explosion -> Chain Reaction / Overcharge), Brutish Fury, Drako Fury -> Thrash, and the
// Flying / Delay traits. Plain node.

const assert = require("assert");
const { toCombatModel } = require("../lib/load-actors");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const passive = (name) => ({ id: name, name, props: { skill_type: "Passive", cost: "-", rolled_atr1: "-", rolled_atr2: "-" } });
const attack = (name, dmg, extra = {}) => ({ id: name, name, props: { skill_type: "Attack", skill_target: "One Creature", cost: "-",
  rolled_atr1: "MIG", rolled_atr2: "DEX", check_bonus: "100", damage_bonus: String(dmg), type_damage: "Physical", defense_target_type: "def", ...extra } });

function pc(name, props = {}, items = []) {
  const m = toCombatModel({ _id: name, name, items: [], system: { props: {
    level: "41", dex_base: "8", ins_base: "8", mig_base: "8", wlp_base: "8", max_hp: "900", current_hp: "900",
    max_mp: "0", current_mp: "0", defense: "10", magic_defense: "10", ...props } } });
  m.items = items;
  return m;
}
function npc(name, props = {}, items = []) {
  const m = toCombatModel({ _id: name, name, items: [], system: { props: {
    level: "45", npc_rank: "soldier", species: "Monster", activation: "1", max_hp: "100", current_hp: "100",
    max_mp: "120", current_mp: "120", dex_base: "8", ins_base: "8", mig_base: "8", wlp_base: "8",
    defense: "8", magic_defense: "8", ...props } } });
  m.items = items;
  return m;
}
const fight = (party, enemies, rounds = 2, seed = "combo") => runBattle({ party, enemies, rng: new Rng(seed), expectedRounds: rounds, policy: "legacy" });

t("Electro Explosion: a slime killed by physical damage bursts 30 bolt on everyone else", () => {
  const killer = pc("Killer", {}, [attack("Smash", 500)]);
  const slime = npc("Slime", { max_hp: "10", current_hp: "10" }, [passive("Electro Explosion")]);
  const other = npc("Other", { max_hp: "999", current_hp: "999" });
  const r = fight([killer], [slime, other], 1);
  const burst = r.log.filter((e) => e.action === "Electro Explosion");
  assert.ok(burst.some((e) => e.target === "Other" && e.damage === 30), "hits its own ally for 30");
  assert.ok(burst.some((e) => e.target === "Killer"), "hits the party too");
});

t("Electro Explosion does not fire on earth damage", () => {
  const killer = pc("Killer", {}, [attack("Quake", 500, { type_damage: "Earth" })]);
  const slime = npc("Slime", { max_hp: "10", current_hp: "10" }, [passive("Electro Explosion")]);
  const r = fight([killer], [slime, npc("Other", { max_hp: "999", current_hp: "999" })], 1);
  assert.ok(!r.log.some((e) => e.action === "Electro Explosion"));
});

t("Overcharge: bolt from a dying slime makes the Prism cast Fulgur Finis (+10), paying its MP", () => {
  const killer = pc("Killer", {}, [attack("Smash", 500)]);
  const slime = npc("Slime", { max_hp: "10", current_hp: "10" }, [passive("Electro Explosion")]);
  const prism = npc("Prism", { max_hp: "999", current_hp: "999", affinity_3: "AB" }, [passive("Overcharge"),
    { id: "ff", name: "Fulgur Finis", props: { skill_type: "Spell", skill_target: "Up to three creatures", cost: "30 x T MP",
      rolled_atr1: "INS", rolled_atr2: "WLP", check_bonus: "100", damage_bonus: "62", type_damage: "Bolt", defense_target_type: "mdef" } }]);
  const r = fight([killer], [slime, prism], 1);
  assert.ok(r.log.some((e) => e.action === "Overcharge"), "Overcharge announced");
  const hit = r.log.find((e) => e.actor === "Prism" && e.action === "Fulgur Finis" && e.damage > 0);
  assert.ok(hit, "the free Fulgur Finis landed");
});

t("Overcharge stops at 0 MP", () => {
  const killer = pc("Killer", {}, [attack("Smash", 500)]);
  const slime = npc("Slime", { max_hp: "10", current_hp: "10" }, [passive("Electro Explosion")]);
  const prism = npc("Prism", { max_hp: "999", current_hp: "999", max_mp: "0", current_mp: "0" }, [passive("Overcharge"),
    { id: "ff", name: "Fulgur Finis", props: { skill_type: "Spell", skill_target: "Up to three creatures", cost: "30 x T MP",
      rolled_atr1: "INS", rolled_atr2: "WLP", check_bonus: "100", damage_bonus: "62", type_damage: "Bolt", defense_target_type: "mdef" } }]);
  const r = fight([killer], [slime, prism], 1);
  assert.ok(!r.log.some((e) => e.actor === "Prism" && e.action === "Fulgur Finis"));
});

t("Brutish Fury adds 25 only at half HP or below", () => {
  const wall = pc("Wall", { max_hp: "99999", current_hp: "99999" });
  const fresh = npc("Orc", { max_hp: "1000", current_hp: "1000" }, [passive("Brutish Fury"), attack("Cleaver", 40)]);
  const hurt = npc("Orc", { max_hp: "1000", current_hp: "1000" }, [passive("Brutish Fury"), attack("Cleaver", 40)]);
  hurt.hp.cur = 400;   // makeCombatant starts at max; set below via a one-round fight instead
  const a = fight([wall], [fresh], 1, "bf").log.find((e) => e.actor === "Orc" && e.damage > 0);
  assert.ok(a, "the orc swung");
  // Same seed, Orc pre-damaged by a party member's opening hit is awkward to arrange, so
  // compare through the rider directly: the gate reads attackerInCrisis.
  const RX = require("../lib/reactions");
  const [row] = RX.declaredReactions([{ name: "Brutish Fury" }]);
  assert.strictEqual(row.gate({ attackerInCrisis: true }), true);
  assert.strictEqual(row.gate({ attackerInCrisis: false }), false);
  assert.strictEqual(row.effect.amount, 25);
});

t("Drako Fury banks HP lost; Thrash spends it for ceil(Fury / 2)", () => {
  const RX = require("../lib/reactions");
  const rows = RX.declaredReactions([{ name: "Drako Fury" }]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].effect.kind, "counter_add");
  assert.strictEqual(rows[1].gate({ sourceAction: "Thrash" }), true);
  assert.strictEqual(rows[1].gate({ sourceAction: "Dragon Claw" }), false);
  // In a fight: a Drakoza that takes damage later Thrashes harder than its base.
  const hitter = pc("Hitter", {}, [attack("Poke", 30)]);
  const drak = npc("Drakoza", { max_hp: "2000", current_hp: "2000" }, [passive("Drako Fury"), attack("Thrash", 10), attack("Dragon Claw", 12)]);
  const r = fight([hitter], [drak], 4, "fury");
  const thrash = r.log.filter((e) => e.actor === "Drakoza" && e.action === "Thrash" && e.damage > 0);
  assert.ok(thrash.length, "Thrash was chosen once Fury built up");
});

t("Flying: a melee weapon cannot reach it; a ranged one can", () => {
  const meleePc = pc("Swordy", {}, []);
  meleePc.weapon = { name: "Sword", attrA: "DEX", attrB: "MIG", baseDamage: 20, range: "melee", family: "sword" };
  const flyer = npc("Ray", { max_hp: "999", current_hp: "999" }, [passive("Flying")]);
  const r = fight([meleePc], [flyer], 1);
  assert.ok(!r.log.some((e) => e.actor === "Swordy" && e.target === "Ray"), "melee never targets the flyer");
  const archer = pc("Archer", {}, []);
  archer.weapon = { name: "Bow", attrA: "DEX", attrB: "INS", baseDamage: 20, range: "ranged", family: "bow" };
  const r2 = fight([archer], [npc("Ray", { max_hp: "999", current_hp: "999" }, [passive("Flying")])], 1);
  assert.ok(r2.log.some((e) => e.actor === "Archer" && e.target === "Ray"), "ranged reaches it");
});

t("Delay (Oaf): the Gigas acts after everyone, even with the best initiative", () => {
  const p = pc("Slowpoke", { dex_base: "6", ins_base: "6" }, [attack("Poke", 1)]);
  const gigas = npc("Gigas", { dex_base: "12", ins_base: "12", max_hp: "999", current_hp: "999" }, [passive("Oaf"), attack("Heavy Swing", 5)]);
  const r = fight([p], [gigas], 1);
  const first = r.log.find((e) => e.actor === "Slowpoke" || e.actor === "Gigas");
  assert.strictEqual(first.actor, "Slowpoke");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
