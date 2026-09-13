"use strict";
// Mindscape — full-loadout swaps (lib/loadout-swap.js). Plain node, no framework.
//
// Synthetic PCs whose STORED sheet is consistent with their items, so the round-trip
// gate passes exactly as it does for the real party — then the rules a swap must honour:
// slot legality, Dodge under martial armor, affinity accessories, sub-items travelling
// with their parent, and the Swift Swimmers set bonus appearing and vanishing.

const assert = require("assert");
const SW = require("../lib/loadout-swap");
const { WorldItems } = require("../lib/world-items");
const { toCombatModel, attachWeaponDetails } = require("../lib/load-actors");
const { weaponAction } = require("../lib/engine");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const ARMOR = () => SW.standardArmorEffects();
const SHIELD = () => SW.standardShieldEffects();
const eff = (name, changes, extra = {}) => ({ name, disabled: false, transfer: true, changes, ...extra });
const ch = (key, mode, value, priority = null) => ({ key, mode, value, priority });

function item(id, name, props, effects = [], extra = {}) {
  return { id, name, type: "equippableItem", props: { name, ...props }, flags: {}, container: null, effects, ...extra };
}

// ── World items ─────────────────────────────────────────────────────────────
function world() {
  const list = [
    item("w-brig", "Brigandine", { item_type: "armor", isMartial: true, item_baseDef: "10", item_baseMdef: "0" }, ARMOR()),
    item("w-ruby", "Ruby Pendant", { item_type: "accessory" }, [eff("Ruby", [ch("affinity_6", 5, "${isEquipped ? 'RS' : 'NA'}$")])]),
    item("w-bronze", "Bronze Shield", { item_type: "shield", item_def_bonus: "2", item_mdef_bonus: "0" }, SHIELD()),
    item("w-gs", "Greatsword", { item_type: "weapon", category: "Sword", hand_slots: "Two-handed", damage_bonus: "10",
      check_bonus: "1", rolled_atr1: "DEX", rolled_atr2: "MIG", type_damage: "Physical", weapon_range: "Melee" }),
    item("w-whip", "Whip", { item_type: "weapon", category: "Flail", hand_slots: "Two-handed", damage_bonus: "8",
      check_bonus: "0", rolled_atr1: "DEX", rolled_atr2: "DEX", type_damage: "Fire", weapon_range: "Melee" }),
    item("w-whip-p", "Explosion Whip (Passive)", { skill_type: "Passive" }, [], { container: "w-whip" }),
    item("w-goggle", "Diver Goggle", { item_type: "accessory", isSet: true, set_name: "Swift Swimmers" },
      [eff("Diver Goggle", [ch("check_mod_accuracy", 2, '${and(isEquipped, ae("Wet")) ? 3 : 0}$')])]),
    item("w-set", "Swift Swimmers — Equipment Set", { set_name: "Swift Swimmers", set_bonus_table: { 0: { pieces: "2", bonus_ae_ref: "Wet" } } }),
    { id: "w-debuff", name: "Debuff", type: "activeEffectContainer", props: {}, flags: {}, container: null,
      effects: [{ _id: "wet1", name: "Wet", disabled: false, statuses: ["wet"], changes: [ch("affinity_3", 0, "VU", 1)] }] },
  ];
  return new WorldItems(new Map(list.map((x) => [x.id, x])));
}

// ── A PC whose stored sheet matches its kit ─────────────────────────────────
function makePc({ props = {}, items = [], actorEffects = [] }) {
  const m = toCombatModel({ _id: "pc", name: "Tester", items: [], system: { props: {
    level: "41", dex_base: "12", ins_base: "8", mig_base: "8", wlp_base: "8",
    max_mp: "50", current_mp: "50", current_hp: "81", max_hp: "81",
    off_hand: "", accessory_name: "", accessory2_name: "",
    ...props,
  } } });
  m.items = items;
  m.actorEffects = actorEffects;
  m.virtualAttacksAll = [];
  attachWeaponDetails(m);
  return m;
}

const bow = () => item("a-bow", "Bow", { item_type: "weapon", isEquipped: true, category: "Bow", hand_slots: "Two-handed",
  damage_bonus: "8", rolled_atr1: "DEX", rolled_atr2: "INS", type_damage: "Physical", weapon_range: "Ranged" });
const bowSkill = () => item("a-bow-skill", "Bow Trick", { skill_type: "Passive" }, [], { container: "a-bow" });
const tunic = () => item("a-tunic", "Combat Tunic", { item_type: "armor", isEquipped: true, isMartial: false,
  item_def_bonus: "+1", item_mdef_bonus: "+1" }, ARMOR());
