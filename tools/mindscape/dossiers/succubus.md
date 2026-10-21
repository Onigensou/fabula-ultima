# Succubus — turns a party member against the others

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-29 Fafnir Castle roster notes
> (placeholder) and the 2026-10-20 balance pass. Stats are read live from the world.

## Identity & role

- Actor `bnem1vdA6Bv3mBVx`, folder Monster / Fafnir Castle. L50 DEMON soldier.
- Fafnir Castle **debuffer**: 5 Encounter rows (with Dire Orc, Death Gazers, Iron Colossus).

## The gimmick

- **Charm:** DL15 INS+WLP save → Charmed + **Deadly Temptation** (a rider on the universal
  Charmed AE, so player Charm IM/RS and cures still work): the victim must spend their action
  harming an ally.
- **Draining Kiss:** Dark damage, heals half of what it deals.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-29 | Built (placeholder); Charm + Deadly Temptation rider | debuffer | user (spec) | rider resolution live-verified |
| 2026-10-20 | Draining Kiss 32→48, Rake 18→34 | too-weak pass | user | Rake text still says "light" |
| 2026-10-21 | Charm repeating every turn its condition holds: accepted | "already in the design when the monster is created" | user | audit pattern lint → intended |

```json dossier
{
  "monster": "Succubus",
  "actorId": "bnem1vdA6Bv3mBVx",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Fafnir Castle debuffer (5 Encounter rows)",
  "exceptions": [
    {
      "rule": "pattern",
      "why": "Charm firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created.",
      "decided_by": "user",
      "date": "2026-10-21"
    }
  ],
  "invariants": [
    {
      "id": "charm-rides-universal",
      "item": "Charm",
      "table": "effect_table",
      "row": "sc_hold",
      "field": "ae_template_ref",
      "equals": "Charmed",
      "why": "The universal Charmed AE, so player IM/RS and cures still apply."
    },
    {
      "id": "charm-temptation-rider",
      "item": "Charm",
      "table": "effect_table",
      "row": "sc_tempt",
      "field": "ae_template_ref",
      "equals": "Deadly Temptation",
      "why": "The 'attack your ally' half."
    },
    {
      "id": "kiss-heals-half",
      "item": "Draining Kiss",
      "table": "effect_table",
      "row": "sk_drain",
      "field": "grant_amount",
      "equals": "ceil(HP_DEALT * 0.5)",
      "why": "Heals half the HP damage (0 on MP damage)."
    }
  ],
  "blind_spots": [
    "The Charm save leg dispatches to players' clients — never exercised solo-GM.",
    "Mindscape does not simulate Deadly Temptation (Board card marks it)."
  ],
  "open_questions": [
    "Rake's description still says 'light' after the 18→34 raise — retext?"
  ]
}
```
