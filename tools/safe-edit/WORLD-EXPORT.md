# world-export — reviewable, loss-proof world-data submission

## The problem this solves

World content is delivered to the co-dev by committing the raw LevelDB shards
(`.ldb` / `MANIFEST-*` / `CURRENT`) under `worlds/<world>/data/`. Git treats
those as **opaque binary**, so:

- a `git diff` of a world-data commit shows you *nothing* about which
  actors/items/skills actually changed, and
- a world push is **wholesale** — it overwrites all collections at once with no
  merge, so a co-dev whose running world is stale can re-push and silently
  clobber your authoring.

That is exactly how the Fafnir moveset was lost: commit `011fb54c` rolled it
from 11 skills to 9 shells, and the textual diff was 2 lines. Invisible.

`world-export` adds a **companion layer**: every authored document is exported
to its own readable JSON file. The LevelDB still ships and is still what Foundry
loads — the JSON is a *review surface* and a *tripwire*. A removed skill now
shows up as a deleted file or a deleted array entry, and `report` / `check`
print a categorized changelog before you push.

## What it covers

`folders`, `items`, `actors`, `tables`, `playlists` (the authored content):
each actor's embedded skills + Active Effects, each RollTable's result rows, and
each Playlist's sounds are fully assembled into the document's JSON. A removed
skill, a dropped loot-table result row, or a deleted table/playlist all show up
in the diff. Volatile playback state (`playing`/`pausedTime`) is stripped from
playlists so the diff reflects the authored playlist, not what's currently
playing. It still ignores true session churn (combats, messages, fog, settings).
Scenes are covered separately by preflight's per-scene golden (`bless`). Output:
`worlds/<world>/_authored-export/`.

CSB-derived sheet fields and volatile `_stats` timestamps are stripped, and all
keys are sorted, so diffs reflect real content changes only.

**Session recordings are stripped too** — `system.props.battle_log` and
`battle_log_table` are written by play (and by every sim run), never authored.
Left in, they swamped the review surface: one migration commit carried a
182-line party-actor change that touched no skill, table or item. Noise that
size is exactly what hides a one-line removal, which is the whole thing this
tool exists to catch. Add any future play-written prop to `VOLATILE_PROPS` in
`bin/world-export.js`.

## Commands

```
node tools/safe-edit/bin/world-export.js export    # write the JSON tree
node tools/safe-edit/bin/world-export.js report    # export + diff vs HEAD
node tools/safe-edit/bin/world-export.js check     # report + exit 1 on losses
node tools/safe-edit/bin/world-export.js baseline  # mark "reviewed up to here"
```

Game **must be closed** (LevelDB single-process LOCK) — the same constraint as
committing `worlds/`. (`--allow-locked` exists only for running against a copy.)

## Two baselines — which to use

`report`/`check` diff the freshly-exported tree against a baseline:

- **default = HEAD** — "everything different from what the co-dev last got."
  This is the **submit gate**. Run it before `git add worlds/ && commit`.
- **`--since-baseline`** — "what changed since *I* last reviewed." For a long
  fix session with many concurrent edits: run `baseline` to mark the current
  state reviewed, keep working, then `report --since-baseline` shows only the
  *new* delta instead of re-listing the whole pile every time.

In both modes the dangerous class — a deleted document, or a skill that vanished
from an actor that still exists — is called out separately from your intended
additions/edits.

### Tracking unreported changes mid-session

```
# after reviewing current state and confirming it's what you intend:
node tools/safe-edit/bin/world-export.js baseline
# ...keep fixing things across many actors/skills...
node tools/safe-edit/bin/world-export.js report --since-baseline
#   -> only the changes made AFTER the checkpoint, removals flagged
```

The checkpoint lives at `_authored-export/.baseline/` and is **gitignored** —
it's your private "last reviewed" marker, never shared.

## Submit workflow

