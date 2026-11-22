// node scripts/shared/equipped-gear.test.mjs — equip slots by item id.
import assert from "node:assert/strict";
import { resolveWornSlots, slotStamp, planEquipSync, itemAttackBonuses, slotIdsOf } from "./equipped-gear.js";

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const NS = "fabula-ultima-companion";
const weapon = (id, name, extra = {}) => ({ id, name, system: { props: { name, item_type: "weapon", rolled_atr1: "DEX", rolled_atr2: "INS",
  check_bonus: 1, damage_bonus: 21, type_damage: "Physical", description: "bow", isEquipped: false, ...extra } } });
const shield = (id, name, extra = {}) => ({ id, name, system: { props: { name, item_type: "shield", item_def_bonus: 2, item_mdef_bonus: 1, description: "", ...extra } } });
const acc = (id, name) => ({ id, name, system: { props: { name, item_type: "accessory", description: "ring" } } });
const mkActor = (props, items, slots = null) => {
  const a = { name: "T", system: { props: { ...props } }, flags: slots ? { [NS]: { equipSlots: { ...slots } } } : {}, items };
  a._source = a;
  return a;
};

await t("id + matching label resolves via id", () => {
  const bow = weapon("B1", "+5 Zarg's Bow");
  const a = mkActor({ main_hand: "+5 Zarg's Bow" }, [bow], { main: "B1" });
  const w = resolveWornSlots(a);
  assert.equal(w.main, bow); assert.equal(w.via.main, "id");
});

await t("REFINE: item renamed, label stale → still the bow (id)", () => {
  const bow = weapon("B1", "+6 Zarg's Bow");
  const a = mkActor({ main_hand: "+5 Zarg's Bow" }, [bow], { main: "B1" });
  const w = resolveWornSlots(a);
  assert.equal(w.main, bow); assert.equal(w.via.main, "id-stale-label");
});

await t("legacy writer equips another weapon by name (id stale) → the named weapon", () => {
  const bow = weapon("B1", "+6 Zarg's Bow"), sword = weapon("S1", "Cursed Sword");
  const a = mkActor({ main_hand: "Cursed Sword" }, [bow, sword], { main: "B1" });
  assert.equal(resolveWornSlots(a).main, sword);
});

await t("empty label = nothing worn, even with an id left behind", () => {
  const bow = weapon("B1", "Bow");
  const a = mkActor({ main_hand: "" }, [bow], { main: "B1" });
  assert.equal(resolveWornSlots(a).main, null);
});

await t("no ids (old data): name fallback as before", () => {
  const bow = weapon("B1", "Bow");
  assert.equal(resolveWornSlots(mkActor({ main_hand: "Bow" }, [bow])).main, bow);
});

await t("duplicates: ids pick the exact copies; main and off never share", () => {
  const w1 = weapon("W1", "Wakizashi"), w2 = weapon("W2", "Wakizashi"), w3 = weapon("W3", "Wakizashi");
  const a = mkActor({ main_hand: "Wakizashi", off_hand: "Wakizashi" }, [w1, w2, w3], { main: "W3", off: "W2" });
  const w = resolveWornSlots(a);
  assert.equal(w.main, w3); assert.equal(w.off, w2);
  const noIds = resolveWornSlots(mkActor({ main_hand: "Wakizashi", off_hand: "Wakizashi" }, [w1, w2, w3]));
  assert.notEqual(noIds.main.id, noIds.off.id);
});

await t("deleted item id falls back to the label", () => {
  const bow2 = weapon("B2", "Bow");
  const a = mkActor({ main_hand: "Bow" }, [bow2], { main: "GONE" });
  assert.equal(resolveWornSlots(a).main, bow2);
});

await t("hidden items are excluded unless asked for", () => {
  const bow = weapon("B1", "Bow"); bow.flags = { [NS]: { hiddenUntilBattleEnd: true } };
  const a = mkActor({ main_hand: "Bow" }, [bow], { main: "B1" });
  assert.equal(resolveWornSlots(a).main, null);
  assert.equal(resolveWornSlots(a, { includeHidden: true }).main, bow);
});

await t("accessories resolve independently of hands", () => {
  const r1 = acc("R1", "Ring"), r2 = acc("R2", "Ring");
  const a = mkActor({ accessory_name: "Ring", accessory2_name: "Ring" }, [r1, r2], { acc1: "R2", acc2: "R1" });
  const w = resolveWornSlots(a);
  assert.equal(w.acc1, r2); assert.equal(w.acc2, r1);
});

