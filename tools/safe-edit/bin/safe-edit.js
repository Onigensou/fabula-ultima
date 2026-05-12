#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { getDoc, safeEdit, createEmbedded, rollback } = require("../lib/edit");
const { gameRunning } = require("../lib/lock");
const journal = require("../lib/journal");

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readPatch(flags) {
  if (flags.patch) return JSON.parse(flags.patch);
  if (flags["patch-file"]) return JSON.parse(fs.readFileSync(flags["patch-file"], "utf8"));
  if (!process.stdin.isTTY) {
    const data = fs.readFileSync(0, "utf8");
    if (data.trim()) return JSON.parse(data);
  }
  throw new Error("Provide --patch '<json>' or --patch-file <path> or pipe JSON via stdin");
}

const COMMANDS = {
  async check() {
    const { running, lockedCollections } = gameRunning();
    if (running) {
      console.log(`GAME RUNNING — LOCK held on: ${lockedCollections.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("Game closed — safe to edit.");
    }
  },

  async get([uuid]) {
    if (!uuid) throw new Error("Usage: safe-edit get <uuid>");
    const doc = await getDoc(uuid);
    if (!doc) {
      console.error(`Not found: ${uuid}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(doc, null, 2));
  },

  async patch([uuid], flags) {
    if (!uuid) throw new Error("Usage: safe-edit patch <uuid> --patch '<json>' [--dry-run] [--note '<msg>']");
    const patch = readPatch(flags);
    const result = await safeEdit({
      uuid,
      patch,
      note: flags.note,
      allowSystemKeyRemoval: Boolean(flags["allow-system-key-removal"]),
      dryRun: Boolean(flags["dry-run"]),
    });
    console.log(JSON.stringify(result, null, 2));
  },

  async create([parentUuid, docType], flags) {
    if (!parentUuid || !docType) {
      throw new Error("Usage: safe-edit create <parent-uuid> <docType> --value '<json>' [--dry-run] [--note '<msg>']");
    }
    let value;
    if (flags.value) value = JSON.parse(flags.value);
    else if (flags["value-file"]) value = JSON.parse(fs.readFileSync(flags["value-file"], "utf8"));
    else if (!process.stdin.isTTY) {
      const data = fs.readFileSync(0, "utf8");
      if (data.trim()) value = JSON.parse(data);
    }
    if (!value) throw new Error("Provide --value '<json>' or --value-file <path> or pipe JSON via stdin");
    const result = await createEmbedded({
      parentUuid,
      docType,
      value,
      note: flags.note,
      dryRun: Boolean(flags["dry-run"]),
    });
    console.log(JSON.stringify(result, null, 2));
  },

  async rollback([entryId]) {
    if (!entryId) throw new Error("Usage: safe-edit rollback <entry-id>");
    const result = await rollback(entryId);
    console.log(JSON.stringify(result, null, 2));
  },

  async log(_, flags) {
    const all = journal.readAll();
    const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
    const recent = all.slice(-limit).reverse();
    for (const e of recent) {
      console.log(`${e.id}  ${e.ts}  ${e.uuid}  ${e.note || ""}`);
    }
  },

  async help() {
    console.log(`safe-edit — direct-LevelDB editor for Foundry world data (game must be closed)

Commands:
  check                       Detect if Foundry is running (LOCK held)
  get <uuid>                  Print the JSON for a document
                              Accepts top-level (Item.aaa) or embedded
                              (Actor.aaa.Item.bbb, Item.aaa.ActiveEffect.bbb,
                              Actor.aaa.Item.bbb.ActiveEffect.ccc).
  patch <uuid> --patch <json> Apply a patch with backup + validation + read-back
                              Supports flat-dotted keys: {"system.damage_bonus": 12}
                              Or use --patch-file <path>, or pipe JSON via stdin
                              Flags: --dry-run, --note <msg>, --allow-system-key-removal
  create <parent-uuid> <docType> --value <json>
                              Create a new embedded document under a parent.
                              docType: Item | ActiveEffect | Combatant
                              Atomically writes the new entry AND appends its
                              _id to the parent's items[]/effects[]/combatants[].
                              Or use --value-file <path>, or pipe JSON via stdin.
                              Flags: --dry-run, --note <msg>
  rollback <entry-id>         Restore a collection from a journal entry's backup
  log [--limit N]             Show recent journal entries

Examples:
  node bin/safe-edit.js check
  node bin/safe-edit.js get Item.gTXdzJjV4Lmwfm7i
  node bin/safe-edit.js get Actor.aaa.Item.bbb
  node bin/safe-edit.js patch Item.gTXdzJjV4Lmwfm7i --patch '{"system.damage_bonus":12}' --dry-run
  node bin/safe-edit.js create Item.aaa ActiveEffect --value '{"name":"Test","type":"base"}' --dry-run
`);
  },
};

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    await COMMANDS.help();
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    await COMMANDS.help();
    process.exitCode = 1;
    return;
  }
  try {
    await handler(positional, flags);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (e.errors) for (const err of e.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
  }
})();
