// node scripts/battle-director/steal-lock.test.mjs
import assert from "node:assert/strict";
const { applyStealLockExclusion, actionRollsStealTable, hasBeenStolenFrom, stolenFromBy, STEAL_LOCK_REASON } = await import("./steal-lock.js");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

const NS = "fabula-ultima-companion";
const stolenAE = (by) => ({ name: `Soul Stolen by ${by}`, flags: { [NS]: { soulStolenBy: `Actor.${by}`, stolenLootKeys: ["k1"] } } });
const actor = (name, effects = []) => ({ name, effects: { contents: effects } });
const SOUL_STEAL = { system: { props: { effect_table: {
  0: { effect_kind: "grant" }, 1: { effect_kind: "roll_loot_table" }, 2: { effect_kind: "chain" },
} } } };
const FIREBALL = { system: { props: { effect_table: { 0: { effect_kind: "deal_damage" } } } } };

const actors = {
  amp: actor("Ampere", [stolenAE("Keren")]),
  prism: actor("Lightning Prism"),
  pary: actor("Galvanic Paryashera", [{ name: "Slow", flags: {} }]),
};
const entry = (id) => ({ tokenUuid: `Scene.s.Token.${id}`, tokenId: id, name: actors[id].name, disposition: -1 });
const actorOf = (e) => actors[e.tokenId];

t("Soul Steal is a steal action; a damage spell is not", () => {
  assert.equal(actionRollsStealTable(SOUL_STEAL), true);
  assert.equal(actionRollsStealTable(FIREBALL), false);
  assert.equal(actionRollsStealTable(null), false);
});
t("a deleted roll_loot_table row does not count", () => {
  assert.equal(actionRollsStealTable({ system: { props: { effect_table: { 0: { effect_kind: "roll_loot_table", $deleted: true } } } } }), false);
});
t("stolen = ANY party member's soulStolenBy AE", () => {
  assert.equal(hasBeenStolenFrom(actors.amp), true);
  assert.equal(stolenFromBy(actors.amp), "Keren");
  assert.equal(hasBeenStolenFrom(actors.prism), false);
  assert.equal(hasBeenStolenFrom(actors.pary), false, "an unrelated AE is not a steal");
});
t("one stolen: it moves to .excluded with the reason + soft dim; the rest stay pickable", () => {
  const out = applyStealLockExclusion([entry("pary"), entry("prism"), entry("amp")], { action: SOUL_STEAL, actorOf });
  assert.deepEqual(out.map((e) => e.tokenId), ["pary", "prism"]);
  assert.equal(out.excluded.length, 1);
  assert.equal(out.excluded[0].tokenId, "amp");
  assert.deepEqual([...out.excluded[0].reasons], [STEAL_LOCK_REASON]);
  assert.equal(out.excluded[0].dim, "soft");
  assert.notEqual(out.showWhenNoneLeft, true);
});
t("a non-steal action is untouched (same array back)", () => {
  const pool = [entry("amp"), entry("prism")];
  assert.equal(applyStealLockExclusion(pool, { action: FIREBALL, actorOf }), pool);
});
t("nothing stolen: same array back, existing .excluded kept", () => {
  const pool = [entry("prism")];
  pool.excluded = [{ tokenId: "x", reasons: ["Vanished"] }];
  const out = applyStealLockExclusion(pool, { action: SOUL_STEAL, actorOf });
  assert.equal(out, pool);
  assert.equal(out.excluded.length, 1);
});
t("prior exclusions (Vanish) are unioned, not replaced", () => {
  const pool = [entry("amp"), entry("prism")];
  pool.excluded = [{ tokenId: "x", reasons: ["Vanished"] }];
  const out = applyStealLockExclusion(pool, { action: SOUL_STEAL, actorOf });
  assert.deepEqual(out.excluded.map((e) => e.tokenId), ["x", "amp"]);
});
t("all stolen: empty pool flagged showWhenNoneLeft so the picker still opens", () => {
  actors.prism.effects.contents.push(stolenAE("Zarg"));
  actors.pary.effects.contents.push(stolenAE("Keren"));
  const out = applyStealLockExclusion([entry("pary"), entry("prism"), entry("amp")], { action: SOUL_STEAL, actorOf });
  assert.equal(out.length, 0);
  assert.equal(out.showWhenNoneLeft, true);
  assert.equal(out.excluded.length, 3);
});
t("an unresolvable actor is kept pickable (the resolver backstop still guards the roll)", () => {
  const out = applyStealLockExclusion([{ tokenUuid: "gone", tokenId: "gone" }], { action: SOUL_STEAL, actorOf: () => null });
  assert.equal(out.length, 1);
});

console.log(`steal-lock: ${n} passed`);
