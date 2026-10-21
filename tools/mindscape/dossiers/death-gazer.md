# Death Gazer — the save-or-die eye

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-29 Fafnir Castle roster notes
> (built as a placeholder). Stats are read live from the world — the world wins.

## Identity & role

- Actor `fCxslZazJKtQWsKP`, folder Monster / Fafnir Castle. L50 MONSTER soldier.
- Fafnir Castle **gimmick caster**: 6 Encounter rows (with Dragon Guards, Dire Orcs,
  Succubi, Imps + Roo, Iron Colossus).

## Concept

An eye that opens fully — and whoever fails to look away drops.

## The gimmick

- **Death Gaze:** DL13 INS+WLP save; failures are reduced to **0 HP** (`deal_damage` + `crush`
  of current HP — never `set_resource`). DL13 is roughly a 60% fail rate for an L50 PC on
  d10+d10.
- **Paced in the action pattern instead of the DL:** round ≥ 2 + cooldown 2 — that pacing
  is the first dial if it plays badly.
- Mind Sear and Eye Beam are filler; DEF 8 / MDEF 16 — swords, not spells.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-29 | Built as specced: DL13 save → 0 HP; paced by round ≥2 + cooldown 2 | gimmick caster | user (spec) | save leg not verifiable solo |

```json dossier
{
  "monster": "Death Gazer",
  "actorId": "fCxslZazJKtQWsKP",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Fafnir Castle gimmick caster (6 Encounter rows)",
  "exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Eye Beam",
      "why": "Gimmick caster: Death Gaze is the threat; Eye Beam is filler.",
      "decided_by": "claude",
      "date": "2026-08-29"
    }
  ],
  "invariants": [
    { "id": "gaze-dl13", "item": "Death Gaze", "table": "effect_table", "row": "dg_save", "field": "save_dl", "equals": "13",
      "why": "Specced DL (≈60% fail) — any change is a balance decision." },
    { "id": "gaze-kill-crush", "item": "Death Gaze", "table": "effect_table", "row": "dg_kill", "field": "damage_keywords", "equals": "crush",
      "why": "Reduce-to-0 via deal_damage + crush (bypasses flat DR); never set_resource." },
    { "id": "gaze-from-round-2", "table": "action_pattern_table", "where": { "action_pattern_name": "Death Gaze" }, "field": "action_pattern_value_1", "equals": "2",
      "why": "Pacing lives in the pattern: not in round 1." }
  ],
  "blind_spots": [
    "The save leg dispatches to players' clients — it hangs solo-GM, so it was never exercised."
  ],
  "open_questions": [
    "IMPORTANT: Death Gaze's 2-round cooldown never applies (no other row within 2 priority of 9), so from round 2 it is a ~60% save-or-die EVERY turn, not every other turn. Intended? If not: drop its priority to 7 or raise Mind Sear's."
  ]
}
```
