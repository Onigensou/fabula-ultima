"use strict";
//
// Mindscape — read-only access to the world's `items` collection.
//
// What a full-loadout swap needs from outside the party actors:
//   • equipment by name        — `--equip "Zarg:acc1=item:Ruby Pendant"`
//   • contained sub-items      — a weapon's gear skills live as separate world
//                                items whose `system.container` is the weapon's id
//   • Equipment Set definitions — set bonuses are data, not code (set-bonus.js)
//   • effect libraries          — a set bonus names an AE ("Wet") resolved from the
//                                set's own effects, then `activeEffectContainer` items
//
// Keyspace (same convention as actors): `!items!<id>` for the document and
// `!items.effects!<itemId>.<effectId>` for each of its Active Effects. The inline
// `effects` array on a stored item is not trusted — see the Fafnir notes in
// tools/safe-edit/bin/world-export.js.
//
// The game must be CLOSED. Opening the store rotates its MANIFEST (content-neutral).

const { withCollection } = require("../../safe-edit/lib/db");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");

const ITEM_KEY = /^!items!([^!.]+)$/;
const ITEM_EFFECT_KEY = /^!items\.effects!([^!.]+)\.([^!.]+)$/;

// CSB empty sentinels (set-bonus.js).
const SET_NAME_EMPTY = "<Set Name>";
const CONTAINER_EMPTY = "-";

function s(v) { return String(v ?? "").trim(); }

function toItem(id, doc) {
  return {
    id,
    name: s(doc.name),
    type: doc.type ?? null,
    props: doc.system?.props ?? {},
    flags: doc.flags ?? {},
    container: doc.system?.container ?? null,
    folder: doc.folder ?? null,
    effects: [],
  };
}

function isContained(item) {
  const c = s(item?.container);
  return !!c && c !== CONTAINER_EMPTY;
}

// A CSB dynamicTable is an object keyed by row index, or occasionally an array.
function tableRows(value) {
  if (!value || typeof value !== "object") return [];
  const raw = Array.isArray(value) ? value : Object.values(value);
  return raw.filter((r) => r && typeof r === "object" && r.$deleted !== true);
}

class WorldItems {
  constructor(byId) {
    this.byId = byId instanceof Map ? byId : new Map(byId);
  }

  all() { return [...this.byId.values()]; }

  get(id) { return this.byId.get(id) ?? null; }

  // Top-level equipment by exact name (case-insensitive). Refuses a miss AND an
  // ambiguity: silently taking the first of two "Bronze Shield" documents would
  // measure whichever one LevelDB happened to list first.
  equipmentByName(name) {
    const want = s(name).toLowerCase();
    const hits = this.all().filter((it) =>
      it.type === "equippableItem" && !isContained(it) && it.name.toLowerCase() === want);
    if (!hits.length) throw new Error(`Mindscape: no world item named "${name}"`);
    if (hits.length > 1) {
      throw new Error(`Mindscape: ${hits.length} world items are named "${name}" `
        + `(${hits.map((h) => h.id).join(", ")}) — pass "item:#<id>" to pick one`);
    }
    return hits[0];
  }

  // Sub-items carried by an item (gear skills, granted spells).
  contained(parentId) {
    return this.all().filter((it) => s(it.container) === parentId);
  }

  // set_name -> { setName, defItem, rows:[{ pieces, label, aeRef, skillRef }] }.
  // Mirrors set-bonus.js getEquipmentSets: first definition wins on a duplicate.
  setDefinitions() {
    const defs = new Map();
    for (const it of this.all()) {
      const rows = tableRows(it.props.set_bonus_table)
        .map((r) => ({
          pieces: Number(r.pieces),
          label: s(r.bonus_label),
          aeRef: s(r.bonus_ae_ref),
          skillRef: s(r.bonus_skill_ref),
        }))
        .filter((r) => Number.isFinite(r.pieces) && r.pieces > 0 && (r.aeRef || r.skillRef));
      if (!rows.length) continue;
      const setName = s(it.props.set_name);
      if (!setName || setName === SET_NAME_EMPTY || defs.has(setName)) continue;
      defs.set(setName, { setName, defItem: it, rows });
    }
    return defs;
  }

  // A set bonus's AE: the definition's own effects first, then any effect library.
  resolveSetAe(defItem, ref) {
    if (!ref) return null;
    for (const e of defItem.effects ?? []) {
      if (e.name === ref || e._id === ref) return e;
    }
    for (const it of this.all()) {
      if (it.type !== "activeEffectContainer") continue;
      for (const e of it.effects ?? []) if (e.name === ref) return e;
    }
    return null;
  }

  // A set bonus's skill: a world item contained by the definition, by name.
  resolveSetSkill(defItem, ref) {
    if (!ref) return null;
    return this.all().find((it) => it.id !== defItem.id && s(it.container) === defItem.id && it.name === ref) ?? null;
  }
}

async function loadWorldItems({ world = DEFAULT_WORLD } = {}) {
  return withCollection("items", world, async (db) => {
    const byId = new Map();
    const effects = new Map();
    for await (const [key, value] of db.iterator()) {
      const i = ITEM_KEY.exec(key);
      if (i && value) { byId.set(i[1], toItem(i[1], value)); continue; }
      const e = ITEM_EFFECT_KEY.exec(key);
      if (e && value) {
        if (!effects.has(e[1])) effects.set(e[1], []);
        effects.get(e[1]).push(value);
      }
    }
    for (const [id, list] of effects) {
      const item = byId.get(id);
      if (item) item.effects = list;
    }
    return new WorldItems(byId);
  });
}

module.exports = { WorldItems, loadWorldItems, isContained, tableRows, SET_NAME_EMPTY, CONTAINER_EMPTY };