1. Close Foundry — and **verify it actually closed**. ⚠ An in-page
   `game.shutDown()` is NOT enough: measured 2026-08-02, it disconnects the
   calling client (users drops to 0) but `/api/status` keeps reporting
   `active: true` and every collection keeps its LOCK, so step 2 still refuses.
   `POST /setup {action:"shutdown"}` returns 403 without an elevated admin
   session, which an empty `adminKey` does not grant. The reliable lever is
   stopping the server process; confirm with:

   ```
   curl -s http://localhost:30000/api/status     # want: {"active":false}  (or no response)
   ```

   Stopping the process is safe for the data — LevelDB is crash-safe, and step 2
   is itself the integrity check (it opens every collection and fails loudly on
   an inconsistent DB). On this machine `tools/test-bridge-client/close-world.mjs`
   does the stop-and-verify in one go (local-only; `tools/*` is gitignored).
2. `node tools/safe-edit/bin/world-export.js report` — review the diff and,
   above all, the **removal warnings**. If a removal is unexpected, STOP and
   reconcile (restore the dropped content) before going further.
3. `git add worlds/ && git commit` — the pre-commit hook (below) regenerates and
   stages the export and re-checks for losses automatically.
4. Push.

## Pre-commit hook (automatic gate)

`hooks/pre-commit` blocks any commit that stages this world's LevelDB data if it
would lose a document or an embedded skill. It also auto-stages the regenerated
JSON so the export stays in lock-step with the binary data.

Install (per clone — git hook config is not shared through the repo):

```
git config core.hooksPath tools/safe-edit/hooks
```

- Bypass for one intentional removal: `git commit --no-verify`
- Disable entirely: `git config --unset core.hooksPath`

