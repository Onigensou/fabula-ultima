// Adaptive Defense (effect_kind weapon_read): which lane an action reads.
//
//     node scripts/battle-director/weapon-read-family.test.mjs
//
// The 11-28 playtest bug (#16): Rakshasa read Zarg's bow but never a spell. The BD
// stamps spells `ar.kind: "Skill"`, so `actionKind === "spell"` never matched; the
// spell fact is `actionSkillType` (the casting item's skill_type).

import assert from "node:assert/strict";
import { weaponReadFamilyOf } from "./weapon-read-family.js";

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
}

check("a bow item reads bow", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Attack" }, { item_type: "weapon", category: "Bow" }), "bow");
});
check("a shield item reads brawling", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Attack" }, { item_type: "shield", category: "Arcane" }), "brawling");
});
check("Twin Shields (virtual, no item) reads its payload weaponType", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Attack", weaponUuid: null, weaponType: "Brawling" }, null), "brawling");
});
check("a spell as the BD stamps it (kind Skill + actionSkillType spell) reads arcane", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Skill", actionSkillType: "spell" }, null), "arcane");
});
check("actionSkillType is case-insensitive", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Skill", actionSkillType: "Spell" }, null), "arcane");
});
check("a legacy payload with actionKind spell still reads arcane", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "spell" }, null), "arcane");
});
check("a weaponless skill (not a spell) fails closed", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Skill", actionSkillType: "active" }, null), null);
  assert.equal(weaponReadFamilyOf({ actionKind: "Skill" }, null), null);
});
check("an NPC pseudo-weapon with no family fails closed", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Attack", weaponType: "" }, null), null);
});
check("the item wins over the payload weaponType", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Attack", weaponType: "Sword" }, { item_type: "weapon", category: "Dagger" }), "dagger");
});
check("an item without a known category falls back to the payload", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Attack", weaponType: "Spear" }, { item_type: "weapon", category: "" }), "spear");
});
check("a weapon-borne skill (weaponType present) reads the weapon even if it is a spell", () => {
  assert.equal(weaponReadFamilyOf({ actionKind: "Skill", actionSkillType: "spell", weaponType: "Sword" }, null), "sword");
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
