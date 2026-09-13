"use strict";
// Mindscape — the 0% baseline loadout (lib/baseline-gear.js). Plain node.
//
// The mapping is a user ruling ("same class, use basic equipment", 2026-09-13), so each
// rule gets a test: category + hands + attributes for weapons, the free hand conversion,
// martial-ness for shields and armor, basic armor kept at +0, accessories emptied, and
// the house/suspect items that must never be picked.

const assert = require("assert");
const B = require("../lib/baseline-gear");
const SW = require("../lib/loadout-swap");
const { WorldItems } = require("../lib/world-items");
const { toCombatModel, attachWeaponDetails } = require("../lib/load-actors");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const eff = (name, changes) => ({ name, disabled: false, transfer: true, changes });
const ch = (key, mode, value, priority = null) => ({ key, mode, value, priority });

// ── A tiny world: folders and items ─────────────────────────────────────────
const folders = new Map([
  ["f-eq", { id: "f-eq", name: "⚔️ Equipments", parent: null }],
  ["f-w", { id: "f-w", name: "Weapon", parent: "f-eq" }],
  ["f-bw", { id: "f-bw", name: "Basic Weapon", parent: "f-w" }],
  ["f-bow", { id: "f-bow", name: "Bow", parent: "f-bw" }],
  ["f-arc", { id: "f-arc", name: "Arcane", parent: "f-bw" }],
  ["f-swd", { id: "f-swd", name: "Sword", parent: "f-bw" }],
  ["f-dag", { id: "f-dag", name: "Dagger", parent: "f-bw" }],
  ["f-rw", { id: "f-rw", name: "Rare Weapon", parent: "f-w" }],
  ["f-ba", { id: "f-ba", name: "Basic Armor", parent: "f-eq" }],
  ["f-bs", { id: "f-bs", name: "Basic Shield", parent: "f-eq" }],
]);

function wItem(id, name, folder, props, effects = []) {
  return { id, name, type: "equippableItem", folder, props: { name, ...props }, flags: {}, container: null, effects };
}
const weapon = (id, name, folder, category, hands, a1, a2, dmg, chk = "0") => wItem(id, name, folder, {
  item_type: "weapon", category, hand_slots: hands, rolled_atr1: a1, rolled_atr2: a2,
  damage_bonus: dmg, check_bonus: chk, type_damage: "Physical", weapon_range: category === "Bow" ? "Ranged" : "Melee",
});

const world = new WorldItems(new Map([
  weapon("i-xbow", "Crossbow", "f-bow", "Bow", "Two-handed", "DEX", "INS", "8"),
  weapon("i-sbow", "Shortbow", "f-bow", "Bow", "Two-handed", "DEX", "DEX", "8"),
  weapon("i-staff", "Staff", "f-arc", "Arcane", "Two-handed", "WLP", "WLP", "6"),
  weapon("i-tome", "Tome", "f-arc", "Arcane", "Two-handed", "INS", "INS", "6"),
  weapon("i-long", "Longsword", "f-swd", "Sword", "Two-handed", "DEX", "DEX", "10", "1"),
  weapon("i-dagger", "Steel Dagger", "f-dag", "Dagger", "One-handed", "DEX", "INS", "4", "1"),
  weapon("i-fancy", "Fancy Bow", "f-rw", "Bow", "Two-handed", "DEX", "INS", "16"),
  wItem("i-brig", "Brigadine", "f-ba", { item_type: "armor", isMartial: true, item_baseDef: "10" }, SW.standardArmorEffects()),
  wItem("i-garb", "Travel Garb", "f-ba", { item_type: "armor", isMartial: false, item_def_bonus: "1", item_mdef_bonus: "1" }, SW.standardArmorEffects()),
  wItem("i-tunic", "Combat Tunic", "f-ba", { item_type: "armor", isMartial: false, item_def_bonus: "1", item_mdef_bonus: "1" }, SW.standardArmorEffects()),
  wItem("i-bplate", "Bronze Plate", "f-ba", { item_type: "armor", isMartial: false, item_def_bonus: "11" }, SW.standardArmorEffects()),
  wItem("i-bronze", "Bronze Shield", "f-bs", { item_type: "shield", isMartial: false, item_def_bonus: "2" }, SW.standardShieldEffects()),
  wItem("i-runic", "Runic Shield", "f-bs", { item_type: "shield", isMartial: true, item_def_bonus: "2", item_mdef_bonus: "2" }, SW.standardShieldEffects()),
  wItem("i-twin", "Twin Runic Shield", "f-bs", { item_type: "shield", isMartial: false, item_def_bonus: "4", item_mdef_bonus: "4" }, SW.standardShieldEffects()),
].map((x) => [x.id, x])));

