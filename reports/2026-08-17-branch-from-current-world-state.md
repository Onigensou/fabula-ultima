---
id: 2026-08-17-branch-from-current-world-state
title: session-2026-08-17 branched one commit behind a pushed world change — please start branches from current origin/main
status: fixed
severity: minor
reporter: onigensou
assignee: sarunphat
component: process/world-data
introduced_in: 930406d9
fixed_in: bf584068
---

# Please pull before branching when the work touches world data

Your `session-2026-08-17` work is good and all of it landed — engine, harness,
tooling and all five documents are on `main` as of `bf584068`. Nothing was
rejected and nothing needs redoing. This is a request about *where the branch
started*, not about what was in it.

The branch forked from `a35b3b64`, which is **one commit before** `173ab2a4`
(the Kirin moveset), and `173ab2a4` was already on `origin/main` when your first
commit was made:

```
01:49  a35b3b64  sarunphat   ← your branch point
02:09  173ab2a4  onigensou   ← Kirin moveset, pushed to origin/main
03:18  930406d9  sarunphat   ← first commit of session-2026-08-17
```

69 minutes. So the newer world state was fetchable and simply wasn't taken.

## Why this one is expensive, when a stale code branch is not

Code merges. The world LevelDB does not — it is opaque binary, and any
merge or fast-forward takes **one side's entire database**. There is no
per-document resolution at the git layer.

Your branch's world DB therefore carries the pre-Kirin actor. This is not
inference; the blobs are byte-identical:

```
your TvLv878yZLNUAWNN.json   b69e828ca93560a5e1428e496f66f6dfc369c7d3
pre-Kirin (a35b3b64)         b69e828ca93560a5e1428e496f66f6dfc369c7d3   ← same
current main                 d0e397a4a8ab04a2e22c575f5b1f07d2fa7a2f9a
```

Merging your branch normally would have reverted 177 insertions of Kirin
authoring, silently, with no textual diff to notice it in — the same failure
class `world-export` exists to catch.

## What it cost to land instead

The branch could not be merged; it had to be taken apart:

- code adopted by path (`git checkout <branch> -- <11 paths>`), never by merge,
  because a cherry-pick would have dragged `data/**` along with it;
- the five documents re-applied one at a time via `world-import --only --ref`;
- `merge -s ours` to record the branch without letting its world data through;
- **two hand-prunes**, because `world-import` is non-destructive by contract and
  therefore cannot replay a *removal*:
  - Quaking Titan `effect_table` row 3 (`qt_visible_enemies`), orphaned once row 2
    moved to `hit_action_targets`;
  - Keren / Cognitive Focus — 7 intra-row keys your `36f320d3` removed but the
    upsert restored by deep-merge: `cf_pick` kept `menu_title` /
    `menu_option_refs` / `menu_option_labels` (the dead `cf_ally`/`cf_enemy` menu
    you identified), and `cf_apply` kept `candidate_source` / `category` /
    `mode` / `count`.

The second one is the part worth knowing about: **the import reported success
and the document still did not match your intent.** Neither `world-import plan`
nor `world-export report` can see it — `plan` counts upsert candidates, and
`report` sees no removals because doc counts are unchanged. Only
`skill-regression structure` caught it.

If you take one thing from this report, take that: **run `structure` after any
`world-import`.** It is the only check that surfaces what a non-destructive
importer left behind.

## Related, same root cause: your structure golden is stale against your own branch

`goldens/structure.json` was last re-baselined in `36f320d3` (commit 2 of 6),
but `08586661` (commit 5) blanked `passive_logic_action` on the three
Hypercognition carriers. So the golden shipped still carrying the 264-char
seeded value that your own commit deleted:

```
~ (world) / Hypercognition   props.passive_logic_action: "#sha1:7f0b3ab3… (264 chars)" → null
~ Esper   / Hypercognition   props.passive_logic_action: "#sha1:7f0b3ab3… (264 chars)" → null
~ Keren   / Hypercognition   props.passive_logic_action: "#sha1:7f0b3ab3… (264 chars)" → null
```

I re-baselined on this side (2088 docs, includes Kirin), so `main` is correct
now — flagging it only because a golden that disagrees with its own branch is
the kind of thing that reads as a regression to whoever pulls it next.

## The ask

Before starting a branch that will touch `worlds/**`:

```
git fetch origin
git checkout -b <branch> origin/main     # not whatever was checked out last
```

and if world data moved under you mid-session, reconcile before you commit
rather than after. If you deliberately need an older base, say so in the branch
or the first commit body and I will plan the reconcile around it — the problem
is never that the base is old, only that it is old *silently*.

Your next branch should start from `bf584068` or later, which already contains
everything from `session-2026-08-17`.

## Notes

- Verified with Foundry closed for export/checks and open for the import.
- Post-reconcile state: compute regression 489/489 clean against the golden;
  `structure` clean at 2088 docs; `world-export report` 0 added / 0 removed /
  5 modified — exactly your five documents; Keren 60 embedded items and Esper 16
  both before and after, so no duplication from the upsert.
- `on_condition_fail` is byte-neutral across the 489-skill corpus, as your
  `da0e93fa` predicted. Your note that no skill currently exercises the refusal
  path still stands — the corpus evidences non-regression, not the fix.
- `skills-simulate.json` was left alone on both sides. Your caveat in `a5bb717c`
  is still the live state: the unreviewed 19 new / 12 removed needs a clean
  sweep before anyone trusts that suite.

## Notes

**2026-08-23 — ask adopted; closing as fixed.** Setting `status: fixed` (the
`fixed_in: bf584068` above is your reconcile, not a change of mine) so it stops
re-announcing on every pull. The request was right and it has been followed
since — checked by ancestry rather than by memory:

| our world-touching commit | contains your latest world work |
|---|---|
| `9f3ee4c2` (2026-08-23) | `a6060208` ✓ and `502fca88` ✓ |
| `4aafe6ed` (2026-08-19) | `06bf8470` ✓ |

and there has been no reconcile, `merge -s ours`, or hand-prune on your side
since `bf584068`. Right now `origin/main` is an ancestor of local `main` and
`git diff origin/main main -- worlds/` is empty, so nothing is diverged.

The two operational rules from this report are carried in our working notes and
are being applied:

- **branch from current `origin/main` when the work touches `worlds/**`** — and
  say so explicitly if an older base is ever deliberate;
- **run `skill-regression structure` after any `world-import`** — your point that
  neither `world-import plan` nor `world-export report` can see what a
  non-destructive upsert left behind (the Cognitive Focus intra-row keys) is the
  most useful thing in this report, and it is the one that would have been
  re-learned the expensive way.

Reopen this if you see a stale base again — the failure is silent by
construction, so your side noticing is the only detector we have.
