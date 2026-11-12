// node scripts/dungeon-pathing-system/dp-terrarium-rules.test.mjs
// Terrarium rules (2026-11-12).
import assert from "node:assert/strict";
import {
  KINDS, kindOfItem, checkTarget, kindBlock, buildSwap, buildRestore, BEHAVIOUR_KEYS, PROFILES, typeLabel,
} from "./dp-terrarium-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("five kinds, each with a profile", () => {
  assert.deepEqual([...KINDS], ["blank", "healing", "gathering", "camp", "random_battle"]);
  for (const k of KINDS) assert.ok(PROFILES[k], k);
});

t("item kind: flag first, then the 'Terrarium: <Type>' name", () => {
  assert.equal(kindOfItem({ flagKind: "camp", name: "whatever" }), "camp");
  assert.equal(kindOfItem({ name: "Terrarium: Random Battle" }), "random_battle");
  assert.equal(kindOfItem({ name: "terrarium:  healing " }), "healing");
  assert.equal(kindOfItem({ name: "Terrain Destroyer" }), null);
  assert.equal(kindOfItem({ flagKind: "bogus", name: "Terrarium: Gold" }), null);
});

t("the main use: a Random Battle or Trap can change", () => {
  assert.deepEqual(checkTarget({ kind: "blank", currentType: "random_battle", initialType: "random_battle" }), { ok: true });
  assert.deepEqual(checkTarget({ kind: "healing", currentType: "trap", initialType: "trap" }), { ok: true });
});

t("a spent tile (blank now) can change; its origin is not locked", () => {
  assert.equal(checkTarget({ kind: "healing", currentType: "blank", initialType: "consumable" }).ok, true);
});

t("same type is refused", () => {
  const r = checkTarget({ kind: "healing", currentType: "healing", initialType: "trap" });
  assert.equal(r.ok, false);
  assert.equal(r.why, "Already a Healing Tile.");
});

t("locked types: door, travel, story, final, event, camp, fishing, settlement", () => {
  for (const type of ["door", "travel", "story", "final", "event", "camp", "fishing", "settlement"]) {
    assert.equal(checkTarget({ kind: "blank", currentType: type, initialType: type }).ok, false, type);
  }
  assert.equal(checkTarget({ kind: "blank", currentType: "fishing", initialType: "fishing" }).why,
    "Fishing spots reset on a new day, so they can't change.");
});

t("an origin Camp stays locked even after it was changed or spent", () => {
  assert.equal(checkTarget({ kind: "healing", currentType: "blank", initialType: "camp" }).ok, false);
});

t("a placed Camp (origin was a Random Battle) is locked too: Camps are rest points", () => {
  assert.equal(checkTarget({ kind: "blank", currentType: "camp", initialType: "random_battle" }).ok, false);
});

t("teleporters lock by Monk's action or teleporter flag, whatever the type says", () => {
  assert.equal(checkTarget({ kind: "blank", currentType: "blank", monksActions: [{ action: "teleport" }] }).ok, false);
  assert.equal(checkTarget({ kind: "blank", currentType: "blank", monksActions: [{ action: "scene" }] }).ok, false);
  assert.equal(checkTarget({ kind: "blank", currentType: "blank", teleporter: { enabled: true } }).ok, false);
  assert.equal(checkTarget({ kind: "blank", currentType: "random_battle", monksActions: [{ action: "runmacro" }] }).ok, true);
});

t("authored fights and switches lock", () => {
  assert.equal(checkTarget({ kind: "blank", currentType: "random_battle", dp: { fixedEncounter: "Actor.x" } }).ok, false);
  assert.equal(checkTarget({ kind: "blank", currentType: "random_battle", dp: { storyBattle: true } }).ok, false);
  // empty / false values don't
  assert.equal(checkTarget({ kind: "blank", currentType: "random_battle", dp: { fixedEncounter: "", storyBattle: false, clearedSwitch: {} } }).ok, true);
});

