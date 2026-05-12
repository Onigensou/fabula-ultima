#!/usr/bin/env node
"use strict";

// Discovery helper: scans the world's actors collection and prints
// candidate Phantasm NPCs.
//
// Heuristic: top-level Actor docs whose name contains "Phantasm"
// (case-insensitive). Reports current isSummon / isPhantasm flag state
// so you can see which still need flagging.
//
// Requires Foundry to be closed (classic-level opens the DB exclusively).
//
// Usage:
//   node tools/safe-edit/bin/_find-phantasms.js
//   node tools/safe-edit/bin/_find-phantasms.js --pattern "Phantasm"

const { openCollection } = require("../lib/db");
const { gameRunning } = require("../lib/lock");

const args = process.argv.slice(2);
let pattern = /phantasm/i;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pattern") {
    pattern = new RegExp(args[++i], "i");
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: --pattern <regex> (default: /phantasm/i)");
    process.exit(0);
  }
}

(async () => {
  const { running, lockedCollections } = gameRunning();
  if (running) {
    console.error(`Foundry is running — close it before scanning. Locked: ${lockedCollections.join(", ")}`);
    process.exit(1);
  }

  const db = await openCollection("actors");
  try {
    const hits = [];
    for await (const [key, value] of db.iterator()) {
      // Only top-level actor docs; skip embedded keys like
      // !actors.items!<id> / !actors.effects!<id>.
      if (!key.startsWith("!actors!")) continue;
      const name = value?.name ?? "";
      if (!pattern.test(name)) continue;
      const props = value?.system?.props ?? {};
      hits.push({
        uuid: `Actor.${value._id ?? key.slice("!actors!".length)}`,
        name,
        isSummon: props.isSummon === true,
        isPhantasm: props.isPhantasm === true,
        folder: value.folder ?? null,
      });
    }

    if (!hits.length) {
      console.log(`No matches for ${pattern}.`);
      return;
    }

    // Sort: not-yet-flagged first, alphabetical within.
    hits.sort((a, b) => {
      if (a.isPhantasm !== b.isPhantasm) return a.isPhantasm ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    console.log(`Found ${hits.length} candidate(s):`);
    console.log("");
    for (const h of hits) {
      const flags = [
        h.isPhantasm ? "isPhantasm:true" : "isPhantasm:false",
        h.isSummon ? "isSummon:true" : "isSummon:false",
      ].join(" ");
      console.log(`  ${h.uuid}  ${JSON.stringify(h.name).padEnd(40)}  [${flags}]`);
    }

    const needFlag = hits.filter((h) => !h.isPhantasm);
    if (needFlag.length) {
      console.log("");
      console.log(`To flag the ${needFlag.length} NPC(s) lacking isPhantasm, run:`);
      const flags = needFlag.map((h) => `--phantasm ${h.uuid}`).join(" ");
      console.log(`  node tools/safe-edit/bin/_apply-phantasmal-echo-patch.js ${flags}`);
    } else {
      console.log("");
      console.log("All candidates already have isPhantasm:true.");
    }
  } finally {
    await db.close();
  }
})();
