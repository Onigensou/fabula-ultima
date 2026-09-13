"use strict";
//
// Mindscape — paper equipment from a JSON spec:  --equip "<PC>=<file>"
//
// WHY THIS EXISTS
// docs/equipment-balance-design.md prices a weapon on paper; this measures it.
// It swaps ONE party member's main-hand weapon for a spec item, IN MEMORY. The
// world is never written and the character's real loadout is untouched. That is
// a hard requirement, not a convenience: equipping a test item on a real actor
// changes a player's sheet, and a token-only change reverts on the next spawn.
//
// THE SHAPE is a Foundry item document with the same `system.props` keys an
// equipment item carries — pasteable from _authored-export/items/<id>.json —
// plus optional embedded `items`: the gear-skill sub-items a real weapon holds
// as contained documents. A gear skill whose NAME is in the reaction registry is
// modelled; any other is reported as an undeclared passive, exactly as it would
// be on a world actor.
//
//   {
//     "name": "Explosion Whip",
//     "system": { "props": { "item_type": "weapon", "category": "Flail",
//       "damage_bonus": "8", "check_bonus": "0", "type_damage": "Fire",
//       "rolled_atr1": "DEX", "rolled_atr2": "DEX", "weapon_range": "Melee" } },
//     "items": [ { "name": "Explosion Whip (Passive)",
//                  "props": { "skill_type": "Passive" } } ]
//   }
//
// Only the main hand is modelled. The displaced weapon stays in the item list —
// its own passives were never weapon riders in the model — and the swap is
// announced by the CLI so a verdict about paper gear can never pass as one about
// the character's real kit.

const fs = require("fs");
const path = require("path");
const { WEAPON_FAMILIES } = require("./load-actors");

const ATTRS = new Set(["DEX", "INS", "MIG", "WLP"]);

function s(v) { return String(v ?? "").trim(); }

// "Zarg=specs/equipment/explosion-whip.json" -> { pc, file }. Split on the FIRST
// "=" so a path containing one still works.
function parseEquipArg(raw) {
  const text = s(raw);
  const at = text.indexOf("=");
  if (at <= 0 || at === text.length - 1) {
    throw new Error(`Mindscape: bad --equip "${raw}" (want "<PC name>=<item.json>")`);
  }
  return { pc: text.slice(0, at).trim(), file: text.slice(at + 1).trim() };
}

function readEquipFile(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    throw new Error(`Mindscape: cannot read equipment file "${abs}": ${e.message}`);
  }
  try {
    return { abs, doc: JSON.parse(raw) };
  } catch (e) {
    throw new Error(`Mindscape: equipment file "${abs}" is not valid JSON: ${e.message}`);
  }
}

// Structural checks, loud and early. The refusals are the point: a weapon the
// engine cannot swing would otherwise read as "this item adds nothing", which
// is a plausible-looking wrong answer of exactly the kind this tool must not give.
function checkEquipSpec(doc, where = "equipment spec") {
  const problems = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [`${where}: must be ONE item object`];
  if (!s(doc.name)) problems.push(`${where}: missing "name"`);

  const p = doc?.system?.props;
  if (!p || typeof p !== "object") {
    problems.push(`${where}: missing "system.props" — a spec is an item document, not a flat stat block`);
    return problems;
  }
  if (s(p.item_type).toLowerCase() !== "weapon") {
    problems.push(`${where}: item_type must be "weapon" (got "${s(p.item_type)}") — only a main-hand swap is modelled`);
  }
  const fam = s(p.category).toLowerCase();
  if (!WEAPON_FAMILIES.includes(fam)) {
    problems.push(`${where}: category "${s(p.category)}" is not a weapon family (${WEAPON_FAMILIES.join(", ")})`);
  }
  for (const k of ["rolled_atr1", "rolled_atr2"]) {
    if (!ATTRS.has(s(p[k]).toUpperCase())) problems.push(`${where}: ${k} "${s(p[k])}" must be DEX, INS, MIG or WLP`);
  }
  // A formula would need actor state. Refused rather than zeroed: `Number(x) || 0`
  // once silently zeroed four party skills while reporting them as modelled.
  const dmg = s(p.damage_bonus);
  if (!dmg || !Number.isFinite(Number(dmg))) {
    problems.push(`${where}: damage_bonus "${dmg}" must be a plain number`);
  } else if (!(Number(dmg) > 0)) {
    // weaponAction treats a non-positive bonus as "no weapon", so the character
    // would silently stop attacking.
    problems.push(`${where}: damage_bonus must be above 0 (got ${dmg})`);
  }
  const chk = s(p.check_bonus);
  if (chk && !Number.isFinite(Number(chk))) problems.push(`${where}: check_bonus "${chk}" must be a plain number`);
  if (!s(p.type_damage)) problems.push(`${where}: missing "type_damage"`);

  for (const item of doc.items ?? []) {
    if (!s(item?.name)) problems.push(`${where}: a gear-skill item is missing "name"`);
    else if (!item.props && !item.system?.props) {
      problems.push(`${where}: gear-skill item "${item.name}" has neither "props" nor "system.props"`);
    }
  }
  return problems;
}

