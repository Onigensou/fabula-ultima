# Drakoza — banks the damage it takes, pays it back in one swing

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-26 build + live-test notes.
> Stats are read live from the world — the world wins.

## Identity & role

- Actor `H6Ubup6kmkgNQzLU`. L43 BEAST/DRAGON soldier, DARK.
- Valley random encounter: surface as a pair; Underground with Skizzik, where the blast feeds Fury.
- Exists so the **Dragonslayer Pendant** (150% vs Dragon sub-type) has targets; claims Dark.

## Concept

A wounded beast gets angrier: every point of damage it takes is banked as **Fury** and paid
back in one Thrash.

## The gimmick

- **Drako Fury:** losing HP → Fury charges equal to the damage taken. Cause filter blank on
  purpose so DoT ticks feed it too.
- **Thrash:** consumes all Fury for bonus damage `ceil(Fury × 0.5)` — scoped by
  `reaction_source_skill: Thrash` so Claw/Tail Swipe never leak the bank. **That 0.5 is THE
  balance dial.**
- AI: Thrash is exclusive once Fury ≥ 30; otherwise Claw / Tail Swipe.
- Counterplay: focus it down in one round, or accept the payback.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-26 | Built: Fury bank + Thrash payback | Dragon-subtype target for Dragonslayer Pendant | user | live-verified Fury banking |
| 2026-08-26 | `add_damage` → `adjust_damage` | retired effect kind was silently inert | claude (fix) | Thrash spends Fury |
| 2026-10-20 | Claw 20→39, Thrash 18→37, Tail Swipe 12→22 | too-weak pass | user | — |
| 2026-10-31 | 1 surface + 1 Underground row | Valley tables tightened to JRPG size: surface 1d28, Underground 1d40 | user | sim report in the commit |

```json dossier
{
  "monster": "Drakoza",
  "actorId": "H6Ubup6kmkgNQzLU",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Valley random encounter (1 surface + 1 Underground Encounter row); Dragon-subtype target",
  "exceptions": [],
  "invariants": [
    { "id": "fury-banks-all-damage", "item": "Drako Fury", "table": "reaction_config_table", "row": "fury_bank", "field": "reaction_cause_filter", "equals": "",
      "why": "Blank so DoT ticks feed Fury too." },
    { "id": "thrash-scoped", "item": "Thrash", "table": "reaction_config_table", "row": "thrash_payback", "field": "reaction_source_skill", "equals": "Thrash",
      "why": "Stops Claw / Tail Swipe leaking the bank." },
    { "id": "payback-dial", "item": "Thrash", "table": "effect_table", "row": "thrash_bonus", "field": "damage_amount", "equals": "ceil(AE_CHARGES_FURY * 0.5)",
      "why": "THE balance dial — change it deliberately, with a log row." },
    { "id": "payback-adjust-damage", "item": "Thrash", "table": "effect_table", "row": "thrash_bonus", "field": "effect_kind", "equals": "adjust_damage",
      "why": "add_damage is retired and inert (it also aborted the spend)." },
    { "id": "thrash-spends-persistent", "item": "Thrash", "table": "effect_table", "row": "thrash_spend", "field": "include_persistent", "equals": true,
      "why": "Without it Fury grows unbounded all fight." },
    { "id": "thrash-at-30-fury", "table": "action_pattern_table", "where": { "action_pattern_name": "Thrash" }, "field": "action_pattern_value_1", "equals": "30",
      "why": "Thrash only once there is a bank worth paying back." }
  ],
  "blind_spots": [
    "Balance unsimulated at design time; never fought a full AI-driven turn end-to-end."
  ],
  "open_questions": []
}
```
