"use strict";
//
// Mindscape — the 0% baseline loadout:  --baseline-gear "all" | "Hina,Zarg"
//
// docs/equipment-balance-design.md prices an item as "% of the wielder's output
// ABOVE the chassis". This builds that chassis for real: every slot of a PC swapped to
// the rulebook BASIC item of the same class, through the same swap engine as --equip
// (lib/loadout-swap.js) — so the round-trip gate, slot legality and set bonuses all
// hold. Run it next to the real loadout on the same seed and the difference is what the
// character's gear is worth; add one --equip on top and you measure a single item
// against basic gear.
//
// Mapping — the user's ruling of 2026-09-13, "same class, use basic equipment". It
// keeps equipment-conditional skills behaving as in real play (Dodge stays on, Twin
// Shields keeps two shields, Magical Artillery keeps an arcane weapon):
//   weapon    basic weapon of the SAME category; same hand count first, then the most
//             rolled attributes in common, then name. No same-hand basic -> the
//             closest one converted with the rulebook's free rule (2H->1H -4 damage,
//             1H->2H +4), so a one-handed Arcane becomes a one-handed Staff at +2.
//   shield    Bronze Shield, or Runic Shield if the worn shield is martial.
//   armor     a worn armor that IS a basic item keeps its +0 version (Combat Tunic);
//             otherwise martial -> Brigadine (the WORLD's spelling), else Travel Garb.
//   accessory emptied.
//
// Basic items are found the way character creation finds them (cc-step-equipment.js):
// by an ancestor folder named "Basic Weapon" / "Basic Armor" / "Basic Shield".

const { withCollection } = require("../../safe-edit/lib/db");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");
const { currentSlotItems, applySwaps } = require("./loadout-swap");
const { isContained } = require("./world-items");

const BASIC_FOLDERS = Object.freeze({ "Basic Weapon": "weapon", "Basic Armor": "armor", "Basic Shield": "shield" });

// In the Basic folders but NOT rulebook basics: house additions and special cases
// (docs/equipment-balance-design.md, "house additions"), plus Bronze/Steel Plate, whose
// stored DEF shape looks wrong (ordinary-armor bonus of 11/12 on top of the DEX die).
const EXCLUDED = Object.freeze(new Set([
  "Longsword", "Magicannon", "Twin Shield", "Improvised (Melee)", "Improvised (Ranged)",
  "Unarmed Strike", "Twin Runic Shield", "Bronze Plate", "Steel Plate", "No Armor",
]));

const ARMOR_BASELINE = Object.freeze({ martial: "Brigadine", plain: "Travel Garb" });
const SHIELD_BASELINE = Object.freeze({ martial: "Runic Shield", plain: "Bronze Shield" });

