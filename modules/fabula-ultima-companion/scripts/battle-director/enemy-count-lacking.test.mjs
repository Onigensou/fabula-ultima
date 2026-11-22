// node scripts/battle-director/enemy-count-lacking.test.mjs
// ENEMY_COUNT_LACKING_<A>[__<B>...]: living, visible, targetable opponents on the
// Battle Director's dCombat roster that lack >= 1 named status they are not IM to.
// A Battle Director fight leaves game.combat null, so the roster is dCombat.
import assert from "node:assert/strict";
globalThis.CONFIG ??= { statusEffects: [] };
globalThis.foundry ??= { utils: { getProperty: (o, p) => String(p).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o) } };
globalThis.Hooks ??= { once() {}, on() {}, callAll() {} };
const NS = "fabula-ultima-companion";
const mkActor = (uuid, disp, effects = [], props = {}) => ({
  uuid, name: uuid, effects: { contents: effects }, appliedEffects: effects,
  prototypeToken: { disposition: disp }, system: { props: { current_hp: 10, ...props } },
});
const ae = (name, extra = {}) => ({ name, disabled: false, statuses: new Set(), changes: [], flags: {}, ...extra });
const servantBlock = ae("Nox Servant", { flags: { [NS]: { noxServant: true } }, changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "opponent" }] });
const guestBlock = ae("Guest", { changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "any" }] });

// The director roster. game.combat stays NULL, exactly as in a real BD fight.
let roster = [];
const cmb = (a, over = {}) => ({ id: a.uuid, actorDoc: a, tokenDoc: { disposition: a.prototypeToken.disposition, hidden: false }, disposition: a.prototypeToken.disposition, defeated: false, ...over });
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };
globalThis.FUCompanion = { api: { experimental: { battleDirector: { getActiveDirector: () => ({ dCombat: { combatants: roster } }) } } } };
// Real shared affinity resolver (registers FUCompanion.api.conditionAffinity).
await import("../shared/condition-affinity.js");
const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
const boss = mkActor("A.boss", -1);
const run = (f) => evaluateFormula(f, buildSkillResolver({ actor: boss, payload: null, skill: null }), -99);
const F2 = "ENEMY_COUNT_LACKING_POISONED__ENVENOMED";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const pc = (i, effs = [], props = {}) => mkActor(`A.pc${i}`, 1, effs, props);
const set = (...entries) => { roster = [cmb(boss), ...entries]; };

t("game.combat is null: the director roster is what is read", () => {
  assert.equal(globalThis.game.combat, null);
  set(cmb(pc(0)), cmb(pc(1)));
  assert.equal(run(F2), 2);
});
t("0 / 1 / 2 / 3 clean PCs count 0..3", () => {
  for (const k of [0, 1, 2, 3]) {
    set(...Array.from({ length: k }, (_, i) => cmb(pc(i))));
    assert.equal(run(F2), k);
  }
});
t("a fully afflicted PC does not count; partial counts", () => {
  set(cmb(pc(0, [ae("Poisoned"), ae("Envenomed")])), cmb(pc(1, [ae("Poisoned")])), cmb(pc(2)));
  assert.equal(run(F2), 2);
});
t("KO'd clean PC (HP 0, and defeated flag) is not counted", () => {
  set(cmb(pc(0, [], { current_hp: 0 })), cmb(pc(1), { defeated: true }), cmb(pc(2)));
  assert.equal(run(F2), 1);
});
t("IM to BOTH statuses is not counted", () => {
  set(cmb(pc(0, [], { condition_poisoned: "IM", condition_envenomed: "IM" })), cmb(pc(1)));
  assert.equal(run(F2), 1);
});
t("IM to one only: still counts while it lacks the other", () => {
  set(cmb(pc(0, [], { condition_poisoned: "IM" })));
  assert.equal(run(F2), 1);
});
t("IM to one and HAS the other: not counted", () => {
  set(cmb(pc(0, [ae("Envenomed")], { condition_poisoned: "IM" })));
  assert.equal(run(F2), 0);
});
t("RS (resist) is not immunity: still counts", () => {
  set(cmb(pc(0, [], { condition_poisoned: "RS", condition_envenomed: "RS" })));
  assert.equal(run(F2), 1);
});
t("2 KO'd + 2 afflicted-or-immune clean -> below the >= 2 gate", () => {
  set(cmb(pc(0, [], { current_hp: 0 })), cmb(pc(1, [], { current_hp: 0 })),
    cmb(pc(2, [ae("Poisoned"), ae("Envenomed")])), cmb(pc(3, [], { condition_poisoned: "IM", condition_envenomed: "IM" })));
  assert.equal(run(`${F2} >= 2`), 0);
});
t("hidden token and creature not on the roster (friendly non-combatant) are not counted", () => {
  const stray = pc(8); // exists, but never joined the dCombat roster
  set(cmb(pc(0), { tokenDoc: { disposition: 1, hidden: true } }), cmb(pc(1)));
  assert.ok(stray);
  assert.equal(run(F2), 1);
});
t("Nox Servant and untargetable guest are not counted", () => {
  set(cmb(pc(0, [servantBlock])), cmb(pc(1, [guestBlock])), cmb(pc(2)));
  assert.equal(run(F2), 1);
});
t("allies of the performer never count", () => {
  set(cmb(mkActor("A.minion", -1)), cmb(pc(0)));
  assert.equal(run(F2), 1);
});
t("status matched by status id; DISABLED AE counts as lacking", () => {
  set(cmb(pc(0, [ae("x", { statuses: new Set(["poisoned"]) }), ae("Envenomed")])),
    cmb(pc(1, [ae("Poisoned", { disabled: true }), ae("Envenomed")])));
  assert.equal(run(F2), 1);
});
t("one-status form, underscore decode, empty name list", () => {
  set(cmb(pc(0, [ae("Poisoned")])), cmb(pc(1)));
  assert.equal(run("ENEMY_COUNT_LACKING_POISONED"), 1);
  set(cmb(pc(0, [ae("Soul Link")])), cmb(pc(1)));
  assert.equal(run("ENEMY_COUNT_LACKING_SOUL_LINK"), 1);
  assert.equal(run("ENEMY_COUNT_LACKING_"), 0);
});
t("unknown status name: every enemy counts (the AUDIT validates the name)", () => {
  set(cmb(pc(0)), cmb(pc(1, [ae("Poisoned")])));
  assert.equal(run("ENEMY_COUNT_LACKING_NOSUCHSTATUS"), 2);
});
t("NO active director -> 0 (fails closed), even with a game.combat roster", () => {
  const saved = globalThis.FUCompanion;
  globalThis.FUCompanion = { api: {} };
  globalThis.game.combat = { combatants: { size: 1, [Symbol.iterator]: () => [{ actor: pc(0), token: { disposition: 1 } }][Symbol.iterator]() } };
  assert.equal(run(F2), 0);
  globalThis.game.combat = null;
  globalThis.FUCompanion = saved;
});
console.log(`${n} passed`);
