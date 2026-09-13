"use strict";
//
// Mindscape — full-loadout equipment swaps (ruleset Part 6f).
//
//   --equip   "Zarg:armor=specs/equipment/x.json"     a paper item
//   --equip   "Zarg:acc1=item:Ruby Pendant"            a real world item (or item:#<id>)
//   --equip   "Zarg=specs/equipment/whip.json"         no slot = main hand
//   --unequip "Keren:acc2"
//
// Everything happens IN MEMORY on the loaded model; no loadout in the world changes.
//
// A swap is not a patch of one number. It mirrors what equipment-swap.js does live —
// flip isEquipped, rewrite the slot props, re-run set bonuses — and then RE-DERIVES
// the sheet with lib/loadout.js, because every gear-dependent number (DEF, MDEF, max
// HP, affinities, check and damage modifiers, the attribute dice) can move: Dodge
// switches off under martial armor, a set bonus appears or vanishes, an override die
// comes and goes with the piece that grants it.
//
// The refusal that keeps it honest: a PC whose REAL loadout does not rebuild onto the
// stored sheet (bin/verify-loadouts.js) is not swapped. A swap computed on a model
// that cannot reproduce the character measures a character that does not exist.

const fs = require("fs");
const path = require("path");
const { toCombatModel, attachWeaponDetails, virtualAttackAvailable } = require("./load-actors");
const { rebuildSheet, verifyLoadout } = require("./loadout");
const { checkEquipSpec } = require("./equip-file");

const SLOTS = Object.freeze(["main", "off", "armor", "acc1", "acc2"]);
const SLOT_TYPES = Object.freeze({
  main: ["weapon", "shield"], off: ["weapon", "shield"],
  armor: ["armor"], acc1: ["accessory"], acc2: ["accessory"],
});
// shared/code-backed-content.js: "Dual Shieldbearer", match "exact" (case-sensitive).
const DUAL_SHIELDBEARER = "Dual Shieldbearer";
const FLAG_NS = "fabula-ultima-companion";
const SET_NAME_EMPTY = "<Set Name>";
const EQUIP_TYPES = new Set(["weapon", "armor", "shield", "accessory"]);

