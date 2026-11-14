// node scripts/shared/held-status-rules.test.mjs
import assert from "node:assert/strict";
import {
  FLAG_NS, isHeld, statusIdsOf, matchStatus, buildHeldEffectData,
  holdExistingUpdate, conversionUpdate, describeHeld,
} from "./held-status-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

const slowTemplate = {
  _id: "tpl1", name: "Slow", img: "slow.svg", origin: "Item.container1",
  statuses: ["slow"], transfer: true,
  duration: { rounds: 3 },
  changes: [{ key: "system.props.dex_die", mode: 2, value: "-2" }],
  flags: { [FLAG_NS]: { lifetimeMode: "", directorAppliedBy: { x: 1 }, dungeonTurnsRemaining: 2, sceneExpiry: true }, statuscounter: { visible: true, value: 3 } },
};

t("matchStatus by id and by name, case-insensitive", () => {
  const list = [{ id: "slow", name: "Slow" }, { id: "dazed", name: "Dazed" }];
  assert.equal(matchStatus(list, "SLOW").id, "slow");
  assert.equal(matchStatus(list, "dazed").id, "dazed");
  assert.equal(matchStatus(list, "Dazed").id, "dazed");
  assert.equal(matchStatus(list, "nope"), null);
  assert.equal(matchStatus(list, ""), null);
});

t("statusIdsOf handles Set and array", () => {
  assert.deepEqual(statusIdsOf({ statuses: new Set(["a", "b"]) }), ["a", "b"]);
  assert.deepEqual(statusIdsOf({ statuses: ["c"] }), ["c"]);
  assert.deepEqual(statusIdsOf({}), []);
});

t("buildHeldEffectData: own origin, no clock, held + crossScene, stamps stripped", () => {
  const d = buildHeldEffectData(slowTemplate, { actorUuid: "Actor.zarg", statusId: "slow", source: "Rockslide" });
  assert.equal(d._id, undefined);
  assert.equal(d.origin, "Actor.zarg");
  assert.equal(d.transfer, false);
  assert.equal(d.duration.rounds, null);
  const ns = d.flags[FLAG_NS];
  assert.equal(ns.heldUntilBattle, true);
  assert.equal(ns.crossScene, true);
  assert.equal(ns.heldSource, "Rockslide");
  assert.equal(ns.heldTurns, null);
  assert.equal(ns.directorAppliedBy, undefined);
  assert.equal(ns.dungeonTurnsRemaining, undefined);
  assert.equal(ns.sceneExpiry, undefined);
  assert.equal(ns.charges, undefined);
  assert.deepEqual(d.changes, slowTemplate.changes, "keeps the condition's mechanics");
  assert.equal(isHeld(d), true);
  // template untouched
  assert.equal(slowTemplate.flags[FLAG_NS].directorAppliedBy.x, 1);
});

t("buildHeldEffectData: turns becomes the battle charge count", () => {
  const d = buildHeldEffectData(slowTemplate, { actorUuid: "Actor.zarg", statusId: "slow", turns: 2 });
  assert.equal(d.flags[FLAG_NS].heldTurns, 2);
  assert.equal(d.flags[FLAG_NS].charges, 2);
  const bad = buildHeldEffectData(slowTemplate, { actorUuid: "Actor.zarg", statusId: "slow", turns: -1 });
  assert.equal(bad.flags[FLAG_NS].heldTurns, null);
});

t("buildHeldEffectData adds the status id when the template lacks it", () => {
  const d = buildHeldEffectData({ name: "Paralyzed" }, { actorUuid: "Actor.k", statusId: "paralyzed" });
  assert.deepEqual(d.statuses, ["paralyzed"]);
});

t("holdExistingUpdate stops the dungeon counter and stamp", () => {
  const u = holdExistingUpdate({ id: "e1" }, { source: "Event", turns: null });
  assert.equal(u._id, "e1");
  assert.equal(u[`flags.${FLAG_NS}.heldUntilBattle`], true);
  assert.equal(u[`flags.${FLAG_NS}.crossScene`], true);
  assert.ok(`flags.${FLAG_NS}.-=dungeonTurnsRemaining` in u);
  assert.ok(`flags.${FLAG_NS}.-=directorAppliedBy` in u);
  assert.ok(`flags.${FLAG_NS}.-=charges` in u);
  const u2 = holdExistingUpdate({ id: "e1" }, { turns: 4 });
  assert.equal(u2[`flags.${FLAG_NS}.charges`], 4);
});

t("conversionUpdate drops held/crossScene and carries the battle stamp + charges", () => {
  const adopted = { flags: { [FLAG_NS]: { charges: 3, directorAppliedBy: { effectLabel: "adopted:Slow", lifetimeMode: "target_turn_end" } }, statuscounter: { visible: true } } };
  const u = conversionUpdate({ id: "e9" }, adopted);
  assert.equal(u._id, "e9");
  assert.ok(`flags.${FLAG_NS}.-=heldUntilBattle` in u);
  assert.ok(`flags.${FLAG_NS}.-=crossScene` in u);
  assert.equal(u[`flags.${FLAG_NS}.charges`], 3);
  assert.equal(u[`flags.${FLAG_NS}.directorAppliedBy`].lifetimeMode, "target_turn_end");
  assert.equal(u["flags.statuscounter.value"], 3);
});

t("describeHeld", () => {
  const d = describeHeld({ id: "e2", name: "Slow", statuses: ["slow"], flags: { [FLAG_NS]: { heldSource: "Boulder", heldTurns: 2 } } });
  assert.deepEqual(d, { effectId: "e2", name: "Slow", statuses: ["slow"], source: "Boulder", turns: 2 });
});

console.log(`\n${n} checks passed`);