If Foundry is still running when you commit data, the hook tells you to close it
(it can't read a locked DB).

## Importing JSON back into the world — `world-import` (merge + recovery)

`world-export` makes the binary push *reviewable*; `world-import` makes it
*mergeable*. It reads the per-document JSON and reconciles the live world to
match it, so two devs can edit concurrently and merge instead of clobbering:

1. Both commit the JSON companion (export already does this).
2. On pull, git merges the JSON **per document** — different docs merge cleanly;
   same-doc edits conflict in readable JSON you resolve by hand.
3. `world-import apply --all` makes the live world match the merged JSON.

**Recovery after a binary LevelDB conflict** (you had to pick one side's whole
collection and dropped the other's docs): re-add them from the other side's JSON —

```
node tools/safe-edit/bin/world-import.js apply --only actors/<id>.json --ref <their-commit>
```

### How it works / rules

- **Game must be OPEN.** Import drives Foundry's own document API through the
  test-bridge (a parent stores embedded items both inline AND as separate keys,
  kept consistent by Foundry — a raw writer would corrupt the world). Export is
  game-closed; import is game-open.
- **Dry-run by default:** `plan` reports what would change (create/update counts
  + embedded). `apply` writes. `apply` refuses the whole tree without `--all`
  (pass `--only <docs>` for a targeted reconcile).
- **Non-destructive:** creates missing docs, updates existing, upserts embedded
  items/effects. It never DELETES a doc/skill that's absent from the JSON —
  pruning a removal is the dangerous case; do it by hand.
- **Idempotent:** re-applying the same JSON updates in place, no duplicates.
- `--ref <gitref>` reads the JSON from a commit's export tree instead of the
  working tree. `--only` filters by relpath (`actors/<id>.json`) or bare id.
- **Prop preservation (the guard that makes it safe).** Import calls CSB's
  `reloadTemplate()` so the imported doc picks up the template's body/header --
  but that call PRUNES every `system.props` key the template does not declare.
  Unguarded it once deleted **112 keys across 10 docs** on a co-dev merge, 3 of
  them authored content (`action_keywords`). `world-import` now captures the
  props first and restores anything the reload dropped -- **both** what the JSON
  intends **and** what the live doc already held, so "absent from the JSON" is
  never treated as permission to delete. Restored keys print loudly, and `plan`
  predicts them *before* you write:

  ```
    WARN 3 undeclared system.props key(s) WOULD be pruned by reloadTemplate and restored:
        Asura: action_keywords
  ```

  Presence is judged on `doc._source.system.props`, never the prepared doc --
  CSB re-derives props on load, so the prepared doc reports them present even
  when LevelDB holds nothing. Regression test (no game needed):
  `node tools/safe-edit/test/world-import-reloadcsb.test.mjs`.
- `world-export report` will NOT catch a prop loss -- it counts documents and
  embedded docs, not properties. The guard above is the only thing between an
  import and silent content loss.

```
node tools/safe-edit/bin/world-import.js plan  [--only …] [--ref <gitref>] [--all]
node tools/safe-edit/bin/world-import.js apply [--only …] [--ref <gitref>] [--all]
```

## Resolving a concurrent-edit conflict — `world-pack` (merge-rebuild)

When two devs edit the **same collection** at once, the binary LevelDB conflicts
and can't be 3-way merged — you must pick one side's whole collection and lose
the other's. `world-pack` turns that into a real merge using Foundry's official
CLI (`@foundryvtt/foundryvtt-cli`, an npm dep of this tool — `npm install` in
`tools/safe-edit`), which round-trips a collection's LevelDB <-> per-document
YAML faithfully (CSB tables + embedded actor-items; verified byte-identical).

```
# 1. unpack BOTH sides of the conflicted collection to readable YAML (game any state):
node tools/safe-edit/bin/world-pack.js unpack --collection actors                 # OURS (live)
node tools/safe-edit/bin/world-pack.js unpack --collection actors --ref <theirs>  # THEIRS (a commit)

# 2. 3-way merge the two YAML trees by hand (or `git merge-file`) under
#    worlds/<world>/_merge-work/ — different docs are different files; same-doc
#    edits are a readable text conflict.

# 3. pack the merged YAML back into a fresh LevelDB (safe; writes to a dir):
node tools/safe-edit/bin/world-pack.js pack --collection actors --in worlds/<world>/_merge-work/<merged>

# 4. install it into the live world — GAME CLOSED. Backs up the existing
#    collection, verifies the new DB opens, auto-rolls-back if it doesn't:
node tools/safe-edit/bin/world-pack.js install --collection actors --from worlds/<world>/_merge-work/actors__packed

# 5. re-open Foundry to confirm, then close + `world-export report` before committing.
```

`_merge-work/` is gitignored scratch. `install` refuses while Foundry holds a
LOCK, backs up to `tools/safe-edit/backups/`, and rolls back on a bad key count.

### The key-count oracle (read the numbers, every time)

Each step prints a key count, and **that is the tripwire** — a merge that ADDS
keys when neither side added a document is wrong by construction. This is not
theoretical: `bc1e3738` re-shipped 3 ghost actors, and the only visible signal
was 3138 actor keys where both legitimate sides had 3111.

- `unpack` reports the **source** key count per side. Compare the two sides
  before you merge anything; an unexplained gap is your answer already.
- `pack` diffs the packed DB against the **installed** collection and NAMES every
  added/removed document. Pass `--expect <keys>` to hard-assert a count.
- `install` prints the same delta and **refuses** if the document set changes at
  all, until you confirm with `--allow-new`. Growth can be legitimate (the other
  side authored new content) — the gate exists to make you look, not to block.

Two robustness fixes behind this, both root-caused 2026-08-26:

- **`unpack` now owns its output dir.** The Foundry CLI writes into `--out`
  *without clearing it*, and `_merge-work/` survives across sessions — so a doc
  deleted weeks ago kept its `.yml` and rode a merge back into the world. Stale
  files are now cleared (a non-empty dir that does not look like a prior unpack
  needs `--force`), and any file that survives with an mtime predating the run is
  a hard error.
- **`unpack` no longer trusts the highest-numbered manifest.** A merge commit can
  leave a DEAD `MANIFEST-*` with a *higher* number than the live one; the old
  "highest wins" rule clobbered a correct `CURRENT` with it and every unpack died
  `LEVEL_ITERATOR_NOT_OPEN`, which blocked merges entirely. `CURRENT` is now tried
  first and manifests are validated by actually opening the DB.

### Which import tool for which job

| Need | Tool | Game |
|------|------|------|
| Reviewable diff + loss tripwire on a push | `world-export` (+ hook) | closed |
| Re-apply ONE dropped doc/skill from JSON | `world-import --only … --ref …` | open |
| Rebuild a WHOLE collection from merged source | `world-pack` (CLI) | closed for `install` |

## Limitation

This prevents **future** invisible loss. Losses already baked into committed
LevelDB (a past clobber) are not visible to an export-vs-export diff — recover
those with the LevelDB-bisect recipe (read the actor's embedded items from an
older commit's shards via `classic-level`; see the Fafnir recovery notes).
