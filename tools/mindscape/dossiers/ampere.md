# Ampere — the Wet applier that sets up the bolt roster

> **Status: draft.** Seeded 2026-10-21 from the Lightning Surge notes (built 2026-08-16,
> renamed from Volt Seahorse 2026-08-17). Stats are read live from the world — the world wins.

## Identity & role

- Actor `kAYN54Id3iTAOw1A`. L43 BEAST/DRAGON soldier (sprite file `Ampyr_Standard.png` is a
  typo; Ampere is correct).
- Valley random encounter, 4 rows — always paired (Mana Ray, Skizzik, Prism, Mana Ray + Kirin).

## Concept

The roster's **Wet applier**. Wet makes a target VU bolt, so it sets up every other monster here.

## The gimmick

- **Bubble Beam:** light Ice, 50% Wet per target (`ae_chance_percent` rolls per target).
- **Bubble Splash:** heavy Ice to all, DL13 DEX+MIG or Wet; AI gates it at a full tank —
  **the Rod's +30 MP is what paces it across rounds** (user corrected me: the hazard IS the
  MP regen).
- **Volt Counter:** when it is struck and the attacker's accuracy result is **even** → 10 Bolt
  to every other creature, **its own allies included**. Even-parity motif shared with Skizzik
  (Ampere = indiscriminate AoE, Skizzik = focused riposte).

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-16 | Built: Wet applier, Rod-paced Splash | sets up the bolt roster | user | — |
| 2026-08-17 | Renamed Volt Seahorse → Ampere; subtype → DRAGON | — | user | — |

```json dossier
{
  "monster": "Ampere",
  "actorId": "kAYN54Id3iTAOw1A",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Valley random encounter, always paired (4 Encounter rows)",
  "exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Bubble Beam",
      "why": "Setup monster: Bubble Beam's job is Wet (VU bolt) for the rest of the roster, not damage.",
      "decided_by": "claude",
      "date": "2026-08-16"
    }
  ],
  "invariants": [
    { "id": "beam-applies-wet", "item": "Bubble Beam", "table": "effect_table", "row": "bb_wet", "field": "ae_template_ref", "equals": "Wet",
      "why": "Wet = VU bolt — the setup." },
    { "id": "beam-wet-per-target", "item": "Bubble Beam", "table": "effect_table", "row": "bb_wet", "field": "ae_chance_percent", "equals": "50",
      "why": "Per-target roll (effect_kind chance would coin-flip once for the row)." },
    { "id": "splash-full-tank", "table": "action_pattern_table", "where": { "action_pattern_name": "Bubble Splash" }, "field": "action_pattern_value_1", "equals": "100",
      "why": "One cast per full tank; the Rod's +30 MP paces it." },
    { "id": "volt-counter-even", "item": "Volt Counter", "table": "reaction_config_table", "row": "vd_damage", "field": "condition_formula", "contains": "ATTACK_CHECK_RESULT % 2 == 0",
      "why": "Even-parity motif." },
    { "id": "volt-counter-hits-allies", "item": "Volt Counter", "table": "effect_table", "row": "vd_targets", "field": "category", "equals": "creature",
      "why": "Indiscriminate — its own allies too." }
  ],
  "blind_spots": [],
  "open_questions": [
    "Action pattern row P1 is an 'always' row with no action name — leftover?"
  ]
}
```
