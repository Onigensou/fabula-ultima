// node scripts/battle-director/summon-clone-status.test.mjs
import assert from "node:assert/strict";
import { parseCloneStatuses, findStatusTemplate, bakedStatusData, hasStatusOf, bakedStatusesFor } from "./summon-clone-status.js";

const NS = "fabula-ultima-companion";
const ZOMBIE = { _id: "zzz", name: "Zombie", statuses: ["bspDC7hFRTYuwdhf"], duration: { rounds: 3 }, changes: [{ key: "x", value: "1" }],
  flags: { [NS]: { charges: 3, chargesMax: 3, lifetimeMode: "target_turn_end", reactionConfig: { a: 1 } }, statuscounter: { visible: true, value: 3 } } };
const SLOW = { _id: "sss", name: "Slow", statuses: new Set(["slowid"]), flags: {} };
const items = [{ type: "activeEffectContainer", effects: [ZOMBIE, SLOW] }, { type: "skill", effects: [{ name: "Zombie", statuses: ["other"] }] }];

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("parse list", () => assert.deepEqual(parseCloneStatuses(" Zombie, Slow ;\nX "), ["Zombie", "Slow", "X"]));
t("parse empty", () => assert.deepEqual(parseCloneStatuses(""), []));
t("find by name (case-insensitive), containers only", () => assert.equal(findStatusTemplate("zombie", items), ZOMBIE));
t("find by status id (Set statuses)", () => assert.equal(findStatusTemplate("slowid", items), SLOW));
t("find missing", () => assert.equal(findStatusTemplate("Nope", items), null));
t("baked copy: permanent, uncleansable, no counter, source untouched", () => {
  const d = bakedStatusData(ZOMBIE);
  assert.equal(d._id, undefined);
  assert.deepEqual(d.duration, {});
  assert.equal(d.flags[NS].charges, undefined);
  assert.equal(d.flags[NS].lifetimeMode, undefined);
  assert.equal(d.flags[NS].directorPermanent, true);
  assert.equal(d.flags[NS].uncleansable, true);
  assert.equal(d.flags[NS].bakedSummonStatus, true);
  assert.deepEqual(d.flags[NS].reactionConfig, { a: 1 });
  assert.equal(d.flags.statuscounter.visible, false);
  assert.deepEqual(d.statuses, ["bspDC7hFRTYuwdhf"]);
  assert.equal(ZOMBIE.flags[NS].charges, 3);
  assert.equal(ZOMBIE._id, "zzz");
});
t("hasStatusOf by status id", () => {
  assert.equal(hasStatusOf([{ name: "Whatever", statuses: ["bspDC7hFRTYuwdhf"] }], ZOMBIE), true);
  assert.equal(hasStatusOf([{ name: "Zombie", statuses: ["other"] }], ZOMBIE), false);
});
t("bakedStatusesFor: adds, skips existing + dupes, reports missing", () => {
  const r = bakedStatusesFor("Zombie, zombie, Slow, Nope", [{ statuses: ["slowid"] }], items);
  assert.equal(r.add.length, 1);
  assert.equal(r.add[0].name, "Zombie");
  assert.deepEqual(r.missing, ["Nope"]);
});
console.log(`summon-clone-status: all ${n} passed`);
