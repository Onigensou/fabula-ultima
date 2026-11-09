#!/usr/bin/env node
"use strict";
// ============================================================================
// Soul Tithe visual/defense pass (2026-11-08, user request):
//   1. New Actor folder "Conflict Objects" under The Legend of Dragonslayer.
//      Soul Fragment + Lightning Crystal (the two conflictObject templates) move
//      there out of Monster/Current Dungeon. Player ownership stays None.
//   2. Soul Fragment floats (idleAnimation.float, the Wind Orb / Sylph primitive)
//      and hovers off the floor (idleAnimation.hover, the Flying lift without the status).
//   3. Soul Fragment resists Physical (affinity_1 = RS) AND every weapon family
//      except Arcane is 50% efficiency. The user chose to STACK them: a
//      non-Arcane physical weapon hit lands at 25%, Arcane physical at 50%.
//
//   node bin/_soul-fragment-folder-defense.js           # dry run
//   node bin/_soul-fragment-folder-defense.js --write   # GAME MUST BE CLOSED
// Idempotent. _soul-tithe-world.js re-applies 2 + 3 when it rebuilds the actor.
// ============================================================================
const { openCollection } = require("../lib/db");

const NS = "fabula-ultima-companion";
const FOLDER_ID = "CoNFLiCToBJeCT01";
const PARENT = "oVRjRmlshSvb68gK";            // The Legend of Dragonslayer
const TEMPLATE_FOLDER = "4gMC1IxdJlF59BSi";   // Monster/Current Dungeon (shape donor)
const ACTORS = ["soULFRagmeNT0001", "pEIMfwzQHUAGnGWz"]; // Soul Fragment, Lightning Crystal
const FRAGMENT = "soULFRagmeNT0001";
const WEAPON_EF = ["bow", "brawling", "dagger", "firearm", "flail", "heavy", "spear", "sword", "thrown"];

function applyFragmentDefense(a) {
  const p = a.system.props;
  p.affinity_1 = "RS";
  for (const w of WEAPON_EF) p[`${w}_ef`] = "50";
  p.arcane_ef = "100";
  a.flags[NS] = { ...a.flags[NS], idleAnimation: { float: true, bounce: false, hover: true } };
  return a;
}
module.exports = { applyFragmentDefense };

async function main() {
  const write = process.argv.includes("--write");
  const folders = await openCollection("folders");
  try {
    const donor = await folders.get(`!folders!${TEMPLATE_FOLDER}`);
    const f = JSON.parse(JSON.stringify(donor));
    Object.assign(f, { _id: FOLDER_ID, name: "Conflict Objects", folder: PARENT, sort: 50000, description: "Templates the conflict events spawn (Lightning Crystal, Soul Fragment). Not monsters; players never own them." });
    f._stats = { ...f._stats, createdTime: Date.now(), modifiedTime: Date.now() };
    console.log(`folder: ${f.name} (${FOLDER_ID}) under ${PARENT}`);
    if (write) await folders.put(`!folders!${FOLDER_ID}`, f);
  } finally { await folders.close(); }

  const db = await openCollection("actors");
  try {
    for (const id of ACTORS) {
      const a = await db.get(`!actors!${id}`);
      a.folder = FOLDER_ID;
      a.ownership = { default: 0, JQGNzKpDPHJmcUIW: 3 };
      if (id === FRAGMENT) applyFragmentDefense(a);
      const p = a.system.props;
      console.log(`actor: ${a.name} -> Conflict Objects, ownership ${JSON.stringify(a.ownership)}, aff1 ${p.affinity_1}, ef ${WEAPON_EF.map((w) => p[w + "_ef"]).join("/")} arcane ${p.arcane_ef}, idle ${JSON.stringify(a.flags[NS].idleAnimation ?? null)}`);
      if (write) await db.put(`!actors!${id}`, a);
    }
  } finally { await db.close(); }
  console.log(write ? "written" : "dry run: pass --write (game closed)");
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