const dodge = () => item("a-dodge", "Dodge", { skill_type: "Passive", level: "2" },
  [eff("Dodge", [ch("bonus_defense", 2, 'aeNotEquippedWhen("shield,martial_armor", "${level}$")')])]);

function archer(extraItems = []) {
  return makePc({
    props: {
      dex_current: 12, ins_current: 8, base_defense: 12, bonus_defense: 3, defense: 15,
      base_magic_defense: 8, bonus_magic_defense: 1, magic_defense: 9,
      main_hand: "Bow", main_attrib_1: "DEX", main_attrib_2: "INS",
      weapon1_base_damage: "8", weapon1_base_mod: "0", weapon1_damagetype: "Physical", affinity_6: "NA",
    },
    items: [bow(), bowSkill(), tunic(), dodge(), ...extraItems],
  });
}

const W = world();
const fromWorld = (name) => SW.resolveSource(`item:${name}`, { worldItems: W });

// ── Arguments ───────────────────────────────────────────────────────────────
t("parseSlotArg: slot forms, default main, Windows paths, unequip", () => {
  assert.deepStrictEqual(SW.parseSlotArg("Zarg=C:/specs/whip.json"), { pc: "Zarg", slot: "main", source: "C:/specs/whip.json" });
  assert.deepStrictEqual(SW.parseSlotArg("Zarg:armor=item:Brigandine"), { pc: "Zarg", slot: "armor", source: "item:Brigandine" });
  assert.deepStrictEqual(SW.parseSlotArg("Keren:acc2", { requireSource: false }), { pc: "Keren", slot: "acc2", source: null });
  assert.throws(() => SW.parseSlotArg("Zarg:hat=x.json"), /unknown slot/);
  assert.throws(() => SW.parseSlotArg("Keren:acc2"), /bad --equip/);
});

// ── Armor and Dodge ─────────────────────────────────────────────────────────
t("the synthetic archer reproduces (gate precondition)", () => {
  const r = SW.applySwaps(archer(), [], { worldItems: W });
  assert.strictEqual(r.after.def, 15);
});
t("martial Brigandine: base DEF stays the d12, Dodge switches OFF, tunic bonus leaves", () => {
  const m = archer();
  const r = SW.applySwaps(m, [{ slot: "armor", source: fromWorld("Brigandine") }], { worldItems: W });
  assert.strictEqual(r.before.def, 15);
  assert.strictEqual(r.after.def, 12);
  assert.strictEqual(m.def, 12);
  assert.deepStrictEqual(r.changes.map((c) => [c.slot, c.from, c.to]), [["armor", "Combat Tunic", "Brigandine"]]);
  assert.strictEqual(m.items.find((i) => i.name === "Combat Tunic").props.isEquipped, false);
});

// ── Accessories ─────────────────────────────────────────────────────────────
t("equipping Ruby Pendant grants fire RS and stamps the slot; unequipping removes it", () => {
  const m = archer();
  SW.applySwaps(m, [{ slot: "acc1", source: fromWorld("Ruby Pendant") }], { worldItems: W });
  assert.strictEqual(m.affinities.fire, "RS");
  assert.strictEqual(m._rawProps.accessory_name, "Ruby Pendant");
  SW.applySwaps(m, [{ slot: "acc1", source: null }], { worldItems: W, requireVerified: false });
  assert.strictEqual(m.affinities.fire, "NE");
  assert.strictEqual(m._rawProps.accessory_name, "");
});