function s(v) { return String(v ?? "").trim(); }
function norm(v) { return s(v).toLowerCase(); }
function isTrue(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function typeOf(item) { return norm(item?.props?.item_type); }
function isTwoHanded(item) { return typeOf(item) !== "shield" && norm(item?.props?.hand_slots).includes("two"); }

// ── Arguments ───────────────────────────────────────────────────────────────
// "<PC>[:<slot>]=<source>" for --equip, "<PC>:<slot>" for --unequip. Split on the
// FIRST "=" so a Windows path ("C:/...") in the source cannot be mistaken for a slot.
function parseSlotArg(raw, { requireSource = true } = {}) {
  const text = s(raw);
  const eq = text.indexOf("=");
  const left = eq >= 0 ? text.slice(0, eq).trim() : text;
  const source = eq >= 0 ? text.slice(eq + 1).trim() : null;
  const colon = left.lastIndexOf(":");
  const pc = colon > 0 ? left.slice(0, colon).trim() : left;
  const slot = colon > 0 ? norm(left.slice(colon + 1)) : "main";
  const want = requireSource ? '"<PC>[:<slot>]=<file.json | item:<name>>"' : '"<PC>:<slot>"';
  if (!pc) throw new Error(`Mindscape: bad argument "${raw}" (want ${want})`);
  if (!SLOTS.includes(slot)) throw new Error(`Mindscape: unknown slot "${slot}" in "${raw}" (slots: ${SLOTS.join(", ")})`);
  if (requireSource && !source) throw new Error(`Mindscape: bad --equip "${raw}" (want ${want})`);
  if (!requireSource && (eq >= 0 || colon <= 0)) throw new Error(`Mindscape: bad --unequip "${raw}" (want ${want})`);
  return { pc, slot, source };
}

// ── Sources ─────────────────────────────────────────────────────────────────
// The world's own DEF/MDEF effect shapes (verbatim from party items, 2026-09-13).
// Every armor and shield in the world carries them; DEF lives in the EFFECTS, not in
// item_baseDef alone, so a paper spec without them would add no defence at all.
function standardArmorEffects() {
  return [
    { name: "Armor DEF", disabled: false, transfer: true, changes: [
      { key: "base_defense", mode: 4, priority: 1, value: "${isEquipped ? (isMartial ? (item_baseDef * 1) : 0) : 0}$" },
      { key: "bonus_defense", mode: 2, priority: 2, value: "${isEquipped ? (isMartial ? 0 : (item_def_bonus * 1)) : 0}$" },
    ] },
    { name: "Armor MDEF", disabled: false, transfer: true, changes: [
      { key: "base_magic_defense", mode: 4, priority: 1, value: "${isEquipped ? (isMartial ? (item_baseMdef * 1) : 0) : 0}$" },
      { key: "bonus_magic_defense", mode: 2, priority: 2, value: "${isEquipped ? (isMartial ? 0 : (item_mdef_bonus * 1)) : 0}$" },
    ] },
  ];
}
function standardShieldEffects() {
  return [
    { name: "DEF UP", disabled: false, transfer: true, changes: [
      { key: "bonus_defense", mode: 2, priority: 2, value: "${isEquipped ? (item_def_bonus * 1) : 0}$" },
    ] },
    { name: "MDEF UP", disabled: false, transfer: true, changes: [
      { key: "bonus_magic_defense", mode: 2, priority: 2, value: "${isEquipped ? (item_mdef_bonus * 1) : 0}$" },
    ] },
  ];
}

function checkItemSpec(doc, where = "equipment spec") {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [`${where}: must be ONE item object`];
  const p = doc?.system?.props;
  if (!p || typeof p !== "object") return [`${where}: missing "system.props" — a spec is an item document`];
  const type = norm(p.item_type);
  if (type === "weapon") return checkEquipSpec(doc, where);

  const problems = [];
  if (!s(doc.name)) problems.push(`${where}: missing "name"`);
  if (!["armor", "shield", "accessory"].includes(type)) {
    problems.push(`${where}: item_type "${s(p.item_type)}" is not equipment (weapon, armor, shield, accessory)`);
  }
  for (const k of ["item_baseDef", "item_baseMdef", "item_def_bonus", "item_mdef_bonus"]) {
    const v = s(p[k]);
    if (v && !Number.isFinite(Number(v))) problems.push(`${where}: ${k} "${v}" must be a plain number`);
  }
  if (type === "armor" && isTrue(p.isMartial) && !(Number(p.item_baseDef) > 0)) {
    problems.push(`${where}: martial armor needs item_baseDef above 0 — it REPLACES the DEX die`);
  }
  if (doc.effects !== undefined && !Array.isArray(doc.effects)) {
    problems.push(`${where}: "effects" must be an array of Active Effect documents`);
  }
  for (const e of Array.isArray(doc.effects) ? doc.effects : []) {
    if (!Array.isArray(e?.changes)) problems.push(`${where}: effect "${e?.name ?? "?"}" has no "changes" array`);
  }
  for (const it of doc.items ?? []) {
    if (!s(it?.name)) problems.push(`${where}: a sub-item is missing "name"`);
    else if (!it.props && !it.system?.props) problems.push(`${where}: sub-item "${it.name}" has neither "props" nor "system.props"`);
  }
  return problems;
}

// A validated spec document -> { item, subItems, origin, warnings }.
function sourceFromDoc(doc, origin) {
  const bad = checkItemSpec(doc, path.basename(String(origin)));
  if (bad.length) throw new Error(`Mindscape: equipment spec is not loadable:\n  · ${bad.join("\n  · ")}`);
  const props = { ...doc.system.props };
  const id = `paper:${s(doc.name)}`;
  const type = norm(props.item_type);
  let effects = clone(doc.effects ?? []);
  const warnings = [];
  const touches = (keys) => effects.some((e) => (e.changes ?? [])
    .some((c) => keys.includes(s(c.key).replace("system.props.", ""))));
  if (type === "armor" && !touches(["base_defense", "bonus_defense", "base_magic_defense", "bonus_magic_defense"])) {
    effects = [...effects, ...standardArmorEffects()];
    warnings.push(`${doc.name}: spec has no DEF/MDEF effects — added the world's standard "Armor DEF"/"Armor MDEF"`);
  }
  if (type === "shield" && !touches(["bonus_defense", "bonus_magic_defense"])) {
    effects = [...effects, ...standardShieldEffects()];
    warnings.push(`${doc.name}: spec has no DEF/MDEF effects — added the world's standard "DEF UP"/"MDEF UP"`);
  }
  return {
    item: { id, name: s(doc.name), type: doc.type ?? "equippableItem", props, flags: clone(doc.flags ?? {}), container: null, effects },
    subItems: (doc.items ?? []).map((it, i) => ({
      id: s(it.id ?? it._id) || `${id}:sub${i}`,
      name: s(it.name),
      type: it.type ?? "equippableItem",
      props: { ...(it.props ?? it.system?.props ?? {}) },
      flags: clone(it.flags ?? {}),
      container: id,
      effects: clone(it.effects ?? []),
    })),
    origin: `paper spec ${origin}`,
    warnings,
  };
}

function readSpecSource(file) {
  const abs = path.resolve(file);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`Mindscape: cannot read equipment spec "${abs}": ${e.message}`);
  }
  return sourceFromDoc(doc, abs);
}

