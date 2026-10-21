# ⭐️ Fafnir — the storm that has to breathe

> **Status: draft.** Seeded 2026-10-21 from `docs/fafnir-boss-design.md` (two-phase AI,
> live-tested 2026-09-20) and `docs/fafnir-boss-checkup.md`. Stats are read live from the
> world — the world wins. Not Hilde-Fafnir (`2SFrEMqLBfqzc7Nj`, Fafnir Castle) and not
> Bandit Fafnir (`oVZvfkkXMdxmB3T9`, a joke actor).

## Identity & role

- Actor `P1uCkpNnxLRBNqZr`. L50 **champion**, 4 turns a round.
- **Story boss** of the Valley of the Dragon. Its **adds are Flame Drake + Lightning Drake**
  (Summon Elemental Drake) — judge the drakes inside this fight, never alone.
- Also sits on `Eisendrache Burning - Enemies` [4,4] (a 25% roll in an early area) — the
  tease and the boss are the same actor.

## Concept

A **two-phase** boss driven by her own MP, not HP or a script.
**Aggressive:** attacks with everything, spends MP on Ruinous Breath and the debuff kit.
**Recovery:** when her magic runs dry she breaks off — summons the drakes and Storm Calms.
**That is the window the party plays around** (heal, revive, reposition, or burn her down).
Storm Calm and Summon are recovery-phase actions only.

## The gimmick

- **The phase is a STATE, not a threshold** — a latch AE (Storm Gathering) applied below
  100 MP and removed at ≥ 300 MP. A plain MP gate flickers (each Storm Calm pushes her back over).
- Summon capped at 2 (one pair alive at a time; one dead drake is topped up).
- Lightning Drake's Amplify Bolt boosts Ruinous Breath (Bolt) — left as-is, noted so it is
  not rediscovered as a bug.
- **Cruel Ultimatum** (Zero Power): the party chooses — one of them takes 300 Fire, or all
  take 120 Bolt. Ignores immunities and absorption.
- Condemn and Torment let the target redirect the action onto an ally (player choice).

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-09-20 | Two-phase MP latch AI + Cruel Ultimatum rebuild | flickering phases; broken edict | user | live-tested on Training Ground (no full battle) |

```json dossier
{
  "monster": "⭐️ Fafnir",
  "actorId": "P1uCkpNnxLRBNqZr",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Valley story boss (champion, 4 turns); adds = Flame Drake + Lightning Drake",
  "exceptions": [],
  "invariants": [
    { "id": "phase-enters-below-100", "item": "Storm Gathering", "table": "reaction_config_table", "row": "sg_enter", "field": "condition_formula", "equals": "CUR_MP < 100",
      "why": "Latch on: the recovery phase begins." },
    { "id": "phase-exits-at-300", "item": "Storm Gathering", "table": "reaction_config_table", "row": "sg_exit", "field": "condition_formula", "equals": "CUR_MP >= 300",
      "why": "Latch off: hysteresis, so phases do not flicker." },
    { "id": "summon-recovery-only", "table": "action_pattern_table", "where": { "action_pattern_name": "Summon Elemental Drake" }, "field": "action_pattern_string", "equals": "Storm Gathering",
      "why": "Summon is a recovery-phase action only." },
    { "id": "calm-recovery-only", "table": "action_pattern_table", "where": { "action_pattern_name": "Storm Calm" }, "field": "action_pattern_string", "equals": "Storm Gathering",
      "why": "Storm Calm is a recovery-phase action only." },
    { "id": "summon-cap-2", "item": "Summon Elemental Drake", "table": "effect_table", "row": "summon_drakes", "field": "summon_max", "equals": "2",
      "why": "One pair alive at a time." },
    { "id": "ultimatum-ignores-absorb", "item": "Zero Power: Cruel Ultimatum", "table": "effect_table", "row": "cu_120", "field": "damage_keywords", "equals": "ignore_absorption",
      "why": "Per the edict text." }
  ],
  "blind_spots": [
    "Mindscape cannot simulate the player choices: Torment / Condemn redirects (ask) and Cruel Ultimatum's menu.",
    "The phase latch firing off the live resource ledger is verified by construction, never watched in a resolved fight."
  ],
  "open_questions": [
    "From the checkup, unchanged: Condemn's damage (can drop a healthy PC), the two IM affinities (dark + earth), dagger EF 50 stacking with IM dark.",
    "Zero Trigger: Suffering grants ZP on ANY turn start — up to 8 ZP/round at 4 activations. Intended?",
    "Deployment: also a 25% roll on Eisendrache Burning - Enemies alongside L13-15 soldiers — keep?"
  ]
}
```
