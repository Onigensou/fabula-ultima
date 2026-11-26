// node scripts/battle-director/status-recovery.test.mjs
// Stunned / Sleep turn-start recovery check (status-recovery.js), with a fake actor
// and an injected roll. No Foundry.
import assert from "node:assert/strict";

globalThis.foundry ??= { utils: { randomID: () => "x" } };
const { recoveryCheckOf, recoveryStatusesOn, runRecoveryChecks } = await import("./status-recovery.js");

const NS = "fabula-ultima-companion";
function fakeEffect(name, rc, extra = {}) {
  const e = {
    name, disabled: false, deleted: false, updates: [],
    flags: { [NS]: { recoveryCheck: rc, ...extra } },
    async delete() { this.deleted = true; },
    async update(u) { this.updates.push(u); },
  };
  return e;
}
const actorWith = (...effects) => ({ name: "Hina", effects: { contents: effects } });
const roll = (total) => async () => ({ total, dA: 8, dB: 8, isCrit: false, isFumble: false });

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };

await t("spec normalises attrs and DL", () => {
  assert.deepEqual(recoveryCheckOf(fakeEffect("Stunned", { attr1: "mig", attr2: "wlp", dl: 10 })), { attr1: "MIG", attr2: "WLP", dl: 10 });
  assert.equal(recoveryCheckOf(fakeEffect("X", { attr1: "STR", attr2: "WLP" })), null);
  assert.equal(recoveryCheckOf({ flags: {} }), null);
});

await t("only flagged, enabled effects count", () => {
  const off = fakeEffect("Sleep", { attr1: "INS", attr2: "WLP", dl: 10 }); off.disabled = true;
  const plain = { name: "Weak", disabled: false, flags: {} };
  assert.equal(recoveryStatusesOn(actorWith(off, plain)).length, 0);
});

await t("pass at DL deletes the status, not blocked", async () => {
  const s = fakeEffect("Stunned", { attr1: "MIG", attr2: "WLP", dl: 10 });
  const r = await runRecoveryChecks(actorWith(s), { roll: roll(10), chat: false });
  assert.equal(s.deleted, true);
  assert.equal(r.blocked, false);
  assert.equal(r.results[0].success, true);
});

await t("fail keeps the status (turn-based bearer), blocked", async () => {
  const s = fakeEffect("Sleep", { attr1: "INS", attr2: "WLP", dl: 10 }, { charges: 3 });
  const r = await runRecoveryChecks(actorWith(s), { roll: roll(9), chat: false });
  assert.equal(s.deleted, false);
  assert.equal(s.updates.length, 0);
  assert.equal(r.blocked, true);
});

await t("turn-less summon: fail spends a charge", async () => {
  const s = fakeEffect("Sleep", { attr1: "INS", attr2: "WLP", dl: 10 }, { charges: 3 });
  const r = await runRecoveryChecks(actorWith(s), { roll: roll(4), chat: false, spendOnFail: true });
  assert.equal(r.blocked, true);
  assert.deepEqual(s.updates[0], { [`flags.${NS}.charges`]: 2 });
});

await t("turn-less summon: last charge deletes on fail, still blocked", async () => {
  const s = fakeEffect("Stunned", { attr1: "MIG", attr2: "WLP", dl: 10 }, { charges: 1 });
  const r = await runRecoveryChecks(actorWith(s), { roll: roll(4), chat: false, spendOnFail: true });
  assert.equal(s.deleted, true);
  assert.equal(r.blocked, true);
  assert.equal(r.results[0].removed, true);
});

await t("crit passes and fumble fails regardless of total", async () => {
  const a = fakeEffect("Stunned", { attr1: "MIG", attr2: "WLP", dl: 10 });
  await runRecoveryChecks(actorWith(a), { roll: async () => ({ total: 4, isCrit: true, isFumble: false, dA: 6, dB: 6 }), chat: false });
  assert.equal(a.deleted, true);
  const b = fakeEffect("Stunned", { attr1: "MIG", attr2: "WLP", dl: 10 });
  await runRecoveryChecks(actorWith(b), { roll: async () => ({ total: 20, isCrit: false, isFumble: true, dA: 12, dB: 12 }), chat: false });
  assert.equal(b.deleted, false);
});

await t("both statuses roll; blocked if either fails", async () => {
  const s = fakeEffect("Stunned", { attr1: "MIG", attr2: "WLP", dl: 10 });
  const z = fakeEffect("Sleep", { attr1: "INS", attr2: "WLP", dl: 10 });
  let i = 0;
  const r = await runRecoveryChecks(actorWith(s, z), { roll: async () => ({ total: i++ === 0 ? 12 : 3, dA: 8, dB: 8 }), chat: false });
  assert.equal(r.checked, 2);
  assert.equal(s.deleted, true);
  assert.equal(z.deleted, false);
  assert.equal(r.blocked, true);
});

await t("a throwing roll counts as a fail", async () => {
  const s = fakeEffect("Stunned", { attr1: "MIG", attr2: "WLP", dl: 10 });
  const r = await runRecoveryChecks(actorWith(s), { roll: async () => { throw new Error("boom"); }, chat: false });
  assert.equal(r.blocked, true);
  assert.equal(s.deleted, false);
});

console.log(`${n} passed`);
