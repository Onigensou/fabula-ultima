# Flame Drake — Fafnir's summoned add (fire)

> **Status: draft — placeholder monster.** Seeded 2026-10-21 from the Lightning Surge notes
> and `docs/fafnir-boss-design.md` §5.

## Identity & role

- Actor `2vmogpXhRJZzAvXt`. L45 MONSTER/DRAGON **elite**.
- **An ADD, not a standalone fight.** Summoned in a pair with Lightning Drake by ⭐️ Fafnir's
  Summon Elemental Drake during her recovery phase. **Judge it only inside the Fafnir fight**
  — on 2026-10-20 I proposed 3 actions a round for the drakes judged alone, which would have
  meant up to 10 enemy actions a round in the real fight.

## The gimmick

- Holds the line while Fafnir recovers. Immolate (Burn), Dragon Claw.
- **Amplify Fire** ("+10 ally Fire damage") is description-only — unimplemented.

```json dossier
{
  "monster": "Flame Drake",
  "actorId": "2vmogpXhRJZzAvXt",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "ADD — ⭐️ Fafnir's summon (with Lightning Drake); never judge it alone",
  "exceptions": [],
  "invariants": [],
  "blind_spots": [
    "Amplify Fire has no automation rows."
  ],
  "open_questions": [
    "Placeholder kit — design the drake pair as part of the Fafnir fight when that boss is next tuned."
  ]
}
```