const catalogue = B.basicCatalogue(world, folders);
const worn = (props) => ({ id: "w", name: props.name ?? "Worn", props });

// ── Catalogue ───────────────────────────────────────────────────────────────
t("catalogue: basics by folder ancestry; house, suspect and rare items excluded", () => {
  const names = (k) => catalogue[k].map((i) => i.name).sort();
  assert.deepStrictEqual(names("weapon"), ["Crossbow", "Shortbow", "Staff", "Steel Dagger", "Tome"]);
  assert.deepStrictEqual(names("armor"), ["Brigadine", "Combat Tunic", "Travel Garb"]);
  assert.deepStrictEqual(names("shield"), ["Bronze Shield", "Runic Shield"]);
});

// ── Weapons ─────────────────────────────────────────────────────────────────
t("a DEX+INS bow maps to the Crossbow (shared attributes), DEX+DEX to the Shortbow", () => {
  assert.strictEqual(B.weaponBaseline(worn({ category: "Bow", hand_slots: "Two-handed", rolled_atr1: "DEX", rolled_atr2: "INS" }), catalogue).item.name, "Crossbow");
  assert.strictEqual(B.weaponBaseline(worn({ category: "Bow", hand_slots: "Two-handed", rolled_atr1: "DEX", rolled_atr2: "DEX" }), catalogue).item.name, "Shortbow");
});
t("a one-handed Arcane weapon becomes a one-handed Staff at +2, and says so", () => {
  const r = B.weaponBaseline(worn({ category: "Arcane", hand_slots: "One-handed", rolled_atr1: "DEX", rolled_atr2: "WLP" }), catalogue);
  assert.strictEqual(r.item.name, "Staff (one-handed)");
  assert.strictEqual(r.item.props.damage_bonus, "2");
  assert.strictEqual(r.item.props.hand_slots, "One-handed");
  assert.match(r.note, /2H->1H/);
});
t("a category with no basic weapon is refused, not guessed", () => {
  assert.throws(() => B.weaponBaseline(worn({ category: "Firearm", hand_slots: "One-handed" }), catalogue), /no basic Firearm/);
});

// ── A PC to baseline ────────────────────────────────────────────────────────
function pcModel({ props, items }) {
  const m = toCombatModel({ _id: "pc", name: "Tester", items: [], system: { props: {
    level: "41", dex_base: "12", ins_base: "8", mig_base: "8", wlp_base: "8", max_hp: "101", current_hp: "101",
    max_mp: "50", current_mp: "50", off_hand: "", accessory_name: "", accessory2_name: "", ...props,
  } } });
  m.items = items;
  m.actorEffects = [];
  m.virtualAttacksAll = [];
  attachWeaponDetails(m);
  return m;
}
function it(id, name, props, effects = []) {
  return { id, name, type: "equippableItem", props: { name, ...props }, flags: {}, container: null, effects };
}

