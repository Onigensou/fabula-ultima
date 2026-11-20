# Nox Priest

> **Status: draft** — scaffolded from the sheet 2026-11-20. Fill the prose, move
> the deliberate ones from `candidate_exceptions` into `exceptions` (with a reason), add the
> invariants the gimmick depends on.

## Identity & role

- Actor `QlhI0YQZ0uqRKTLb`. elite L46, UNDEAD, 1 turn(s), HP 300.
- Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).
- Area rules (user): every Nox is Undead (VU Light, IM Dark/Poison/Poisoned); healing damages it in full (FF style); a Phoenix Feather or Hope defeats it outright, elites included. Fragment Eater: an eaten Soul Fragment pays no refund until battle end.

## Concept

Elite caster, the cog of the Soul Tithe: every fragment the party destroys refills its MP for Zombie Plague, Gravis Alta and Lux Finis.

## The gimmick

- **Soul Siphon**: +30 MP whenever any Soul Fragment is destroyed.
- **Zombie Plague**: all enemies, DL13 MIG+WLP or Zombie (Zombie now counts on the victim's turns and outlives the Priest, 2026-11-20).
- **Lux Finis**: Light, HR+62, at most 2 Zombie'd targets, Opportunity Blind (not +20%).
- **Resurrection** (was Revive): 30 MP, 1 turn in 3, once per battle; kills a Zombie'd or Undead target; can only target one (2026-11-20).
- **Gravis Alta**: 50% of current HP to all, never kills (was Gravis, 25%). **Nox Tome** HR+20 when dry.

## Numbers & targets

HP 450 (was 300), MP 106, DEF 9, MDEF 14. Design page: https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-20 | Built (first wiring pass, v1.0.636) from design page rev 38 | user-designed kit | user | sandbox-verified; 113-sim playtest |
| 2026-11-20 | HP 300 → 450 (elite ×1.5) | pace 3-4 rounds for a secret end-game area (113-sim playtest: 2.1 rounds, 90% party HP) | user (pace), claude (numbers) | re-run pending |
| 2026-11-20 | Revive target_eligibility HAS_STATUS_ZOMBIE == 1 \|\| SPECIES_IS_UNDEAD == 1 | a playtest Revive went to a non-Zombie player and did nothing | user | — |
| 2026-11-20 | Zombie no longer reaped when the Priest falls | "that's not how debuff work" | user | — |
| 2026-11-20 | Token scale 1.47 → 2.26 | Battler Scale mockup | user | — |
| 2026-11-20 | Pass 2: +20% average hit: Nox Tome HR+20→25 (Lux Finis not raised) | same re-run; target party ends nearer 60-70% | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Pass 3: +25% average hit: Nox Tome HR+25→33 (Lux Finis not raised, user) | same rounds, lower party HP (pass 2: 2.9 rounds, 83% party HP) | user (go), claude (numbers) | re-run pending |
| 2026-11-20 | Gravis → **Gravis Alta**: 50% of current HP (was 25%), still never KOs | same rounds, lower party HP (pass 2: 2.9 rounds, 83% party HP) | user | re-run pending |
| 2026-11-20 | Gravis Alta AI cooldown 3 rounds | pass-3 quick test: 2 wipes in 4 Priest fights, Gravis Alta cast 2-3 rounds running fed the Soul Fragments (max HP locked to 1) | user | re-run pending |
| 2026-11-20 | Gravis Alta cooldown removed again; engine fix: Gravis Alta / Revive / Zombie Plague now classify harmful, so Prophetic Defender / Protect / Illusory Shield can answer them | user: the counterplay belongs to the players | user | re-run pending |
| 2026-11-20 | Revive renamed **Resurrection** (item, AI row, spell list); same rules | naming, to match the animation pass | user | — |
| 2026-11-20 | Batch Z: all passes so far (incl. Gravis Alta, Resurrection, affinities, weapon efficiency), snapshot runner, 2 runs/encounter, PC-only HP (Keren max 85, Grave Toll) | measure before the push | claude | HPH 3.5 r / 66%; GPH 3.0 r / 30% (1 run); all finished fights won. User: "quite happy with the overview", shipped v1.0.642 |

```json dossier
{
  "monster": "Nox Priest",
  "actorId": "QlhI0YQZ0uqRKTLb",
  "status": "draft",
  "updated": "2026-11-20",
  "role": "Sealed Cavern (Valley_Map010) random encounter: the Nox Legion, Nidhogg's brainwashed servants. Secret end-game area; pace target 3-4 rounds (user 2026-11-20).",
  "exceptions": [],
  "candidate_exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Nox Tome",
      "finding": "best basic attack avg 24 < 45"
    },
    {
      "rule": "resisted-min",
      "action": "Nox Tome",
      "finding": "resisted hit = 9% of PC HP (< 25%)"
    },
    {
      "rule": "not-simulated",
      "finding": "not simulated: Soul Siphon: trigger soul_fragment_destroyed; Revive: SPECIES_IS_UNDEAD; Lux Finis: CRIT"
    }
  ],
  "invariants": [],
  "blind_spots": [],
  "open_questions": [
    "Pass 2 (HP + damage) re-run under review"
  ]
}
```