await t("slotStamp matches the legacy equip mapping (weapon / shield / empty / accessory)", () => {
  const s = slotStamp("main", weapon("B1", "Bow", { damage_bonus: 22 }));
  assert.equal(s["system.props.main_hand"], "Bow");
  assert.equal(s["system.props.main_attrib_2"], "INS");
  assert.equal(s["system.props.weapon1_base_damage"], 22);
  assert.equal(s["system.props.weapon1_base_mod"], 1);
  assert.equal(s[`flags.${NS}.equipSlots.main`], "B1");
  const sh = slotStamp("off", shield("S1", "Royal Shield"));
  assert.equal(sh["system.props.off_attrib_1"], "SHI");
  assert.equal(sh["system.props.off_base_mod_1"], 2);
  assert.equal(sh["system.props.off_base_mod_2"], 1);
  assert.equal(sh["system.props.weapon2_damagetype"], "-");
  const e = slotStamp("main", null);
  assert.equal(e["system.props.main_hand"], ""); assert.equal(e["system.props.main_attrib_1"], "SHI");
  assert.equal(e[`flags.${NS}.equipSlots.main`], null);
  const r = slotStamp("acc2", acc("R1", "Ring"));
  assert.equal(r["system.props.accessory2_name"], "Ring"); assert.equal(r["system.props.accessory2_details"], "ring");
});

await t("planEquipSync after a refine: label + damage re-stamped, nothing else", () => {
  const bow = weapon("B1", "+6 Zarg's Bow", { damage_bonus: 22 });
  const a = mkActor({ main_hand: "+5 Zarg's Bow", main_attrib_1: "DEX", main_attrib_2: "INS", weapon1_base_mod: 1,
    weapon1_base_damage: 21, weapon1_damagetype: "Physical", main_details: "bow" }, [bow], { main: "B1" });
  const { update, slots } = planEquipSync(a);
  assert.deepEqual(slots, ["main"]);
  assert.deepEqual(update, { "system.props.main_hand": "+6 Zarg's Bow", "system.props.weapon1_base_damage": 22 });
});

await t("planEquipSync is idempotent and leaves bare NPC names alone", () => {
  const bow = weapon("B1", "Bow");
  const a = mkActor({ main_hand: "Bow", main_attrib_1: "DEX", main_attrib_2: "INS", weapon1_base_mod: "1",
    weapon1_base_damage: "21", weapon1_damagetype: "Physical", main_details: "bow" }, [bow], { main: "B1" });
  assert.equal(planEquipSync(a).slots.length, 0);
  const npc = mkActor({ main_hand: "Claws", weapon1_base_damage: 9 }, []);
  assert.equal(planEquipSync(npc).slots.length, 0);
});

await t("planEquipSync stamps a missing id (old data)", () => {
  const bow = weapon("B1", "Bow");
  const a = mkActor({ main_hand: "Bow", main_attrib_1: "DEX", main_attrib_2: "INS", weapon1_base_mod: 1,
    weapon1_base_damage: 21, weapon1_damagetype: "Physical", main_details: "bow" }, [bow]);
  assert.deepEqual(planEquipSync(a).update, { [`flags.${NS}.equipSlots.main`]: "B1" });
});

await t("itemAttackBonuses = item stats + actor buffs over the cached base", () => {
  const bow = weapon("B1", "+6 Zarg's Bow", { damage_bonus: 22, check_bonus: 1 });
  // cache still at the +5 values (21), CSB computed weapon1_damage = 21 + 3 buff
  const a = mkActor({ weapon1_base_mod: 1, weapon1_mod: 3, weapon1_base_damage: 21, weapon1_damage: 24 }, [bow]);
  assert.deepEqual(itemAttackBonuses(a, bow, "main"), { checkBonus: 3, damageBonus: 25 });
  const off = mkActor({ off_base_mod_1: 0, off_mod_1: 0, off_base_mod_2: 0, off_mod_2: 2 }, [bow]);
  assert.deepEqual(itemAttackBonuses(off, bow, "off"), { checkBonus: 1, damageBonus: 24 });
  assert.equal(itemAttackBonuses(mkActor({}, [bow]), bow, "main"), null);
});

await t("slotIdsOf tolerates missing flags", () => {
  assert.deepEqual(slotIdsOf({}), {});
  assert.deepEqual(slotIdsOf(mkActor({}, [], { main: "X" })), { main: "X" });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
