"use strict";
//
// Monster Design Dossier tests. Plain Node: `node test/dossier.test.js`.
//
// The dossier is only worth having if drift is caught: each invariant selector must
// FAIL when the sheet stops matching the design, not just pass on today's data.

const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const DS = require("../lib/dossier");
const { WorldItems } = require("../lib/world-items");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// Gigas as the sheet holds it (the parts the invariants read).
const GIGAS = {
  id: "1Lw78Js1f7MogV2B", name: "Gigas",
  affinities: { bolt: "VU", fire: "VU", physical: "RS" },
  _rawProps: { condition_frightened: "NA" },
  items: [
    { name: "Heavy Swing", props: { skill_type: "Attack", damage_bonus: "120" } },
    { name: "Heavy Bodyslam", props: { skill_type: "Active", effect_table: { 0: { effect_label: "bodyslam_recoil", damage_amount: "100" } } } },
    { name: "Oaf", props: {
      effect_table: { 0: { effect_label: "oaf_delay" }, 1: { effect_label: "oaf_fear", ae_initial_charges: "1" } },
      reaction_config_table: { 1: { reaction_effect_ref: "oaf_fear", condition_formula: "SUBJECT_IS_SELF == 1 && TRIGGER_DAMAGE_IS_BOLT == 1 && IS_MY_TURN == 1" } },
    } },
    { name: "Giant Club", props: { id: "emb", damage_bonus: "22", item_cost: "1800" } },
  ],
};
const WORLD = new WorldItems([["MIbpz90syxNxghMh", { id: "MIbpz90syxNxghMh", props: { id: "world", damage_bonus: "22", item_cost: "1800" } }]]);
const gigasDossier = DS.parseDossier(fs.readFileSync(path.join(DS.DOSSIER_DIR, "gigas.md"), "utf8"), "gigas.md");
const failed = (model, opts = { worldItems: WORLD }) => DS.checkInvariants(gigasDossier, model, opts).filter((i) => !i.ok).map((i) => i.id);

console.log("\nparse");

test("the Gigas dossier parses and carries its sections", () => {
  assert.strictEqual(gigasDossier.data.monster, "Gigas");
  assert.strictEqual(gigasDossier.data.actorId, "1Lw78Js1f7MogV2B");
  assert.ok(gigasDossier.sections["The gimmick"].includes("Frightened"));
  assert.ok(gigasDossier.data.invariants.length >= 8);
});

