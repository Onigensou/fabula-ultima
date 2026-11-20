# Nox Viper

> **Status: draft** — scaffolded from the sheet 2026-11-20. Fill the prose, move
> the deliberate ones from `candidate_exceptions` into `exceptions` (with a reason), add the
> invariants the gimmick depends on.

## Identity & role

- Actor `gXSRiFqgfMZkQnXr`. soldier L45, UNDEAD, 1 turn(s), HP 140.
- Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).
- Area rules (user): every Nox is Undead (VU Light, IM Dark/Poison/Poisoned); healing damages it in full (FF style); a Phoenix Feather or Hope defeats it outright, elites included. Fragment Eater: an eaten Soul Fragment pays no refund until battle end.

## Concept

Venom serpent: breaks armour for good and keeps biting whoever it holds.

## The gimmick

- **Bile Spew**: 30 MP, Overflow, DL13 MIG+WLP; a failure gives Armor Break and Envenomed.
- **Poison Fang**: Multi 2, applies Corroded (−2 DEF a stack, max 5, uncleansable, lasts the battle).
- **Coil**: Grappled on hit; never targets summons or guests (2026-11-20).
- **Feeding Coil**: a free Fang on the held creature at the start of the Viper's turn and of the held creature's turn; the break check is rolled first.
- Grapple splash (attacking the Viper also hits the held ally) is kept on purpose (user).

## Numbers & targets

HP 275 (was 140), Init 15. Poison Fang ~52 ×2, Coil ~37, Bile Spew ~42 (pass 2). Design page: https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-20 | Built (first wiring pass, v1.0.636) from design page rev 38 | user-designed kit | user | sandbox-verified; 113-sim playtest |
| 2026-11-20 | HP 140 → 220 | pace 3-4 rounds for a secret end-game area (113-sim playtest: 2.1 rounds, 90% party HP) | user (pace), claude (numbers) | re-run pending |
| 2026-11-20 | Coil players-only | 7 of 14 playtest Coils hit summons immune to Grappled; accuracy was fine (2 misses) | user | — |
| 2026-11-20 | Token scale 1.41 → 1.74 | Battler Scale mockup | user | — |
| 2026-11-20 | Pass 2: HP 220 → 275 (soldiers another ×1.25) | re-run after pass 1 still 2.5 rounds / 84% party HP; elites already at 3.3 rounds | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 2: +20% average hit: Poison Fang HR+35→44, Coil HR+23→29, Bile Spew HR+28→35 | same re-run; target party ends nearer 60-70% | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 3: +25% average hit: Poison Fang HR+44→57, Coil HR+29→38, Bile Spew HR+35→46 | same rounds, lower party HP (pass 2: 2.9 rounds, 83% party HP) | user (go), claude (numbers) | re-run pending |

```json dossier
{
  "monster": "Nox Viper",
  "actorId": "gXSRiFqgfMZkQnXr",
  "status": "draft",
  "updated": "2026-11-20",
  "role": "Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).",
  "exceptions": [],
  "candidate_exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Poison Fang",
      "finding": "best basic attack avg 43 < 45"
    },
    {
      "rule": "not-simulated",
      "finding": "not simulated: Feeding Coil: SUBJECT_IS_ENEMY"
    }
  ],
  "invariants": [],
  "blind_spots": [],
  "open_questions": [
    "Pass 2 (HP + damage) re-run under review"
  ]
}
```
