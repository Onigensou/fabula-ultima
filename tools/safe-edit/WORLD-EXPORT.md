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

`folders`, `items`, `actors` (the authored content), with each actor's embedded
skills + their Active Effects fully assembled into the actor's JSON. It
deliberately ignores volatile session churn (scenes, combats, messages, fog,
playlists, settings). Output: `worlds/<world>/_authored-export/`.

CSB-derived sheet fields and volatile `_stats` timestamps are stripped, and all
keys are sorted, so diffs reflect real content changes only.

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

1. Close Foundry.
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

## Limitation

This prevents **future** invisible loss. Losses already baked into committed
LevelDB (a past clobber) are not visible to an export-vs-export diff — recover
those with the LevelDB-bisect recipe (read the actor's embedded items from an
older commit's shards via `classic-level`; see the Fafnir recovery notes).
