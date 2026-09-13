"use strict";
// Mindscape — loadout model tests. Plain node, no framework.
//
// Each case mirrors a rule a real party sheet depends on (see lib/loadout.js for
// the sources): the armor DEF/MDEF effects, Dodge's equipment gate, the Wet
// override, affinity floors, the max_hp template formula.

const assert = require("assert");
const L = require("../lib/loadout");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const eff = (name, changes, extra = {}) => ({ name, disabled: false, transfer: true, changes, ...extra });
const ch = (key, mode, value, priority = null) => ({ key, mode, value, priority });

// The live armor effects, verbatim shape (party dump 2026-09-13).
const ARMOR_AES = () => [
  eff("Armor DEF", [
    ch("base_defense", 4, "${isEquipped ? (isMartial ? (item_baseDef * 1) : 0) : 0}$", 1),
    ch("bonus_defense", 2, "${isEquipped ? (isMartial ? 0 : (item_def_bonus * 1)) : 0}$", 2),
  ]),
  eff("Armor MDEF", [
    ch("base_magic_defense", 4, "${isEquipped ? (isMartial ? (item_baseMdef * 1) : 0) : 0}$", 1),
    ch("bonus_magic_defense", 2, "${isEquipped ? (isMartial ? 0 : (item_mdef_bonus * 1)) : 0}$", 2),
  ]),
];

function armor(name, { martial, baseDef = "0", def = "0", baseMdef = "0", mdef = "0", equipped = true, extra = [] }) {
  return {
    id: name, name,
    props: { item_type: "armor", isEquipped: equipped, isMartial: martial,
      item_baseDef: baseDef, item_def_bonus: def, item_baseMdef: baseMdef, item_mdef_bonus: mdef },
    effects: [...ARMOR_AES(), ...extra],
  };
}

const dodge = (level = "2") => ({
  id: "dodge", name: "Dodge", props: { skill_type: "Passive", level },
  effects: [eff("Dodge", [ch("bonus_defense", 2, 'aeNotEquippedWhen("shield,martial_armor", "${level}$")')])],
});

function pc({ props = {}, items = [], actorEffects = [] } = {}) {
  return {
    name: "Tester",
    _rawProps: { level: "41", dex_base: "12", ins_base: "8", mig_base: "8", wlp_base: "8", ...props },
    items, actorEffects,
  };
}

// ── Armor and Dodge ─────────────────────────────────────────────────────────
t("non-martial armor ADDS its bonus to the DEX die; Dodge adds its SL", () => {
  const { values } = L.rebuildSheet(pc({ items: [armor("Combat Tunic", { martial: false, def: "+1", mdef: "+1" }), dodge()] }));
  assert.strictEqual(values.base_defense, 12);
  assert.strictEqual(values.bonus_defense, 3);
  assert.strictEqual(values.defense, 15);
  assert.strictEqual(values.magic_defense, 9);
});
t("martial armor RAISES base DEF to its fixed value and switches Dodge off", () => {
  const { values } = L.rebuildSheet(pc({ props: { dex_base: "8" }, items: [armor("Paladin", { martial: true, baseDef: "12", baseMdef: "13" }), dodge()] }));
  assert.strictEqual(values.base_defense, 12);
  assert.strictEqual(values.bonus_defense, 0);
  assert.strictEqual(values.defense, 12);
  assert.strictEqual(values.base_magic_defense, 13);
});
t("martial armor never LOWERS a higher DEX die (UPGRADE = max)", () => {
  const { values } = L.rebuildSheet(pc({ props: { dex_base: "12" }, items: [armor("Brigandine", { martial: true, baseDef: "10" })] }));
  assert.strictEqual(values.base_defense, 12);
});
t("an UNEQUIPPED item contributes nothing, even with enabled literal effects", () => {
  const refine = eff("Armor Refinement", [ch("system.props.max_hp", 2, "25")]);
  const { values } = L.rebuildSheet(pc({ items: [armor("Spare Plate", { martial: true, baseDef: "14", equipped: false, extra: [refine] })] }));
  assert.strictEqual(values.base_defense, 12);
  assert.strictEqual(values.max_hp, 41 + 40);
});

