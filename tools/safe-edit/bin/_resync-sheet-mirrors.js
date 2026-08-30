#!/usr/bin/env node
"use strict";

// Re-syncs the CSB actor sheet list mirrors from the live embedded items.
//
// WHY THIS EXISTS: CSB renders the sheet from list props, NOT from the items.
// Each mirror row holds its OWN copy of the description, so editing
// `system.props.description` on an item leaves the sheet — and the Study
// system — showing the OLD text. Deleting an item leaves an ORPHAN row behind,
// so the passive still appears on the sheet after the item is gone.
//
//   attack_list[id]       -> attack_description
//   normal_spell_list[id] -> spell_description
//   skill_passive_list[id]-> passive_description
//   skill_active_list[id] -> active_description
//
// This script makes the mirrors match reality:
//   - description differs -> overwrite from the item
//   - item no longer exists -> drop the row
//
// It only ever touches the description field and orphan rows; every other
// mirror field (cost, target, duration, attribute dice, roll) is left alone.
//
// Usage:
//   node tools/safe-edit/bin/_resync-sheet-mirrors.js --dry-run
//   node tools/safe-edit/bin/_resync-sheet-mirrors.js --apply
//   node tools/safe-edit/bin/_resync-sheet-mirrors.js --apply --actor <id> [--actor <id>...]
//   node tools/safe-edit/bin/_resync-sheet-mirrors.js --apply --all

const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const { assertGameClosed } = require("../lib/lock");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALL = argv.includes("--all");
const CLI_ACTORS = argv.reduce(
  (acc, a, i) => (a === "--actor" ? acc.concat(argv[i + 1]) : acc),
  []
);

// The 13 actors touched by the 2026-08-30 action-text pass.
//
// ⚠ DELIBERATELY EXCLUDES ⭐️ Fafnir (P1uCkpNnxLRBNqZr). It carries its own
// PRE-EXISTING mirror drift — a stale `Rend` spell_description and an orphan
// `Lightning Prison` row in skill_active_list pointing at a deleted item — but
// the user scoped Fafnir out of this pass. Run with `--actor P1uCkpNnxLRBNqZr`
// to clean it when that is actually wanted.
const DEFAULT_ACTORS = [
  "0AwQ7wEDz4ISA9mA", // Asura
  "8kluKkqkcGFkmXNO", // Mist Dragon
  "H6Ubup6kmkgNQzLU", // Drakoza
  "I2sSkVIQ4FCunZBE", // Skizzik
  "TvLv878yZLNUAWNN", // Kirin
  "iGc0EUHE9LKWT0Ye", // Mana Ray
  "kAYN54Id3iTAOw1A", // Ampere
  "x8TBsDZaRgoSo5no", // Obsidrax
  "2SFrEMqLBfqzc7Nj", // Hilde-Fafnir
  "FLy3XRr40wNRmYxV", // Iron Colossus
  "bnem1vdA6Bv3mBVx", // Succubus
  "fCxslZazJKtQWsKP", // Death Gazer
  "rftRuHZwWx5SiNpH", // Dire Orc
];

const LISTS = {
  attack_list: "attack_description",
  normal_spell_list: "spell_description",
  skill_passive_list: "passive_description",
  skill_active_list: "active_description",
};

(async () => {
  assertGameClosed();
  console.log(`[mirrors] mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  if (APPLY) {
    console.log(`[mirrors] actors snapshot -> ${snapshotCollection("actors")}\n`);
  }

  const db = await openCollection("actors");

  // Index every embedded item by actor.
  const items = {};
  const actorNames = {};
  for await (const [k, v] of db.iterator()) {
    const key = String(k);
    let m;
    if ((m = key.match(/^!actors!(.+)$/))) actorNames[m[1]] = v.name;
    else if ((m = key.match(/^!actors\.items!([^.]+)\.([^.]+)$/)))
      (items[m[1]] ||= {})[m[2]] = v;
  }

  const targets = ALL ? Object.keys(actorNames) : CLI_ACTORS.length ? CLI_ACTORS : DEFAULT_ACTORS;

  let fixed = 0;
  let dropped = 0;
  let actorsTouched = 0;

  for (const aid of targets) {
    let actor;
    try {
      actor = await db.get(`!actors!${aid}`);
    } catch {
      console.warn(`? ${aid} — actor not found, skipping`);
      continue;
    }
    const props = actor.system?.props;
    if (!props) continue;

    const name = actor.name;
    let changed = false;

    for (const [listKey, descKey] of Object.entries(LISTS)) {
      const list = props[listKey];
      if (!list || typeof list !== "object") continue;

      for (const [iid, row] of Object.entries(list)) {
        if (!row || typeof row !== "object") continue;
        const live = items[aid]?.[iid];

        if (!live) {
          console.log(`  ${name} · ${listKey} · ${row.name} — ORPHAN, dropping row`);
          if (APPLY) delete list[iid];
          changed = true;
          dropped++;
          continue;
        }

        const want = live.system?.props?.description;
        if (want === undefined) continue;
        if (row[descKey] === want) continue;

        console.log(`  ${name} · ${listKey} · ${row.name} — resyncing ${descKey}`);
        if (APPLY) row[descKey] = want;
        changed = true;
        fixed++;
      }
    }

    if (changed) {
      actorsTouched++;
      if (APPLY) await db.put(`!actors!${aid}`, actor);
    }
  }

  await db.close();
  console.log(
    `\n[mirrors] ${APPLY ? "resynced" : "would resync"}=${fixed} ` +
      `${APPLY ? "dropped" : "would drop"}=${dropped} across ${actorsTouched} actor(s)`
  );
})();
