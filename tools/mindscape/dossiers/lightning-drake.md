# Lightning Drake — Fafnir's summoned add (bolt)

> **Status: draft — placeholder monster.** Seeded 2026-10-21 from the Lightning Surge notes
> and `docs/fafnir-boss-design.md` §5.

## Identity & role

- Actor `mQlh6GTyw2449hXC`. L45 MONSTER/DRAGON **elite**.
- **An ADD, not a standalone fight.** Summoned in a pair with Flame Drake by ⭐️ Fafnir during
  her recovery phase. **Judge it only inside the Fafnir fight.**

## The gimmick

- Arc Volt (Paralyzed), Dragon Claw.
- **Amplify Bolt** ("+30 ally Bolt damage") would boost Fafnir's Ruinous Breath (Bolt) — the
  design doc keeps that synergy deliberately. Currently description-only — unimplemented.

```json dossier
{
  "monster": "Lightning Drake",
  "actorId": "mQlh6GTyw2449hXC",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "ADD — ⭐️ Fafnir's summon (with Flame Drake); never judge it alone",
  "exceptions": [],
  "invariants": [],
  "blind_spots": [
    "Amplify Bolt has no automation rows."
  ],
  "open_questions": [
    "Implement Amplify Bolt? If so, it buffs Ruinous Breath while the drakes live — size Breath with that in mind."
  ]
}
```