// ── max_hp ──────────────────────────────────────────────────────────────────
t("max_hp = level + 5*MIG + 5*HP benefits + refinement effect (system.props. prefix)", () => {
  const classList = { 0: { benefit: "hp" }, 1: { benefit: "ip" }, 2: { benefit: "hp" }, 3: { benefit: "hp", $deleted: true } };
  const refine = eff("Armor Refinement", [ch("system.props.max_hp", 2, "20")]);
  const { values } = L.rebuildSheet(pc({ props: { class_list: classList }, items: [armor("Tunic", { martial: false, extra: [refine] })] }));
  assert.strictEqual(values.max_hp, 41 + 40 + 10 + 20);
});
t("max_hp adds bonus_hp, itself effect-driven (Blanche: Survivor +5, Fortress SL*5)", () => {
  const survivor = { id: "sv", name: "Survivor", props: { skill_type: "Passive" },
    effects: [eff("Survivor", [ch("bonus_hp", 2, "5")])] };
  const fortress = { id: "ft", name: "Fortress", props: { skill_type: "Other", level: "4" },
    effects: [eff("Fortress", [ch("max_hp", 2, "${level * 5}$")])] };
  const classList = { 0: { benefit: "hp" }, 1: { benefit: "hp" }, 2: { benefit: "hp" }, 3: { benefit: "ip" } };
  const refine = eff("Armor Refinement", [ch("system.props.max_hp", 2, "25")]);
  const model = pc({ props: { mig_base: "12", class_list: classList },
    items: [survivor, fortress, armor("+5 Paladin Armor", { martial: true, baseDef: "12", extra: [refine] })] });
  const { values } = L.rebuildSheet(model);
  assert.strictEqual(values.bonus_hp, 5);
  assert.strictEqual(values.max_hp, 166);
});
t("fetchFromParent reads the bearer's prop (Prophetic Defender)", () => {
  const skill = { id: "pd", name: "Prophetic Defender", props: { skill_type: "Passive" },
    effects: [eff("Prophetic Defender", [ch("max_hp", 2, "${fetchFromParent('ins_base')}$")])] };
  const { values } = L.rebuildSheet(pc({ props: { ins_base: "12" }, items: [skill] }));
  assert.strictEqual(values.max_hp, 41 + 40 + 12);
});

// ── Situational state ───────────────────────────────────────────────────────
function wetKit(withWet) {
  const goggle = { id: "g", name: "Diver Goggle", props: { item_type: "accessory", isEquipped: true },
    effects: [eff("Diver Goggle", [ch("check_mod_accuracy", 2, '${and(isEquipped, ae("Wet")) ? 3 : 0}$')])] };
  const swimsuit = armor("Swimsuit", { martial: false, def: "+1", extra: [
    eff("Swimsuit", [ch("override_dex", 5, '${and(isEquipped, ae("Wet")) ? 12 : 0}$')]),
  ] });
  const wet = eff("Wet", [ch("affinity_3", 0, "VU")], { statuses: ["5FFBDg2y54bpqgat"] });
  return pc({ props: { dex_base: "8" }, items: [goggle, swimsuit], actorEffects: withWet ? [wet] : [] });
}
t("Wet: ae() gates read the ACTOR's effects; override_dex lifts the DEX die", () => {
  const { values, report } = L.rebuildSheet(wetKit(true));
  assert.strictEqual(values.check_mod_accuracy, 3);
  assert.strictEqual(values.dex_current, 12);
  assert.strictEqual(values.base_defense, 12);
  assert.strictEqual(values.affinity_3, "VU");   // CUSTOM-mode actor effect
  assert.ok(report.situational.some((x) => x.state === "Wet" && x.key === "check_mod_accuracy"));
});
t("not Wet: the same gear gives nothing and the DEX die falls back", () => {
  const { values } = L.rebuildSheet(wetKit(false));
  assert.strictEqual(values.check_mod_accuracy, 0);
  assert.strictEqual(values.dex_current, 8);
  assert.strictEqual(values.affinity_3, "NA");
});
t("STATUS_COUNT reads 0 and is flagged situational, not refused", () => {
  const skill = { id: "adv", name: "Adversity", props: { skill_type: "Passive" },
    effects: [eff("Adversity", [ch("check_mod_all", 2, "${min(STATUS_COUNT, 3)}$")])] };
  const { values, report } = L.rebuildSheet(pc({ items: [skill] }));
  assert.strictEqual(values.check_mod_all, 0);
  assert.ok(report.situational.some((x) => x.state === "STATUS_COUNT"));
});