// Real kit: a refined rare bow, a +4 Combat Tunic (refinement +20 HP), a fire-RS pendant.
function archer() {
  return pcModel({
    props: {
      dex_current: 12, ins_current: 8, base_defense: 12, bonus_defense: 1, defense: 13,
      base_magic_defense: 8, bonus_magic_defense: 1, magic_defense: 9, max_hp: 101, affinity_6: "RS",
      main_hand: "+5 Fancy Bow", main_attrib_1: "DEX", main_attrib_2: "INS", weapon1_base_damage: "21", weapon1_base_mod: "1",
      accessory_name: "Ruby Pendant",
    },
    items: [
      it("a-bow", "+5 Fancy Bow", { item_type: "weapon", isEquipped: true, category: "Bow", hand_slots: "Two-handed",
        damage_bonus: "21", check_bonus: "1", rolled_atr1: "DEX", rolled_atr2: "INS", type_damage: "Physical", weapon_range: "Ranged" }),
      it("a-tunic", "+4 Combat Tunic", { item_type: "armor", isEquipped: true, isMartial: false, item_def_bonus: "1", item_mdef_bonus: "1" },
        [...SW.standardArmorEffects(), eff("Armor Refinement", [ch("system.props.max_hp", 2, "20")])]),
      it("a-ruby", "Ruby Pendant", { item_type: "accessory", isEquipped: true }, [eff("Ruby", [ch("affinity_6", 5, "${isEquipped ? 'RS' : 'NA'}$")])]),
    ],
  });
}

t("slot mapping: bow -> Crossbow, a basic armor keeps its +0 self, accessories emptied", () => {
  const swaps = B.baselineSwapsFor(archer(), catalogue);
  assert.deepStrictEqual(swaps.map((x) => [x.slot, x.source?.item.name ?? null]),
    [["main", "Crossbow"], ["armor", "Combat Tunic"], ["acc1", null]]);
});
t("armor: martial -> Brigadine, ordinary -> Travel Garb", () => {
  const model = (martial) => pcModel({ props: { main_hand: "Stick" },
    items: [it("x", "Knightly Mail", { item_type: "armor", isEquipped: true, isMartial: martial })] });
  assert.strictEqual(B.baselineSwapsFor(model(true), catalogue).find((x) => x.slot === "armor").source.item.name, "Brigadine");
  assert.strictEqual(B.baselineSwapsFor(model(false), catalogue).find((x) => x.slot === "armor").source.item.name, "Travel Garb");
});
t("shields: martial -> Runic Shield, ordinary -> Bronze Shield (never Twin Runic)", () => {
  const model = pcModel({ props: { main_hand: "Big Wall", main_attrib_1: "SHI", main_attrib_2: "SHI", off_hand: "Small Wall", off_attrib_1: "SHI" },
    items: [
      it("s1", "Big Wall", { item_type: "shield", isEquipped: true, isMartial: false }),
      it("s2", "Small Wall", { item_type: "shield", isEquipped: true, isMartial: true }),
    ] });
  const swaps = B.baselineSwapsFor(model, catalogue);
  assert.deepStrictEqual(swaps.map((x) => [x.slot, x.source.item.name]), [["main", "Bronze Shield"], ["off", "Runic Shield"]]);
});

t("end to end: the baseline strips gear power and nothing else", () => {
  const m = archer();
  const [r] = B.applyBaselineGear([m], { names: ["all"], worldItems: world, folders });
  assert.ok(r.baseline);
  assert.strictEqual(m.weapon.name, "Crossbow");
  assert.strictEqual(m.weapon.baseDamage, 8);
  assert.strictEqual(m.weapon.checkBonus, 0);
  assert.strictEqual(m.hp.max, 81);              // the +4 refinement's 20 HP is gone
  assert.strictEqual(m.def, 13);                 // a +0 Combat Tunic is still a Combat Tunic
  assert.strictEqual(m.affinities.fire, "NE");   // the pendant is gone
});
t("a name filter picks PCs; an unknown name is refused", () => {
  assert.deepStrictEqual(B.applyBaselineGear([archer()], { names: ["Nobody"].slice(0, 0).concat(["Tester"]), worldItems: world, folders }).length, 1);
  assert.throws(() => B.applyBaselineGear([archer()], { names: ["Nobody"], worldItems: world, folders }), /no party member named "nobody"/);
});
t("baseName strips a refinement prefix only", () => {
  assert.strictEqual(B.baseName("+4 Combat Tunic"), "Combat Tunic");
  assert.strictEqual(B.baseName("Combat Tunic +4"), "Combat Tunic +4");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
