"use strict";
//
// Mindscape — synthetic enemies from a JSON spec.
//
// WHY THIS EXISTS
// `--enemies` resolves names out of the world LevelDB, so a monster could only
// be measured AFTER it had been built in the world. That is backwards: the
// cheapest moment to find out a fight is wrong is while it is still a design
// document. This loads a paper monster instead.
//
// THE ONE RULE: it must go through `toCombatModel`, the same function the world
// loader uses. A spec file is a Foundry actor document with the same
// `system.props` keys — NOT a bespoke schema. If a spec could describe a
// creature the world could not hold, the tool would be measuring something that
// can never exist, which is the failure mode Mindscape is built to refuse.
//
// Shape (one object, or an array of them):
//
//   {
//     "name": "Rakshasa",
//     "system": { "props": { "level": "40", "npc_rank": "elite",
//                            "activation": "4", "max_hp": "840", ... } },
//     "items": [ { "name": "Execute", "props": { "skill_type": "Attack", ... } } ]
//   }
//
// `items` holds EMBEDDED documents here, unlike a real actor document (whose
// `items` array is ID strings resolved from a separate keyspace). That is the
// one intentional divergence, and it is why this module attaches them itself
// rather than reusing loadAll's resolution pass.

const fs = require("fs");
const path = require("path");
const { toCombatModel, WEAPON_FAMILIES } = require("./load-actors");

// Mindscape-only props, namespaced so they can never collide with a CSB column
// and so a reader can tell at a glance which fields are modelling scaffolding
// rather than sheet data. Documented in docs/mindscape-ruleset.md Part 8.
const MS_PREFIX = "mindscape_";

function readSpecFile(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    throw new Error(`Mindscape: cannot read enemy file "${abs}": ${e.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Mindscape: enemy file "${abs}" is not valid JSON: ${e.message}`);
  }
  return { abs, docs: Array.isArray(json) ? json : [json] };
}

// Structural checks BEFORE the model is built. These are deliberately loud and
// early: a spec missing `max_hp` would otherwise reach validate() as a generic
// "no stored max_hp" and read like a world-data problem rather than a typo in a
// file the author is actively editing.
function checkSpec(doc, i, abs) {
  const where = `${path.basename(abs)}[${i}]`;
  const problems = [];
  if (!doc || typeof doc !== "object") return [`${where}: not an object`];
  if (!String(doc.name ?? "").trim()) problems.push(`${where}: missing "name"`);

  const props = doc?.system?.props;
  if (!props || typeof props !== "object") {
    problems.push(`${where}: missing "system.props" — a spec is an actor document, not a flat stat block`);
    return problems;
  }
  // isNpc() keys off these two; without one the spec loads as a PLAYER and is
  // silently skipped by every enemy-side code path.
  if (!String(props.npc_rank ?? "").trim() && !String(props.species ?? "").trim()) {
    problems.push(`${where}: needs "npc_rank" or "species" — otherwise it models as a player character`);
  }
  if (props.max_hp == null) problems.push(`${where}: missing "max_hp" (never derived — see the refusal policy)`);

  for (const item of doc.items ?? []) {
    if (!String(item?.name ?? "").trim()) problems.push(`${where}: an item is missing "name"`);
    if (item && !item.props && !item.system?.props) {
      problems.push(`${where}: item "${item.name}" has neither "props" nor "system.props"`);
    }
  }
  return problems;
}

// Accept both the embedded shape (`{name, props}`) and a full Foundry item
// document (`{name, system:{props}}`) so a spec can be pasted straight out of an
// authored export without reshaping.
function normalizeItem(item, idx) {
  const props = item.props ?? item.system?.props ?? {};
  return {
    id: String(item.id ?? item._id ?? `spec-item-${idx}`),
    name: String(item.name),
    type: item.type ?? null,
    props,
  };
}

// Mirror loadAll's weapon-family resolution for a spec that gives its monster an
// equipped weapon. Monsters rarely do, but the field exists and a silent null
// here would disable the efficiency axis exactly as it does in the world path.
function attachWeaponFamily(model) {
  const w = model.weapon;
  if (!w?.name) return;
  const item = model.items.find((i) => i.name === w.name);
  const cat = String(item?.props?.category ?? "").trim().toLowerCase();
  if (cat && WEAPON_FAMILIES.includes(cat)) w.family = cat;
  w.itemType = String(item?.props?.item_type ?? "").trim().toLowerCase() || null;
  w.range = /ranged/i.test(String(item?.props?.weapon_range ?? "")) ? "ranged" : "melee";
}

// Load every enemy declared across one or more spec files.
// Returns combat models indistinguishable from world-loaded ones, except for
// `fromSpec` — which exists so the CLI can SAY the fight is against paper.
function loadEnemyFiles(files) {
  const out = [];
  const problems = [];

  for (const file of files) {
    const { abs, docs } = readSpecFile(file);
    docs.forEach((doc, i) => {
      const bad = checkSpec(doc, i, abs);
      if (bad.length) { problems.push(...bad); return; }

      const model = toCombatModel({
        _id: doc._id ?? `spec-${path.basename(abs, ".json")}-${i}`,
        name: doc.name,
        system: doc.system,
        items: [],                       // resolved below, not from the ID keyspace
      });
      model.items = (doc.items ?? []).map(normalizeItem);
      attachWeaponFamily(model);
      model.fromSpec = abs;
      out.push(model);
    });
  }

  if (problems.length) {
    throw new Error(`Mindscape: enemy spec is not loadable:\n  · ${problems.join("\n  · ")}`);
  }
  return out;
}

module.exports = { loadEnemyFiles, MS_PREFIX };
