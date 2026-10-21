# Dire Orc — the bruiser that gets meaner when hurt

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-29 Fafnir Castle roster notes
> (placeholder). Stats are read live from the world — the world wins.

## Identity & role

- Actor `rftRuHZwWx5SiNpH`, folder Monster / Fafnir Castle. L50 MONSTER/DEMI-HUMAN soldier.
- Fafnir Castle **midrange bruiser**: 6 Encounter rows (pair, with Imps, Succubi, Death
  Gazer, Iron Colossus).

## The gimmick

- **Brutish Fury:** at half HP or below, +25 damage on all its attacks — burst it from the
  top or end it fast once it turns.
- **War Howl:** Shaken on all enemies.
- Skull Splitter (Pierce) is the spike; Cleaver the filler.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-29 | Built (placeholder); Brutish Fury gate live-verified at exactly half HP | midrange bruiser | user (spec) | — |
| 2026-10-21 | War Howl repeating every turn its condition holds: accepted | "already in the design when the monster is created" | user | audit pattern lint → intended |

```json dossier
{
  "monster": "Dire Orc",
  "actorId": "rftRuHZwWx5SiNpH",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Fafnir Castle midrange bruiser (6 Encounter rows)",
  "exceptions": [
    {
      "rule": "pattern",
      "why": "War Howl firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created.",
      "decided_by": "user",
      "date": "2026-10-21"
    }
  ],
  "invariants": [
    {
      "id": "fury-at-half-hp",
      "item": "Brutish Fury",
      "table": "reaction_config_table",
      "row": "do_rage",
      "field": "condition_formula",
      "equals": "CUR_HP * 2 <= MAX_HP",
      "why": "The half-HP turn is the gimmick."
    },
    {
      "id": "fury-plus-25",
      "item": "Brutish Fury",
      "table": "effect_table",
      "row": "do_rage",
      "field": "damage_amount",
      "equals": "25",
      "why": "The size of the turn."
    }
  ],
  "blind_spots": [],
  "open_questions": []
}
```
