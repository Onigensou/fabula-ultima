# Gigas — the Frightened-lock tank

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-14 build notes. Entries marked
> `decided_by: user` are the designer's calls; `claude` entries are proposals awaiting
> confirmation. Read with `node bin/dossier.js gigas`.

## Identity & role

- Actor `1Lw78Js1f7MogV2B`, folder `Current Dungeon`. L45 **elite**, HUMANOID/GIANT, 1 activation.
- **Random encounter, fields WITH ADDS** (user, 2026-08-14). Valley of the Dragon Encounter
  row 19: Gigas + 2 Electro Slime. Also underground, rarer (Valley Underground plan) — no
  Rod down there, so it is stronger in the cave; user accepts that.
- Never live-tested. Token art still placeholder.

## Concept

A man-eating mountain giant that is secretly a coward, startled by thunder. One action a
round, one huge swing. A wall — unless the party plays well **and** turns the Lightning
Rod on it.

## The gimmick

- **Heavy Swing** (Attack, MIG+MIG +7, **+120 physical**, avg ~128) is the threat. It is
  meant to be able to drop a PC. That is the pressure that pushes the party to the Rod.
- **Oaf** (passive): **whenever Gigas takes Bolt damage — from anything — it is Frightened
  until the end of its next turn** (user, 2026-10-21; supersedes the 2026-08-14 Rod-only gate).
  PC bolt attacks, the Lightning Rod and the Lightning Crystal all count: it is meant to be
  played alongside the dungeon hazards.
  ⚠ The SHEET still gates it `IS_MY_TURN == 1` (Rod-only) — see DRIFT in the brief.
- **Frightened blocks `Attack`** → Heavy Swing is off. Gigas falls back to **Heavy Bodyslam**
  (Active, so Frightened does not block it): +75 physical (~83) **and 100 physical to itself**.
- So bolt turns the big hit into a weaker hit that hurts Gigas. Counterplay is landing bolt
  before its turn — a PC's bolt skill, or the dungeon's hazards.
