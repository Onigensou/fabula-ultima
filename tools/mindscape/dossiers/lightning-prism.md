# Lightning Prism — the bolt battery that punishes bolt

> **Status: draft.** Seeded 2026-10-21 from the Lightning Surge roster notes (2026-08-01/16).
> Stats are read live from the world — the world wins.

## Identity & role

- Actor `sTGMdYipYCG36aBO`. L45 ELEMENTAL soldier.
- Valley random encounter, 9 rows (with slimes, Skizzik, Kirin, Ampere, Mana Ray, Obsidrax).

## Concept

A crystal that stores lightning: hit it with Bolt and it discharges back at you.

## The gimmick

- **Overcharge:** Bolt damage striking it (landed or absorbed) → a free Fulgur Finis (+10
  damage) on an enemy, paying its own MP. Uncapped — **MP is the limiter** (user-set economy:
  max MP ÷ cost = a fixed number of discharges).
- Overcharge's cause filter is **`damage` on purpose** — it EXCLUDES the Lightning Storm's
  hazard strike (the opposite of Skizzik/Kirin).
- **Physical shatters it** — VU physical + earth, and every weapon family at 25% except
  arcane. The roster interlock answer: Zarg/Blanche break the Prism.
- Arc Spark is the empty-tank fallback; Fulgur Finis (up to three targets) is the threat.

## Numbers & targets

- Prism MP economy is user-set (2026-08-01); the AI flips Fulgur → Arc Spark by MP band.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-01 | MP economy: max ÷ cost = N discharges, self-gating | MP is the limiter, no per-round cap | user | — |
| 2026-08-16 | Absorbed damage keeps its element (engine fix) | Overcharge could never fire | claude (fix) | — |

```json dossier
{
  "monster": "Lightning Prism",
  "actorId": "sTGMdYipYCG36aBO",
  "status": "draft",
  "aliases": ["Prism"],
  "updated": "2026-10-21",
  "role": "Valley random encounter (9 Encounter rows)",
  "exceptions": [
    {
      "rule": "vu-count",
      "why": "VU physical + earth is the interlock answer (physical shatters the Prism, earth answers the bolt roster).",
      "decided_by": "claude",
      "date": "2026-08-01"
    },
    {
      "rule": "absorb",
      "why": "Bolt absorb is the roster interlock: bolt feeds Overcharge.",
      "decided_by": "claude",
      "date": "2026-08-01"
    },
    {
      "rule": "basic-attack-min",
      "action": "Arc Spark",
      "why": "Arc Spark is the empty-tank fallback; Fulgur Finis (multi-target) and Overcharge are the threat.",
      "decided_by": "claude",
      "date": "2026-08-01"
    }
  ],
  "invariants": [
    { "id": "absorbs-bolt", "affinity": "bolt", "equals": "AB", "why": "Bolt feeds it." },
    { "id": "physical-shatters", "affinity": "physical", "equals": "VU", "why": "The interlock answer." },
    { "id": "overcharge-excludes-storm", "item": "Overcharge", "table": "reaction_config_table", "where": { "reaction_trigger": "creature_lose_resource" }, "field": "reaction_cause_filter", "equals": "damage",
      "why": "Deliberately excludes the Lightning Storm's hazard strike." },
    { "id": "overcharge-casts-fulgur", "item": "Overcharge", "table": "effect_table", "row": "overcharge_cast", "field": "action_ref", "equals": "Fulgur Finis",
      "why": "The discharge." },
    { "id": "arc-spark-is-fallback", "table": "action_pattern_table", "where": { "action_pattern_name": "Arc Spark" }, "field": "action_pattern_condition", "equals": "mp",
      "why": "Arc Spark only below the Fulgur MP band." }
  ],
  "blind_spots": [],
  "open_questions": [
    "Weapon EF 25% on every family except arcane 200% — intended as 'magic is the answer', or a leftover?"
  ]
}
```
