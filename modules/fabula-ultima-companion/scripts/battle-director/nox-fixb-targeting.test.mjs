// node scripts/battle-director/nox-fixb-targeting.test.mjs
// Fix pass B: dCombat-first performer side, direct-ref Servant drop, fail-closed ActionReader.
import assert from "node:assert/strict";
globalThis.CONFIG ??= { statusEffects: [] };
globalThis.foundry ??= { utils: { getProperty: (o, p) => String(p).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o) } };
globalThis.game ??= { combat: null, user: { isGM: true }, actors: { get: () => null } };
const { isTargetBlockedFor } = await import("./snapshot.js");
globalThis.Hooks ??= { once() {}, on() {}, callAll() {} };
const NS = "fabula-ultima-companion";
const block = { name: "Nox Servant", disabled: false, flags: { [NS]: { noxServant: true } }, changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "opponent" }] };
const mk = (uuid, effects, proto) => ({ uuid, name: uuid, effects: { contents: effects }, appliedEffects: effects, prototypeToken: { disposition: proto }, system: { props: {} } });
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ok", name); };

await t("performer side from the PLACED token (dCombat) beats a wrong prototype", () => {
  const servant = mk("A.s", [block], 1);
  const boss = mk("A.boss", [], 1);                    // prototype says party-side, but the PLACED token is hostile
  const dCombat = { combatants: [{ actorDoc: boss, tokenDoc: { disposition: -1 } }, { actorDoc: servant, tokenDoc: { disposition: 1 } }] };
  assert.equal(isTargetBlockedFor(servant, boss, { dCombat }), true);    // placed -1 vs 1 => opponent
  assert.equal(isTargetBlockedFor(servant, boss, {}), false);            // prototype-only read (the old behaviour) misses it
});
await t("unknown still fails closed", () => {
  const servant = mk("A.s", [block], null), x = mk("A.x", [], null);
  assert.equal(isTargetBlockedFor(servant, x, { dCombat: { combatants: [] } }), true);
});

const { dropNoxServantsFromDirectRef } = await import("./skill-targeting.js");
const servant = mk("A.s", [block], 1), pc = mk("A.pc", [], 1), boss = mk("A.boss", [], -1);
const tok = (a, d) => ({ uuid: `T.${a.uuid}`, actor: a, disposition: d });
const hasServant = (l) => l.some((x) => x.actor === servant);
await t("opponent's harmful row onto a Servant via a direct ref is dropped; the PC stays", () => {
  const ctx = { reactorActor: boss, payload: { actionIntent: "harmful" } };
  const out = dropNoxServantsFromDirectRef([tok(servant, 1), tok(pc, 1)], ctx);
  assert.equal(hasServant(out), false); assert.equal(out.length, 1);
});
await t("ally support onto a Servant via a direct ref is untouched", () => {
  const ctx = { reactorActor: pc, payload: { actionIntent: "aid" } };
  assert.equal(hasServant(dropNoxServantsFromDirectRef([tok(servant, 1)], ctx)), true);
});
await t("an ally's HARMFUL action does not land on a Servant either", () => {
  const ctx = { reactorActor: pc, payload: { actionIntent: "harmful" } };
  assert.equal(hasServant(dropNoxServantsFromDirectRef([tok(servant, 1)], ctx)), false);
});
console.log(`${n} passed`);
