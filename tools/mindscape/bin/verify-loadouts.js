#!/usr/bin/env node
"use strict";
//
// Mindscape — the loadout round-trip gate (ruleset Part 6e). READ-ONLY.
//
//   node bin/verify-loadouts.js                 # the Current Game party
//   node bin/verify-loadouts.js --party "Name"
//
// For each party member, rebuilds every gear-dependent sheet number from scratch
// (template base + every applicable Active Effect, lib/loadout.js) and compares it
// with the value stored on the sheet. A PC that does not reproduce must not be
// given paper equipment: a swap computed on a model that cannot rebuild the
// character's REAL kit would be measuring a character that does not exist.
//
// The game must be CLOSED (Foundry holds the LevelDB lock). Opening the store
// rotates its MANIFEST — content-neutral; see project notes before committing.

const { loadParty, resolveCurrentGame } = require("../lib/load-actors");
const { verifyLoadout } = require("../lib/loadout");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--party") out.partyName = argv[++i];
    else if (argv[i] === "--verbose" || argv[i] === "-v") out.verbose = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const party = await loadParty({ partyName: args.partyName });
  const game = await resolveCurrentGame();
  console.log(`\nLoadout round-trip — ${game.gameName} · ${args.partyName ?? game.partyName}`);

  let failed = 0;
  for (const pc of party) {
    const v = verifyLoadout(pc);
    if (!v.ok) failed++;
    console.log(`\n${v.ok ? "✓" : "✗"} ${pc.name}  —  ${v.matched.length} keys reproduced, ${v.mismatches.length} mismatched`);
    console.log(`    equipped: ${v.equipped.map((e) => `${e.name} (${e.type})`).join(", ") || "nothing"}`);
    for (const m of v.mismatches) {
      console.log(`    ✗ ${m.key.padEnd(28)} stored ${JSON.stringify(m.stored)}   rebuilt ${JSON.stringify(m.rebuilt)}`);
    }
    for (const u of v.unresolved) {
      console.log(`    ? ${u.key.padEnd(28)} ${u.source}: ${u.reason}`);
    }
    // Situational values reproduce only because the sheet was saved in that state
    // (e.g. Wet). The sim has no such state, so these are reported, not modelled.
    const states = new Map();
    for (const x of v.situational) {
      const k = `${x.state}`;
      if (!states.has(k)) states.set(k, new Set());
      states.get(k).add(`${x.key} (${x.source})`);
    }
    for (const [state, keys] of states) {
      console.log(`    ~ depends on "${state}": ${[...keys].join("; ")}`);
    }
    if (args.verbose) console.log(`    matched: ${v.matched.join(", ")}`);
  }

  console.log(`\n${failed ? `✗ ${failed} of ${party.length} PC(s) do NOT reproduce — do not give them paper equipment.` : `✓ all ${party.length} PC(s) reproduce.`}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(`\nverify-loadouts failed: ${e.message}\n`); process.exit(1); });
