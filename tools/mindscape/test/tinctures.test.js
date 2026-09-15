"use strict";
// Mindscape — Tincture Cycle consumables (lib/tinctures.js and the engine seams). Plain node.

const assert = require("assert");
const T = require("../lib/tinctures");
const R = require("../lib/rules");
const { toCombatModel } = require("../lib/load-actors");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// ── Parsing and state ───────────────────────────────────────────────────────
t("parses kind=percent pairs", () => {
  assert.deepStrictEqual(T.parseTinctureArg("strength=25, spirit=30,endurance=25"),
    { strength: 25, spirit: 30, endurance: 25 });
});
t("refuses an unknown kind and a bad percent", () => {
  assert.throws(() => T.parseTinctureArg("precision=3"), /unknown tincture/);
  assert.throws(() => T.parseTinctureArg("strength=150"), /out of range/);
  assert.throws(() => T.parseTinctureArg("strength"), /bad tincture/);
});
t("no tincture switched on -> no state, so the engine path is untouched", () => {
  assert.strictEqual(T.makeTinctureState({ pct: {} }), null);
  assert.strictEqual(T.makeTinctureState({ pct: { strength: 0 } }), null);
});

// ── Duration ────────────────────────────────────────────────────────────────
t("lasts three of the bearer's turns", () => {
  const c = { buffs: {} };
  T.applyBuff(c, "strength", 25);
  T.tickTurnEnd(c); assert.strictEqual(T.buffPct(c, "strength"), 25);
  T.tickTurnEnd(c); assert.strictEqual(T.buffPct(c, "strength"), 25);
  T.tickTurnEnd(c); assert.strictEqual(T.buffPct(c, "strength"), 0);
});
t("re-applying refreshes the clock and never stacks the percent", () => {
  const c = { buffs: {} };
  T.applyBuff(c, "strength", 25);
  T.tickTurnEnd(c); T.tickTurnEnd(c);
  T.applyBuff(c, "strength", 25);
  assert.deepStrictEqual(c.buffs.strength, { pct: 25, turnsLeft: 3 });
});
t("Strength boosts DEF actions only, Spirit MDEF actions only", () => {
  const c = { buffs: {} };
  T.applyBuff(c, "strength", 25);
  assert.strictEqual(T.outgoingMult(c, { defenseTarget: "def" }), 1.25);
  assert.strictEqual(T.outgoingMult(c, { defenseTarget: "mdef" }), 1);
  T.applyBuff(c, "spirit", 30);
  assert.strictEqual(T.outgoingMult(c, { defenseTarget: "mdef" }), 1.3);
});

// ── The damage pipeline ─────────────────────────────────────────────────────
const tgt = (affinity) => ({
  affinities: { physical: affinity }, efficiency: { sword: 150 }, statuses: {},
});
t("the boost lands AFTER efficiency and BEFORE affinity, floored (20 -> EF 30 -> x1.25 37 -> VU 74)", () => {
  const spec = { base: 20, element: "physical", weaponFamily: "sword" };
  assert.strictEqual(R.incomingDamage(tgt("VU"), spec).damage, 60);
  assert.strictEqual(R.incomingDamage(tgt("VU"), { ...spec, postEfficiencyMult: 1.25 }).damage, 74);
  // Before efficiency would have read 20 x1.25 = 25 -> EF 38 -> VU 76: the order is observable.
  assert.strictEqual(R.incomingDamage(tgt("RS"), { ...spec, postEfficiencyMult: 1.25 }).damage, 19);
});
t("Endurance sums into percentage damage reduction", () => {
  const target = { affinities: {}, statuses: {}, damageReduction: { flat: 0, percent: 25 } };
  assert.strictEqual(R.incomingDamage(target, { base: 40, element: "physical" }).damage, 30);
});
t("hitChance matches the check's crit and fumble rules", () => {
  assert.strictEqual(R.hitChance(6, 6, 0, 1), 35 / 36);          // only the double 1 misses
  assert.strictEqual(R.hitChance(6, 6, 0, 100), 1 / 36);         // only the double 6 hits
  assert.strictEqual(R.hitChance(4, 4, 0, 100), 0);              // d4 can never crit
});

