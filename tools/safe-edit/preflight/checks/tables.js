"use strict";

/**
 * suite: tables — RollTable result rows that point at a document must resolve.
 *
 * Your dungeon roulette (The Wyrmwood - Treasure/Encounter/Enemies/…) is a set
 * of RollTables whose result rows reference world Items/Actors. If a referenced
 * item/actor is dropped or an import reverts it, the table still "rolls" but
 * hands out a broken/blank result at the table. A deleted whole table is caught
 * by world-export; this catches the silent within-table dangling reference.
 *
 * Compendium-pack references (documentCollection contains a ".") can't be
 * resolved offline and are skipped.
 */

const { SEVERITY, finding } = require("../util");
const { DOC_TYPE_TO_COLLECTION } = require("../../lib/keys");

const ID = "tables";
const TITLE = "RollTable result references";

function run(world) {
  const out = [];
  for (const table of world.tables || []) {
    for (const res of table.results || []) {
      const dc = res.documentCollection;
      const id = res.documentId;
      if (!dc || !id) continue;                 // plain text result — nothing to resolve
      if (String(dc).includes(".")) continue;   // compendium pack — can't resolve offline
      const coll = DOC_TYPE_TO_COLLECTION[dc];
      if (!coll || !world.byId[coll]) continue;  // not a world collection we loaded
      if (!world.has(coll, id)) {
        out.push(finding(ID, SEVERITY.FAIL,
          `Table "${table.name}": result "${res.text || id}" → missing ${dc} ${id}`,
          { doc: "tables", id: table._id, extra: id }));
      }
    }
  }
  return out;
}

module.exports = { id: ID, title: TITLE, run };
