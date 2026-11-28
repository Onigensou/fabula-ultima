// node scripts/battle-director/botc-untoll-minion.test.mjs
// Birth of the Cruel: only the raised Minion's death lifts the Grave Toll.
// SUBJECT_IS_MY_MINION (payload summonKind / isClone) + the row migration.
import assert from "node:assert/strict";
globalThis.CONFIG ??= { statusEffects: [] };
globalThis.foundry ??= { utils: {} };
globalThis.foundry.utils.getProperty ??= (o, p) => String(p).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
globalThis.foundry.utils.fromUuidSync = () => null;
globalThis.Hooks ??= { once() {}, on() {}, callAll() {} };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };

const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
const keren = { uuid: "Actor.keren", name: "Keren", id: "keren", flags: {} };
const run = (payload, f) => evaluateFormula(f, buildSkillResolver({ actor: keren, payload, skill: null }), -99);
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ok", name); };

await t("Mana Ray (kind minion, clone) falls: MINION 1, SUMMON 1", () => {
  const p = { summonedBy: "Actor.keren", summonKind: "minion", isClone: true };
  assert.equal(run(p, "SUBJECT_IS_MY_MINION"), 1);
  assert.equal(run(p, "SUBJECT_IS_MY_SUMMON"), 1);
});
await t("Crysta (Numen, no kind, not a clone) falls: MINION 0, SUMMON still 1", () => {
  const p = { summonedBy: "Actor.keren", summonKind: null, isClone: false };
  assert.equal(run(p, "SUBJECT_IS_MY_MINION"), 0);
  assert.equal(run(p, "SUBJECT_IS_MY_SUMMON"), 1);
  assert.equal(run(p, "SUBJECT_IS_MY_MINION == 1 && 1 >= 1"), 0);
});
await t("legacy unstamped clone counts as a Minion", () => {
  assert.equal(run({ summonedBy: "Actor.keren", isClone: true }, "SUBJECT_IS_MY_MINION"), 1);
});
await t("someone else's minion / other kinds: 0", () => {
  assert.equal(run({ summonedBy: "Actor.blanche", summonKind: "minion", isClone: true }, "SUBJECT_IS_MY_MINION"), 0);
  assert.equal(run({ summonedBy: "Actor.keren", summonKind: "companion", isClone: false }, "SUBJECT_IS_MY_MINION"), 0);
  assert.equal(run(null, "SUBJECT_IS_MY_MINION"), 0);
});

// Migration: only the botc_untoll row's condition changes; other rows untouched.
const mig = await import("../../data-migrations/2026-11-28-botc-untoll-minion-only.js");
const mkItem = (name, parent = null) => {
  const it = {
    name, parent,
    system: { props: {
      effect_table: { 3: { effect_label: "botc_summon", summon_clone_statuses: "Zombie" } },
      reaction_config_table: {
        0: { reaction_trigger: "creature_defeated", reaction_effect_ref: "botc_chain", condition_formula: "OWN_PERSISTENT_SUMMONS_MINION == 0" },
        1: { reaction_trigger: "creature_defeated", reaction_effect_ref: "botc_untoll", condition_formula: "SUBJECT_IS_MY_SUMMON == 1 && AE_COUNT_GRAVE_TOLL >= 1" },
        2: { reaction_trigger: "creature_defeated", reaction_effect_ref: "botc_ko_cleanup", condition_formula: "AE_COUNT_GRAVE_TOLL >= 1" },
      },
    } },
    updates: [],
    async update(u) {
      this.updates.push(u);
      for (const [k, v] of Object.entries(u)) {
        const path = k.split(".").slice(1); let o = this;
        for (const p of ["system", ...path.slice(0, -1)]) o = o[p];
        o[path.at(-1)] = v;
      }
    },
  };
  return it;
};
await t("migration rewrites the untoll row only, idempotent", async () => {
  const world = mkItem("Birth of the Cruel");
  const kerenCopy = mkItem("Birth of the Cruel", { name: "Keren" });
  const other = mkItem("Some Other Skill");
  const g = { items: [world, other], actors: [{ name: "Keren", items: [kerenCopy] }] };
  await mig.migrate(g);
  for (const it of [world, kerenCopy]) {
    const rt = it.system.props.reaction_config_table;
    assert.equal(rt[1].condition_formula, "SUBJECT_IS_MY_MINION == 1 && AE_COUNT_GRAVE_TOLL >= 1");
    assert.equal(rt[0].condition_formula, "OWN_PERSISTENT_SUMMONS_MINION == 0");
    assert.equal(rt[2].condition_formula, "AE_COUNT_GRAVE_TOLL >= 1");
    assert.equal(it.system.props.effect_table[3].summon_clone_statuses, "Zombie");
    assert.equal(it.updates.length, 1);
    assert.deepEqual(Object.keys(it.updates[0]), ["system.props.reaction_config_table.1.condition_formula"]);
  }
  assert.equal(other.updates.length, 0);
  await mig.migrate(g);
  assert.equal(world.updates.length, 1, "second run writes nothing");
});
console.log(`botc-untoll-minion: ${n} passed`);
