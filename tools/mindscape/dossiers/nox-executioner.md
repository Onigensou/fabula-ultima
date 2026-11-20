# Nox Executioner

> **Status: draft** — scaffolded from the sheet 2026-11-20. Fill the prose, move
> the deliberate ones from `candidate_exceptions` into `exceptions` (with a reason), add the
> invariants the gimmick depends on.

## Identity & role

- Actor `lCrB0iEWzPkNrzry`. elite L48, UNDEAD, 1 turn(s), HP 320.
- Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).
- Area rules (user): every Nox is Undead (VU Light, IM Dark/Poison/Poisoned); healing damages it in full (FF style); a Phoenix Feather or Hope defeats it outright, elites included. Fragment Eater: an eaten Soul Fragment pays no refund until battle end.

## Concept

Elite headsman and the area's tank: one blade for the healthy, one for the dying, and a head at every round's end.

## The gimmick

- **Parry** (universal, heavy shields): halves damage when the incoming check result is even; crits get through; no-check damage is never parried.
- **Nox Guillotine** (vs DEF, Cripple) and **Nox Gibbet** (vs MDEF, Execute).
- **Soul Sever**: 30 MP, eats a fragment that has Called and deals its HP as poison to all enemies. AI waits for "Called" (2026-11-20).
- **Beheading**: marks a player below 25% of Max HP; at round end beheads the lowest marked one (KO, fragment goes with them).

## Numbers & targets

HP 480 (was 320), DEF 15, MDEF 13. Guillotine/Gibbet ~54 (pass 2) (×2 on their condition). Design page: https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-20 | Built (first wiring pass, v1.0.636) from design page rev 38 | user-designed kit | user | sandbox-verified; 113-sim playtest |
| 2026-11-20 | HP 320 → 480 (elite ×1.5) | pace 3-4 rounds for a secret end-game area (113-sim playtest: 2.1 rounds, 90% party HP) | user (pace), claude (numbers) | re-run pending |
| 2026-11-20 | Beheading line 15% → 25% | marks happened, but no execution in 113 sims | user | — |
| 2026-11-20 | Soul Sever AI row waits for "Called" | 3 of 9 playtest Severs found nothing to eat | user | — |
| 2026-11-20 | Token scale 2.24 → 2.60 | Battler Scale mockup | user | — |
| 2026-11-20 | Pass 2: +20% average hit: Guillotine/Gibbet HR+37→46 | same re-run; target party ends nearer 60-70% | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 3: +25% average hit: Guillotine/Gibbet HR+46→59 (Soul Sever not raised: fragment HP by design) | same rounds, lower party HP (pass 2: 2.9 rounds, 83% party HP) | user (go), claude (numbers) | re-run pending |

```json dossier
{
  "monster": "Nox Executioner",
  "actorId": "lCrB0iEWzPkNrzry",
  "status": "draft",
  "updated": "2026-11-20",
  "role": "Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).",
  "exceptions": [],
  "candidate_exceptions": [
    {
      "rule": "resisted-min",
      "action": "Nox Gibbet",
      "finding": "resisted hit = 16% of PC HP (< 25%)"
    },
    {
      "rule": "not-simulated",
      "finding": "not simulated: Beheading: SUBJECT_IS_ENEMY; Beheading: SUBJECT_IS_NPC; Beheading: IS_NPC; Beheading: IS_SUMMON; Beheading: IS_GUEST; Beheading: effect conflict_event_action; Soul Sever: effect conflict_event_action; Parry: ATTACK_IS_CRIT"
    }
  ],
  "invariants": [],
  "blind_spots": [],
  "open_questions": [
    "Pass 2 (HP + damage) re-run under review"
  ]
}
```