function copyWorldItem(item) {
  return {
    id: item.id, name: item.name, type: item.type, props: { ...item.props },
    flags: clone(item.flags ?? {}), container: item.container ?? null, effects: clone(item.effects ?? []),
  };
}

function worldSource(worldItems, ref) {
  if (!worldItems) throw new Error("Mindscape: an item:<name> source needs the world items collection");
  const r = s(ref);
  const item = r.startsWith("#") ? worldItems.get(r.slice(1)) : worldItems.equipmentByName(r);
  if (!item) throw new Error(`Mindscape: no world item with id "${r.slice(1)}"`);
  if (!EQUIP_TYPES.has(typeOf(item))) throw new Error(`Mindscape: world item "${item.name}" is not equipment`);
  return {
    item: copyWorldItem(item),
    subItems: worldItems.contained(item.id).map(copyWorldItem),
    origin: `world item "${item.name}" [${item.id}]`,
    warnings: [],
  };
}

// A piece the character already CARRIES — worn elsewhere or in the bag — by name or
// #id. The point is "baseline + one of this PC's real items": the refined +5 bow lives
// on the actor, not among the world items. Refused when two copies differ (different
// refinement would otherwise be picked at random); use own:#<id> then.
function ownSource(model, ref) {
  if (!model) throw new Error("Mindscape: an own:<name> source needs the PC it belongs to");
  const r = s(ref);
  const gear = (model.items ?? []).filter((it) => EQUIP_TYPES.has(typeOf(it)));
  const hits = r.startsWith("#")
    ? gear.filter((it) => it.id === r.slice(1))
    : gear.filter((it) => s(it.name) === r || s(it.props?.name) === r);
  if (!hits.length) throw new Error(`Mindscape: ${model.name} carries no equipment ${r.startsWith("#") ? `with id "${r.slice(1)}"` : `named "${r}"`}`);
  const variants = new Set(hits.map((h) => JSON.stringify({ ...h.props, isEquipped: null })));
  if (variants.size > 1) {
    throw new Error(`Mindscape: ${model.name} carries ${hits.length} different "${r}" (${hits.map((h) => h.id).join(", ")}) — pass own:#<id>`);
  }
  const item = hits.find((h) => !isTrue(h.props?.isEquipped)) ?? hits[0];
  return { item, subItems: [], own: true, origin: `${model.name}'s own "${item.name}" [${item.id}]`, warnings: [] };
}

