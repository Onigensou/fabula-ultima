---
id: 2026-07-31-dragonslayer-species-vs-subtype
title: Dragonslayer Pendant was inert because "dragon" lives in subtype_list, not species
status: verified
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/skill-formulas
introduced_in: 8af5796e
fixed_in: dce32111
---

# TARGET_SPECIES_IS_DRAGON can never be 1 in this world

Your commit message called this out already ("correct but INERT: no DRAGON-species
actor exists") and left re-speciating as a design call. The design call has been
made, and it is neither of the two options you were choosing between: **the dragons
are already tagged, just on a different field.**

Every dragon here is `species: MONSTER` and carries its real kind in
`system.props.subtype_list`:

```
⭐️ Fafnir           species=MONSTER  subtype_list=DRAGON
⭐️ Bandit Fafnir    species=MONSTER  subtype_list=DRAGON
Flame Drake         species=MONSTER  subtype_list=DRAGON
Lightning Drake     species=MONSTER  subtype_list=DRAGON
```

So nothing needs re-speciating — `species` is the coarse FU bucket and the world
has consistently used `subtype_list` for the fine one (121 actors carry it, 14
distinct values: HUMAN 39, SPIRIT 13, GOLEM 6, GORGER 5, DRAGON 4, …).

## Fix

Added the sub-species twins of the existing species identifiers in
`skill-formulas.js`, right after the `TARGET_SPECIES_IS_` block:

```
SUBTYPE_IS_<X>          reads the RESOLVER actor's  system.props.subtype_list
TARGET_SUBTYPE_IS_<X>   reads the trigger SUBJECT's system.props.subtype_list
```

Same conventions as their species twins (case-insensitive, `_` → space, absent
prop → 0). One deliberate difference: the prop is a *list* by name, so the matcher
splits on `,`/`;`/`|` and matches ANY entry. It is single-valued in the current
data, but a future `"DRAGON, UNDEAD"` actor will answer 1 to both without a
follow-up change.

`Dragonslayer Pendant (gear skill)` gate retargeted to `TARGET_SUBTYPE_IS_DRAGON`.

## Evidence (live, after reload)

```
actor              species  subtype    SUBTYPE_IS_DRAGON  TARGET_SUBTYPE_IS_DRAGON  old TARGET_SPECIES_IS_DRAGON
⭐️ Fafnir          MONSTER  DRAGON     1                  1                         0
⭐️ Bandit Fafnir   MONSTER  DRAGON     1                  1                         0
Flame Drake        MONSTER  DRAGON     1                  1                         0
Lightning Drake    MONSTER  DRAGON     1                  1                         0
Salamander         BEAST    REPTILIAN  0                  0                         0
Hellhound          BEAST    (blank)    0                  0                         0
```

The old identifier resolving 0 against all six is the direct confirmation that the
pendant could never fire.

`skill-regression`: 482/482 match golden after the engine edit — purely additive.

## Not verified

The pendant's ×1.5 is an **outgoing-stage** `adjust_damage`, and
`applyAdjustDamageMutation` explicitly owns only the incoming stage
(`card-mutations.js:1184-1186`) — outgoing rides `computeSenderDamageBonuses` at
RESOLVE. So I verified the *gate*, not the multiplier arriving on a card. That path
is your existing sender-bonus plumbing and was never the broken part, but it has
not been seen firing end-to-end against a live dragon.

## Notes

- If you would rather the gate read species after all, re-speciating 4 actors is
  still open — but it would break `SPECIES_IS_MONSTER` for them, which currently
  resolves 1.
