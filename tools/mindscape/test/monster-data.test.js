"use strict";
// Mindscape — the monster-data interpreter (lib/monster-data.js). Monsters here are built
// from raw reaction / effect / action-pattern tables in the same shape the world stores,
// so every test exercises the path a shipped monster takes. Plain node.

const assert = require("assert");
const { toCombatModel } = require("../lib/load-actors");
const { runBattle } = require("../lib/engine");
const { Rng } = require("../lib/rng");
const MD = require("../lib/monster-data");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); fail++; }
}

const NS = "fabula-ultima-companion";
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), { $deleted: false, ...r }]));
const tpl = (name, changes = [], flags = {}) => MD.toTemplate({ name, changes: changes.map(([key, value, mode = 2]) => ({ key, value, mode })), flags: { [NS]: flags } });
const LIB = Object.fromEntries([
  tpl("Frightened", [["disable_action", "Attack", 5]], { lifetimeMode: "target_turn_end", charges: 3, chargesMax: 3 }),
  tpl("Paralyzed", [["disable_action", "Skill", 5]], { lifetimeMode: "target_turn_end", charges: 3, chargesMax: 3 }),
  tpl("Shaken", [["bonus_wlp", "-2"]], { lifetimeMode: "target_turn_end", charges: 3, chargesMax: 3 }),
  tpl("Slow", [["bonus_dex", "-2"]], { lifetimeMode: "target_turn_end", charges: 3, chargesMax: 3 }),
  tpl("Wet", [["affinity_3", "VU", 0]], {}),
  tpl("Delay", [], {}),
  tpl("Marked", [], { lifetimeMode: "", charges: 2 }),
].map((x) => [x.name, x]));

function item(name, type, props = {}, { effects = [], reactions = [], onActivate = "" } = {}) {
  return { id: name, name, effects: [], props: {
    skill_type: type, cost: "-", skill_target: "One Creature", rolled_atr1: "-", rolled_atr2: "-", defense_target_type: "def",
    effect_table: table(effects), reaction_config_table: table(reactions), on_activate_effect_ref: onActivate, ...props,
  } };
}
const attack = (name, dmg, extra = {}, opts = {}) => item(name, "Attack", {
  rolled_atr1: "MIG", rolled_atr2: "DEX", check_bonus: "100", damage_bonus: String(dmg), type_damage: "Physical", ...extra }, opts);
const pattern = (rows) => table(rows.map((r) => ({ action_pattern_condition: "always", action_pattern_string: "", action_pattern_value_1: "0",
  action_pattern_value_2: "100", action_pattern_priority: "5", action_pattern_target_focus: "auto", action_pattern_cooldown: "0", ...r })));

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
const fight = (party, enemies, { rounds = 2, seed = "md", event = null } = {}) => runBattle({
  party, enemies, rng: new Rng(seed), expectedRounds: rounds, policy: "legacy", monsterRules: "data", statusLibrary: LIB, conflictEvent: event });

// ── The formula language ────────────────────────────────────────────────────
t("formulas: precedence, functions, comparisons, logic", () => {
  const state = { rng: new Rng("f"), combatants: [], round: 3 };
  const me = { name: "M", hp: 40, maxHp: 100, mp: 30, actor: { mp: { max: 60 } }, aes: [] };
  const ev = (src) => MD.evalFormula(state, src, { reactor: me });
  assert.strictEqual(ev("ceil(10 * 0.25) + 2 * 3"), 9);
  assert.strictEqual(ev("CUR_HP * 2 <= MAX_HP"), 1);
  assert.strictEqual(ev("min(75, CUR_MP) + max(0, 5 - 9)"), 30);
  assert.strictEqual(ev("ROUND % 2 == 1 && CUR_MP > 10"), 1);
  assert.strictEqual(ev("!(CUR_HP > 50) ? 7 : 3"), 7);
  assert.strictEqual(ev("AE_COUNT_SOMETHING == 0"), 1);
});

t("formulas: an unknown identifier is a recorded gap, never a guess", () => {
  const state = { rng: new Rng("f"), combatants: [], round: 1 };
  const me = { name: "M", hp: 1, maxHp: 1, mp: 0, actor: { mp: { max: 0 } }, aes: [] };
  assert.strictEqual(MD.evalFormula(state, "MYSTERY_VALUE > 2", { reactor: me }), null);
  assert.ok(Object.keys(state.dataGaps).some((k) => k.includes("MYSTERY_VALUE")));
});

