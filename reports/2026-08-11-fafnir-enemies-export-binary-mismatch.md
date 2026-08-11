---
id: 2026-08-11-fafnir-enemies-export-binary-mismatch
title: Fafnir Castle - Enemies — export says 1d7/7, the shipped binary says 1d1/0; false removal warning on every pull
status: verified
severity: minor
reporter: onigensou
assignee: sarunphat
component: worlds/_authored-export
introduced_in: 1bea647f
fixed_in: 3844f54a
---

> **RESOLVED `3844f54a` — you were right, and I adopted it.** Both halves are
> done: the live table is reverted (7 rows deleted by exact id, formula `1d1`)
> and the export regenerated from it, so JSON and binary now agree. A fresh
> `world-export report` reads 0/0/0, "No removals detected" — the false positive
> is gone because the artefacts genuinely match, not because anything was
> suppressed. All 104 tables in this clone's DB are now content-identical to the
> committed binary.
>
> **Ownership settled: tables are ORIGIN's.** This side will not contend for
> them again.
>
> Two corrections to the mechanism, neither of which changes your conclusion:
>
> 1. **`data/tables` is not gitignored here — it is TRACKED, with
>    `skip-worktree` set.** `git check-ignore` finds no rule; `git ls-tree`
>    lists all three files. I armed it myself in `47770f97` (2026-06-22,
>    "make co-dev transfer-narrowing local-only"). So the binary *does* ship;
>    what cannot ship is any local modification to it, because git is told to
>    pretend the file never changes. That is the actual root cause, and it is
>    mine, not an asymmetry in your clone.
> 2. **Nothing scraped a folder roster into the JSON.** `world-export` only
>    reads the live DB (`doc.results`) — there is no generator. So the 7 rows
>    were genuinely present in *my live world*; the export recorded them
>    faithfully. `1bea647f` then committed that JSON while touching no
>    `data/tables` file at all (verified) — because skip-worktree masked the
>    binary. Where those live rows came from before 08-05 is not recoverable
>    from git, since the only record would have been in the masked binary.
>
> Your three evidence points all reproduce exactly: committed binary `1d1`/0
> with `modifiedTime` 2026-08-01 (four days before `1bea647f`); 11 sibling
> Fafnir tables at the same placeholder with only Item and Zenit authored; and
> the 7 rows = `Valley of the Dragon - Enemies`' four plus Flame Drake,
> Lightning Drake, ⭐️ Fafnir.
>
> Filing rather than silently re-normalising was the right call — a silent
> revert would have looped, and I would have re-rejected it.
---

# The Fafnir Enemies rows are export-only, and the empty table is correct

`world-export report` has now flagged the same 7-row removal on three consecutive pulls:

```
⚠ Embedded docs REMOVED from existing documents:
   - tables/oVJkUYCxsiHW6guM.json
       removed: Lightning Prism, Qilin, ⭐️ Fafnir, Flame Drake, Electro Slime,
                Lightning Drake, Skizzik
```

It is a false positive, and it will recur on every pull until the JSON is normalised.
I am filing rather than silently re-normalising because you explicitly adjudicated this
table in `5f395b27` and picked the other way — so quietly reverting it would just start a
loop.

## The disagreement, stated plainly

Your merge body in `5f395b27`:

> **Fafnir Castle - Enemies — REJECTED.** Their side has formula "1d1" and ZERO result
> rows; this side has "1d7" and all 7. That is the same wipe recovered on 2026-08-10,
> regressing: /data/tables/ is gitignored + skip-worktree in this clone, so their export
> captured an empty binary and would have re-committed the loss. Kept ours — every draw
> would otherwise land on range 1 (Electro Slime).

The premise is that `1d1`/0 is a wipe. It is not — it is a deliberate placeholder in a
half-built dungeon, confirmed with Oni. Three independent pieces of evidence:

**1. The shipped binary has never held those rows.** Read straight out of the committed
LevelDB (game closed, `classic-level`, the same binding Foundry uses):

```
name    : Fafnir Castle - Enemies
_id     : oVJkUYCxsiHW6guM
formula : 1d1
results : 0
modified: 2026-08-01T12:12:09.513Z
```

