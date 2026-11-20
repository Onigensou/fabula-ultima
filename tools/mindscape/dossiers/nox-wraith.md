# Nox Wraith

> **Status: draft** — scaffolded from the sheet 2026-11-20. Fill the prose, move
> the deliberate ones from `candidate_exceptions` into `exceptions` (with a reason), add the
> invariants the gimmick depends on.

## Identity & role

- Actor `CzQhpNYeo3ZI0TzH`. soldier L46, UNDEAD, 1 turn(s), HP 130.
- Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).
- Area rules (user): every Nox is Undead (VU Light, IM Dark/Poison/Poisoned); healing damages it in full (FF style); a Phoenix Feather or Hope defeats it outright, elites included. Fragment Eater: an eaten Soul Fragment pays no refund until battle end.

## Concept

Soldier DPS: a soul that became a mouth. Its drain locks wounds straight into the fragment, and it eats a fragment to keep going.

## The gimmick

- **Ethereal**: resists Strike damage (half).
- **Soul Ripper**: drain locked at once into the target's Soul Fragment (lowers Max HP).
- **Devour Soul**: eats one fragment that has Called (no refund), heals itself, gets its turn back; once a round, in Crisis-ish (≤50% HP). The AI now waits for a "Called" fragment (2026-11-20).

## Numbers & targets

HP 260 (was 130), DEF 9, MDEF 11. Soul Ripper ~60 (pass 2). Design page: https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-20 | Built (first wiring pass, v1.0.636) from design page rev 38 | user-designed kit | user | sandbox-verified; 113-sim playtest |
| 2026-11-20 | HP 130 → 210 | pace 3-4 rounds for a secret end-game area (113-sim playtest: 2.1 rounds, 90% party HP) | user (pace), claude (numbers) | re-run pending |
| 2026-11-20 | Devour Soul AI row waits for creature_has_status "Called" | every playtest Devour was a no-op: no fragment had Called | user | — |
| 2026-11-20 | Token scale 1.00 → 1.47 | Battler Scale mockup | user | — |
| 2026-11-20 | Pass 2: HP 210 → 260 (soldiers another ×1.25) | re-run after pass 1 still 2.5 rounds / 84% party HP; elites already at 3.3 rounds | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 2: +20% average hit: Soul Ripper HR+43→53 | same re-run; target party ends nearer 60-70% | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 3: +25% average hit: Soul Ripper HR+53→68 | same rounds, lower party HP (pass 2: 2.9 rounds, 83% party HP) | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Weapon efficiency: Arcane 150, Bow 75 | had none; read off the sprite: magic bites a spirit, arrows pass through the rags | user (go), claude (flavour) | re-run pending |

```json dossier
{
  "monster": "Nox Wraith",
  "actorId": "CzQhpNYeo3ZI0TzH",
  "status": "draft",
  "updated": "2026-11-20",
  "role": "Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).",
  "exceptions": [],
  "candidate_exceptions": [
    {
      "rule": "not-simulated",
      "finding": "not simulated: Devour Soul: effect conflict_event_action; Devour Soul: effect modify_turns; Soul Ripper: effect conflict_event_action"
    }
  ],
  "invariants": [],
  "blind_spots": [],
  "open_questions": [
    "Pass 2 (HP + damage) re-run under review"
  ]
}
```
