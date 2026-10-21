# Skizzik — many small hits, storm-fed counter-attacker

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-20 rework notes and
> `docs/skizzik-rework-proposal.md` (§10 as-built). Stats are read live from the world.

## Identity & role

- Actor `I2sSkVIQ4FCunZBE`. L48 ELEMENTAL/SPIRIT soldier, the dungeon's highest initiative.
- The most common Valley soldier: 11 Encounter rows, alone or with slimes, Prism, Kirin,
  Ampere, Obsidrax, Drakoza.

## Concept

**Many small hits, not few big ones.** A fast skirmisher whose damage multiplies through
free attacks.

## The gimmick

- **Static Buildup:** every hit banks Static; the third discharges 30 Bolt into that target.
- **Chain Reaction:** whenever Bolt strikes it (landed or absorbed) → a free Thunder Strike.
  The cause filter stays **BLANK** so the Lightning Storm feeds it — it absorbs the Rod's 30
  Bolt, so a Rod strike buys a free attack *plus* 30 healing. It is a **Rod magnet**.
- **Overload Riposte:** an attack against it whose accuracy result is **even** → a free Bolt
  riposte at the attacker. Uncapped — ~half of its actions in the design.
- Even-parity counter is a deliberate dungeon motif shared with Ampere (payloads differ).
- Rod management is the fight's dominant variance.

## Numbers & targets

- Thunder Strike and HP were cut hard in the rework because the uncapped counter is ~51% of
  its actions; the cost is the extra ACTION, not the number on it.
- Mindscape (2026-08-20): as-built + Lightning Storm = "a real fight"; without the storm, trivial.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-20 | Rework: uncapped even-parity riposte, Chain Reaction, Static; HP & damage cut | many small hits identity | claude | sim: real fight with storm |
| 2026-08-20 | Live test: counter fires but rarely, and hit the WRONG targets | free action inherited the parent's target list | — | open |

```json dossier
{
  "monster": "Skizzik",
  "actorId": "I2sSkVIQ4FCunZBE",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "common Valley soldier (11 Encounter rows); designed WITH the Lightning Storm",
  "exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Thunder Strike",
      "why": "Many small hits: free Thunder Strikes (Chain Reaction) and the uncapped riposte multiply its output, so the base number is low on purpose.",
      "decided_by": "claude",
      "date": "2026-08-20"
    },
    {
      "rule": "absorb",
      "why": "Bolt absorb is the roster interlock — bolt-spamming feeds it (and the Rod heals it).",
      "decided_by": "claude",
      "date": "2026-08-01"
    }
  ],
  "invariants": [
    { "id": "absorbs-bolt", "affinity": "bolt", "equals": "AB",
      "why": "Rod magnet: absorbed bolt is what makes the Rod heal and feed it." },
    { "id": "chain-reaction-storm-fed", "item": "Chain Reaction", "table": "reaction_config_table", "where": { "reaction_trigger": "creature_lose_resource" }, "field": "reaction_cause_filter", "equals": "",
      "why": "BLANK lets the Lightning Storm feed it (Prism's Overcharge sets 'damage' for the opposite reason)." },
    { "id": "chain-reaction-absorb-row", "item": "Chain Reaction", "table": "reaction_config_table", "where": { "reaction_trigger": "creature_gain_resource" }, "field": "condition_formula", "contains": "TRIGGER_DAMAGE_IS_BOLT == 1",
      "why": "Absorbed bolt is an HP GAIN — this mirror row is the only way it ever fires." },
    { "id": "riposte-even-parity", "item": "Overload Riposte", "table": "reaction_config_table", "row": "riposte_strike", "field": "condition_formula", "contains": "ATTACK_CHECK_RESULT % 2 == 0",
      "why": "The even-parity counter motif (shared with Ampere)." },
    { "id": "riposte-targets-attacker", "item": "Overload Riposte", "table": "effect_table", "row": "riposte_target", "field": "candidate_source", "equals": "trigger_attacker",
      "why": "Single-target riposte at the attacker — not a second AoE." }
  ],
  "blind_spots": [
    "Live 2026-08-20: Overload Riposte fired ~1/5 of the design rate and hit the previous action's targets instead of the attacker.",
    "The sim journal does not log enemy free actions — check what a log does not record before concluding from its silence."
  ],
  "open_questions": [
    "Was the riposte mis-targeting (free action inheriting the parent's target list) ever fixed? Balance should not be re-tuned until it is."
  ]
}
```