// ── Hands ───────────────────────────────────────────────────────────────────
t("a two-handed weapon cannot go in the off hand", () => {
  assert.throws(() => SW.applySwaps(archer(), [{ slot: "off", source: fromWorld("Greatsword") }], { worldItems: W }), /two-handed, main hand only/);
});
t("nothing goes in the off hand while the main hand is two-handed", () => {
  assert.throws(() => SW.applySwaps(archer(), [{ slot: "off", source: fromWorld("Bronze Shield") }], { worldItems: W }), /Bow is two-handed/);
});
t("a shield in the main hand needs Dual Shieldbearer", () => {
  assert.throws(() => SW.applySwaps(archer(), [{ slot: "main", source: fromWorld("Bronze Shield") }], { worldItems: W }), /Dual Shieldbearer/);
  const dsb = item("a-dsb", "Dual Shieldbearer", { skill_type: "Passive" });
  const m = archer([dsb]);
  SW.applySwaps(m, [{ slot: "main", source: fromWorld("Bronze Shield") }], { worldItems: W });
  assert.strictEqual(m._rawProps.main_attrib_1, "SHI");
  assert.strictEqual(weaponAction({ actor: m }), null);   // a shield is not a weapon swing
});
t("a weapon swap rebuilds the swing: family, damage, element, range, accuracy", () => {
  const m = archer();
  SW.applySwaps(m, [{ slot: "main", source: fromWorld("Greatsword") }], { worldItems: W });
  assert.strictEqual(m.weapon.family, "sword");
  assert.strictEqual(m.weapon.baseDamage, 10);
  assert.strictEqual(m.weapon.range, "melee");
  const swing = weaponAction({ actor: m });
  assert.strictEqual(swing.checkBonus, 1);
  assert.strictEqual(swing.attrB, "mig");
});
t("granted sub-items follow their parent's equip state (the live equip gate)", () => {
  const { extractActions } = require("../lib/skills");
  const m = archer();
  SW.applySwaps(m, [{ slot: "main", source: fromWorld("Whip") }], { worldItems: W });
  const passives = extractActions(m).passives.map((p) => p.name);
  assert.ok(!passives.includes("Bow Trick"), "the unequipped bow's gear skill must be gated off");
  assert.ok(passives.includes("Explosion Whip (Passive)"), "the whip's gear skill must be live");
  assert.ok(m.items.some((i) => i.name === "Bow Trick"), "gated, not deleted — so the bow can be put back");
});
t("a Versatile granted skill stays usable with its item unequipped", () => {
  const { extractActions } = require("../lib/skills");
  const m = archer();
  m.items.find((i) => i.name === "Bow Trick").props.versatile = true;
  SW.applySwaps(m, [{ slot: "main", source: fromWorld("Whip") }], { worldItems: W });
  assert.ok(extractActions(m).passives.some((p) => p.name === "Bow Trick"));
});
t("the main hand cannot be emptied", () => {
  assert.throws(() => SW.applySwaps(archer(), [{ slot: "main", source: null }], { worldItems: W }), /cannot be emptied/);
});

// ── The gate ────────────────────────────────────────────────────────────────
t("a PC whose real loadout does not rebuild is REFUSED", () => {
  const m = archer();
  m._rawProps.defense = 19;
  assert.throws(() => SW.applySwaps(m, [{ slot: "armor", source: fromWorld("Brigandine") }], { worldItems: W }), /does not rebuild/);
});

// ── Set bonuses: Swift Swimmers ─────────────────────────────────────────────
const swimsuit = () => item("a-swim", "Swimsuit", { item_type: "armor", isEquipped: true, isMartial: false, isSet: true,
  set_name: "Swift Swimmers", item_def_bonus: "+1", item_mdef_bonus: "0" },
  [...ARMOR(), eff("Swift Swimmer", [ch("override_dex", 5, '${and(isEquipped, ae("Wet")) ? 12 : 0}$', 2)])]);
const goggle = () => item("a-goggle", "Diver Goggle", { item_type: "accessory", isEquipped: true, isSet: true, set_name: "Swift Swimmers" },
  [eff("Diver Goggle", [ch("check_mod_accuracy", 2, '${and(isEquipped, ae("Wet")) ? 3 : 0}$')])]);
const ruby = () => item("a-ruby", "Ruby Pendant", { item_type: "accessory", isEquipped: true },
  [eff("Ruby", [ch("affinity_6", 5, "${isEquipped ? 'RS' : 'NA'}$")])]);
const wetGrant = () => ({ name: "Wet", disabled: false, transfer: false, statuses: ["wet"],
  changes: [ch("affinity_3", 0, "VU", 1)], flags: { "fabula-ultima-companion": { setBonus: "Swift Swimmers:2:ae" } } });
const dagger = () => item("a-dag", "Dagger", { item_type: "weapon", isEquipped: true, category: "Dagger", hand_slots: "One-handed",
  damage_bonus: "4", rolled_atr1: "DEX", rolled_atr2: "INS", type_damage: "Physical", weapon_range: "Melee" });