function resolveSource(source, { worldItems = null, model = null } = {}) {
  const text = s(source);
  if (text.startsWith("own:")) return ownSource(model, text.slice("own:".length));
  return text.startsWith("item:") ? worldSource(worldItems, text.slice("item:".length)) : readSpecSource(text);
}

// ── Slots ───────────────────────────────────────────────────────────────────
// What is worn where, the way equipment-swap.js reads it: hand and accessory slots by
// the NAME stamped in the slot prop, armor by its isEquipped flag.
function currentSlotItems(model) {
  const props = model._rawProps ?? {};
  const worn = (model.items ?? []).filter((it) => EQUIP_TYPES.has(typeOf(it)) && isTrue(it.props?.isEquipped));
  const taken = new Set();
  const byName = (name, types) => {
    const want = s(name);
    if (!want) return null;
    const hit = worn.find((it) => !taken.has(it) && types.includes(typeOf(it))
      && (s(it.name) === want || s(it.props?.name) === want)) ?? null;
    if (hit) taken.add(hit);
    return hit;
  };
  return {
    main: byName(props.main_hand, SLOT_TYPES.main),
    off: byName(props.off_hand, SLOT_TYPES.off),
    armor: worn.find((it) => typeOf(it) === "armor") ?? null,
    acc1: byName(props.accessory_name, SLOT_TYPES.acc1),
    acc2: byName(props.accessory2_name, SLOT_TYPES.acc2),
  };
}

// Slot props, mirroring equipment-swap.js applyHandSlot / applyAccSlot. The derived
// twins (weapon1_mod, weapon1_damage) are written too, because the combat model reads
// them and CSB would re-derive them from the base fields on a live sheet.
function writeSlotProps(props, slot, item) {
  const p = item?.props ?? {};
  const name = item ? s(item.name || p.name) : "";
  if (slot === "acc1" || slot === "acc2") {
    props[slot === "acc1" ? "accessory_name" : "accessory2_name"] = name;
    return;
  }
  if (slot === "armor") return;   // armor has no slot prop: isEquipped is its whole state
  const isWeapon = typeOf(item) === "weapon";
  const mod = item ? (isWeapon ? (p.check_bonus ?? 0) : (p.item_def_bonus ?? 0)) : 0;
  const dmg = item ? (isWeapon ? (p.damage_bonus ?? 0) : (p.item_mdef_bonus ?? 0)) : 0;
  if (slot === "main") {
    props.main_hand = name;
    props.main_attrib_1 = item ? (isWeapon ? s(p.rolled_atr1 || "DEX").toUpperCase() : "SHI") : "";
    props.main_attrib_2 = item ? (isWeapon ? s(p.rolled_atr2 || "DEX").toUpperCase() : "SHI") : "";
    props.weapon1_base_mod = mod;
    props.weapon1_mod = Number(mod) || 0;
    props.weapon1_base_damage = dmg;
    props.weapon1_damage = Number(dmg) || 0;
    props.weapon1_damagetype = item ? (isWeapon ? s(p.type_damage || "Physical") : "-") : "-";
  } else {
    props.off_hand = name;
    props.off_attrib_1 = item ? (isWeapon ? s(p.rolled_atr1 || "DEX").toUpperCase() : "SHI") : "";
    props.off_attrib_2 = item ? (isWeapon ? s(p.rolled_atr2 || "DEX").toUpperCase() : "SHI") : "";
    props.off_base_mod_1 = mod;
    props.off_base_mod_2 = dmg;
    props.weapon2_damagetype = item ? (isWeapon ? s(p.type_damage || "Physical") : "-") : "-";
  }
}

function unequip(model, item) {
  // Its granted sub-items STAY on the model. skills.js extractActions gates them off
  // while the parent is unequipped (the live equip gate, Versatile excepted), so putting
  // the item back on — own:<name> — brings them straight back.
  model.items = (model.items ?? [])
    .map((it) => (it === item ? { ...it, props: { ...it.props, isEquipped: false } } : it));
}

