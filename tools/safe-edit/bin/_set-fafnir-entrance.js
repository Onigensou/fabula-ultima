#!/usr/bin/env node
// Opt ⭐ Fafnir into the `shadowstorm` boss entrance (Dreadwyrm Descent).
//
// The director's entrance phase reads an actor-level module flag to decide how
// an enemy enters (director-init.js `entranceStyleFor`). Anything without the
// flag fades in as before; Fafnir falls out of the sky as a shadow instead.
//
// A FLAG and not a `system.props` field on purpose: CSB prunes every prop its
// template does not declare, so a props-homed opt-in would need a template
// change (which world-export cannot carry) and would silently vanish on the
// next sheet re-stamp. See reference_safe_edit.
//
// Idempotent. Dry by default; pass --write, with the game CLOSED.
//
//   node bin/_set-fafnir-entrance.js
//   node bin/_set-fafnir-entrance.js --write

const { openCollection } = require("../lib/db");

const FLAG_NS     = "fabula-ultima-companion";
const FLAG_KEY    = "entranceStyle";
const STYLE       = "shadowstorm";

// ⭐ Fafnir — Valley of the Dragon. NOT ⭐ Hilde-Fafnir (2SFrEMqLBfqzc7Nj),
// which is the Fafnir Castle final boss and has no bespoke entrance yet.
const TARGETS = [
  { id: "P1uCkpNnxLRBNqZr", expectName: "⭐️ Fafnir" },
];

const WRITE = process.argv.includes("--write");

(async () => {
  const db = await openCollection("actors");
  let changed = 0;

  try {
    for (const { id, expectName } of TARGETS) {
      const key = `!actors!${id}`;
      let actor = null;
      try { actor = await db.get(key); } catch { /* fall through to the miss below */ }
      if (!actor) {
        console.error(`MISS  ${id} — not in this world; aborting without writing.`);
        process.exitCode = 1;
        return;
      }
      if (expectName && actor.name !== expectName) {
        // A name mismatch means the id drifted to some other actor. Refuse
        // rather than stamp a boss entrance onto whatever is sitting there.
        console.error(`NAME  ${id} is "${actor.name}", expected "${expectName}"; aborting.`);
        process.exitCode = 1;
        return;
      }

      const flags = actor.flags ?? {};
      const ns    = flags[FLAG_NS] ?? {};
      const cur   = ns[FLAG_KEY] ?? null;

      if (cur === STYLE) {
        console.log(`SKIP  ${actor.name} already has ${FLAG_KEY}="${STYLE}"`);
        continue;
      }

      console.log(`SET   ${actor.name}: ${FLAG_KEY} ${cur === null ? "(unset)" : `"${cur}"`} -> "${STYLE}"`);
      changed++;

      if (WRITE) {
        // Merge, never replace: this actor's other flags (CSB, core, other
        // modules) must survive untouched.
        actor.flags = { ...flags, [FLAG_NS]: { ...ns, [FLAG_KEY]: STYLE } };
        await db.put(key, actor);
      }
    }

    if (!WRITE) console.log(`\nDRY RUN — ${changed} change(s) pending. Re-run with --write (game CLOSED).`);
    else console.log(`\nWROTE ${changed} change(s).`);
  } finally {
    await db.close();
  }
})().catch((e) => {
  console.error("FAILED:", e);
  process.exitCode = 1;
});
