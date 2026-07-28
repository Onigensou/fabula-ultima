# reports/ — shared bug reports

A bug report is a **file in this repo**, not a message. File one here and it travels
with the next push; the other side's next pull announces it automatically.

Two people work on this repo from separate machines with separate Claude sessions.
Before this, a bug found on one side had to be copy-pasted into a chat on the other,
and once the conversation scrolled the bug was gone. A report here has a *state* that
neither side can silently drop, and it stays attached to the code it describes.

## One file per report

```
reports/2026-07-28-botc-summon-max.md
```

Named `YYYY-MM-DD-short-slug.md`. The date prefix means two people filing the same
day never collide, and — deliberately — **there is no index file**. Listings are
derived by scanning this directory, because an index is the one thing both sides
would edit at once, and therefore the one thing that would conflict.

## The front-matter is the state

```yaml
---
id: 2026-07-28-botc-summon-max
title: Birth of the Cruel never spawns its minion
status: open          # open | fixed | verified | wontfix
severity: blocker     # blocker | major | minor | cosmetic
reporter: onigensou   # who found it — verifies the fix
assignee: sarunphat   # who owns the fix
component: battle-director/skill-effects
introduced_in:        # sha that caused it, when known
fixed_in:             # sha that fixed it — set when status -> fixed
---
```

Everything below the fences is free-form prose. Useful sections: **Symptom**,
**Root cause**, **Evidence**, **Repro**, **Suggested fix**, **Notes**. Keep `Notes`
append-only so the back-and-forth reads as a thread in `git log -p`.

Include enough that the other side never has to ask a follow-up: the exact console
output, `file.js:line`, and steps that reproduce it.

## The loop

| step | who | what |
|---|---|---|
| 1 | reporter | add the file, `status: open`, commit, push |
| 2 | fixer | pull — the hook prints it | 
| 3 | fixer | fix, commit with trailer `Report: <id>`, set `status: fixed` + `fixed_in`, push |
| 4 | reporter | pull — hook says "awaiting your verify"; re-run the repro |
| 5 | reporter | set `status: verified`, push |

Status changes are ordinary edits — one word plus a sha. The tooling below is a
convenience, never a requirement; hand-editing is completely fine.

## Reading them

```bash
node tools/bug-report/bin/report-digest.js --inbox            # what needs me
node tools/bug-report/bin/report-digest.js --list --status open
node tools/bug-report/bin/report-digest.js --show botc-summon-max
```

## The announcement (do this once per clone)

```bash
git config core.hooksPath tools/safe-edit/hooks
```

`post-merge` and `post-checkout` print any report that changed in a pull. **Git does
not share `core.hooksPath`** — it is local config, so each clone sets it once. It is
the same setting the world-export `pre-commit` gate already needs, so it is probably
already set; `git config --get core.hooksPath` confirms.

Without it nothing breaks — reports still arrive, they just do not announce
themselves, and `--inbox` covers it manually.

Caveat: `post-merge` fires on merge/fast-forward pulls. `git pull --rebase` runs
`post-rewrite` instead and is not wired — run `--inbox` after a rebase pull.

## Housekeeping

Move `verified` reports older than ~60 days into `reports/archive/` (skipped by the
digest) so the inbox stays fast and this directory stays readable.