function equip(model, item, subItems, { own = false } = {}) {
  if (own) {
    // Already carried: switch it on IN PLACE. Its sub-items never left the model
    // (unequip keeps them), and the equip gate lets them through again.
    let worn = null;
    model.items = (model.items ?? []).map((it) => {
      if (it.id !== item.id) return it;
      worn = { ...it, props: { ...it.props, isEquipped: true } };
      return worn;
    });
    if (!worn) throw new Error(`Mindscape: ${model.name} no longer carries "${item.name}" [${item.id}]`);
    return worn;
  }
  const worn = { ...item, props: { ...item.props, isEquipped: true } };
  model.items = [...(model.items ?? []), worn, ...subItems.map((sub) => ({ ...sub, container: worn.id }))];
  return worn;
}

// ── Set bonuses ─────────────────────────────────────────────────────────────
// Mirrors set-bonus.js reconcileSetBonuses on the in-memory model: count equipped set
// pieces, keep grants whose threshold is still met, drop the rest, add newly met ones.
function reconcileSetBonuses(model, worldItems) {
  if (!worldItems) throw new Error("Mindscape: set bonuses need the world items collection");
  const counts = {};
  for (const it of model.items ?? []) {
    if (it.type && it.type !== "equippableItem") continue;
    const p = it.props ?? {};
    if (!isTrue(p.isEquipped) || !isTrue(p.isSet)) continue;
    const name = s(p.set_name);
    if (!name || name === SET_NAME_EMPTY) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }

  const wantedAe = new Map();
  const wantedSkill = new Map();
  const missing = [];
  for (const { setName, defItem, rows } of worldItems.setDefinitions().values()) {
    const have = counts[setName] ?? 0;
    for (const row of rows) {
      if (have < row.pieces) continue;
      if (row.aeRef) {
        const tag = `${setName}:${row.pieces}:ae`;
        const tpl = worldItems.resolveSetAe(defItem, row.aeRef);
        if (tpl) wantedAe.set(tag, tpl); else missing.push(`${tag} -> AE "${row.aeRef}" not found`);
      }
      if (row.skillRef) {
        const tag = `${setName}:${row.pieces}:skill`;
        const tpl = worldItems.resolveSetSkill(defItem, row.skillRef);
        if (tpl) wantedSkill.set(tag, tpl); else missing.push(`${tag} -> skill "${row.skillRef}" not found`);
      }
    }
  }

  const tagOf = (doc, key) => doc?.flags?.[FLAG_NS]?.[key] ?? null;
  const removed = [];
  const added = [];

  model.actorEffects = (model.actorEffects ?? []).filter((e) => {
    const tag = tagOf(e, "setBonus");
    if (!tag || wantedAe.has(tag)) return true;
    removed.push(`${e.name} (${tag})`);
    return false;
  });
  model.items = (model.items ?? []).filter((it) => {
    const tag = tagOf(it, "setBonusSkill");
    if (!tag || wantedSkill.has(tag)) return true;
    removed.push(`${it.name} (${tag})`);
    return false;
  });

  const haveAe = new Set(model.actorEffects.map((e) => tagOf(e, "setBonus")).filter(Boolean));
  for (const [tag, tpl] of wantedAe) {
    if (haveAe.has(tag)) continue;
    const e = clone(tpl);
    delete e._id;
    e.disabled = false;
    e.transfer = false;   // actor-direct managed effect, as set-bonus.js builds it
    e.flags = { ...(e.flags ?? {}), [FLAG_NS]: { ...(e.flags?.[FLAG_NS] ?? {}), setBonus: tag } };
    model.actorEffects.push(e);
    added.push(`${e.name} (${tag})`);
  }
  const haveSkill = new Set(model.items.map((it) => tagOf(it, "setBonusSkill")).filter(Boolean));
  for (const [tag, tpl] of wantedSkill) {
    if (haveSkill.has(tag)) continue;
    const it = copyWorldItem(tpl);
    it.id = `setbonus:${tag}`;
    it.container = "-";
    it.flags = { ...it.flags, [FLAG_NS]: { ...(it.flags?.[FLAG_NS] ?? {}), setBonusSkill: tag } };
    model.items.push(it);
    added.push(`${it.name} (${tag})`);
  }
  return { counts, removed, added, missing };
}

