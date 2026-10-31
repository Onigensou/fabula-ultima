# Iron Colossus — the super tank

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-29 roster notes and the user's
> 2026-10-20 concept. Stats are read live from the world — the world wins.

## Identity & role

- Actor `FLy3XRr40wNRmYxV`, folder Monster / Fafnir Castle. L52 CONSTRUCT/GOLEM **elite**.
- Fafnir Castle **tank**: 5 Encounter rows, always with escorts (Dire Orcs, Succubi, Death
  Gazer, Dragon Guards + Imps).
- Token deliberately bigger than Gigas (2.77) — it is the wall.

## Concept

**Super tank** (user, 2026-10-20): takes ~4 actions to kill at 100% efficiency, VU bolt +
heavy EF as the answer, high DEF / moderate MDEF. Cheap damage, paid in denial (Gigas precedent).

## The gimmick

- Golem Fragment shields allies; Grinding Quake (Earth to all) and Seismic Stomp (Multi 3)
  spread chip damage while the escort does the killing.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-29 | Built as tank (~4.4 TP elite, cheap DPS) | tank archetype, Gigas precedent | user (spec) | — |
| 2026-10-20 | Concept restated: 4 actions at 100% efficiency; measured HP 480 proposed | rows stall (party has no heavy weapon) | user | options b/c NOT applied |
| 2026-10-21 | Grinding Quake repeating every turn its condition holds: accepted | "already in the design when the monster is created" | user | audit pattern lint → intended |
| 2026-10-31 | Golem Fist 6% added to steal, (Empty) 42 → 36 | Galvanize Golem was its only source and became a cave beast | user | — |

```json dossier
{
  "monster": "Iron Colossus",
  "actorId": "FLy3XRr40wNRmYxV",
  "status": "draft",
  "aliases": [
    "Colossus"
  ],
  "updated": "2026-10-21",
  "role": "Fafnir Castle tank, always escorted (5 Encounter rows)",
  "exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Siege Fist",
      "why": "Tank archetype: cheap damage, paid in denial — the escort does the killing (Gigas precedent).",
      "decided_by": "claude",
      "date": "2026-08-29"
    },
    {
      "rule": "resisted-min",
      "action": "Siege Fist",
      "why": "Same tank trade: its hits are meant to be soft.",
      "decided_by": "claude",
      "date": "2026-08-29"
    },
    {
      "rule": "pattern",
      "why": "Grinding Quake firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created.",
      "decided_by": "user",
      "date": "2026-10-21"
    }
  ],
  "invariants": [
    {
      "id": "bolt-vulnerable",
      "affinity": "bolt",
      "equals": "VU",
      "why": "The answer to the tank (user concept 2026-10-20)."
    }
  ],
  "blind_spots": [
    "The party has no heavy weapon today, so the heavy-EF answer is not available in sims — rows stall."
  ],
  "open_questions": [
    "Awaiting your choice from 2026-10-20: (b) 1 escort or (c) 320 HP — both ~6 rounds; or keep the sheet as is?"
  ]
}
```
