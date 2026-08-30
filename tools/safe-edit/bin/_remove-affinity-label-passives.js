#!/usr/bin/env node
"use strict";

// Removes monster Passive skills that ONLY restate the creature's damage-type
// affinities or condition immunities.
//
// Why: both are already surfaced by the Study system and the affinity table on
// the sheet. Keeping them as passives is redundant AND actively misleading —
// a player looking at the study sheet sees "1 hidden passive remaining" and
// reasonably assumes it DOES something, when it is only a label.
//
// This does NOT touch label-only passives that state a real rule the affinity
// table cannot express (Flying, Dodge, Heavy, Spellblade, ...). Those stay.
//
// Every target below was verified to carry NO automation whatsoever:
// no effect_table, no reaction_config_table, no ActiveEffects.
//
// Usage:
//   node tools/safe-edit/bin/_remove-affinity-label-passives.js --dry-run
//   node tools/safe-edit/bin/_remove-affinity-label-passives.js --apply

const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const { assertGameClosed } = require("../lib/lock");

const APPLY = process.argv.includes("--apply");

const TARGETS = [
  {
    actorId: "FLy3XRr40wNRmYxV",
    itemId: "LnTfrgzFzJbFhHMm",
    label: "Iron Colossus / Adamant Plating",
    reason: "damage-type affinity label (RS Physical + Earth, IM Poison)",
  },
  {
    actorId: "2SFrEMqLBfqzc7Nj",
    itemId: "csviMSGyPvawLkyW",
    label: "Hilde-Fafnir / Crown of the Sleeping Dragon",
    reason:
      "condition-immunity label (Berserk, Charm, Confused, Enraged, Frightened, Petrify, Shaken, Zombie)",
  },
  {
    actorId: "fCxslZazJKtQWsKP",
    itemId: "ba9EknTOZeIqoQOB",
    label: "Death Gazer / Unblinking",
    reason: "condition-immunity label (Blind, Dazed, Obscure, Shaken)",
  },
];

const nonEmpty = (o) =>
  o && typeof o === "object" && Object.values(o).some((r) => r && !r.$deleted);

(async () => {
  assertGameClosed();
  console.log(`[remove] mode=${APPLY ? "APPLY" : "DRY-RUN"} targets=${TARGETS.length}\n`);

  if (APPLY) {
    const backup = snapshotCollection("actors");
    console.log(`[remove] actors snapshot -> ${backup}\n`);
  }

  const db = await openCollection("actors");
  let removed = 0;
  let failed = 0;

  for (const t of TARGETS) {
    const itemKey = `!actors.items!${t.actorId}.${t.itemId}`;
    const actorKey = `!actors!${t.actorId}`;

    let item = null;
    try {
      item = await db.get(itemKey);
    } catch (e) {
      /* missing */
    }
    if (!item) {
      console.log(`= ${t.label} — already gone, skipping`);
      continue;
    }

    // Re-assert inertness at run time. Never delete something that grew teeth.
    const p = item.system?.props || {};
    const childAEs = [];
    for await (const [k] of db.iterator({
      gte: `!actors.items.effects!${t.actorId}.${t.itemId}.`,
      lt: `!actors.items.effects!${t.actorId}.${t.itemId}.￿`,
    })) {
      childAEs.push(String(k));
    }
    if (nonEmpty(p.effect_table) || nonEmpty(p.reaction_config_table) || childAEs.length) {
      console.error(
        `✗ ${t.label} — REFUSING: carries automation ` +
          `(effect_table=${nonEmpty(p.effect_table)} reaction_config=${nonEmpty(
            p.reaction_config_table
          )} AEs=${childAEs.length})`
      );
      failed++;
      continue;
    }
    if (p.skill_type !== "Passive") {
      console.error(`✗ ${t.label} — REFUSING: skill_type is "${p.skill_type}", not Passive`);
      failed++;
      continue;
    }

    const actor = await db.get(actorKey);
    const items = Array.isArray(actor.items) ? actor.items : [];
    const nextItems = items.filter((id) => id !== t.itemId);

    console.log(`— ${t.label}`);
    console.log(`  reason:  ${t.reason}`);
    console.log(`  key:     ${itemKey}`);
    console.log(`  actor.items: ${items.length} -> ${nextItems.length}`);

    if (!APPLY) {
      console.log("  DRY RUN — no write\n");
      removed++;
      continue;
    }

    await db.del(itemKey);
    actor.items = nextItems;
    await db.put(actorKey, actor);
    console.log("  removed\n");
    removed++;
  }

  await db.close();
  console.log(`[remove] ${APPLY ? "removed" : "would remove"}=${removed} failed=${failed}`);
  if (failed) process.exitCode = 1;
})();
