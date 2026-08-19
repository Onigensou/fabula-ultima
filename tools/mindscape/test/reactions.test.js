"use strict";
// Mindscape — reaction layer + conflict event tests. Plain node, no framework.
//
// These assert the properties that make the layer worth having. The gates are
// exercised through the real registry entries, not restated, so an edit to a
// registry gate breaks the test rather than quietly diverging from it.

const assert = require("assert");
const RX = require("../lib/reactions");
const { LIGHTNING_STORM } = require("../lib/conflict-events");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// ── Overload Riposte ────────────────────────────────────────────────────────
const riposte = RX.REACTION_REGISTRY["Overload Riposte"];
const hit = (o = {}) => ({ hit: true, damage: 40, accuracyResult: 14, element: "physical", ...o });

t("riposte fires on an even Accuracy Result", () => {
  assert.strictEqual(riposte.gate(hit()), true);
});
t("riposte does NOT fire on an odd Accuracy Result", () => {
  assert.strictEqual(riposte.gate(hit({ accuracyResult: 15 })), false);
});
t("riposte does NOT fire on Bolt — that is Chain Reaction's lane", () => {
  assert.strictEqual(riposte.gate(hit({ element: "bolt" })), false);
});
t("riposte does NOT fire on a miss", () => {
  assert.strictEqual(riposte.gate(hit({ hit: false })), false);
});
t("riposte does NOT fire on a zero-damage hit", () => {
  assert.strictEqual(riposte.gate(hit({ damage: 0 })), false);
});
// The live failure mode this mirrors: ATTACK_CHECK_RESULT reads 0 when no roll
// info is threaded, and 0 % 2 == 0 is TRUE, so the gate fires on everything.
t("riposte does NOT fire when there is no roll (0 % 2 == 0 trap)", () => {
  assert.strictEqual(riposte.gate(hit({ accuracyResult: 0 })), false);
});
t("riposte is uncapped — the gate carries no per-round state", () => {
  for (let i = 0; i < 10; i++) assert.strictEqual(riposte.gate(hit()), true);
});

// ── Static Buildup ──────────────────────────────────────────────────────────
const stat = RX.REACTION_REGISTRY["Static Buildup"];
t("static burst is 30 Bolt at a threshold of 3, on the creature just damaged", () => {
  assert.strictEqual(stat.effect.threshold, 3);
  assert.strictEqual(stat.effect.damage, 30);
  assert.strictEqual(stat.effect.element, "bolt");
  assert.strictEqual(stat.effect.target, "victim");
});

// ── Chain Reaction ──────────────────────────────────────────────────────────
const chain = RX.REACTION_REGISTRY["Chain Reaction"];
t("chain reaction fires on Bolt", () => {
  assert.strictEqual(chain.gate({ element: "bolt", direction: "loss" }), true);
});
t("chain reaction fires on an ABSORBED bolt hit (direction recover)", () => {
  assert.strictEqual(chain.gate({ element: "bolt", direction: "recover" }), true);
});
t("chain reaction ignores non-Bolt", () => {
  assert.strictEqual(chain.gate({ element: "fire", direction: "loss" }), false);
});

// ── Registry hygiene ────────────────────────────────────────────────────────
t("every registry entry has a known trigger and an effect kind", () => {
  const triggers = new Set(Object.values(RX.TRIGGERS));
  const kinds = new Set(["free_attack", "stack_burst", "burst", "grant_mp"]);
  for (const [name, r] of Object.entries(RX.REACTION_REGISTRY)) {
    assert.ok(triggers.has(r.trigger), `${name}: unknown trigger ${r.trigger}`);
    assert.ok(kinds.has(r.effect.kind), `${name}: unknown effect ${r.effect.kind}`);
    assert.strictEqual(typeof r.gate, "function", `${name}: no gate`);
  }
});
t("a counter payload is excluded from turn-action selection", () => {
  assert.ok(RX.REACTION_ONLY_ACTIONS.has("Thunder Strike (Riposte)"));
  // Chain Reaction re-fires the MAIN attack, which must stay selectable.
  assert.ok(!RX.REACTION_ONLY_ACTIONS.has("Thunder Strike"));
});
t("declaredReactions/undeclaredReactions partition the passive list", () => {
  const passives = [{ name: "Overload Riposte" }, { name: "Flying" }, { name: "Static Buildup" }];
  assert.deepStrictEqual(RX.declaredReactions(passives).map((r) => r.name),
    ["Overload Riposte", "Static Buildup"]);
  assert.deepStrictEqual(RX.undeclaredReactions(passives), ["Flying"]);
});
t("collect() returns only same-trigger reactions whose gate passes", () => {
  const c = { reactions: RX.declaredReactions([{ name: "Overload Riposte" }, { name: "Chain Reaction" }]) };
  const got = RX.collect(c, RX.TRIGGERS.ON_TARGETED, hit());
  assert.deepStrictEqual(got.map((r) => r.name), ["Overload Riposte"]);
});
t("collect() treats a throwing gate as no-fire, never as a crash", () => {
  const c = { reactions: [{ name: "boom", trigger: RX.TRIGGERS.ON_TARGETED, gate: () => { throw new Error("x"); }, effect: {} }] };
  assert.deepStrictEqual(RX.collect(c, RX.TRIGGERS.ON_TARGETED, {}), []);
});

// ── Lightning Storm ─────────────────────────────────────────────────────────
const mkState = (names) => {
  const combatants = names.map((n) => ({ name: n, alive: true }));
  return { combatants, rng: { int: () => 0 }, rod: null };
};

t("storm seeds the Rod onto somebody at init", () => {
  const s = mkState(["A", "B"]);
  LIGHTNING_STORM.init(s);
  assert.ok(s.combatants.includes(s.rod));
});
t("creature-dealt damage MOVES the Rod", () => {
  const s = mkState(["A", "B"]);
  s.rod = s.combatants[0];
  LIGHTNING_STORM.onDamage(s, s.combatants[1], "damage");
  assert.strictEqual(s.rod, s.combatants[1]);
});
// The exclusion that was actually wrong in the first implementation.
t("the storm's OWN strike does not move the Rod (hazard cause)", () => {
  const s = mkState(["A", "B"]);
  s.rod = s.combatants[0];
  LIGHTNING_STORM.onDamage(s, s.combatants[1], "hazard");
  assert.strictEqual(s.rod, s.combatants[0]);
});
t("the Rod strikes only its holder, once per activation", () => {
  const s = mkState(["A", "B"]);
  s.rod = s.combatants[0];
  assert.ok(LIGHTNING_STORM.onTurnStart(s, s.combatants[0]));
  assert.strictEqual(LIGHTNING_STORM.onTurnStart(s, s.combatants[1]), null);
});
t("a dead holder is re-seeded at round start (rule 5)", () => {
  const s = mkState(["A", "B"]);
  s.rod = s.combatants[0];
  s.combatants[0].alive = false;
  LIGHTNING_STORM.onRoundStart(s);
  assert.strictEqual(s.rod, s.combatants[1]);
});
t("the strike is 30 Bolt and +30 MP", () => {
  const s = mkState(["A"]);
  s.rod = s.combatants[0];
  const strike = LIGHTNING_STORM.onTurnStart(s, s.combatants[0]);
  assert.deepStrictEqual(strike, { damage: 30, element: "bolt", mp: 30 });
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
