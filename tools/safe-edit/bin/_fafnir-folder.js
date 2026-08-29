// Create the Actor folder for the Fafnir Castle roster.
// Run from tools/safe-edit; --apply to write.
//
// The world has no per-dungeon actor folders yet — the live roster sits in
// "Monster / Current Dungeon" and graduates to "Monster" root when a dungeon
// closes. This one is named for the dungeon's ROLLTABLE folder ("Fafnir
// Castle") so the two trees line up. It is deliberately NOT "Current Dungeon":
// these five must not mix with the Valley of the Dragon roster.
const { getByKey } = require("../lib/db");
const { FOLDER_FAFNIR, FOLDER_MONSTER_ROOT } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

run(async ({ changes }) => {
  const parent = await getByKey("folders", `!folders!${FOLDER_MONSTER_ROOT}`);
  if (!parent) throw new Error("missing Monster folder");
  if (await getByKey("folders", `!folders!${FOLDER_FAFNIR}`)) {
    throw new Error("Fafnir Castle actor folder already exists — rerun is a no-op, not an update");
  }

  // Copied off the sibling "Current Dungeon" folder rather than guessed:
  // color null, sorting "a". `sort` puts it directly after it.
  changes.push([`!folders!${FOLDER_FAFNIR}`, {
    name: "Fafnir Castle",
    type: "Actor",
    folder: FOLDER_MONSTER_ROOT,
    _id: FOLDER_FAFNIR,
    description: "",
    sorting: "a",
    sort: 200000,
    color: null,
    flags: {},
    _stats: {
      compendiumSource: null, duplicateSource: null,
      coreVersion: "12.343", systemId: "custom-system-builder", systemVersion: "4.8.5",
      createdTime: null, modifiedTime: null, lastModifiedBy: null,
    },
  }, "NEW folder — Actor / The Legend of Dragonslayer / Monster / Fafnir Castle"]);
}, "fafnir-castle: actor folder", "folders");
