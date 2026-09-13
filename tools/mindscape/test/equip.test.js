"use strict";
// Mindscape — paper equipment (--equip) and attack-declaration riders.
// Plain node, no framework.
//
// The Explosion Whip rows are exercised through the REAL registry entry and a
// real runBattle, so an edit to the gate, the tuning, or the engine seam breaks
// a test rather than quietly diverging from docs/equipment-balance-design.md.

const assert = require("assert");
const RX = require("../lib/reactions");
const { toCombatModel } = require("../lib/load-actors");
const { checkEquipSpec, applyEquip, parseEquipArg } = require("../lib/equip-file");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const PASSIVE = "Explosion Whip (Passive)";

function whipDoc(passiveProps = null, overrides = {}) {
  return {
    name: "Explosion Whip",
    system: { props: {
      item_type: "weapon", category: "Flail", damage_bonus: "8", check_bonus: "0",
      type_damage: "Fire", rolled_atr1: "DEX", rolled_atr2: "DEX", weapon_range: "Melee",
      ...overrides,
    } },
    items: passiveProps ? [{ name: PASSIVE, props: { skill_type: "Passive", ...passiveProps } }] : [],
  };
}

// A one-PC party: d8s, one activation, no kit — every turn is the weapon swing,
// so the log is exactly the behaviour under test.
function pc(level = 41) {
  return toCombatModel({ _id: "pc", name: "Tester", items: [], system: { props: {
    level: String(level), dex_base: "8", ins_base: "8", mig_base: "8", wlp_base: "8",
    max_hp: "500", current_hp: "500", max_mp: "0", current_mp: "0",
    defense: "30", magic_defense: "30",
    main_hand: "Stick", weapon1_base_damage: "1", main_attrib_1: "DEX", main_attrib_2: "DEX",
  } } });
}

// DEF 2: everything but a fumble hits, so the damage bounds below are about the
// rider, not about accuracy. No actions: dummies only ever guard.
function dummy(name) {
  return toCombatModel({ _id: name, name, items: [], system: { props: {
    level: "41", npc_rank: "soldier", species: "Monster",
    dex_base: "8", ins_base: "8", mig_base: "8", wlp_base: "8",
    max_hp: "5000", current_hp: "5000", defense: "2", magic_defense: "2",
  } } });
}

// Per-round swing entries for the tester: hits and misses, never announce rows.
function swings(passiveProps, { level = 41, seed = "equip-test", rounds = 6 } = {}) {
  const who = pc(level);
  applyEquip(who, whipDoc(passiveProps));
  const r = runBattle({
    party: [who], enemies: [dummy("A"), dummy("B"), dummy("C")],
    rng: new Rng(seed), expectedRounds: rounds,
  });
  const byRound = new Map();
  for (const e of r.log) {
    if (e.actor !== "Tester" || e.reaction || e.announce) continue;
    if (!byRound.has(e.round)) byRound.set(e.round, []);
    byRound.get(e.round).push(e);
  }
  return byRound;
}

// ── Spec loading ────────────────────────────────────────────────────────────
t("a well-formed weapon spec passes", () => {
  assert.deepStrictEqual(checkEquipSpec(whipDoc()), []);
});
t("a non-weapon is refused — only the main hand is modelled", () => {
  assert.ok(checkEquipSpec(whipDoc(null, { item_type: "armor" })).some((p) => /item_type/.test(p)));
});
t("an unknown category is refused — the EF axis would be silently inert", () => {
  assert.ok(checkEquipSpec(whipDoc(null, { category: "Whip" })).some((p) => /category/.test(p)));
});
t("a formula damage_bonus is refused, never zeroed", () => {
  assert.ok(checkEquipSpec(whipDoc(null, { damage_bonus: "5 + SL_X" })).some((p) => /damage_bonus/.test(p)));
});
t("a zero damage_bonus is refused — weaponAction would read it as no weapon", () => {
  assert.ok(checkEquipSpec(whipDoc(null, { damage_bonus: "0" })).some((p) => /above 0/.test(p)));
});
t("--equip splits on the first '='", () => {
  assert.deepStrictEqual(parseEquipArg("Zarg=a=b.json"), { pc: "Zarg", file: "a=b.json" });
  assert.throws(() => parseEquipArg("Zarg"));
});
t("applyEquip rebuilds the weapon the engine reads and attaches the gear skill", () => {
  const who = pc();
  const rec = applyEquip(who, whipDoc({}));
  assert.strictEqual(rec.displaced, "Stick");
  assert.strictEqual(who.weapon.family, "flail");
  assert.strictEqual(who.weapon.range, "melee");
  assert.strictEqual(who.weapon.baseDamage, 8);
  assert.strictEqual(who.weapon.attrA, "DEX");
  assert.ok(who.items.some((i) => i.name === PASSIVE && i.props.skill_type === "Passive"));
});

