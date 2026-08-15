"use strict";

/**
 * suite: refs — "does anything point at something that no longer exists?"
 *
 * The silent class of world-import damage: a token still references an actor
 * that got dropped, a scene note points at a deleted journal entry, a folder's
 * parent vanished. None of these show up as a document removal in a diff — the
 * pointer survives, its target doesn't. At the table this is a broken token or
 * a dead link you only notice mid-session.
 */

const { SEVERITY, finding } = require("../util");

const ID = "refs";
const TITLE = "Broken references (dangling pointers)";

function run(world) {
  const out = [];

  // --- token -> actor -----------------------------------------------------
  // A placed token whose actorId is gone is a broken token: no sheet, no data.
  for (const scene of world.scenes) {
    for (const tok of scene.tokens || []) {
      if (!tok.actorId) continue; // unlinked/synthetic token — nothing to resolve
      if (!world.has("actors", tok.actorId)) {
        out.push(finding(ID, SEVERITY.FAIL,
          `Scene "${scene.name}": token "${tok.name || tok._id}" references missing actor ${tok.actorId}`,
          { doc: "scene", id: scene._id, extra: tok.actorId }));
      }
    }
  }

  // --- scene note -> journal entry ---------------------------------------
  for (const scene of world.scenes) {
    for (const note of scene.notes || []) {
      if (note.entryId && !world.has("journal", note.entryId)) {
        out.push(finding(ID, SEVERITY.FAIL,
          `Scene "${scene.name}": map note references missing journal entry ${note.entryId}`,
          { doc: "scene", id: scene._id, extra: note.entryId }));
      }
    }
  }

  // --- sheet action row -> embedded item ----------------------------------
  // The four NPC sheet lists the Monster Encyclopedia renders each store a
  // `uuid` pointing at the actor's own embedded copy of the skill. When that
  // pointer goes stale (a re-grant assigns a new _id, a world-import upserts a
  // duplicate) the row still renders on the sheet, so nothing looks wrong —
  // but the encyclopedia can never reveal it. Witnessing keys off the FIRED
  // item's id, which no longer equals the row's, so the entry is pinned at
  // "???" for the rest of the campaign. Invisible until a player complains.
  //
  // WARN, not FAIL: a stale row is a degraded reveal, not a broken session,
  // and there is a standing backlog of them.
  const ACTION_LISTS = ["attack_list", "skill_active_list", "normal_spell_list", "skill_passive_list"];
  for (const actor of world.actors || []) {
    const embeddedIds = new Set((actor.items || []).map((it) => it._id));
    if (!embeddedIds.size) continue;
    const props = (actor.system && actor.system.props) || {};
    for (const listKey of ACTION_LISTS) {
      const list = props[listKey];
      if (!list || typeof list !== "object") continue;
      for (const row of Object.values(list)) {
        if (!row || row.$deleted) continue;
        const uuid = String(row.uuid || "").trim();
        if (!uuid) continue; // legacy row with no pointer — always rendered
        const id = uuid.split(".").pop();
        if (!id || embeddedIds.has(id)) continue;
        out.push(finding(ID, SEVERITY.WARN,
          `actor "${actor.name}": ${listKey} row "${row.name || id}" points at missing embedded item ${id} (can never be revealed in the encyclopedia)`,
          { doc: "actors", id: actor._id, extra: id }));
      }
    }
  }

  // --- folder -> parent folder -------------------------------------------
  // A dangling parent orphans a whole folder subtree in the sidebar.
  for (const c of ["actors", "items", "journal"]) {
    for (const doc of world[c] || []) {
      const parent = doc.folder;
      if (parent && !world.has("folders", parent)) {
        out.push(finding(ID, SEVERITY.WARN,
          `${c.slice(0, -1)} "${doc.name}" sits in missing folder ${parent}`,
          { doc: c, id: doc._id, extra: parent }));
      }
    }
  }

  return out;
}

module.exports = { id: ID, title: TITLE, run };
