# safe-edit

Direct-LevelDB editor for Foundry world data. Lets you (or Claude) make surgical
edits to Actors / Items / Scenes / etc. without opening Foundry.

**The game must be closed.** Foundry holds an exclusive `LOCK` on each
LevelDB collection while running; safe-edit refuses to write if any collection
is locked.

## What it does

Each write goes through six layers:

1. **Game-closed check** — refuses to run if Foundry holds a `LOCK`.
2. **Backup** — snapshots the affected collection dir to `tools/safe-edit/backups/`.
3. **Validation** — structural checks (required core fields, `_id` consistency,
   immutable `_id`/`type`, type declared in `system.json`, no silent
   `system.*` key loss).
4. **Write** via `classic-level` (the same binding Foundry uses).
5. **Read-back verify** — confirms the on-disk value hashes to the expected value;
   auto-rolls back from the backup on mismatch.
6. **Journal** — appends to `tools/safe-edit/journal.jsonl` with hashes and a
   pointer to the backup, enabling later rollback.

## What it does NOT do (v1)

- **Embedded documents** — items on an actor, AEs on an item, etc. These have
  their own LevelDB keys (`!actors.items!<id>`) but consistency with the parent
  matters; left to v2. Use a macro inside Foundry for those.
- **Compendium packs** — only world data. Compendium edits should use the
  Foundry CLI.
- **Runtime hooks** — `prepareData()`, active-effect application, and other
  in-memory logic won't fire. The next time you open Foundry, the document is
  re-prepared from the new on-disk state.
- **Foundry-runtime validation** — only structural checks. For full validation,
  shell out to `fvtt package validate` (not wired in yet).

## Install

Requires Node.js 18+.

```bash
cd tools/safe-edit
npm install
```

## CLI

```bash
node bin/safe-edit.js check
node bin/safe-edit.js get Item.gTXdzJjV4Lmwfm7i
node bin/safe-edit.js patch Item.gTXdzJjV4Lmwfm7i \
  --patch '{"system.damage_bonus":12}' --dry-run
node bin/safe-edit.js patch Item.gTXdzJjV4Lmwfm7i \
  --patch '{"system.damage_bonus":12}' --note "bump fire bolt damage"
node bin/safe-edit.js log --limit 10
node bin/safe-edit.js rollback 20260512-1430-abcd
```

Patches accept Foundry-style flat-dotted keys (`{"system.damage_bonus": 12}`)
or nested objects (`{"system": {"damage_bonus": 12}}`). Both deep-merge into
the existing document.

## Library

```js
const { getDoc, safeEdit, rollback } = require("./tools/safe-edit/lib");

const doc = await getDoc("Item.gTXdzJjV4Lmwfm7i");

const result = await safeEdit({
  uuid: "Item.gTXdzJjV4Lmwfm7i",
  patch: { "system.damage_bonus": 12 },
  note: "bump fire bolt damage",
  dryRun: false,
});
// → { entryId, backupPath, beforeHash, afterHash, ... }

await rollback(result.entryId);
```

## Layout

```
tools/safe-edit/
├── bin/safe-edit.js     CLI
├── lib/
│   ├── index.js         public exports
│   ├── edit.js          safeEdit orchestrator + rollback
│   ├── lock.js          LOCK-file game-running check
│   ├── keys.js          UUID ↔ LevelDB key encoding
│   ├── db.js            classic-level wrapper
│   ├── backup.js        snapshot/restore collection dirs
│   ├── validate.js      structural validation
│   ├── journal.js       change log
│   ├── patch.js         flat-dotted expansion + deep merge
│   └── paths.js         path constants
├── backups/             generated; gitignored
├── journal.jsonl        generated; gitignored
└── package.json
```
