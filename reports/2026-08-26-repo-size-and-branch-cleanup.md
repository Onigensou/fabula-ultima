---
id: 2026-08-26-repo-size-and-branch-cleanup
title: Repo is 4.6 GB with 153 local branches — delegating the cleanup call to you
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: process/repo-maintenance
introduced_in:
fixed_in:
---

# Not a bug — a housekeeping decision I'd rather you make

This came up while checking whether anything still needed pushing after the
Valley-dragons delivery (`cb1d12d4`). Nothing was outstanding and the repo is
healthy, but the measurements were big enough to be worth showing you.

**Onigensou's note, in their words:** *"I think these are leftover from branches we
already completed and merged back into main, so it's safe to clean these up — but
I'll delegate it to you since I'm scared of making mistakes, and just to be safe.
You have much more clarity than me as an actual programmer."*

So: **this is yours to decide and to execute.** Nothing has been deleted, gc'd or
rewritten. The repo is in a clean, stable state and can stay exactly as-is
indefinitely — there is no urgency and no breakage.

## Measurements (2026-08-26, after `cb1d12d4`)

```
.git on disk                                     4.6 GB
  reachable from origin's refs                   3.8 GB   ← SHARED. both clones carry this
  reachable from all refs (incl. local-only)     4.0 GB
  => local-only branches + stashes                ~0.2 GB

git count-objects -vH
  loose:      19,745 objects   2.32 GiB
  in-pack:    47,040 objects   1.92 GiB   (61 packs)
  prune-packable: 1,020
  garbage: 1                   242.88 MiB  ← .git/objects/pack/tmp_pack_ntumta

local branches                                   153
  merged into origin/main                        123
  NOT merged into origin/main                     29
     of which backup/ or safety/ snapshots        14
     of which real WIP branches                   15
stashes                                           14
branches on origin                                 7
local branches with no upstream                  147
```

Integrity is fine: `git fsck --connectivity-only` exits 0 with no output, no
interrupted merge/rebase, 613 refs all resolve, no `gc.log`.

## ⚠ The one correction to the "clean up branches" intuition

**Deleting branches will not meaningfully shrink this repo.** The 3.8 GB is
reachable from *origin's* refs — it is the project's actual history, and both
clones have it. Branch and stash cleanup can only touch the ~0.2 GB delta, and
only locally.

This matters because it means branch cleanup and size reduction are *two separate
questions*, and the second one is the harder one:

| Want | Lever | Reclaims | Risk |
|---|---|---|---|
| tidier branch list | delete merged branches | ~0 | low |
| smaller **local** `.git` | drop the 243 MB garbage pack + `git gc` | likely >1 GB | low, local-only |
| smaller **shared** history | history rewrite (filter-repo/BFG) | large | **breaks every clone** |

**Please do not do the third one casually.** It would invalidate onigensou's clone
and every branch either of us has. If you think it's genuinely warranted, raise it
first — that's a conversation, not a maintenance task.

## Why it got to 3.8 GB (so the decision is informed)

```
commits on origin/main                 2137
  touching worlds/…/data (LevelDB)      369
  touching worlds/…/_authored-export    214
  touching modules/ (code)             1548
```

The world LevelDB is currently ~56 MB of opaque binary that barely delta-compresses,
so each of those 369 world pushes wrote close to a full fresh copy into history
permanently. The 1548 code commits cost almost nothing by comparison. Today's
delivery added ~56 MB for both of us.

The only forward-looking lever that doesn't rewrite history is **pushing world data
less often** — e.g. reserving the full binary push for real handoffs and using the
export-JSON-only flow (a few hundred KB) for routine deliveries. Not proposing a
change, just naming the actual dial.

## The branch list, classified

**123 merged into `origin/main`** — content is on main; deleting them loses nothing.
This is the bulk, and it's where onigensou's read is correct.

```bash
git branch --merged origin/main | grep -v '^\*\|^  main$'   # review first
```

**14 `backup/` + `safety/` snapshots** — deliberate pre-pull safety commits from past
co-dev syncs, oldest 2026-06-18. Almost certainly disposable now, but they're
snapshots of *world state*, so please eyeball before dropping.

**15 branches with commits not on main — do NOT blind-delete these:**

```
feat/kirin-rail-stream-charge                2 commits  2026-08-26
feat/gacha-system-v2                        30 commits  2026-08-25
feat/roulette-ui-refinement                 16 commits  2026-08-10
feat/equipment-orbment-system               12 commits  2026-07-01
wip-boss-delivery-2026-06-23                 3 commits  2026-06-23
debug/host-crash-simultaneous-login          3 commits  2026-06-22
implement-out-of-combat-healing-system       1 commit   2026-06-19
port-passive-card-ui-into-battle-director    7 commits  2026-06-17
debug-multi-gm-behavior-in-battle-director   6 commits  2026-06-17
refine-cooking-system-ui                     3 commits  2026-06-13
config-monster-centauros                     3 commits  2026-06-05
implement-equipment-refinement-system       12 commits  2026-05-27
implement-sleep-soundly-minigame             6 commits  2026-05-21
tile-logic-round2                            3 commits  2026-05-13
refactor/action-pipeline-shared-utils     1195 commits  2026-05-08  ← yours
```

⚠ **`refactor/action-pipeline-shared-utils` is your branch**, tracking the
`companion` remote (the unrelated-history one). 1195 commits. Only you can judge it.

## ⚠ "Unmerged" does not mean "unshipped" — check content, not ancestry

`feat/kirin-rail-stream-charge` reads as 2 commits ahead of `origin/main`, which
looks like unpushed work. It isn't:

```bash
git diff --quiet origin/main feat/kirin-rail-stream-charge \
  -- worlds/fabula-ultima-2/_authored-export/actors/TvLv878yZLNUAWNN.json
# exit 0 — the Kirin doc is byte-identical
```

The work landed via a rebase/cherry-pick, so the *commits* aren't ancestors even
though the *content* is fully on main. Several of the other 14 are probably the
same shape. **Please compare authored-export content rather than trusting
`--no-merged`** before deciding any of them are dead — that's the check that
distinguishes "already shipped, safe" from "real work, keep".

## Suggested order, if you take it on

1. Drop `.git/objects/pack/tmp_pack_ntumta` — 243 MB, dated 12 July, flagged as
   `garbage` by `git count-objects -vH`. Unreferenced aborted pack.
2. `git gc` — 19,745 loose objects and 1,020 prune-packable want repacking.
3. Delete the 123 merged branches (review the list first).
4. Content-check the 15 unmerged ones, then decide individually.
5. Triage the 14 stashes (all labelled world-data churn, June–July).
6. Leave the shared 3.8 GB alone unless we've explicitly agreed otherwise.

Steps 1–2 are local-only and reversible in effect; 3–5 are onigensou's branches
and they are explicitly fine with you clearing them. Step 6 is the one with teeth.

## Notes

- Filed at onigensou's request as a delegation, not as a defect. They are comfortable
  with you deleting their local branches; they specifically do not want to run the
  deletions themselves.
- Whatever you decide, a one-line answer on this report is enough to close it —
  including "leave it alone", which is a legitimate outcome.
