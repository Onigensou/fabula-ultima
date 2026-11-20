# Nox Ghoul

> **Status: draft** — scaffolded from the sheet 2026-11-20. Fill the prose, move
> the deliberate ones from `candidate_exceptions` into `exceptions` (with a reason), add the
> invariants the gimmick depends on.

## Identity & role

- Actor `HiIGOwMq8q57TeUh`. soldier L45, UNDEAD, 1 turn(s), HP 150.
- Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).
- Area rules (user): every Nox is Undead (VU Light, IM Dark/Poison/Poisoned); healing damages it in full (FF style); a Phoenix Feather or Hope defeats it outright, elites included. Fragment Eater: an eaten Soul Fragment pays no refund until battle end.

## Concept

The Legion's foot soldier: moderate, all-round offence that punishes healing and the Soul-Torn.

## The gimmick

- **Poison Blade**: Poisoned; on a creature already Poisoned it inflicts Envenomed instead.
- **Grave Claw**: inflicts Bleed; the AI aims it at the Soul-Torn.
- **Counter when enemy Healed**: an enemy player who is healed gets a normal attack (no HR) back. Only real heals on players, not a heal used as an attack.
- Counterplay: heal the Ghoul to hurt it (Undead), kill it before it stacks Envenomed.

## Numbers & targets

HP 240 (was 150), DEF 11, MDEF 9. Poison Blade ~52, Grave Claw ~45 (both +20% flat, rev 33). Design page: https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-20 | Built (first wiring pass, v1.0.636) from design page rev 38 | user-designed kit | user | sandbox-verified; 113-sim playtest |
| 2026-11-20 | HP 150 → 240 | pace 3-4 rounds for a secret end-game area (113-sim playtest: 2.1 rounds, 90% party HP) | user (pace), claude (numbers) | re-run pending |
| 2026-11-20 | Token scale 0.95 → 1.42 | Battler Scale mockup | user | — |

```json dossier
{
  "monster": "Nox Ghoul",
  "actorId": "HiIGOwMq8q57TeUh",
  "status": "draft",
  "updated": "2026-11-20",
  "role": "Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).",
  "exceptions": [],
  "candidate_exceptions": [
    {
      "rule": "not-simulated",
      "finding": "not simulated: Counter when enemy Healed: SUBJECT_IS_ENEMY"
    }
  ],
  "invariants": [],
  "blind_spots": [],
  "open_questions": [
    "Damage +20% held until the tuned re-run is reviewed (user 2026-11-20)"
  ]
}
```
