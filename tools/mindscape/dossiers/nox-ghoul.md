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

HP 300 (was 150), DEF 11, MDEF 9. Poison Blade ~62, Grave Claw ~54 (pass 2). Design page: https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-20 | Built (first wiring pass, v1.0.636) from design page rev 38 | user-designed kit | user | sandbox-verified; 113-sim playtest |
| 2026-11-20 | HP 150 → 240 | pace 3-4 rounds for a secret end-game area (113-sim playtest: 2.1 rounds, 90% party HP) | user (pace), claude (numbers) | re-run pending |
| 2026-11-20 | Token scale 0.95 → 1.42 | Battler Scale mockup | user | — |
| 2026-11-20 | Pass 2: HP 240 → 300 (soldiers another ×1.25) | re-run after pass 1 still 2.5 rounds / 84% party HP; elites already at 3.3 rounds | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 2: +20% average hit: Grave Claw HR+38→47, Poison Blade HR+45→55 | same re-run; target party ends nearer 60-70% | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 3: +25% average hit: Grave Claw HR+47→61, Poison Blade HR+55→71 | same rounds, lower party HP (pass 2: 2.9 rounds, 83% party HP) | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Batch Z: all passes so far (incl. Gravis Alta, Resurrection, affinities, weapon efficiency), snapshot runner, 2 runs/encounter, PC-only HP (Keren max 85, Grave Toll) | measure before the push | claude | GGHH 3.0 r / 49%; GWG 3.0 r / 64%; GVG 4.0 r / 61%; GPH 3.0 r / 30% (1 run); GEG 3.5 r / 57%; G-Roo-G timed out (runner); all finished fights won. User: "quite happy with the overview", shipped v1.0.642 |

| 2026-11-21 | **Poison Blade → vs MDEF** (Grave Claw stays vs DEF) | design rule: every monster mixes DEF and MDEF attacks so one defense can't lock it out (Blanche DEF 19 took Poison Blade 15% of the time). Exact hit math vs the party sheet (Hina/Keren/Blanche/Zarg): before 96/81/15/55 %, after 55/65/45/88 %, average 62 → 63% | user | batch M (2 runs/row, feat/nox-mdef): GGHH 3.0 r / 61%; GWG 3.0 r / 72%; GVG 3.0 r / 65%; HWG 3.0 r / 86%; GPH 4.5 r / 39%; GEG 3.5 r / 46%; G-Roo-G 3 r / 57% (sim reads 'inconclusive': all enemies gone, no PC down); all won |

```json dossier
{
  "monster": "Nox Ghoul",
  "actorId": "HiIGOwMq8q57TeUh",
  "status": "draft",
  "updated": "2026-11-21",
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
    "Pass 2 (HP + damage) re-run under review"
  ]
}
```
