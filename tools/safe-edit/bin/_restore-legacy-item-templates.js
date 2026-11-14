// Restore the 8 legacy CSB item templates (user, 2026-11-14).
//
// 313 items on 32 legacy characters (Yuri, St. Reefesia, Fjord, Cradle, Juno, Gwyn, Cherry, …) point at item
// templates that were deleted from this world. CSB's TemplateSystem.getModifiers() then calls
// ui.notifications.warn("Item template has been deleted …") — which throws while the game is still loading
// (ui.notifications is not built yet), so each of those characters fails data preparation on every load, and
// after load the warning pops up as a toast on every refresh.
//
// The templates still exist, with the same ids, in the archive world (fabula-ultima-2-archive). This copies them
// back unchanged except: a new folder "Legacy Templates (do not use)", and names prefixed "_Legacy · " so nobody
// builds new items on them (items find their template by id, so the names are free to change). All 8 carry ZERO
// modifiers, so no character's numbers change: CSB skips a missing template today and adds nothing from these.
//
// Run from tools/safe-edit, game CLOSED; --apply to write. Idempotent: a second run reports 0 writes.
const { openCollection } = require("../lib/db");
const { run } = require("./_fafnir-util");

const ARCHIVE = "fabula-ultima-2-archive";
const IDS = ["gIRU9XGqYeMBwBN9", "xdZPhVF8AnmwQEPM", "FZmpKcQRP7hZQqbV", "r0yZpLPAK9VXhM2p", "VJCHYWOx1mPsMSip", "5Z0gKtN5R51ebJOa", "tJixj9vNEQd3F0IO", "lUpHsEfBDEY3BeNq"];
const FOLDER = "LegacyTemplates0";
const FOLDER_NAME = "Legacy Templates (do not use)";
const GM = "JQGNzKpDPHJmcUIW";

async function readAll(collection, world) {
  const db = await openCollection(collection, world);
  const out = new Map();
  try { for await (const [key, doc] of db.iterator()) out.set(key, doc); } finally { await db.close(); }
  return out;
}

(async () => {
  const now = Date.now();
  // 1) the folder (an Item folder, shaped like an existing one)
  await run(async ({ changes }) => {
    const folders = await readAll("folders");
    if (folders.has(`!folders!${FOLDER}`)) return;
    const like = [...folders.values()].find((f) => f.type === "Item");
    if (!like) throw new Error("no Item folder in the live world to copy the shape from");
    const f = JSON.parse(JSON.stringify(like));
    Object.assign(f, { _id: FOLDER, name: FOLDER_NAME, folder: null, sorting: "a", sort: 999999, color: null, description: "CSB item templates restored from the archive world so legacy characters' old items resolve. Do not build new items on these.", flags: {} });
    f._stats = { ...(f._stats || {}), createdTime: now, modifiedTime: now, lastModifiedBy: GM, compendiumSource: null, duplicateSource: null };
    changes.push([`!folders!${FOLDER}`, f, `new Item folder "${FOLDER_NAME}"`]);
  }, "legacy templates: folder", "folders");

  // 2) the 8 templates, copied from the archive (same ids)
  await run(async ({ changes }) => {
    const live = await readAll("items");
    const arch = await readAll("items", ARCHIVE);
    for (const id of IDS) {
      const key = `!items!${id}`;
      if (live.has(key)) continue;
      const src = arch.get(key);
      if (!src) throw new Error(`template ${id} not found in ${ARCHIVE}`);
      if (src.type !== "_equippableItemTemplate") throw new Error(`${id} in ${ARCHIVE} is a ${src.type}, not an item template`);
      if ((src.system?.modifiers || []).length) throw new Error(`${id} (${src.name}) carries modifiers; this script only restores modifier-free templates`);
      const doc = JSON.parse(JSON.stringify(src));
      doc.name = `_Legacy · ${String(src.name).replace(/^_+/, "")}`;
      doc.folder = FOLDER;
      doc._stats = { ...(doc._stats || {}), modifiedTime: now, lastModifiedBy: GM };
      changes.push([key, doc, `restore "${src.name}" as "${doc.name}" (${JSON.stringify(doc).length} bytes)`]);
    }
  }, "legacy templates: restore 8 item templates from the archive", "items");
})().catch((e) => { console.error(e); process.exitCode = 1; });