function normalizeItem(item, idx, prefix) {
  return {
    id: String(item.id ?? item._id ?? `${prefix}-${idx}`),
    name: String(item.name),
    type: item.type ?? null,
    props: item.props ?? item.system?.props ?? {},
  };
}

// Mutates the loaded model in place — it is a per-invocation copy read out of
// LevelDB, never written back. Returns what was swapped, for the CLI banner.
function applyEquip(model, doc, file = null) {
  const p = doc.system.props;
  const displaced = model.weapon?.name ?? null;
  const name = s(doc.name);

  // Same fields toCombatModel + loadAll build for a world weapon, so everything
  // downstream (weaponAction, checkBonusFor's melee/ranged split, the EF axis,
  // resolveWeaponFamily for Attack skills) reads the paper weapon unchanged.
  model.weapon = {
    name,
    baseDamage: Number(p.damage_bonus),
    baseMod: 0,
    element: s(p.type_damage),
    attrA: s(p.rolled_atr1).toUpperCase(),
    attrB: s(p.rolled_atr2).toUpperCase(),
    family: s(p.category).toLowerCase(),
    itemType: "weapon",
    range: /ranged/i.test(s(p.weapon_range)) ? "ranged" : "melee",
    checkBonus: Number(p.check_bonus) || 0,
  };

  const prefix = `equip-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  model.items = [
    ...(model.items ?? []),
    normalizeItem({ ...doc, props: p }, 0, prefix),
    ...(doc.items ?? []).map((it, i) => normalizeItem(it, i + 1, prefix)),
  ];

  model.equippedFromSpec = { pc: model.name, item: name, file, displaced };
  return model.equippedFromSpec;
}

// Resolve every --equip against the loaded party. Throws — naming the party —
// on a PC that is not in it: a swap that silently matched nobody would measure
// the unchanged kit and report it as the item.
function applyEquipFiles(args, party) {
  const applied = [];
  const problems = [];
  const seen = new Set();

  for (const raw of args) {
    const { pc, file } = parseEquipArg(raw);
    const model = party.find((m) => s(m.name).toLowerCase() === pc.toLowerCase());
    if (!model) {
      problems.push(`--equip "${raw}": no party member named "${pc}" (party: ${party.map((m) => m.name).join(", ")})`);
      continue;
    }
    if (seen.has(model)) {
      problems.push(`--equip "${raw}": ${model.name} already has a paper weapon — one main hand per PC`);
      continue;
    }
    const { abs, doc } = readEquipFile(file);
    const bad = checkEquipSpec(doc, path.basename(abs));
    if (bad.length) { problems.push(...bad); continue; }
    seen.add(model);
    applied.push(applyEquip(model, doc, abs));
  }

  if (problems.length) {
    throw new Error(`Mindscape: equipment spec is not loadable:\n  · ${problems.join("\n  · ")}`);
  }
  return applied;
}

module.exports = { parseEquipArg, checkEquipSpec, applyEquip, applyEquipFiles };
