# Mana Ray — the MP thief the storm refills

> **Status: draft.** Seeded 2026-10-21 from the Lightning Surge notes (built 2026-08-16 as a
> structure-only placeholder). Stats are read live from the world — the world wins.

## Identity & role

- Actor `iGc0EUHE9LKWT0Ye`. L45 BEAST/AQUATIC soldier, Flying.
- Valley random encounter: surface with Ampere; Underground with Obsidrax + Ampere.

## Concept

An MP-economy soldier: it steals MP and turns it into damage, and the Lightning Rod's +30 MP
refills its whole pool — the intended hook.

## The gimmick

- **Mana Stinger:** burns 20% of the victim's MAX MP and adds that much damage. Split across
  **two reaction rows on purpose** — bonus on `will_deal_damage` (reads MP intact), drain on
  `deals_damage` (after). One row would let the drain land first and under-report its bonus.
- **Volt Stinger** (Bolt + Paralyzed), paid in MP; the Rod refills it.
- **Flying** at conflict start.
- 2 VU + 2 RS per the user's brief — outside the 1-VU rule, so it dies faster than its HP predicts.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-16 | Built as structure-only placeholder; 2 VU + 2 RS | user's brief | user | numbers expected to move |
| 2026-10-20 | Volt Stinger 40→55, Mana Stinger 24→39 | too-weak pass | user | — |
| 2026-10-31 | 1 surface + 1 Underground row. `Mana Ray x2` was replaced because it barely tested the party | Valley tables tightened to JRPG size: surface 1d28, Underground 1d40 | user | sim report in the commit |

```json dossier
{
  "monster": "Mana Ray",
  "actorId": "iGc0EUHE9LKWT0Ye",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Valley random encounter (1 surface + 1 Underground Encounter row)",
  "exceptions": [
    {
      "rule": "vu-count",
      "why": "2 VU + 2 RS per the user's brief (2026-08-16).",
      "decided_by": "user",
      "date": "2026-08-16"
    }
  ],
  "invariants": [
    { "id": "stinger-bonus-before-drain", "item": "Mana Stinger", "table": "reaction_config_table", "row": "stinger_bonus", "field": "reaction_trigger", "equals": "creature_will_deal_damage",
      "why": "The bonus must read MP before the drain lands." },
    { "id": "stinger-drain-after", "item": "Mana Stinger", "table": "reaction_config_table", "row": "stinger_burn", "field": "reaction_trigger", "equals": "creature_deals_damage",
      "why": "The drain fires on hit, after the bonus." },
    { "id": "flying", "item": "Flying", "table": "reaction_config_table", "row": "fly_apply", "field": "reaction_trigger", "equals": "conflict_start",
      "why": "Flying from the first turn." }
  ],
  "blind_spots": [],
  "open_questions": [
    "Still a placeholder — confirm the role it should play in its rows (the Rod refilling its pool is the stated hook)."
  ]
}
```
