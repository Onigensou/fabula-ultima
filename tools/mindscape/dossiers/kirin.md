# Kirin — the horn that charges on everyone's lightning

> **Status: draft.** Seeded 2026-10-21 from the Lightning Surge notes (reworks 2026-08-16,
> -17, -26). Stats are read live from the world — the world wins.

## Identity & role

- Actor `TvLv878yZLNUAWNN` (renamed from "Qilin"). L50 BEAST/FEY **elite**, starts at 0 MP.
- Valley random encounter, 6 rows (with slimes, Prism, Skizzik, Ampere + Mana Ray, Obsidrax).

## Concept

**An inevitable strong attack the party deliberately starves**, not a doomsday clock they
defuse (user, 2026-08-16 → reworked 2026-08-26). The lever moved from *prevent it* to *starve it*.

## The gimmick

- **Lightning Charge:** whenever ANY creature takes Bolt from a source other than the Kirin,
  it gains MP = one fifth of that damage. Overflow past max becomes stacking Shield. The
  cause filter stays **BLANK** so the Rod hazard feeds it; `reaction_source` stays BLANK or
  it silently becomes self-only.
- **Divine Railstream (charge dump):** costs 0; adds `min(75, CUR_MP)` to every target, then
  Paralyze (chance scales with MP), then drains all MP. **Chain order is load-bearing** —
  Paralyze reads MP before the drain.
- **Horn Rush** (Bolt, Execute ×2 vs a target in Crisis) and **Hooves** (Physical + Slow) —
  Hooves was brought back as the off-element answer for a bolt-resistant party (user's fix,
  2026-08-17: add an option, don't nerf).
- Counterplay: affinity (RS halves income), misses, keeping Bolt off everyone. Shields do NOT
  starve it.

## Numbers & targets

- Income rate 0.2 — user accepted as a starting metric 2026-08-26, tuning deferred. The
  median cast's position in the ~49 → ~112 per-target band IS the fight's difficulty.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-16 | Divine Railstream no longer a party-wipe; meant to land | live: it never fired | user | — |
| 2026-08-17 | Hooves re-added (Physical) | mono-element kit; add an option, don't nerf | user | — |
| 2026-08-26 | Divine Railstream = charge dump, income from any bolt × 0.2 | old design was defusable | claude | income untuned |
| 2026-08-26 | 0.2 accepted as a starting metric | — | user | tuning deferred |
| 2026-10-31 | Display rename: Rail Stream → Divine Railstream | User naming pass; no mechanical change | user | name-only diff proved |

```json dossier
{
  "monster": "Kirin",
  "actorId": "TvLv878yZLNUAWNN",
  "status": "draft",
  "aliases": ["Qilin"],
  "updated": "2026-10-31",
  "role": "Valley random-encounter elite (6 Encounter rows)",
  "exceptions": [],
  "invariants": [
    { "id": "charge-from-others-bolt", "item": "Lightning Charge", "table": "reaction_config_table", "row": "charge_horn", "field": "condition_formula", "equals": "TRIGGER_DAMAGE_IS_BOLT == 1 && CAUSE_IS_SELF == 0",
      "why": "Feeds on ANY creature taking bolt, but not its own Divine Railstream / Horn Rush." },
    { "id": "charge-storm-fed", "item": "Lightning Charge", "table": "reaction_config_table", "row": "charge_horn", "field": "reaction_cause_filter", "equals": "",
      "why": "BLANK lets the Rod hazard feed it." },
    { "id": "charge-not-self-scoped", "item": "Lightning Charge", "table": "reaction_config_table", "row": "charge_horn", "field": "reaction_source", "equals": "",
      "why": "'self' would silently make it self-only." },
    { "id": "rail-scales-with-mp", "item": "Divine Railstream", "table": "effect_table", "row": "rail_charge_bonus", "field": "damage_amount", "equals": "min(75, CUR_MP)",
      "why": "1:1 with the gauge; the min() is the Chimerist guard." },
    { "id": "rail-paralyze-before-drain", "item": "Divine Railstream", "table": "effect_table", "row": "rail_chain", "field": "chain_steps", "equals": "apply_paralyzed, rail_drain",
      "why": "Order is load-bearing: the Paralyze chance reads MP before the drain." },
    { "id": "hooves-physical", "item": "Hooves", "prop": "type_damage", "equals": "Physical",
      "why": "The off-element answer for a bolt-resistant party." }
  ],
  "blind_spots": [
    "Mindscape used to start everyone at full MP; Kirin is authored at 0 (fixed 2026-10-20) — older verdicts overstate it."
  ],
  "open_questions": [
    "Lightning Charge income 0.2 is still the untuned starting metric — sweep 0.15 / 0.2 / 0.3?"
  ]
}
```