// ── Statuses ────────────────────────────────────────────────────────────────
t("statuses: target_turn_end ticks on the bearer's turns, '' on the applier's", () => {
  const state = { round: 1, combatants: [], statusLibrary: LIB };
  const bearer = { name: "B", aes: [], side: "party", actor: {} };
  const applier = { name: "A", aes: [], side: "enemy", actor: {} };
  state.combatants.push(bearer, applier);
  MD.addAe(state, bearer, LIB.Frightened, { applier, charges: 1 });
  MD.addAe(state, bearer, LIB.Marked, { applier });
  MD.onTurnStart(state, bearer);                       // not the applier: Marked untouched
  assert.strictEqual(MD.aeCharges(bearer, "Marked"), 2);
  MD.onTurnEnd(state, bearer);                         // Frightened 1 -> gone
  assert.ok(!MD.hasAe(bearer, "Frightened"));
  MD.onTurnStart(state, applier); MD.onTurnStart(state, applier);
  assert.ok(!MD.hasAe(bearer, "Marked"), "the 3-turn default runs on the applier's turn starts");
});

t("statuses: Frightened bars Attacks but not Skills; Wet makes Bolt VU; Slow steps DEX", () => {
  const state = { round: 1, combatants: [] };
  const c = { name: "C", aes: [], side: "party", actor: { affinities: { bolt: "NE" } } };
  MD.addAe(state, c, LIB.Frightened, {});
  assert.ok(MD.isBlocked(c, { skillType: "Attack" }));
  assert.ok(MD.isBlocked(c, { basicAttack: true }));
  assert.ok(!MD.isBlocked(c, { skillType: "Active" }));
  MD.addAe(state, c, LIB.Wet, {});
  assert.strictEqual(MD.affinities(c).bolt, "VU");
  MD.addAe(state, c, LIB.Slow, {});
  assert.strictEqual(MD.applyAttrSteps({ dex: 10, ins: 8, mig: 8, wlp: 8 }, c).dex, 8);
});

// ── Triggers and effects, from the world's own row shapes ───────────────────
const EXPLOSION = item("Electro Explosion", "Passive", {}, {
  reactions: [{ reaction_trigger: "creature_defeated", reaction_source: "self", reaction_passive_mode: "on",
    condition_formula: "TRIGGER_DAMAGE_IS_EARTH == 0", reaction_effect_ref: "electro_burst" }],
  effects: [
    { effect_label: "electro_burst", effect_kind: "deal_damage", damage_element: "bolt", damage_amount: "30", target_ref: "burst_targets" },
    { effect_label: "burst_targets", effect_kind: "targeting", candidate_source: "combat", exclude_self: true, mode: "all" },
  ],
});

t("creature_defeated: the slime's burst hits everyone else, its own side included", () => {
  const killer = pc("Killer", {}, [attack("Smash", 500)]);
  const slime = npc("Slime", { max_hp: "10", current_hp: "10" }, [EXPLOSION]);
  const other = npc("Other", { max_hp: "999", current_hp: "999" });
  const r = fight([killer], [slime, other], { rounds: 1 });
  const burst = r.log.filter((e) => e.action === "Electro Explosion");
  assert.ok(burst.some((e) => e.target === "Other" && e.damage === 30));
  assert.ok(burst.some((e) => e.target === "Killer"));
});

t("creature_defeated: the condition reads the killing element (earth: no burst)", () => {
  const killer = pc("Killer", {}, [attack("Quake", 500, { type_damage: "Earth" })]);
  const slime = npc("Slime", { max_hp: "10", current_hp: "10" }, [EXPLOSION]);
  const r = fight([killer], [slime, npc("Other", { max_hp: "999", current_hp: "999" })], { rounds: 1 });
  assert.ok(!r.log.some((e) => e.action === "Electro Explosion"));
});

t("reaction_source scopes the SUBJECT: blank = any creature, self = only the reactor", () => {
  // Kirin's Lightning Charge shape: any creature losing HP to Bolt not caused by me.
  const charger = item("Charge", "Passive", {}, {
    reactions: [{ reaction_trigger: "creature_lose_resource", reaction_source: "", reaction_resource_filter: "hp", reaction_passive_mode: "on",
      condition_formula: "TRIGGER_DAMAGE_IS_BOLT == 1 && CAUSE_IS_SELF == 0", reaction_effect_ref: "gain" }],
    effects: [{ effect_label: "gain", effect_kind: "grant", grant_resource: "mp", grant_amount: "5", target_ref: "self" }],
  });
  const selfOnly = item("SelfCharge", "Passive", {}, {
    reactions: [{ reaction_trigger: "creature_lose_resource", reaction_source: "self", reaction_resource_filter: "hp", reaction_passive_mode: "on",
      condition_formula: "TRIGGER_DAMAGE_IS_BOLT == 1", reaction_effect_ref: "gain" }],
    effects: [{ effect_label: "gain", effect_kind: "grant", grant_resource: "mp", grant_amount: "5", target_ref: "self" }],
  });
  const zapper = pc("Zapper", {}, [attack("Zap", 1, { type_damage: "Bolt" })]);
  const target = npc("Target", { max_hp: "999", current_hp: "999" });
  const kirin = npc("Kirin", { max_hp: "999", current_hp: "999", max_mp: "100", current_mp: "0", defense: "99" }, [charger]);
  const loner = npc("Loner", { max_hp: "999", current_hp: "999", max_mp: "100", current_mp: "0", defense: "99" }, [selfOnly]);
  const r = runBattle({ party: [zapper], enemies: [target, kirin, loner], rng: new Rng("scope"), expectedRounds: 1, policy: "legacy", monsterRules: "data", statusLibrary: LIB });
  const hitTarget = r.log.some((e) => e.actor === "Zapper" && e.target === "Target" && e.damage > 0);
  if (hitTarget) {
    const k = r.combatants.find((c) => c.name === "Kirin");
    assert.ok(k.reactionsFired > 0, "blank source: Kirin charged off another creature's bolt damage");
  }
  const l = r.combatants.find((c) => c.name === "Loner");
  assert.strictEqual(l.reactionsFired, 0, "self source: nothing fires for someone else's loss");
});