- Escort tension: Electro Slime (AB bolt) can **hold the Rod as a sponge** and starve Gigas
  of Frightened → "kill the slime to free the Rod". The slime's death burst cannot frighten
  Gigas (not Gigas's turn). Bolt-feeding Prism / Skizzik / Kirin punish bolt spam.

## Numbers & targets

> Stats are read live from the world (`node bin/dossier.js gigas` → *Live sheet*); the world
> wins over any number written here. These are the design targets and the reasoning.

- HP **800** for the adds encounter (user, 2026-08-14); ~1200 only if ever fielded solo.
- Party onto-Gigas rate ≈ 385/round high efficiency (~2 rds), ~200/round low (~4 rds).
- Budget: elite = 2 soldiers → Gigas + 2 soldiers = Normal, + 3 = Hard (4 PCs).
- EF: heavy 200 · arcane 200 · bow 150 · all others 50 (most extreme spread in the world).
- If it still plays flat, the next lever is **2 activations**, not more HP.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-14 | Built: Heavy Swing / Heavy Bodyslam / Oaf | Frightened-lock tank concept | user | formula-probe verified, no battle |
| 2026-08-14 | Oaf gated on `IS_MY_TURN` | make the lock Rod-only | user | truth table verified live |
| 2026-08-14 | Frightened charges 3 → 1 | 3 = three-round lockout off one zap | claude (fix) | — |
| 2026-08-14 | HP 800, fields with adds | solo Gigas loses the action economy and kills the party's multi-target layer | user | — |
| 2026-08-14 | Giant Club +22 / Uncommon / 1800z | "strong but not that strong" | user | — |
| 2026-10-20 | Balance scan called Gigas OP for one-shotting | scan had no design context | — | **wrong read** → this dossier |
| 2026-10-21 | Dossier created | design context must survive re-tuning | user | — |
| 2026-10-21 | Affinities: world sheet (VU bolt/fire/poison, RS phys/air/earth) is the design | "the world is up to date" | user | 3-VU audit finding → intended |
| 2026-10-21 | Oaf trigger intent: **all bolt damage counts** — meant to be played with the dungeon hazards (Rod, Crystal) | user answer | user | sheet gate still requires IS_MY_TURN — see open question |

## Not simulated / risks

See `blind_spots` and `open_questions` below — they print in every brief and audit.
| 2026-10-21 | Oaf design: ANY Bolt damage → Frightened until the end of its next turn | Rod-only gate was not the intended mechanic | user | sheet still Rod-only → DRIFT, fix pending go-ahead |

```json dossier
{
  "monster": "Gigas",
  "actorId": "1Lw78Js1f7MogV2B",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "random encounter with adds (Valley Encounter row 19: Gigas + 2 Electro Slime); rarer underground",
  "exceptions": [
    {
      "rule": "one-shot",
      "action": "Heavy Swing",
      "why": "The big hit is the threat that pushes the party to land Bolt (a PC skill or a dungeon hazard). Bolt → Frightened until the end of its next turn → Heavy Swing is blocked. Judge it WITH bolt in play.",
      "decided_by": "user",
      "date": "2026-10-21"
    },
    {
      "rule": "vu-count",
      "why": "The world sheet is authoritative: VU bolt/fire/poison + RS physical/air/earth is intended (the 2026-08-14 'VU bolt only' note was superseded on the sheet).",
      "decided_by": "user",
      "date": "2026-10-21"
    }
  ],
  "invariants": [
    {
      "id": "frightened-not-immune",
      "prop": "condition_frightened",
      "equals": "NA",
      "why": "Frightened IS the counterplay. RS/IM here deletes the whole design."
    },
    {
      "id": "bolt-vulnerable",
      "affinity": "bolt",
      "equals": "VU",
      "why": "Bolt is the Rod's element and the counterplay signal."
    },
    {
      "id": "swing-is-attack",
      "item": "Heavy Swing",
      "prop": "skill_type",
      "equals": "Attack",
      "why": "Frightened blocks the Attack label. If Heavy Swing stops being an Attack, the one-shot is no longer gated."
    },
    {
      "id": "bodyslam-is-active",
      "item": "Heavy Bodyslam",
      "prop": "skill_type",
      "equals": "Active",
      "why": "Must survive Frightened's Attack block, or Gigas has no action while Frightened."
    },
    {
      "id": "bodyslam-recoil",
      "item": "Heavy Bodyslam",
      "table": "effect_table",
      "row": "bodyslam_recoil",
      "field": "damage_amount",
      "equals": "100",
      "why": "Self-damage is the payoff for landing the Rod."
    },
    {
      "id": "oaf-any-bolt",
      "item": "Oaf",
      "table": "reaction_config_table",
      "row": "oaf_fear",
      "field": "condition_formula",
      "excludes": "IS_MY_TURN",
      "why": "Any Bolt damage must frighten it (user 2026-10-21) — an IS_MY_TURN gate makes it Rod-only."
    },
    {
      "id": "oaf-bolt-gate",
      "item": "Oaf",
      "table": "reaction_config_table",
      "row": "oaf_fear",
      "field": "condition_formula",
      "contains": "TRIGGER_DAMAGE_IS_BOLT == 1",
      "why": "Bolt is the trigger."
    },
    {
      "id": "frightened-one-charge",
      "item": "Oaf",
      "table": "effect_table",
      "row": "oaf_fear",
      "field": "ae_initial_charges",
      "equals": "1",
      "why": "Charges tick at the end of each of Gigas's own turns; 1 charge = until the end of its next turn when hit off-turn. 3 = a three-turn lockout."
    },
    {
      "id": "club-in-sync",
      "item": "Giant Club",
      "sameAsWorldItem": "MIbpz90syxNxghMh",
      "why": "The embedded copy is what gets stolen; it must match the world item."
    }
  ],
  "blind_spots": [
    "Oaf → Frightened IS simulated in data mode (lib/monster-data.js, since 2026-10-20). Verdicts from before then (registry mode) read Gigas as always swinging — do not reuse them.",
    "BD turn order ignores the Delay AE — 'acts last' is not engine-enforced (lowest DEX+INS makes autopilot pick it last)."
  ],
  "open_questions": [
    "Rod strike lands at the START of Gigas's own turn: with 1 charge, Frightened ends when that same turn ends. Is 'its next turn' that current turn (keep 1 charge), or the following one (needs 2 charges when hit on its own turn)?",
    "Arcane EF 200 is a flat DPR doubling, not a skill expression — keep, or drop to 150?"
  ]
}
```