// ── Rebuild into the combat model ───────────────────────────────────────────
function refreshCombatModel(model, values) {
  const props = model._rawProps;
  for (const [k, v] of Object.entries(values)) props[k] = v;
  props.current_hp = values.max_hp;
  // The same flattening the loader applies to a world actor, so nothing downstream can
  // tell a swapped PC from a loaded one.
  const fresh = toCombatModel({ _id: model.id, name: model.name, items: [], system: { props } });
  for (const k of ["attributes", "hp", "def", "mdef", "affinities", "checkMods", "damageReduction", "extraDamage", "weapon", "statuses"]) {
    model[k] = fresh[k];
  }
  attachWeaponDetails(model);
  model.virtualAttacks = (model.virtualAttacksAll ?? model.virtualAttacks ?? [])
    .filter((v) => virtualAttackAvailable(v, model));
}

function snapshotStats(m) {
  const aff = Object.entries(m.affinities ?? {}).filter(([, v]) => v !== "NE").map(([k, v]) => `${k} ${v}`);
  const cm = m.checkMods ?? {};
  const dr = m.damageReduction ?? {};
  return {
    weapon: m.weapon?.name ? `${m.weapon.name} (+${m.weapon.baseDamage}${m.weapon.checkBonus ? `, +${m.weapon.checkBonus} acc` : ""}, ${m.weapon.family ?? "-"})` : "-",
    dice: `DEX d${m.attributes?.dex} INS d${m.attributes?.ins} MIG d${m.attributes?.mig} WLP d${m.attributes?.wlp}`,
    def: m.def,
    mdef: m.mdef,
    hp: m.hp?.max,
    affinities: aff.length ? aff.join(", ") : "neutral",
    accuracy: `all ${cm.all ?? 0} / acc ${cm.accuracy ?? 0} / melee ${cm.melee ?? 0} / ranged ${cm.ranged ?? 0} / magic ${cm.magic ?? 0}`,
    reduction: `all ${dr.flat ?? 0} / physical ${dr.byElement?.physical ?? 0}`,
    virtualAttacks: (m.virtualAttacks ?? []).map((v) => v.name).join(", ") || "-",
  };
}