t("a reaction never re-fires from inside itself (Searing Brand's self-damage)", () => {
  const brand = item("Brand", "Passive", {}, {
    reactions: [{ reaction_trigger: "creature_lose_resource", reaction_source: "self", reaction_resource_filter: "hp", reaction_passive_mode: "on", reaction_effect_ref: "boom" }],
    effects: [{ effect_label: "boom", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "5", target_ref: "self", damage_cause: "damage" }],
  });
  const hitter = pc("Hitter", {}, [attack("Poke", 1)]);
  const bearer = npc("Bearer", { max_hp: "999", current_hp: "999", defense: "1" }, [brand]);
  const r = fight([hitter], [bearer], { rounds: 1 });
  const pokes = r.log.filter((e) => e.actor === "Hitter" && e.target === "Bearer" && e.damage > 0).length;
  const booms = r.log.filter((e) => e.action === "Brand").length;
  assert.strictEqual(booms, pokes, "one explosion per outside hit, not a chain");
});

// ── The action reader ───────────────────────────────────────────────────────
function howler(priClaw) {
  return npc("Howler", { activation: "1" }, [
    item("Howl", "Active", { skill_target: "All Enemies" }, { onActivate: "h",
      effects: [{ effect_label: "h", effect_kind: "apply_ae", ae_template_ref: "Shaken", target_ref: "action_targets", ae_duplicate_mode: "replace" }] }),
    attack("Claw", 10),
  ]);
}

t("priority window: a row more than 2 below the top is never picked, even under cooldown", () => {
  const m = howler();
  m._rawProps.action_pattern_table = pattern([
    { action_pattern_name: "Howl", action_pattern_priority: "8", action_pattern_cooldown: "3" },
    { action_pattern_name: "Claw", action_pattern_priority: "2" },
  ]);
  const r = fight([pc("P", { max_hp: "9999", current_hp: "9999" })], [m], { rounds: 4 });
  const used = r.log.filter((e) => e.actor === "Howler" && !e.reaction && !e.quiet).map((e) => e.action);
  assert.ok(used.length >= 4 && used.every((a) => a === "Howl"), `all Howl: ${used.join(",")}`);
});

t("priority window: within 2, the cooldown hands the turn to the next row", () => {
  const m = howler();
  m._rawProps.action_pattern_table = pattern([
    { action_pattern_name: "Howl", action_pattern_priority: "8", action_pattern_cooldown: "3" },
    { action_pattern_name: "Claw", action_pattern_priority: "7" },
  ]);
  const r = fight([pc("P", { max_hp: "9999", current_hp: "9999" })], [m], { rounds: 6, seed: "cd" });
  const byRound = {};
  for (const e of r.log) if (e.actor === "Howler" && e.action === "Howl" && e.effectOnly) byRound[e.round] = true;
  const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < rounds.length; i++) assert.ok(rounds[i] - rounds[i - 1] >= 3, `Howl respects its cooldown: rounds ${rounds}`);
  assert.ok(r.log.some((e) => e.actor === "Howler" && e.action === "Claw"));
});

