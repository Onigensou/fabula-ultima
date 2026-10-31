#!/usr/bin/env node
"use strict";
// ============================================================================
// World data for the shared leave-combat exit (battle-director/leave-exit-fx.js).
//
//   node bin/_wire-leave-exits.js           # dry run
//   node bin/_wire-leave-exits.js --write   # GAME MUST BE CLOSED
//
// Every leave_combat row runs by default, so only the exceptions need data:
//   - Roo's ck_vanish walks away.
//   - Life and Mana Gorger art is drawn facing right, so they carry the token
//     Config mark or the exit would send them off tail first.
// Idempotent.
// ============================================================================

const { openCollection } = require("../lib/db");

const MODULE_ID = "fabula-ultima-companion";
const ROO_KNIFE = "!actors.items!VwClo606KbQSK6aQ.IqytDxaB5BGEtSZZ";
const GORGERS = ["!actors!nyHr1MwzRKcGUdyW", "!actors!PgNX7yW5nxq2emWX"];

async function main() {
  const write = process.argv.includes("--write");
  const db = await openCollection("actors");
  try {
    const knife = await db.get(ROO_KNIFE);
    const rows = knife.system.props.effect_table;
    const key = Object.keys(rows).find((k) => rows[k].effect_label === "ck_vanish");
    if (!key || rows[key].effect_kind !== "leave_combat") throw new Error("ck_vanish leave_combat row not found on Roo's Chef's Knife");
    console.log(`Roo / Chef's Knife ck_vanish: leave_exit ${JSON.stringify(rows[key].leave_exit ?? null)} -> "walk"`);
    rows[key].leave_exit = "walk";
    if (write) await db.put(ROO_KNIFE, knife);

    for (const k of GORGERS) {
      const a = await db.get(k);
      const flags = (a.prototypeToken.flags ??= {});
      const mine = (flags[MODULE_ID] ??= {});
      console.log(`${a.name}: spriteFacesRight ${JSON.stringify(mine.spriteFacesRight ?? null)} -> true`);
      mine.spriteFacesRight = true;
      if (write) await db.put(k, a);
    }
  } finally { await db.close(); }
  console.log(write ? "written" : "dry run: pass --write (game closed)");
}

main().catch((e) => { console.error(e); process.exit(1); });