// ── The swap ────────────────────────────────────────────────────────────────
function applySwaps(model, swaps, { worldItems = null, requireVerified = true } = {}) {
  if (requireVerified) {
    const v = verifyLoadout(model);
    if (!v.ok) {
      throw new Error(`Mindscape: ${model.name}'s real loadout does not rebuild onto the stored sheet `
        + `(${v.mismatches.map((m) => `${m.key}: stored ${m.stored}, rebuilt ${m.rebuilt}`).join("; ")}) — `
        + `refusing to swap equipment on a model that cannot reproduce the character`);
    }
  }
  if (!worldItems) throw new Error("Mindscape: equipment swaps need the world items collection (set bonuses live there)");

  const before = snapshotStats(model);
  const props = model._rawProps;
  const changes = [];
  const warnings = [];
  const ownsDsb = (model.items ?? []).some((it) => s(it.name) === DUAL_SHIELDBEARER);
  const ordered = [...swaps].sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));

  for (const swap of ordered) {
    const slots = currentSlotItems(model);
    const oldItem = slots[swap.slot];
    const newItem = swap.source?.item ?? null;
    const where = `${model.name}:${swap.slot}`;

    if (newItem) {
      const type = typeOf(newItem);
      if (!SLOT_TYPES[swap.slot].includes(type)) {
        throw new Error(`Mindscape: ${where} — "${newItem.name}" is ${type || "not equipment"}, not ${SLOT_TYPES[swap.slot].join("/")}`);
      }
      if (type === "shield" && swap.slot === "main" && !ownsDsb) {
        throw new Error(`Mindscape: ${where} — shields need ${DUAL_SHIELDBEARER} for the main hand`);
      }
      if (swap.slot === "off" && isTwoHanded(newItem)) {
        throw new Error(`Mindscape: ${where} — "${newItem.name}" is two-handed, main hand only`);
      }
      if (swap.slot === "off" && slots.main && isTwoHanded(slots.main)) {
        throw new Error(`Mindscape: ${where} — ${slots.main.name} is two-handed and holds the off hand`);
      }
    } else if (swap.slot === "main") {
      throw new Error(`Mindscape: ${where} — the main hand cannot be emptied (Unarmed Strike is not modelled)`);
    }

    if (swap.source?.own) {
      // Read the carried copy as it is NOW, not as it was when the source resolved: an
      // earlier swap in this same call may have changed it.
      const carried = (model.items ?? []).find((it) => it.id === newItem.id);
      if (carried && isTrue(carried.props?.isEquipped) && carried.id !== oldItem?.id) {
        throw new Error(`Mindscape: ${where} — "${newItem.name}" is already worn in another slot; unequip it there first`);
      }
    }

    if (oldItem) unequip(model, oldItem);
    if (newItem) {
      equip(model, newItem, swap.source.subItems ?? [], { own: !!swap.source.own });
      if (swap.slot === "main" && isTwoHanded(newItem) && slots.off) {
        unequip(model, slots.off);
        writeSlotProps(props, "off", null);
        changes.push({ slot: "off", from: slots.off.name, to: "- (freed: two-handed main)" });
      }
    }
    writeSlotProps(props, swap.slot, newItem);
    changes.push({ slot: swap.slot, from: oldItem?.name ?? "-", to: newItem?.name ?? "-", origin: swap.source?.origin ?? null });
    warnings.push(...(swap.source?.warnings ?? []));
  }

  const setBonus = reconcileSetBonuses(model, worldItems);
  const { values, report } = rebuildSheet(model);
  refreshCombatModel(model, values);
  return {
    pc: model.name, before, after: snapshotStats(model), changes, setBonus, warnings,
    unresolved: report.unresolved, situational: report.situational,
  };
}

// CLI entry: every --equip / --unequip against the loaded party, grouped per PC.
function applyLoadoutArgs({ equips = [], unequips = [] }, party, { worldItems = null, requireVerified = true } = {}) {
  const perPc = new Map();
  const find = (name, raw) => {
    const hit = party.find((p) => norm(p.name) === norm(name));
    if (!hit) throw new Error(`Mindscape: "${raw}" — no party member named "${name}" (party: ${party.map((p) => p.name).join(", ")})`);
    return hit;
  };
  const add = (model, swap, raw) => {
    if (!perPc.has(model)) perPc.set(model, []);
    const list = perPc.get(model);
    if (list.some((x) => x.slot === swap.slot)) throw new Error(`Mindscape: "${raw}" — ${model.name}:${swap.slot} is already swapped in this run`);
    list.push(swap);
  };
  for (const raw of equips) {
    const a = parseSlotArg(raw);
    const model = find(a.pc, raw);
    // Resolved against the model AS IT IS NOW — after --baseline-gear, if any — so an
    // own:<name> finds the carried item in its current state.
    add(model, { slot: a.slot, source: resolveSource(a.source, { worldItems, model }) }, raw);
  }
  for (const raw of unequips) {
    const a = parseSlotArg(raw, { requireSource: false });
    add(find(a.pc, raw), { slot: a.slot, source: null }, raw);
  }
  const reports = [];
  for (const [model, swaps] of perPc) reports.push(applySwaps(model, swaps, { worldItems, requireVerified }));
  return reports;
}

module.exports = {
  SLOTS, DUAL_SHIELDBEARER,
  parseSlotArg, checkItemSpec, sourceFromDoc, readSpecSource, resolveSource,
  currentSlotItems, reconcileSetBonuses, applySwaps, applyLoadoutArgs, snapshotStats, writeSlotProps,
  standardArmorEffects, standardShieldEffects,
};
