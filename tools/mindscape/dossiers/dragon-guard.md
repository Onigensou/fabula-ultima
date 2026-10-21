# Dragon Guard — the castle's line soldier

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-31 build notes. Stats are read live
> from the world — the world wins.

## Identity & role

- Actor `tJCXrTtfLkrN9E57`, folder Monster / Fafnir Castle. L50 HUMANOID/DRAGON soldier, Fire.
- Fafnir Castle **line soldier**: 5 Encounter rows (pair, flanking Death Gazer / Roo / Iron
  Colossus, with Imps).

## The gimmick

- **Flame Breath:** heavy Fire to all, only vs 3+ enemies, round 1 allowed (a 1.5–2 round
  fight often never sees round 2). Its MP pool covers one breath — **the pool is the
  once-per-fight brake**.
- **Suppressing Sweep — PLACEHOLDER** (up to 2 + Slow), only at 1–2 enemies: reachable but
  uncommon, the right weight for a placeholder.
- Saber is the filler. VU ice, bow 175 / sword 60.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-31 | Built; breath gated enemy_count 3+, MP = one breath | line soldier | user (spec) | live: breath to all 3 |
| 2026-10-20 | Saber 25→44, Flame Breath 20→30, Sweep 15→25 | too-weak pass | user | — |

```json dossier
{
  "monster": "Dragon Guard",
  "actorId": "tJCXrTtfLkrN9E57",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Fafnir Castle line soldier (5 Encounter rows)",
  "exceptions": [],
  "invariants": [
    { "id": "breath-vs-groups", "table": "action_pattern_table", "where": { "action_pattern_name": "Flame Breath" }, "field": "action_pattern_value_1", "equals": "3",
      "why": "Breath only against 3+ enemies." },
    { "id": "ice-vulnerable", "affinity": "ice", "equals": "VU", "why": "Its one weakness." }
  ],
  "blind_spots": [],
  "open_questions": [
    "Suppressing Sweep is still a placeholder — what is its real design?"
  ]
}
```
