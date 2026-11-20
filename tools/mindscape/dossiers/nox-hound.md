# Nox Hound

> **Status: draft** — scaffolded from the sheet 2026-11-20. Fill the prose, move
> the deliberate ones from `candidate_exceptions` into `exceptions` (with a reason), add the
> invariants the gimmick depends on.

## Identity & role

- Actor `RFnNMvI0AtMQpwuP`. soldier L44, UNDEAD, 1 turn(s), HP 120.
- Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).
- Area rules (user): every Nox is Undead (VU Light, IM Dark/Poison/Poisoned); healing damages it in full (FF style); a Phoenix Feather or Hope defeats it outright, elites included. Fragment Eater: an eaten Soul Fragment pays no refund until battle end.

## Concept

Fast soul-hound that never stays on one victim; spreads wounds so every player feeds the Soul Tithe.

## The gimmick

- **Rending Fangs**: two bites on two AI-chosen players (Fresh Scent: prefers the unhurt).
- **Zombie Bite**: 90% Zombie on hit; never targets summons or guests (2026-11-20).
- **On the Hunt**: free Rending Fangs when an enemy enters Crisis, both bites on that creature.
- Counterplay: kill it first; cleanse Zombie before a Priest's Lux Finis or Revive.

## Numbers & targets

HP 240 (was 120), Init 14. Rending Fangs ~24 ×2, Zombie Bite ~38 (pass 2). Design page: https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-20 | Built (first wiring pass, v1.0.636) from design page rev 38 | user-designed kit | user | sandbox-verified; 113-sim playtest |
| 2026-11-20 | HP 120 → 190 | pace 3-4 rounds for a secret end-game area (113-sim playtest: 2.1 rounds, 90% party HP) | user (pace), claude (numbers) | re-run pending |
| 2026-11-20 | Zombie Bite players-only (IS_SUMMON == 0 && IS_GUEST == 0) | summons are immune to Zombie; bites were wasted on Fox fire | user | — |
| 2026-11-20 | Token scale 1.00 → 1.45 | Battler Scale mockup | user | — |
| 2026-11-20 | Pass 2: HP 190 → 240 (soldiers another ×1.25) | re-run after pass 1 still 2.5 rounds / 84% party HP; elites already at 3.3 rounds | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 2: +20% average hit: Rending Fangs HR+13→17, Zombie Bite HR+25→31 | same re-run; target party ends nearer 60-70% | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 3: +25% average hit: Rending Fangs HR+17→23, Zombie Bite HR+31→41 | same rounds, lower party HP (pass 2: 2.9 rounds, 83% party HP) | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 4: Light VU → NA, **Fire VU**; HP 240 → 190; study hint "shies from fire" | 47% of party damage to the Nox went into the Light weakness (mostly one bow); spread the chart | user (go), claude (element/HP) | re-run pending |
| 2026-11-20 | Batch Z: all passes so far (incl. Gravis Alta, Resurrection, affinities, weapon efficiency), snapshot runner, 2 runs/encounter, PC-only HP (Keren max 85, Grave Toll) | measure before the push | claude | GGHH 3.0 r / 49%; HVH 2.0 r / 79%; HWG 3.0 r / 78%; HPH 3.5 r / 66%; GPH 3.0 r / 30% (1 run); HEH 3.0 r / 39% (1 run); H-Kurona x2-H 2.0 r / 92%; all finished fights won. User: "quite happy with the overview", shipped v1.0.642 |

| 2026-11-21 | **Zombie Bite → vs MDEF, accuracy +8 → +6** (Rending Fangs stays vs DEF) | design rule: every monster mixes DEF and MDEF attacks; at +8 vs MDEF it would hit 92% on average, user picked +6. Exact hit math (Hina/Keren/Blanche/Zarg): before (DEF +8) 99/99/54/90 %, after (MDEF +6) 78/84/71/97 %, average 85 → 83%. The Zombie rider is HIT_MARGIN >= 0 (= on a hit), unaffected | user | batch M (2 runs/row): GGHH 3.0 r / 61%; HVH 2.0 r / 83%; HWG 3.0 r / 86%; HPH 3.0 r / 53%; GPH 4.5 r / 39%; HEH 3.5 r / 51%; H-Kurona x2-H 2.0 r / 94%; all won |

```json dossier
{
  "monster": "Nox Hound",
  "actorId": "RFnNMvI0AtMQpwuP",
  "status": "draft",
  "updated": "2026-11-21",
  "role": "Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).",
  "exceptions": [],
  "candidate_exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Zombie Bite",
      "finding": "best basic attack avg 32 < 45"
    },
    {
      "rule": "not-simulated",
      "finding": "not simulated: Zombie Bite: HIT_MARGIN"
    }
  ],
  "invariants": [],
  "blind_spots": [],
  "open_questions": [
    "Pass 2 (HP + damage) re-run under review"
  ]
}
```