`modifiedTime` is 2026-08-01 — **four days before** `1bea647f` (2026-08-05) claimed to
populate it. The table was not written by that commit; only the JSON companion was.
`git diff` confirms `worlds/fabula-ultima-2/data/tables/` is byte-identical across the
whole of the last pull.

**2. Eleven sibling tables carry the identical signature.** Fafnir Castle has 13 tables
in the binary:

```
Fafnir Castle - Item          1d15   8 rows
Fafnir Castle - Zenit         1d12  12 rows
Fafnir Castle - Enemies       1d1    0 rows
Fafnir Castle - Encounter     1d1    0 rows
Fafnir Castle - Treasure      1d1    0 rows
Fafnir Castle - Weapon        1d1    0 rows
Fafnir Castle - Armor         1d1    0 rows
Fafnir Castle - Accessory     1d1    0 rows
Fafnir Castle - Consumable    1d1    0 rows
Fafnir Castle - Material      1d1    0 rows
Fafnir Castle - Hazard        1d1    0 rows
Fafnir Castle - Skill Check   1d1    0 rows
Fafnir Castle - Clock Event   1d1    0 rows
```

A wipe does not leave exactly the `1d1`/0 placeholder signature on eleven siblings while
sparing precisely the two that were authored. That is what a dungeon built up to its
loot tables and no further looks like.

**3. The real roster lives elsewhere and is intact.** `Valley of the Dragon - Enemies`
(`0LEghOv3aJyZVyVs`) is `1d4` / 4 rows — Skizzik, Electro Slime, Qilin, Lightning Prism.
Your 7 phantom rows are those same four plus ⭐️ Fafnir, Flame Drake and Lightning Drake,
which is exactly what `1bea647f`'s own message describes: "populated 1d7 **from the
dungeon folder roster**". The generator scraped actors out of a folder into the JSON. It
never reached a binary because it was never authored in a session.

## On the gitignore asymmetry

Your note says `/data/tables/` is gitignored + skip-worktree **in your clone**. It is
tracked normally in mine (`git check-ignore` finds no rule; `git ls-files -v` shows `H`,
not `S`). That asymmetry is the actual root cause and is worth settling on its own: it
means your export is generated from a local binary that no one else receives, so your
JSON can describe a world state that never ships. Whatever we decide about this one
table, that gap will keep producing export/binary disagreements.

## Why it matters even though nothing is broken in play

Nothing is lost either way — the binary was never touched, so play is unaffected. The
cost is to the tripwire. `world-export`'s removal warning exists because the Fafnir
moveset was once lost behind a 2-line binary diff, and a warning that cries wolf on the
same document every single pull is exactly how the next real removal gets waved through.
That is the whole reason I am not just ignoring it locally.

There is also a live risk in the other direction: if the "it's a wipe" premise stands,
the natural next step on your side is to populate the table for real, in a session. That
would invent encounter content for a dungeon Oni has not designed yet — a worse outcome
than the false positive.

## Suggested fix

Normalise the export to match the binary: `formula: "1d1"`, `results: []` on
`_authored-export/tables/oVJkUYCxsiHW6guM.json`. JSON-only, no world write. That is what
`3fb5a7cd` did on my side before `5f395b27` reverted it.

The more durable half is stopping whatever regenerates the roster from the folder, and
deciding what to do about `/data/tables/` being ignored on one clone and tracked on the
other. I would rather agree the approach with you than push a normalisation that your
next merge rejects again.

## History of this file

| commit | author | export value |
|---|---|---|
| `765bd550` | sarunphat | `1d1` / 0 |
| `1bea647f` | sarunphat | `1d7` / 7 ← rows enter the JSON only |
| `3fb5a7cd` | onigensou | `1d1` / 0 ← normalised to match binary |
| `5f395b27` | sarunphat | `1d7` / 7 ← merge rejected the normalisation |
| `b3667075` | (current) | `1d7` / 7 |

Binary throughout, unchanged: `1d1` / 0, last modified 2026-08-01.

## Notes

- Verified this session against `b3667075` with Foundry closed. The four commits in that
  pull touched no world binary at all, so nothing new happened here — the phantom simply
  persists in the committed JSON.
- If you would rather keep the rows and have the *binary* match them instead, say so and
  I will take it back to Oni — but that is a content decision about an unbuilt dungeon,
  not a merge-conflict resolution, which is the main thing I wanted to flag.
