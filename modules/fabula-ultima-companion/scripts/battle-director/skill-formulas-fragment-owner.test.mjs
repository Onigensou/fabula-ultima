// node scripts/battle-director/skill-formulas-fragment-owner.test.mjs
// SOUL_FRAGMENT_OWNER_IS_<NAME>: resolver actor (a pattern row's performer = the
// fragment) is a soul fragment whose token-flagged owner matches <NAME>. Else 0.
import assert from "node:assert/strict";
globalThis.CONFIG ??= { statusEffects: [] };
const owners = {};
globalThis.foundry ??= { utils: {} };
globalThis.foundry.utils.getProperty ??= (o, p) => String(p).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
globalThis.foundry.utils.fromUuidSync = (u) => owners[u] ?? null;
globalThis.Hooks ??= { once() {}, on() {}, callAll() {} };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };
const NS = "fabula-ultima-companion";
const pcActor = (uuid, name, id = uuid) => (owners[uuid] = { uuid, name, id, documentName: "Actor" });
pcActor("Actor.h", "Hina"); pcActor("Actor.k", "Keren"); pcActor("Actor.b", "Blanche Dubois", "Xb12");
const frag = (ownerUuid, conflictObject = "soul-fragment") => ({
  name: "Soul Fragment", flags: { [NS]: { conflictObject } },
  token: { flags: { [NS]: ownerUuid ? { soulFragmentOwner: ownerUuid } : {} } },
});
const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
const run = (actor, f) => evaluateFormula(f, buildSkillResolver({ actor, payload: null, skill: null }), -99);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("Hina's fragment: HINA 1, KEREN 0", () => {
  const f = frag("Actor.h");
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_HINA"), 1);
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_KEREN"), 0);
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_HINA == 1"), 1);
});
t("non-fragment actor: 0 (even with an owner flag)", () => {
  const a = frag("Actor.h", "lightning-crystal");
  assert.equal(run(a, "SOUL_FRAGMENT_OWNER_IS_HINA"), 0);
  assert.equal(run({ name: "Nidhogg", flags: {} }, "SOUL_FRAGMENT_OWNER_IS_HINA"), 0);
  assert.equal(run(null, "SOUL_FRAGMENT_OWNER_IS_HINA"), 0);
});
t("missing / unresolvable owner: 0", () => {
  assert.equal(run(frag(null), "SOUL_FRAGMENT_OWNER_IS_HINA"), 0);
  assert.equal(run(frag("Actor.gone"), "SOUL_FRAGMENT_OWNER_IS_HINA"), 0);
});
t("unknown name: 0 (fails closed)", () => {
  assert.equal(run(frag("Actor.h"), "SOUL_FRAGMENT_OWNER_IS_NOBODY"), 0);
  assert.equal(run(frag("Actor.h"), "SOUL_FRAGMENT_OWNER_IS_"), 0);
});
t("normalisation: spaces/case/punctuation in the owner name, id match", () => {
  const f = frag("Actor.b");
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_BLANCHE_DUBOIS"), 1);
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_BLANCHE"), 0);
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_XB12"), 1);
});
t("falls back to actor.parent when there is no token", () => {
  const f = { flags: { [NS]: { conflictObject: "soul-fragment" } }, parent: { flags: { [NS]: { soulFragmentOwner: "Actor.k" } } } };
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_KEREN"), 1);
  assert.equal(run(f, "SOUL_FRAGMENT_OWNER_IS_HINA"), 0);
});
console.log(`${n} passed`);
