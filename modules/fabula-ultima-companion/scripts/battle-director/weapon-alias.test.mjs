// node modules/fabula-ultima-companion/scripts/battle-director/weapon-alias.test.mjs
import assert from "node:assert/strict";
import { parseAliases, aliasCategories } from "./weapon-alias.js";

assert.deepEqual(parseAliases("melee_dagger: brawling, sword, thrown"), [{ source: "melee_dagger", cats: ["brawling", "sword", "thrown"] }]);
assert.deepEqual(parseAliases("dagger: sword; bow:  thrown"), [{ source: "dagger", cats: ["sword"] }, { source: "bow", cats: ["thrown"] }]);
assert.deepEqual(parseAliases(""), []);
assert.deepEqual(parseAliases("no colon here"), []);

const skill = { system: { props: { item_type: "" } }, documentName: "Item" };
const ae = (value, parent = skill, disabled = false) => ({ disabled, parent, changes: [{ key: "weapon_category_alias", value }] });
const actor = (...effects) => ({ appliedEffects: effects });

const keren = actor(ae("melee_dagger: brawling, sword, thrown"));
assert.deepEqual(aliasCategories(keren, "dagger", "melee"), ["brawling", "sword", "thrown"]);   // a melee dagger
assert.deepEqual(aliasCategories(keren, "dagger", "ranged"), []);                                 // a thrown-range dagger: no
assert.deepEqual(aliasCategories(keren, "sword", "melee"), []);                                   // other categories untouched
assert.deepEqual(aliasCategories(actor(ae("dagger: sword")), "dagger", "ranged"), ["sword"]);     // source without range = any range
assert.deepEqual(aliasCategories(actor(ae("melee_dagger: sword", skill, true)), "dagger", "melee"), []);   // disabled AE
const ring = { system: { props: { item_type: "accessory", isEquipped: false } }, documentName: "Item" };
assert.deepEqual(aliasCategories(actor(ae("melee_dagger: sword", ring)), "dagger", "melee"), []);          // unequipped gear carrier
ring.system.props.isEquipped = true;
assert.deepEqual(aliasCategories(actor(ae("melee_dagger: sword", ring)), "dagger", "melee"), ["sword"]);   // equipped gear carrier
assert.deepEqual(aliasCategories(null, "dagger", "melee"), []);
console.log("weapon-alias: all tests pass");