// ── The Gigas loop, end to end ──────────────────────────────────────────────
t("Oaf: a Bolt strike on its own turn Frightens it, barring Heavy Swing for Bodyslam", () => {
  const oaf = item("Oaf", "Passive", {}, {
    reactions: [
      { reaction_trigger: "conflict_start", reaction_source: "", reaction_passive_mode: "on", reaction_effect_ref: "oaf_delay" },
      { reaction_trigger: "creature_lose_resource", reaction_source: "", reaction_passive_mode: "on",
        condition_formula: "SUBJECT_IS_SELF == 1 && TRIGGER_DAMAGE_IS_BOLT == 1 && IS_MY_TURN == 1", reaction_effect_ref: "oaf_fear" },
    ],
    effects: [
      { effect_label: "oaf_delay", effect_kind: "apply_ae", ae_template_ref: "Delay", target_ref: "self", ae_duplicate_mode: "skip" },
      { effect_label: "oaf_fear", effect_kind: "apply_ae", ae_template_ref: "Frightened", target_ref: "self", ae_duplicate_mode: "replace", ae_initial_charges: "1" },
    ],
  });
  const swing = attack("Heavy Swing", 50);
  const slam = item("Heavy Bodyslam", "Active", { rolled_atr1: "MIG", rolled_atr2: "MIG", check_bonus: "100", damage_bonus: "30", type_damage: "Physical" });
  const gigas = npc("Gigas", { max_hp: "5000", current_hp: "5000" }, [oaf, swing, slam]);
  gigas._rawProps.action_pattern_table = pattern([
    { action_pattern_name: "Heavy Swing", action_pattern_priority: "10", action_pattern_condition: "self_lacks_status", action_pattern_string: "Frightened" },
    { action_pattern_name: "Heavy Bodyslam", action_pattern_priority: "10", action_pattern_condition: "self_has_status", action_pattern_string: "Frightened" },
    { action_pattern_name: "Heavy Swing", action_pattern_priority: "1" },
    { action_pattern_name: "Heavy Bodyslam", action_pattern_priority: "1" },
  ]);
  // A storm whose Rod never leaves the Gigas.
  const storm = {
    id: "test-storm", label: "Storm",
    init(state) { state.rod = state.combatants.find((c) => c.name === "Gigas"); },
    onTurnStart(state, actor) { return state.rod === actor ? { damage: 5, element: "bolt", mp: 0 } : null; },
  };
  const party = [pc("Tank", { max_hp: "99999", current_hp: "99999" })];
  const calm = fight(party, [gigas], { rounds: 3 });
  assert.ok(calm.log.some((e) => e.actor === "Gigas" && e.action === "Heavy Swing"));
  assert.ok(!calm.log.some((e) => e.actor === "Gigas" && e.action === "Heavy Bodyslam"), "no storm, no fear");
  const stormy = fight(party, [gigas], { rounds: 3, event: storm });
  const acts = stormy.log.filter((e) => e.actor === "Gigas" && /^Heavy/.test(e.action)).map((e) => e.action);
  assert.ok(acts.length && acts.every((a) => a === "Heavy Bodyslam"), `struck every turn -> only Bodyslam: ${acts.join(",")}`);
});

// ── Saves ───────────────────────────────────────────────────────────────────
t("save tiers are cumulative: a low total lands every tier above it", () => {
  const breath = item("Breath", "Spell", { skill_target: "All Enemies" }, { onActivate: "go", effects: [
    { effect_label: "go", effect_kind: "chain", chain_steps: "sv,t1,t2,t3" },
    { effect_label: "sv", effect_kind: "save_check", target_ref: "action_targets", save_attr1: "dex", save_attr2: "dex", save_dl: "16", save_tiers: "16,14,2" },
    { effect_label: "t1", effect_kind: "apply_ae", ae_template_ref: "Slow", target_ref: "save_tier_1" },
    { effect_label: "t2", effect_kind: "apply_ae", ae_template_ref: "Shaken", target_ref: "save_tier_2" },
    { effect_label: "t3", effect_kind: "apply_ae", ae_template_ref: "Paralyzed", target_ref: "save_tier_3" },
  ] });
  const m = npc("Breather", {}, [breath]);
  m._rawProps.action_pattern_table = pattern([{ action_pattern_name: "Breath" }]);
  // d6 + d6 can never reach 14, and can never be under 2.
  const r = fight([pc("Victim", { dex_base: "6", max_hp: "9999", current_hp: "9999" })], [m], { rounds: 1 });
  const got = r.log.filter((e) => e.target === "Victim" && e.status).map((e) => e.status);
  assert.ok(got.includes("Slow") && got.includes("Shaken"), got.join(","));
  assert.ok(!got.includes("Paralyzed"));
});

// ── Coverage ────────────────────────────────────────────────────────────────
t("coverage(): names what the interpreter cannot run, by kind", () => {
  const m = npc("Odd", {}, [item("Weird", "Passive", {}, {
    reactions: [{ reaction_trigger: "creature_sneezes", reaction_passive_mode: "on", reaction_effect_ref: "x", condition_formula: "SNEEZE_COUNT > 1" }],
    effects: [{ effect_label: "x", effect_kind: "open_action_menu" }],
  })]);
  const gaps = MD.coverage(m);
  assert.ok(gaps.some((g) => g.includes("trigger creature_sneezes")));
  assert.ok(gaps.some((g) => g.includes("SNEEZE_COUNT")));
  assert.ok(gaps.some((g) => g.includes("open action menu")));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