// ── Affinities ──────────────────────────────────────────────────────────────
t("aeAffinityFloor keeps an Absorb already in place", () => {
  const ring = { id: "r", name: "Ring of Magma", props: { item_type: "accessory", isEquipped: true },
    effects: [eff("Ring", [ch("affinity_6", 5, "AB", 1)])] };
  const shroud = { id: "o", name: "Orbment", props: { item_type: "armor", isEquipped: true, isMartial: false },
    effects: [eff("Resistance Fire", [ch("affinity_6", 5, 'aeAffinityFloor("RS")', 2)])] };
  assert.strictEqual(L.rebuildSheet(pc({ items: [ring, shroud] })).values.affinity_6, "AB");
  assert.strictEqual(L.rebuildSheet(pc({ items: [shroud] })).values.affinity_6, "RS");
});
t("a false aeWhen on an affinity writes NA (the live gate's fallback)", () => {
  const blood = { id: "b", name: "Dark Blood", props: { skill_type: "Passive" },
    effects: [eff("Dark Blood", [ch("affinity_4", 5, 'aeWhen("Crisis", "RS")')])] };
  assert.strictEqual(L.rebuildSheet(pc({ items: [blood] })).values.affinity_4, "NA");
  const crisis = eff("Crisis", []);
  assert.strictEqual(L.rebuildSheet(pc({ items: [blood], actorEffects: [crisis] })).values.affinity_4, "RS");
});
t("equip-gated string ternary: 'RS' while equipped", () => {
  const pendant = { id: "p", name: "Ruby Pendant", props: { item_type: "accessory", isEquipped: true },
    effects: [eff("Ruby", [ch("affinity_6", 5, "${isEquipped ? 'RS' : 'NA'}$")])] };
  assert.strictEqual(L.rebuildSheet(pc({ items: [pendant] })).values.affinity_6, "RS");
});

// ── Weapons, filters, refusal ───────────────────────────────────────────────
t("hasWeapon('arcane') gates Magical Artillery on the equipped weapon", () => {
  const art = { id: "ma", name: "Magical Artillery", props: { skill_type: "Passive", level: "3" },
    effects: [eff("MA", [ch("check_mod_magic", 2, '${hasWeapon("arcane") ? level * 2 : 0}$')])] };
  const wand = { id: "w", name: "Glowstick", props: { item_type: "weapon", isEquipped: true, category: "Arcane" }, effects: [] };
  const bow = { id: "w2", name: "Bow", props: { item_type: "weapon", isEquipped: true, category: "Bow" }, effects: [] };
  assert.strictEqual(L.rebuildSheet(pc({ items: [art, wand] })).values.check_mod_magic, 6);
  assert.strictEqual(L.rebuildSheet(pc({ items: [art, bow] })).values.check_mod_magic, 0);
});
t("disabled and non-transfer effects are skipped", () => {
  const shroud = { id: "es", name: "Elemental Shroud", props: { skill_type: "Spell" }, effects: [
    eff("Shroud (Fire)", [ch("affinity_6", 5, "RS")], { transfer: false }),
    eff("Old buff", [ch("check_mod_all", 2, "5")], { disabled: true }),
  ] };
  const { values } = L.rebuildSheet(pc({ items: [shroud] }));
  assert.strictEqual(values.affinity_6, "NA");
  assert.strictEqual(values.check_mod_all, 0);
});
t("an unknown identifier is REPORTED, never zero-substituted into the value", () => {
  const odd = { id: "x", name: "Odd", props: { skill_type: "Passive" },
    effects: [eff("Odd", [ch("check_mod_all", 2, "${mystery_prop + 2}$")])] };
  const { values, report } = L.rebuildSheet(pc({ items: [odd] }));
  assert.strictEqual(values.check_mod_all, 0);
  assert.ok(report.unresolved.some((u) => u.key === "check_mod_all" && /mystery_prop/.test(u.reason)));
});
t("later priority wins between two OVERRIDEs", () => {
  const a = { id: "a", name: "A", props: { skill_type: "Passive" }, effects: [eff("A", [ch("affinity_2", 5, "RS", 5)])] };
  const b = { id: "b", name: "B", props: { skill_type: "Passive" }, effects: [eff("B", [ch("affinity_2", 5, "VU", 1)])] };
  assert.strictEqual(L.rebuildSheet(pc({ items: [a, b] })).values.affinity_2, "RS");
});

// ── The round-trip gate ─────────────────────────────────────────────────────
t("verifyLoadout: a consistent stored sheet reproduces with no mismatches", () => {
  const model = pc({
    props: { base_defense: 12, bonus_defense: 3, defense: 15, base_magic_defense: 8, bonus_magic_defense: 1, magic_defense: 9, max_hp: 81, affinity_6: "NA" },
    items: [armor("Combat Tunic", { martial: false, def: "+1", mdef: "+1" }), dodge()],
  });
  const v = L.verifyLoadout(model);
  assert.deepStrictEqual(v.mismatches, []);
  assert.ok(v.ok);
  assert.ok(v.matched.includes("defense") && v.matched.includes("max_hp"));
});
t("verifyLoadout: a sheet that does not reproduce is reported key by key", () => {
  const model = pc({ props: { defense: 19, bonus_defense: 3 }, items: [armor("Combat Tunic", { martial: false, def: "+1" }), dodge()] });
  const v = L.verifyLoadout(model);
  assert.strictEqual(v.ok, false);
  assert.ok(v.mismatches.some((m) => m.key === "defense" && m.stored === 19 && m.rebuilt === 15));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
