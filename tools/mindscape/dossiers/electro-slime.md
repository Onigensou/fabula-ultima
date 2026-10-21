# Electro Slime — the chaff that punishes you for killing it

> **Status: draft.** Seeded 2026-10-21 from the Lightning Surge roster notes and the
> 2026-10-20 balance pass. Stats are read live from the world — the world wins.

## Identity & role

- Actor `A1VzokzJPoyxobCd`. L40 ELEMENTAL/SLIME soldier.
- Valley chaff: 7 Encounter rows — slime-only rows teach the death burst first (rows 1–2),
  then paired with the Bolt reactors, and as **Gigas's escort** (row 19).

## Concept

Bolt counterpart to Fire Slime. **Its role is its death trigger + Paralyze** (user,
2026-10-20) — not its damage.

## The gimmick

- **Electro Explosion:** reduced to 0 HP by anything but Earth → 30 Bolt to **all other
  creatures, allies included**. That one burst simultaneously feeds Prism Overcharge, Skizzik
  Chain Reaction and Kirin Lightning Charge — **killing the chaff is punished**. Earth kills
  it cleanly.
- **Static Shot:** 50% Paralyzed on hit.
- **Rod sponge (deliberate):** it absorbs bolt, so it can hold the Lightning Rod without
  being hurt — next to Gigas that starves Gigas of Frightened ("kill the slime to free the
  Rod"). Its death burst cannot frighten Gigas (not Gigas's turn).

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-01 | Built; stays sub-bracket on purpose | chaff — 45 HP + the death burst are the point | claude | — |
| 2026-10-20 | Accuracy only: Static Shot chk 5→8, Tackle 6→9 | role is the death trigger + paralyze, not damage | user | — |

```json dossier
{
  "monster": "Electro Slime",
  "actorId": "A1VzokzJPoyxobCd",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Valley chaff (7 Encounter rows), Gigas's escort in row 19",
  "exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Static Shot",
      "why": "Its role is the death trigger + Paralyze, not damage (2026-10-20 balance pass raised accuracy only).",
      "decided_by": "user",
      "date": "2026-10-20"
    },
    {
      "rule": "absorb",
      "why": "Bolt absorb makes it a deliberate Rod sponge (starves Gigas of Frightened) and keeps the roster interlock.",
      "decided_by": "claude",
      "date": "2026-08-16"
    }
  ],
  "invariants": [
    { "id": "absorbs-bolt", "affinity": "bolt", "equals": "AB", "why": "Rod sponge." },
    { "id": "earth-kills-cleanly", "item": "Electro Explosion", "table": "reaction_config_table", "row": "electro_burst", "field": "condition_formula", "equals": "TRIGGER_DAMAGE_IS_EARTH == 0",
      "why": "Earth is the clean answer; anything else detonates it." },
    { "id": "burst-hits-everyone", "item": "Electro Explosion", "table": "effect_table", "row": "burst_targets", "field": "candidate_source", "equals": "combat",
      "why": "Allies included — that is what feeds the bolt reactors." },
    { "id": "burst-is-bolt", "item": "Electro Explosion", "table": "effect_table", "row": "electro_burst", "field": "damage_element", "equals": "bolt",
      "why": "The burst must be Bolt to trigger the interlock." },
    { "id": "static-shot-paralyze", "item": "Static Shot", "table": "reaction_config_table", "row": "apply_paralyzed", "field": "condition_formula", "contains": "chance(50)",
      "why": "Paralyze is half its role." }
  ],
  "blind_spots": [
    "MAX_REACTION_DEPTH 2 in Mindscape: slime-chain → second-hop combos are cut."
  ],
  "open_questions": []
}
```
