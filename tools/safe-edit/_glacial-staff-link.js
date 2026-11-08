// 2026-11-08 bug list #14: give the world Glacial Staff master (FRwmrAhwe8xSLEXZ) its linked
// Icicle Lance _skill, cloned from Zarg's play-verified copy (N0t2sdZ4XEqQFtzv, container = his staff).
"use strict";
const { getDoc, newDocId } = require("./lib/edit");
const { openCollection } = require("./lib/db");
const { assertGameClosed } = require("./lib/lock");
(async () => {
  assertGameClosed();
  const DRY = process.argv.includes("--dry");
  const SHELL = "FRwmrAhwe8xSLEXZ", EMBED_FOLDER = "ft3358qUh5ZDldYQ";
  const src = await getDoc("Actor.Z4CFy505cD3nzl1W.Item.N0t2sdZ4XEqQFtzv");
  const lib = await getDoc("Item.G1jgccyBZOYYynCv");      // a world spell: ownership shape
  const shell = await getDoc(`Item.${SHELL}`);
  if (!src || !shell) throw new Error("source or shell missing");
  const db = await openCollection("items");
  try {
    // Idempotent: an existing linked Icicle Lance on this shell wins.
    for await (const [k, v] of db.iterator()) {
      if (k.startsWith("!items!") && v?.system?.container === SHELL && v?.name === "Icicle Lance") { console.log("already linked:", k); return; }
    }
    const id = newDocId();
    const doc = JSON.parse(JSON.stringify(src));
    doc._id = id;
    doc.folder = EMBED_FOLDER;
    doc.system.container = SHELL;
    doc.system.uniqueId = id;
    doc.effects = [];
    doc.ownership = JSON.parse(JSON.stringify(lib?.ownership ?? { default: 0 }));
    doc.sort = 0;
    const now = Date.now();
    doc._stats = { ...(doc._stats || {}), createdTime: now, modifiedTime: now, lastModifiedBy: doc._stats?.lastModifiedBy ?? null };
    console.log(JSON.stringify({ newKey: `!items!${id}`, name: doc.name, container: doc.system.container, folder: doc.folder, tpl: doc.system.template, effectsDropped: (src.effects ?? []).length, props: Object.keys(doc.system.props).length }, null, 1));
    if (!DRY) await db.put(`!items!${id}`, doc);
  } finally { await db.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
