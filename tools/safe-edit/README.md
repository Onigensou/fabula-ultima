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
4. **Write** via `classic-level` (the same binding Foundry uses). Multi-key
   operations (create) use a batch so both writes are atomic on disk.
5. **Read-back verify** — confirms the on-disk value hashes to the expected
   value; auto-rolls back from the backup on mismatch.
6. **Journal** — appends to `tools/safe-edit/journal.jsonl` with hashes and a
   pointer to the backup, enabling later rollback.

## Supported documents

### Top-level
All world collections: `Actor`, `Item`, `Scene`, `JournalEntry`, `Macro`,
`RollTable`, `Playlist`, `Cards`, `Folder`, `User`, `ChatMessage`, `Combat`,
`Setting`, `FogExploration`.

### Embedded
Three sub-document types, at any depth Foundry supports:
- `Item` (under `Actor` — characters' inventory & skills)
- `ActiveEffect` (under `Actor`, `Item`, or a deeply embedded `Item`)
- `Combatant` (under `Combat`)

UUID forms:
- `Item.aaa` — top-level
- `Actor.aaa.Item.bbb` — embedded Item on Actor
- `Item.aaa.ActiveEffect.bbb` — AE on top-level Item
- `Actor.aaa.Item.bbb.ActiveEffect.ccc` — AE on embedded Item on Actor (3-level)
- `Combat.aaa.Combatant.bbb` — Combatant on Combat

LevelDB key format on disk: `!<collection>.<sub>...!<id>.<id>...`. Parent IDs
are encoded in the key. The parent's stored JSON carries a `string[]` of child
IDs in a field matching the sub-type (`items`, `effects`, `combatants`).
`create` updates both the new child entry and the parent's ID list atomically.

## What it does NOT do

- **Other embedded types** — `Token`, `JournalEntryPage`, `TableResult`,
  `PlaylistSound`. Same pattern; not wired in yet.
- **Delete** — neither top-level nor embedded. Manual via the LevelDB API for
  now (`db.del(key)`).
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
# Game state
node bin/safe-edit.js check

# Read
node bin/safe-edit.js get Item.gTXdzJjV4Lmwfm7i
node bin/safe-edit.js get Actor.aaa.Item.bbb
node bin/safe-edit.js get Actor.aaa.Item.bbb.ActiveEffect.ccc

# Patch (top-level or embedded)
node bin/safe-edit.js patch Item.gTXdzJjV4Lmwfm7i \
  --patch '{"system.damage_bonus":12}' --dry-run
node bin/safe-edit.js patch Item.aaa.ActiveEffect.bbb \
  --patch-file ./my-patch.json --note "disable AE"

# Create an embedded document
node bin/safe-edit.js create Item.aaa ActiveEffect \
  --value-file ./new-ae.json --dry-run
node bin/safe-edit.js create Actor.aaa Item \
  --value-file ./new-skill.json --note "add Fire Bolt skill"

# History / rollback
node bin/safe-edit.js log --limit 10
node bin/safe-edit.js rollback 20260512-1430-abcd
```

Patches accept Foundry-style flat-dotted keys (`{"system.damage_bonus": 12}`)
or nested objects (`{"system": {"damage_bonus": 12}}`). Both deep-merge into
the existing document.

For Windows / PowerShell users: pass JSON via `--patch-file <path>` or
`--value-file <path>` rather than inline `--patch '<json>'` — PowerShell's
argument parser mangles JSON inline strings.

## Library

```js
const { getDoc, safeEdit, createEmbedded, rollback } = require(
  "./tools/safe-edit/lib"
);

const doc = await getDoc("Actor.aaa.Item.bbb");

const r1 = await safeEdit({
  uuid: "Item.aaa.ActiveEffect.bbb",
  patch: { disabled: true },
  note: "disable AE",
});

const r2 = await createEmbedded({
  parentUuid: "Actor.aaa",
  docType: "Item",
  value: { name: "Fire Bolt", type: "equippableItem", system: { /* ... */ } },
  note: "add Fire Bolt skill",
});
// → { childUuid, childKey, parentKey, entryId, ... }

await rollback(r2.entryId);
```

## Layout

```
tools/safe-edit/
├── bin/safe-edit.js     CLI
├── bin/_test-clone.js   Test helper: clone a doc with a fresh _id
├── lib/
│   ├── index.js         public exports
│   ├── edit.js          getDoc, safeEdit (patch), createEmbedded, rollback
│   ├── lock.js          LOCK-file game-running check
│   ├── keys.js          UUID ↔ LevelDB key encoding (N-part embedded UUIDs)
│   ├── db.js            classic-level wrapper
│   ├── backup.js        snapshot/restore collection dirs
│   ├── validate.js      structural validation (top-level + embedded)
│   ├── journal.js       change log
│   ├── patch.js         flat-dotted expansion + deep merge
│   └── paths.js         path constants
├── backups/             generated; gitignored
├── journal.jsonl        generated; gitignored
└── package.json
```