function s(v) { return String(v ?? "").trim(); }
function norm(v) { return s(v).toLowerCase(); }
function isTrue(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
// "+4 Combat Tunic" -> "Combat Tunic": the refinement prefix refinement-core.js writes.
function baseName(name) { return s(name).replace(/^\+\d+\s+/, ""); }

async function loadWorldFolders({ world = DEFAULT_WORLD } = {}) {
  return withCollection("folders", world, async (db) => {
    const byId = new Map();
    for await (const [key, value] of db.iterator()) {
      if (!key.startsWith("!folders!") || !value?._id) continue;
      byId.set(value._id, { id: value._id, name: s(value.name), parent: value.folder ?? null, type: value.type ?? null });
    }
    return byId;
  });
}

function basicCatalogue(worldItems, folders) {
  const kindOf = (folderId) => {
    const seen = new Set();
    let cur = folders.get(folderId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (BASIC_FOLDERS[cur.name]) return BASIC_FOLDERS[cur.name];
      cur = folders.get(cur.parent);
    }
    return null;
  };
  const catalogue = { weapon: [], armor: [], shield: [] };
  for (const it of worldItems.all()) {
    if (it.type !== "equippableItem" || isContained(it) || EXCLUDED.has(it.name)) continue;
    const kind = kindOf(it.folder);
    // The folder and the item's own type must agree; a stray document is not a basic.
    if (!kind || norm(it.props.item_type) !== kind) continue;
    catalogue[kind].push(it);
  }
  return catalogue;
}

function handsOf(item) { return norm(item.props.hand_slots).includes("two") ? "two" : "one"; }

function sharedAttributes(worn, candidate) {
  const pool = [norm(candidate.props.rolled_atr1), norm(candidate.props.rolled_atr2)];
  let shared = 0;
  for (const a of [norm(worn.props.rolled_atr1), norm(worn.props.rolled_atr2)]) {
    const i = pool.indexOf(a);
    if (i >= 0) { shared++; pool.splice(i, 1); }
  }
  return shared;
}

function weaponBaseline(worn, catalogue) {
  const category = s(worn.props.category);
  const candidates = catalogue.weapon.filter((w) => norm(w.props.category) === norm(category));
  if (!candidates.length) {
    throw new Error(`Mindscape: no basic ${category || "(no category)"} weapon in the world's Basic Weapon folder — cannot baseline "${worn.name}"`);
  }
  const ranked = (list) => [...list].sort((a, b) =>
    sharedAttributes(worn, b) - sharedAttributes(worn, a) || a.name.localeCompare(b.name));

  const sameHands = ranked(candidates.filter((c) => handsOf(c) === handsOf(worn)));
  if (sameHands.length) return { item: sameHands[0], note: null };

  const base = ranked(candidates)[0];
  const hands = handsOf(worn);
  const delta = hands === "one" ? -4 : 4;
  const damage = Math.max(0, (Number(base.props.damage_bonus) || 0) + delta);
  const name = `${base.name} (${hands}-handed)`;
  return {
    item: {
      ...base,
      id: `baseline:${base.id}:${hands}`,
      name,
      props: { ...base.props, name, damage_bonus: String(damage), hand_slots: hands === "one" ? "One-handed" : "Two-handed" },
    },
    note: `no ${hands}-handed basic ${category}: ${base.name} converted with the free ${hands === "one" ? "2H->1H" : "1H->2H"} rule (${delta > 0 ? "+" : ""}${delta} damage)`,
  };
}

function pick(list, name, kind) {
  const hit = list.find((it) => it.name === name);
  if (!hit) throw new Error(`Mindscape: basic ${kind} "${name}" is not in the world's Basic ${kind[0].toUpperCase()}${kind.slice(1)} folder`);
  return hit;
}

function sourceOf(item, note = null) {
  return {
    item: { id: item.id, name: item.name, type: item.type, props: { ...item.props }, flags: clone(item.flags ?? {}), container: null, effects: clone(item.effects ?? []) },
    subItems: [],
    origin: `baseline: basic ${norm(item.props.item_type)} "${item.name}"`,
    warnings: note ? [note] : [],
  };
}

function baselineSwapsFor(model, catalogue) {
  const slots = currentSlotItems(model);
  const swaps = [];

  for (const slot of ["main", "off"]) {
    const worn = slots[slot];
    if (!worn) continue;
    if (norm(worn.props.item_type) === "shield") {
      swaps.push({ slot, source: sourceOf(pick(catalogue.shield, SHIELD_BASELINE[isTrue(worn.props.isMartial) ? "martial" : "plain"], "shield")) });
    } else {
      const { item, note } = weaponBaseline(worn, catalogue);
      swaps.push({ slot, source: sourceOf(item, note) });
    }
  }

  if (slots.armor) {
    const own = catalogue.armor.find((a) => a.name === baseName(slots.armor.name));
    const target = own ?? pick(catalogue.armor, ARMOR_BASELINE[isTrue(slots.armor.props.isMartial) ? "martial" : "plain"], "armor");
    swaps.push({ slot: "armor", source: sourceOf(target, own ? `${slots.armor.name} is itself basic: its +0 version` : null) });
  }

  for (const slot of ["acc1", "acc2"]) {
    if (slots[slot]) swaps.push({ slot, source: null });
  }
  return swaps;
}

// `names`: null/["all"] for the whole party, else PC names.
function applyBaselineGear(party, { names = null, worldItems, folders, requireVerified = true } = {}) {
  if (!worldItems || !folders) throw new Error("Mindscape: --baseline-gear needs the world items and folders collections");
  const catalogue = basicCatalogue(worldItems, folders);
  const wanted = names && !(names.length === 1 && norm(names[0]) === "all") ? names.map(norm) : null;
  for (const n of wanted ?? []) {
    if (!party.some((p) => norm(p.name) === n)) {
      throw new Error(`Mindscape: --baseline-gear — no party member named "${n}" (party: ${party.map((p) => p.name).join(", ")})`);
    }
  }
  const reports = [];
  for (const model of party) {
    if (wanted && !wanted.includes(norm(model.name))) continue;
    const report = applySwaps(model, baselineSwapsFor(model, catalogue), { worldItems, requireVerified });
    report.baseline = true;
    reports.push(report);
  }
  return reports;
}

module.exports = {
  BASIC_FOLDERS, EXCLUDED, ARMOR_BASELINE, SHIELD_BASELINE,
  loadWorldFolders, basicCatalogue, weaponBaseline, baselineSwapsFor, applyBaselineGear, baseName,
};