test("a file without a json dossier block is refused", () => {
  assert.throws(() => DS.parseDossier("# x\n\nno block", "x.md"), /no ```json dossier block/);
});

test("every file in dossiers/ parses", () => {
  for (const d of DS.loadDossiers()) assert.ok(d.data.monster, d.file);
});

test("decision log rows come back without the header", () => {
  const log = DS.decisionLog(gigasDossier);
  assert.ok(log.length >= 5);
  assert.strictEqual(log[0][0], "2026-08-14");
});

console.log("\ninvariants — today's sheet holds");

test("every Gigas invariant holds on the sheet as built", () => {
  assert.deepStrictEqual(failed(GIGAS), []);
});

test("the dossier is found by actor id even after a rename", () => {
  assert.strictEqual(DS.findDossier([gigasDossier], { ...GIGAS, name: "Gigas (renamed)" }), gigasDossier);
});

console.log("\ninvariants — drift is caught");

test("Heavy Swing turned into an Active skill = the one-shot loses its Frightened gate", () => {
  const m = clone(GIGAS);
  m.items[0].props.skill_type = "Active";
  assert.deepStrictEqual(failed(m), ["swing-is-attack"]);
});

test("Frightened resisted = the whole design is gone", () => {
  const m = clone(GIGAS);
  m._rawProps.condition_frightened = "RS";
  assert.deepStrictEqual(failed(m), ["frightened-not-immune"]);
});

test("bolt no longer VU", () => {
  const m = clone(GIGAS);
  m.affinities.bolt = "NE";
  assert.deepStrictEqual(failed(m), ["bolt-vulnerable"]);
});

test("IS_MY_TURN dropped from the Oaf gate", () => {
  const m = clone(GIGAS);
  m.items[2].props.reaction_config_table[1].condition_formula = "SUBJECT_IS_SELF == 1 && TRIGGER_DAMAGE_IS_BOLT == 1";
  assert.deepStrictEqual(failed(m), ["oaf-rod-only-gate"]);
});

test("Frightened back to 3 charges (table row found by effect_label)", () => {
  const m = clone(GIGAS);
  m.items[2].props.effect_table[1].ae_initial_charges = "3";
  assert.deepStrictEqual(failed(m), ["frightened-one-charge"]);
});

test("a missing item fails rather than passing silently", () => {
  const m = clone(GIGAS);
  m.items = m.items.filter((i) => i.name !== "Heavy Bodyslam");
  assert.deepStrictEqual(failed(m), ["bodyslam-is-active", "bodyslam-recoil"]);
});

test("stolen Club copy out of sync with the world item (id/uuid ignored)", () => {
  const m = clone(GIGAS);
  m.items[3].props.damage_bonus = "18";
  const r = DS.checkInvariants(gigasDossier, m, { worldItems: WORLD }).find((i) => i.id === "club-in-sync");
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /damage_bonus/);
  assert.doesNotMatch(r.text, /\bid\b/);
});

test("without world items the sync check says it was skipped, not that it passed", () => {
  const r = DS.checkInvariants(gigasDossier, GIGAS, {}).find((i) => i.id === "club-in-sync");
  assert.strictEqual(r.skipped, true);
});

test("operators: in / min / max", () => {
  const m = { ...GIGAS, _rawProps: { max_hp: "800", npc_rank: "elite" } };
  const run = (inv) => DS.checkInvariant(inv, m).ok;
  assert.strictEqual(run({ prop: "npc_rank", in: ["elite", "champion"] }), true);
  assert.strictEqual(run({ prop: "max_hp", min: 700 }), true);
  assert.strictEqual(run({ prop: "max_hp", max: 700 }), false);
});

test("actor-level table via where: one match passes, a duplicate is ambiguous, none is missing", () => {
  const m = { ...GIGAS, _rawProps: { action_pattern_table: {
    0: { action_pattern_name: "Heavy Swing", action_pattern_priority: "10", action_pattern_string: "Frightened" },
    2: { action_pattern_name: "Heavy Swing", action_pattern_priority: "1" },
  } } };
  const run = (where) => DS.checkInvariant({ id: "x", table: "action_pattern_table", where, field: "action_pattern_string", equals: "Frightened" }, m);
  assert.strictEqual(run({ action_pattern_name: "Heavy Swing", action_pattern_priority: "10" }).ok, true);
  assert.match(run({ action_pattern_name: "Heavy Swing" }).text, /ambiguous/);
  assert.match(run({ action_pattern_name: "Severing Verdict" }).text, /no row matches/);
});

console.log("\nfindings");

test("an exception marks the matching finding intended, with its reason", () => {
  const out = DS.classifyFindings([
    { rule: "one-shot", action: "Heavy Swing", text: "Heavy Swing avg 128 ..." },
    { rule: "absorb", text: "absorbs bolt" },
  ], gigasDossier);
  assert.strictEqual(out[0].status, "intended");
  assert.strictEqual(out[0].confirmed, true);
  assert.match(out[0].why, /Lightning Rod/);
  assert.strictEqual(out[1].status, "new");
});

test("an exception for one action does not excuse another action's one-shot", () => {
  const [f] = DS.classifyFindings([{ rule: "one-shot", action: "Heavy Bodyslam", text: "x" }], gigasDossier);
  assert.strictEqual(f.status, "new");
});

test("no dossier: everything is new", () => {
  const [f] = DS.classifyFindings([{ rule: "one-shot", action: "Heavy Swing", text: "x" }], null);
  assert.strictEqual(f.status, "new");
});

console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}\n`);