// ── Registry: array entries, gate, kind-scoped tuning ───────────────────────
t("an array registry entry declares one row per hook point", () => {
  const rows = RX.declaredReactions([{ name: PASSIVE, props: {} }]);
  assert.deepStrictEqual(rows.map((r) => r.effect.kind).sort(), ["damage_add", "target_count"]);
  assert.ok(rows.every((r) => r.name === PASSIVE));
});
t("the whip gate: even round AND basic attack only", () => {
  const [row] = RX.registryRows(RX.REACTION_REGISTRY[PASSIVE]);
  assert.strictEqual(row.gate({ round: 2, isBasicAttack: true }), true);
  assert.strictEqual(row.gate({ round: 3, isBasicAttack: true }), false);
  assert.strictEqual(row.gate({ round: 2, isBasicAttack: false }), false);
});
t("the whip gate does NOT fire on round 0 or no round (0 % 2 === 0 trap)", () => {
  const [row] = RX.registryRows(RX.REACTION_REGISTRY[PASSIVE]);
  assert.strictEqual(row.gate({ round: 0, isBasicAttack: true }), false);
  assert.strictEqual(row.gate({ isBasicAttack: true }), false);
});
t("tuning dials reach only the row whose effect they name", () => {
  const rows = RX.declaredReactions([{ name: PASSIVE, props: {
    mindscape_target_count: "2", mindscape_damage_add: "0", mindscape_damage_add_level_div: "5",
  } }]);
  const reach = rows.find((r) => r.effect.kind === "target_count").effect;
  const dmg = rows.find((r) => r.effect.kind === "damage_add").effect;
  assert.strictEqual(reach.count, 2);
  assert.strictEqual(reach.amount, undefined);
  assert.strictEqual(dmg.amount, 0);
  assert.strictEqual(dmg.levelDiv, 5);
  assert.strictEqual(dmg.count, undefined);
});
t("tuning never mutates the frozen registry entry", () => {
  RX.declaredReactions([{ name: PASSIVE, props: { mindscape_target_count: "9" } }]);
  const [row] = RX.registryRows(RX.REACTION_REGISTRY[PASSIVE]);
  assert.strictEqual(row.effect.count, 3);
});

// ── Engine: the rider actually changes the swing ────────────────────────────
t("no passive: one target every round, damage HR + 8", () => {
  for (const [round, es] of swings(null)) {
    assert.strictEqual(es.length, 1, `round ${round}: ${es.length} entries`);
    for (const e of es) if (!e.miss) assert.ok(e.damage >= 9 && e.damage <= 16, `round ${round}: ${e.damage}`);
  }
});
t("Explosion Whip: Multi 3 on even rounds only", () => {
  const by = swings({});
  assert.ok(by.size >= 4, `only ${by.size} rounds logged`);
  for (const [round, es] of by) assert.strictEqual(es.length, round % 2 === 0 ? 3 : 1, `round ${round}`);
});
t("Explosion Whip: +10 per target on even rounds only", () => {
  for (const [round, es] of swings({})) {
    for (const e of es) {
      if (e.miss) continue;
      const [lo, hi] = round % 2 === 0 ? [19, 26] : [9, 16];
      assert.ok(e.damage >= lo && e.damage <= hi, `round ${round}: ${e.damage} not in [${lo}, ${hi}]`);
    }
  }
});
t("scaled variant: Multi 2 and +level/5 (L41 -> +8) on even rounds", () => {
  const by = swings({ mindscape_target_count: "2", mindscape_damage_add: "0", mindscape_damage_add_level_div: "5" });
  for (const [round, es] of by) {
    const even = round % 2 === 0;
    assert.strictEqual(es.length, even ? 2 : 1, `round ${round}`);
    for (const e of es) {
      if (e.miss) continue;
      const [lo, hi] = even ? [17, 24] : [9, 16];
      assert.ok(e.damage >= lo && e.damage <= hi, `round ${round}: ${e.damage}`);
    }
  }
});
t("the level term follows the wielder's level (L20 -> +4)", () => {
  const by = swings({ mindscape_damage_add: "0", mindscape_damage_add_level_div: "5" }, { level: 20 });
  for (const [round, es] of by) {
    if (round % 2) continue;
    for (const e of es) if (!e.miss) assert.ok(e.damage >= 13 && e.damage <= 20, `round ${round}: ${e.damage}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