function swimmer({ wet }) {
  return makePc({
    props: {
      dex_base: "8", main_hand: "Dagger", main_attrib_1: "DEX", main_attrib_2: "INS", weapon1_base_damage: "4",
      accessory_name: wet ? "Diver Goggle" : "Ruby Pendant",
      dex_current: wet ? 12 : 8, base_defense: wet ? 12 : 8, bonus_defense: 1, defense: wet ? 13 : 9,
      check_mod_accuracy: wet ? 3 : 0, affinity_3: wet ? "VU" : "NA", affinity_6: wet ? "NA" : "RS",
    },
    items: [dagger(), swimsuit(), wet ? goggle() : ruby()],
    actorEffects: wet ? [wetGrant()] : [],
  });
}

t("both set pieces worn: an unrelated swap KEEPS the Wet grant", () => {
  const m = swimmer({ wet: true });
  const r = SW.applySwaps(m, [{ slot: "acc2", source: fromWorld("Ruby Pendant") }], { worldItems: W });
  assert.deepStrictEqual(r.setBonus.removed, []);
  assert.strictEqual(m.attributes.dex, 12);
  assert.strictEqual(m.affinities.bolt, "VU");
});
t("removing a set piece REMOVES Wet — and every Wet-gated bonus with it", () => {
  const m = swimmer({ wet: true });
  const r = SW.applySwaps(m, [{ slot: "acc1", source: fromWorld("Ruby Pendant") }], { worldItems: W });
  assert.deepStrictEqual(r.setBonus.removed, ["Wet (Swift Swimmers:2:ae)"]);
  assert.strictEqual(m.attributes.dex, 8);
  assert.strictEqual(m.def, 9);
  assert.strictEqual(m.checkMods.accuracy, 0);
  assert.strictEqual(m.affinities.bolt, "NE");
});
t("completing the set GRANTS Wet from the world's set definition", () => {
  const m = swimmer({ wet: false });
  const r = SW.applySwaps(m, [{ slot: "acc1", source: fromWorld("Diver Goggle") }], { worldItems: W });
  assert.deepStrictEqual(r.setBonus.added, ["Wet (Swift Swimmers:2:ae)"]);
  assert.strictEqual(m.attributes.dex, 12);
  assert.strictEqual(m.checkMods.accuracy, 3);
  assert.strictEqual(m.affinities.bolt, "VU");
});

// ── Paper specs ─────────────────────────────────────────────────────────────
t("a paper armor spec with no effects gets the world's standard DEF effects, with a warning", () => {
  const src = SW.sourceFromDoc({ name: "Paper Plate", system: { props: { item_type: "armor", isMartial: true, item_baseDef: "14" } } }, "paper-plate.json");
  assert.ok(src.warnings.some((w) => /standard "Armor DEF"/.test(w)));
  const m = archer();
  SW.applySwaps(m, [{ slot: "armor", source: src }], { worldItems: W });
  assert.strictEqual(m.def, 14);
});
t("martial paper armor without item_baseDef is refused", () => {
  assert.throws(() => SW.sourceFromDoc({ name: "Bad", system: { props: { item_type: "armor", isMartial: true } } }, "bad.json"), /item_baseDef/);
});

// ── own:<name> — the PC's own inventory ─────────────────────────────────────
t("own:<name> puts a carried item back, with its granted skills, without duplicating it", () => {
  const { extractActions } = require("../lib/skills");
  const m = archer();
  SW.applySwaps(m, [{ slot: "main", source: fromWorld("Whip") }], { worldItems: W });
  const back = SW.resolveSource("own:Bow", { model: m });
  assert.ok(back.own);
  SW.applySwaps(m, [{ slot: "main", source: back }], { worldItems: W });
  assert.strictEqual(m.weapon.name, "Bow");
  assert.strictEqual(m.weapon.family, "bow");
  const passives = extractActions(m).passives.map((p) => p.name);
  assert.ok(passives.includes("Bow Trick"), "the bow's skill is back");
  assert.ok(!passives.includes("Explosion Whip (Passive)"), "the whip's skill is gated again");
  assert.strictEqual(m.items.filter((i) => i.name === "Bow").length, 1, "switched on in place, not duplicated");
});
t("own: refuses an item the PC does not carry", () => {
  assert.throws(() => SW.resolveSource("own:Excalibur", { model: archer() }), /carries no equipment named "Excalibur"/);
});
t("own: refuses an item already worn in another slot", () => {
  const m = archer();
  SW.applySwaps(m, [{ slot: "acc1", source: fromWorld("Ruby Pendant") }], { worldItems: W });
  const again = SW.resolveSource("own:Ruby Pendant", { model: m });
  assert.throws(() => SW.applySwaps(m, [{ slot: "acc2", source: again }], { worldItems: W }), /already worn/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