// ── Carrier policy ──────────────────────────────────────────────────────────
function policyState() {
  const mk = (name, maxHp, takenLastRound = 0) => ({ name, side: "party", alive: true, maxHp, takenLastRound, buffs: {} });
  const blanche = mk("Blanche", 166), zarg = mk("Zarg", 111, 40), hina = mk("Hina", 98);
  const state = {
    tinctures: T.makeTinctureState({ pct: { strength: 25, spirit: 25, endurance: 25 }, user: "Blanche" }),
    combatants: [blanche, zarg, hina],
  };
  const lanes = { Blanche: { def: 99, mdef: 0 }, Zarg: { def: 50, mdef: 0 }, Hina: { def: 0, mdef: 30 } };
  return { state, blanche, zarg, hina, projectLane: (c, lane) => lanes[c.name][lane] };
}
t("Endurance first, on the ally who lost the most HP past the trigger", () => {
  const { state, blanche, zarg, projectLane } = policyState();
  const pick = T.chooseTincture(state, blanche, { projectLane });
  assert.strictEqual(pick.kind, "endurance");
  assert.strictEqual(pick.target, zarg);
});
t("a damage tincture goes to the best projected ally, never the carrier, never twice", () => {
  const { state, blanche, zarg, hina, projectLane } = policyState();
  T.applyBuff(zarg, "endurance", 25);
  let pick = T.chooseTincture(state, blanche, { projectLane });
  assert.strictEqual(pick.kind, "strength");
  assert.strictEqual(pick.target, zarg, "Blanche projects more on DEF but may not boost herself");
  T.applyBuff(zarg, "strength", 25);
  pick = T.chooseTincture(state, blanche, { projectLane });
  assert.strictEqual(pick.kind, "spirit");
  assert.strictEqual(pick.target, hina);
});
t("only the carrier drinks", () => {
  const { state, zarg, projectLane } = policyState();
  assert.strictEqual(T.chooseTincture(state, zarg, { projectLane }), null);
});

// ── Engine ──────────────────────────────────────────────────────────────────
function pc(name, props, items = []) {
  const m = toCombatModel({ _id: name, name, items: [], system: { props: {
    level: "41", dex_base: "8", ins_base: "8", mig_base: "8", wlp_base: "8",
    max_mp: "0", current_mp: "0", magic_defense: "10", defense: "10", ...props,
  } } });
  m.items = items;
  return m;
}
function npc(name, props, items = []) {
  const m = toCombatModel({ _id: name, name, items: [], system: { props: {
    level: "41", npc_rank: "soldier", species: "Monster", activation: "1",
    dex_base: "4", ins_base: "4", mig_base: "4", wlp_base: "4",
    max_mp: "0", current_mp: "0", defense: "1", magic_defense: "1", ...props,
  } } });
  m.items = items;
  return m;
}
const slash = { id: "s", name: "Slash", props: { skill_type: "Attack", skill_target: "One Creature", cost: "-",
  rolled_atr1: "DEX", rolled_atr2: "MIG", damage_bonus: "20", type_damage: "Physical", defense_target_type: "def" } };
const crush = { id: "c", name: "Crush", props: { skill_type: "Attack", skill_target: "One Creature", cost: "-",
  rolled_atr1: "MIG", rolled_atr2: "DEX", check_bonus: "10", damage_bonus: "40", type_damage: "Physical", defense_target_type: "def" } };

t("the carrier hands Strength over on rounds 1, 4 and 7, and the damage it added is exact", () => {
  // Blanche acts first (higher DEX/INS) and has nothing else to do; the dummy never attacks.
  const party = () => [
    pc("Blanche", { max_hp: "166", current_hp: "166", dex_base: "12", ins_base: "12" }),
    pc("Striker", { max_hp: "110", current_hp: "110" }, [slash]),
  ];
  const dummy = () => npc("Dummy", { max_hp: "9000", current_hp: "9000" });
  const on = runBattle({ party: party(), enemies: [dummy()], rng: new Rng("tin"), expectedRounds: 8,
    tinctures: { pct: { strength: 25 }, user: "Blanche", stock: 3 } });
  const off = runBattle({ party: party(), enemies: [dummy()], rng: new Rng("tin"), expectedRounds: 8 });

  const drinks = on.log.filter((e) => e.tincture);
  assert.deepStrictEqual(drinks.map((e) => e.round), [1, 4, 7]);
  assert.ok(drinks.every((e) => e.target === "Striker"));
  assert.strictEqual(on.tinctures.used.strength, 3);

  const sOn = on.combatants.find((c) => c.name === "Striker");
  const sOff = off.combatants.find((c) => c.name === "Striker");
  assert.ok(sOn.tinctureBonusDealt > 0);
  assert.strictEqual(sOn.damageDealt - sOff.damageDealt, sOn.tinctureBonusDealt);
  assert.strictEqual(off.tinctures, null);
});
t("Endurance on a focused carrier cuts the damage she takes, counted as prevented", () => {
  const party = () => [pc("Blanche", { max_hp: "300", current_hp: "300", defense: "1" })];
  const brute = () => npc("Brute", { max_hp: "9000", current_hp: "9000", activation: "2" }, [crush]);
  const on = runBattle({ party: party(), enemies: [brute()], rng: new Rng("end"), expectedRounds: 3,
    tinctures: { pct: { endurance: 25 }, user: "Blanche", stock: 3 } });
  const off = runBattle({ party: party(), enemies: [brute()], rng: new Rng("end"), expectedRounds: 3 });
  const bOn = on.combatants.find((c) => c.name === "Blanche");
  const bOff = off.combatants.find((c) => c.name === "Blanche");
  assert.ok(on.tinctures.used.endurance >= 1, "she drinks once round 1's damage crosses the trigger");
  assert.ok(bOn.tincturePrevented > 0);
  assert.strictEqual(bOff.damageTaken - bOn.damageTaken, bOn.tincturePrevented);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
