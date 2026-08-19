---
id: 2026-08-19-ae-add-mode-flags-compound
title: ADD-mode ActiveEffects targeting flags.* compounded once per prepareData — fixed, no action needed, but worth knowing
status: verified
severity: major
reporter: onigensou
assignee: sarunphat
component: syntax-extender/conditional-change-gate
introduced_in: cc7356d0
fixed_in: 911f48b1
---

# An effect named "Provoke SL+1" was granting +11

Nothing here needs doing on your side — it is fixed on `main` and the world data
is cleaned. This is a heads-up, because the failure shape is subtle, it hid for
five weeks, and it will bite again the moment anyone authors gear with a new
ADD-mode flag change.

## What happened

`seedAeAccumulators()` in `syntaxExtender-conditionalChangeGate.js` exists
precisely for this, and its own comment states the rule:

> the base must reset every pass or it would compound across passes

It seeded `damage_taken_mult`, `damage_dealt_mult_*` and
`damage_taken_increased_*`. It did **not** seed `skill_level_bonus_*`,
`check_mod_*` or `opp_lucky`. Those three compounded.

The asymmetry is a Foundry detail worth internalising: **Foundry rebuilds
`system` from `_source` on every `prepareData`, so an ADD-mode change always
lands on a clean base. `flags` is cloned once at `_initialize` and then reused** —
so an ADD-mode change targeting `flags.*` adds to its own previous output, once
per derivation.

## Evidence

Three consecutive `prepareData()` calls, no writes in between, with a `system`
prop as the control:

```
Blanche  flags…skill_level_bonus_provoke    12 -> 13 -> 14     (_source 11, stable)
Keren    flags…check_mod_dex                 6 ->  9 -> 12     (_source  3, stable)
Blanche  system.props.defense               19 -> 19 -> 19     <- system is fine
```

The runtime climb is the bug. The on-disk numbers are just old captures of it —
each saved session froze whatever the counter had reached. Blanche's stored value
walked the whole way up:

```
Jul 10  1     Jul 18  6     Jul 20  10   <- plateau
Jul 11  2     Jul 18  7     Aug 19  11
Jul 11  3     Jul 19  8
Jul 12  5     Jul 19  9
```

Save slots carried it too (`slot-1` held provoke 12 / check_mod_dex 6), so
loading an older save re-injected a *higher* number than the world had.

## Why it survived five weeks of procedure

Worth calling out, because none of our existing gates were ever going to catch it:

- `world-export` diffs authored content against HEAD. These are flags inside the
  actor document, and they moved **one point at a time** — indistinguishable from
  ordinary play state in a diff.
- `preflight` has no rule for "AE-derived value persisted into source".
- It surfaced only because an unrelated diff review asked why a `+5 Paladin Armor`
  rename appeared. That line was innocent (a stale sheet mirror catching up from a
  2026-08-02 refinement). The real bug was one row below it in the same diff.

## The third one was a live gameplay leak

`opp_lucky` is the `requiresFlag` gate on the Bunny Tail's **Lucky** Opportunity —
*roll 5d100, gain that much Zenit*, `gmApproveNeeded: false`. Hina's Bunny Tail is
unequipped **and** its AE is disabled, so she should have had no access. The
stranded `opp_lucky: 1` in source made `getFlag` read truthy anyway, so Lucky was
being offered on every Opportunity with the accessory off — averaging ~252 free
Zenit a proc, with no GM approval step in the path to notice it.

That one is not a stat being wrong on a sheet; it is currency entering the economy.

## Fix

`911f48b1`, in the existing style of the function:

- `check_mod_{dex,ins,mig,wlp}` -> 0 (bounded set, the four rolled attributes)
- `opp_lucky` -> 0, so *disabling* its mode-5 effect actually clears it
- open-ended ADD-mode fu flags -> 0, derived from the actor's own applicable
  effects, because `skill_level_bonus_<slug>` cannot be enumerated the way the
  fixed lists can. Explicitly seeded keys are skipped — those encode a specific
  identity (1 for MULTIPLY, 0 for ADD).

Verified live after reload — all three stable across four derivations at their
correct values: Provoke **1**, `check_mod_dex` **3**, `opp_lucky` **0**. Keren's 3
is the positive control that legitimate stacking survives: Cat Ears +1 and
Swimsuit +2 still compose. Multiplier seeds still read 1.

`6f973abd` then removed the three baked-in source values. Keys were removed rather
than zeroed — they are pure runtime accumulators, so the effects should be the
only source of truth. Re-audit across all 290 actors: **0 remaining**, down from 3.

## What this means for you

**The fix is code-only** (`911f48b1`, one file, +40 lines). It works on your world
immediately on pull, because it re-seeds the base every pass rather than depending
on cleaned data.

**Your world data is probably still polluted.** The `chore` commit cleaned our
three actors; if you run a separate world copy, yours will still have inflated
values stored. They are inert after the engine fix, so nothing needs coordinating —
but the audit is cheap if you want the data tidy. The shape to look for is any
numeric `flags["fabula-ultima-companion"].*` that is non-zero and has an ADD-mode
AE writing to it.

**Do not naive-FF our push range.** It touches `data/actors` (17), `data/items` (8)
and `data/tables` (4) — the usual whole-LevelDB adoption risk from
`2026-07-17`. If you only want the accumulation fix, take `911f48b1` alone; it is
self-contained and touches nothing under `worlds/`.

## The rule going forward

Any new gear rider that ADDs to a `flags.fabula-ultima-companion.*` key needs its
base seeded. The open-ended branch now handles that automatically for
single-segment keys, so in practice: **if you add a new bounded family, add it to
the explicit list; if you add a new `<prefix>_<slug>` family, it is already
covered.** MULTIPLY families still need an explicit seed of 1 — the dynamic branch
only ever seeds 0, since it cannot know the intended identity.

## Correction to an earlier report of mine

While tracing this I claimed internally that the `*_ef` creature-type field family
(`construct_ef`, `dragon_ef`, …) was how type-scaled damage was meant to work, and
that Dragonslayer Pendant was inert. **That was wrong**, and
`2026-07-31-dragonslayer-species-vs-subtype` already had it right: the pendant
works through `Dragonslayer Pendant (gear skill)` with
`condition_formula: TARGET_SUBTYPE_IS_DRAGON` + `adjust_damage` ×1.5 outgoing. The
27 `*_ef` fields on the item template are unused scaffold — no reader in the module,
no macro, and no item in the world carries a non-default value. Not a bug, just
dead template surface; flagging it only so nobody re-derives it as a missing feature.
