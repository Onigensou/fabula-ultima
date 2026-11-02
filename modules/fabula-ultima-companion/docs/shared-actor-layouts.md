# Shared actor sheet layouts

Since v1.0.513 (2026-11-03), most actors in the world store an **empty** sheet layout.
That is intended, not data loss.

## What changed

CSB keeps a full copy of a sheet layout (`system.body` + `system.header`) on every actor.
In fabula-ultima-2, 316 non-template actors stored 47 MB of layout, but only 33 layouts
were distinct. Actors can't simply use their template's layout. 139 NPCs carry older
versions of the NPC template's layout, 100 actors point at a template that no longer
exists, and PCs carry their own per-character blocks. Forcing them back onto the
template changes their sheets. So each distinct layout is now kept **once**:

- **`_Layout Library`** is a hidden `_template` actor. Its
  `flags.fabula-ultima-companion.layoutLibrary.layouts` maps a content hash to
  `{ body, header }`.
- **Each actor** keeps its root panels with `contents: []`, plus
  `flags.fabula-ultima-companion.layoutRef = <hash>`.
- **At prepare time**, `scripts/csb-extensions/csb-template-layout-dedup.js` (SHARED
  ACTOR LAYOUTS) puts the library layout back on the prepared actor. Every actor gets
  exactly the layout it had.

Result: the world data every client downloads went from about 130 MB to about 89 MB. Over a
home connection, that is the difference players wait for on every join and reload.

## Rules for code and tools

- **Read `actor.system.body`, not `actor._source.system.body`.** The prepared document
  holds the resolved layout. `_source` (and `toObject()`, the export, raw LevelDB) holds
  the empty stub plus the ref.
- **Never delete or edit `_Layout Library`.** Every actor with a `layoutRef` loses its
  sheet without it. A missing entry is reported loudly: a console error, plus a
  permanent notification for a GM.
- **`reloadTemplate` on an actor still works as it always did.** It stamps the
  template's layout onto the actor, and a stored layout wins over the ref. This
  includes `world-import`, which calls `reloadTemplate`.
- **New actors carry their own layout** until the migration runs again. It is
  idempotent and folds new actors into the library:
  `node tools/safe-edit/bin/_share-actor-layouts.js` (game CLOSED; backs up first).
- **Root panel attributes stay on the stub on purpose.** An unlinked token's delta
  body is merged over the base actor's body, so dropping `flow` / `align` etc. from
  the stub changed 48 token sheets in the parity run.
- **The resolved layout is a shared object.** Do not mutate `actor.system.body` in
  place. The parity run deep-froze the library and found no writer.
- **Exporting an actor to a compendium or another world** carries the empty stub and
  the ref. It needs a `_Layout Library` there too, or a `reloadTemplate` after import.

## Evidence (2026-11-03)

Checked in the battle sandbox (the real Foundry client and the module, with the world
read from disk). The whole world was run before and after the migration: 315 world
actors and 110 unlinked token actors.

| Check | Result |
|---|---|
| Stored layout, built CSB trees, derived props, rendered sheets | **identical** |
| Same check with `csbLayoutTreeCache` off | **identical** |
| Regression-bench skill fingerprints | **487/487** |

The only diff was the Field actor's sheet: its wellspring effects get fresh ids on every
boot, so it differs between any two boots. On the real server, a GM and a player client
both resolved all 262 actors, and the player received the library. The rendering check
ran only in the sandbox, because rendering a sheet writes props.
