# Mist Dragon — physical-proof until the wind scatters it

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-26 build + live-test notes.
> Stats are read live from the world — the world wins.

## Identity & role

- Actor `8kluKkqkcGFkmXNO`. L45 ELEMENTAL/DRAGON **elite**, WIND.
- Valley random encounter, 2 rows (with Obsidrax; with Mana Ray + Drakoza).
- Exists so the **Dragonslayer Pendant** has targets; claims Air.

## Concept

A dragon made of mist: weapons pass through it until the wind blows it apart. It mimics
the valley's other creatures.

## The gimmick

- **Illusory Form:** Resistant to Physical — carried on an **AE**, NOT on the sheet's
  physical affinity, precisely so it can be stripped. Air damage scatters it until the end
  of the round; it re-gathers at round end. **Air is both its VU and its off-switch** (the
  RAW Flying loop).
- **Phantom Shift is a FIXED repertoire, not real mimicry** (user chose Option A): Thunder
  Strike (spike), Venomstone Spines (spread), Mana Stinger (MP drain), all re-cast in Air
  with Blind riders.
- Mist Breath (heavy Air, 50% Blind) dominates while MP ≥ 50%.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-26 | Built: Illusory Form, fixed Phantom Shift repertoire | Option A — true mimicry not expressible in data | user | Illusory Form loop live-verified |

```json dossier
{
  "monster": "Mist Dragon",
  "actorId": "8kluKkqkcGFkmXNO",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Valley random-encounter elite (2 Encounter rows); Dragon-subtype target",
  "exceptions": [],
  "invariants": [
    { "id": "air-vulnerable", "affinity": "air", "equals": "VU",
      "why": "Air is its weakness and its off-switch." },
    { "id": "physical-rs-only-via-ae", "affinity": "physical", "in": ["NE", "NA", ""],
      "why": "RS physical lives on the Illusory Form AE so Air can strip it; an RS on the sheet would make it permanent." },
    { "id": "air-scatters-form", "item": "Illusory Form", "table": "reaction_config_table", "row": "mist_scatter", "field": "condition_formula", "contains": "TRIGGER_DAMAGE_IS_AIR == 1",
      "why": "The off-switch." },
    { "id": "scatter-persistent", "item": "Illusory Form", "table": "effect_table", "row": "mist_scatter", "field": "include_persistent", "equals": true,
      "why": "Else the strip is a silent no-op." },
    { "id": "form-regathers", "item": "Illusory Form", "table": "reaction_config_table", "where": { "reaction_trigger": "round_end" }, "field": "reaction_effect_ref", "equals": "mist_gather",
      "why": "Returns at round end." }
  ],
  "blind_spots": [
    "The Blind riders were never observed firing in a real attack.",
    "Mindscape does not simulate Phantom Shift / Illusory Form fully (Board card marks it)."
  ],
  "open_questions": [
    "Best basic attack (Phantom Shift: Thunder Strike, avg 38) is under the 45 floor and its resisted hit is ~16% of PC HP — intended for an elite, or too soft?"
  ]
}
```
