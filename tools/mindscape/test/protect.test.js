"use strict";
// Mindscape — Protect resolves the redirected hit against the PROTECTOR. Plain node.
//
// Live (card-mutations.js, redirect_target) and the Guardian skill text: "any Checks that
// are part of the danger will be performed against you". Same roll total vs the
// protector's DEF, damage through the protector's affinities and damage reduction.

const assert = require("assert");
const { toCombatModel } = require("../lib/load-actors");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// A fragile ally (the weakest target, so every enemy swing goes at it) and a Guardian
// holding Protect. Neither side of the party attacks.
function party({ tankDef = 10, tankRs = false, tankDr = 0 } = {}) {
  const pc = (name, props, items) => {
    const m = toCombatModel({ _id: name, name, items: [], system: { props: {
      level: "41", dex_base: "8", ins_base: "8", mig_base: "8", wlp_base: "8",
      max_mp: "0", current_mp: "0", magic_defense: "10", ...props,
    } } });
    m.items = items;
    return m;
  };
  return [
    pc("Ally", { max_hp: "50", current_hp: "50", defense: "1" }, []),
    pc("Guardian", { max_hp: "900", current_hp: "900", defense: String(tankDef),
      affinity_1: tankRs ? "RS" : "NA", damage_receiving_mod_all: String(tankDr) },
      [{ id: "p", name: "Protect", props: { skill_type: "Active", cost: "-", skill_target: "One creature" } }]),
  ];
}

// d4 dice can never roll a critical (a crit needs doubles of 6+), so a miss stays a miss.
function brute(checkBonus) {
  const m = toCombatModel({ _id: "brute", name: "Brute", items: [], system: { props: {
    level: "41", npc_rank: "soldier", species: "Monster", activation: "1",
    max_hp: "5000", current_hp: "5000", dex_base: "4", ins_base: "4", mig_base: "4", wlp_base: "4",
    defense: "30", magic_defense: "30",
  } } });
  m.items = [{ id: "a", name: "Crush", props: { skill_type: "Attack", skill_target: "One Creature", cost: "-",
    rolled_atr1: "MIG", rolled_atr2: "DEX", check_bonus: String(checkBonus), damage_bonus: "40",
    type_damage: "Physical", defense_target_type: "def" } }];
  return m;
}

function fight(p, e, seed = "protect") {
  const r = runBattle({ party: p, enemies: [e], rng: new Rng(seed), expectedRounds: 1 });
  const by = Object.fromEntries(r.combatants.map((c) => [c.name, c]));
  return { r, ally: by.Ally, tank: by.Guardian };
}

t("the Guardian protects: the ally takes nothing", () => {
  const { ally, tank } = fight(party(), brute(10));
  assert.strictEqual(ally.damageTaken, 0);
  assert.ok(tank.damageTaken > 0);
});
t("damage is computed through the PROTECTOR's resistance (41-44 raw -> halved)", () => {
  const { tank } = fight(party({ tankRs: true }), brute(10));
  assert.ok(tank.damageTaken >= 21 && tank.damageTaken <= 22, `took ${tank.damageTaken}`);
});
t("damage reduction is the PROTECTOR's", () => {
  const { tank } = fight(party({ tankDr: 10 }), brute(10));
  assert.ok(tank.damageTaken >= 31 && tank.damageTaken <= 34, `took ${tank.damageTaken}`);
});
t("the same roll is checked against the PROTECTOR's DEF: a hit on the ally can miss the Guardian", () => {
  const { r, ally, tank } = fight(party({ tankDef: 100 }), brute(10));
  assert.strictEqual(tank.damageTaken, 0);
  assert.strictEqual(ally.damageTaken, 0);
  assert.ok(r.log.some((e) => e.miss && e.target === "Guardian" && e.protected === "Ally"), "the miss is logged against the protector");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