t("per-tile rule: lock beats everything, allow lifts type locks", () => {
  assert.equal(checkTarget({ kind: "blank", currentType: "trap", dp: { terrariumRule: "lock" } }).ok, false);
  assert.equal(checkTarget({ kind: "blank", currentType: "door", initialType: "door", dp: { terrariumRule: "allow" } }).ok, true);
  assert.equal(checkTarget({ kind: "blank", currentType: "blank", dp: { terrariumRule: "allow" } }).ok, false); // still same type
});

t("reset-on-rest tiles are allowed with the new-day warning naming the origin", () => {
  const r = checkTarget({ kind: "blank", currentType: "blank", initialType: "healing", dp: { resetOnRest: true } });
  assert.equal(r.ok, false); // same type: spent healing is blank already
  const r2 = checkTarget({ kind: "gathering", currentType: "blank", initialType: "healing", dp: { resetOnRest: "true" } });
  assert.deepEqual(r2, { ok: true, warn: "Resets to a Healing Tile on a new day." });
});

t("kind blocks: map needs a camp / material table / encounter table", () => {
  assert.equal(kindBlock("camp", {}), "This map has no camp.");
  assert.equal(kindBlock("camp", { hasCampScene: true }), "");
  assert.equal(kindBlock("gathering", {}), "Nothing to gather on this map.");
  assert.equal(kindBlock("random_battle", { hasEncounterTable: true }), "");
  assert.equal(kindBlock("blank", {}), "");
  assert.equal(kindBlock("healing", {}), "");
});

t("swap: target profile set, other behaviour keys removed, Monk's actions cleared", () => {
  const before = { usable: false, effectConfig: { enabled: true, resourceType: "damage" }, checkGate: { enabled: false },
    resetOnRest: true, fogMode: "fog" };
  const actions = [{ action: "runmacro", data: { entity: { id: "Macro.N2SMCCEYesd38dMR" } } }];
  const s = buildSwap("healing", before, actions);
  assert.equal(s.set.usable, true);
  assert.equal(s.set.effectConfig.resourceType, "healing");
  assert.equal(s.set.effectConfig.enabled, true);
  assert.deepEqual(s.unset, ["checkGate"]);
  assert.deepEqual(s.actions, []);
  assert.ok(!("resetOnRest" in s.set) && !("fogMode" in s.set), "non-behaviour keys untouched");
  assert.deepEqual(s.backup.actions, actions);
  assert.deepEqual(s.backup.flags.effectConfig, before.effectConfig);
  assert.ok(s.backup.absent.includes("skipConfirm"));
});

t("restore puts every behaviour key back exactly (round trip)", () => {
  const before = { usable: false, skipConfirm: true, effectConfig: { enabled: true, resourceType: "damage", resourceValue: 10 } };
  const actions = [{ action: "runmacro" }];
  const s = buildSwap("blank", before, actions);
  // apply swap
  const after = { ...before };
  Object.assign(after, s.set); for (const k of s.unset) delete after[k];
  // apply restore
  const r = buildRestore(s.backup);
  Object.assign(after, r.set); for (const k of r.unset) delete after[k];
  assert.deepEqual(after, before);
  assert.deepEqual(r.actions, actions);
});

t("backup is a copy, not a reference", () => {
  const before = { effectConfig: { enabled: true } };
  const s = buildSwap("blank", before, []);
  before.effectConfig.enabled = false;
  assert.equal(s.backup.flags.effectConfig.enabled, true);
});

t("behaviour keys never include the keys that must survive", () => {
  for (const k of ["resetOnRest", "fogMode", "fog", "consumed", "expired", "terrariumRule", "terrarium", "fastTravelMode", "eligibleForFastTravel"]) {
    assert.ok(!BEHAVIOUR_KEYS.includes(k), k);
  }
});

t("type labels", () => {
  assert.equal(typeLabel("random_battle"), "Random Battle Tile");
  assert.equal(typeLabel("mystery_box"), "Mystery Box Tile");
});

console.log(`\n${n} passed`);
