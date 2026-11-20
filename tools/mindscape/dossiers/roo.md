# Roo — the Fafnir Castle Tonberry

> **Status: draft.** Seeded 2026-10-21 from the 2026-09-03/04 build notes. Stats are read
> live from the world — the world wins.

## Identity & role

- Actor `VwClo606KbQSK6aQ`, folder Monster / Fafnir Castle. L50 UNDEAD/SPIRIT soldier.
- Random encounter, deliberately **rare by presence across groups** (user): Fafnir Castle
  Encounter rows 11 (Dragon Guard, Roo, Dragon Guard) and 13 (Imp, Death Gazer, Roo, Imp).
- Not the same actor as `Bandit Roo` (`kIvWhnszRhsHafWu`, L25) — encounter rows resolve by exact name.

## Concept

A Tonberry: it walks toward one victim, three steps, does not hurry and does not stop —
then draws the knife. **Easy to hit, hard to hurt** (re-stat 2026-09-04).

## The gimmick

- **Approach** (turn start): marks one victim, ticks a step each turn; on the third it
  arrives (In Melee Range).
- **Chef's Knife** (Active, auto-hit): 9999 Dark that ignores immunities — the arrival is
  lethal. Then the Roo walks away and leaves the conflict (an "escaped" outcome if it was alone).
- The three-step walk IS the warning: kill it, or slow it, before it arrives.
  **`condition_slow` is left open on purpose** — delaying the clock is the counterplay.
- **Who it wants is a secret** (user, 2026-11-19): no tether, marker, name or step counter.
  The party reads the victim from where the Roo walks (it ends beside them, on their floor
  row, growing with depth). Marked and the Approach counter carry `flags.hidden`.
- **IM Physical breaks the "never Immune to Physical" rule on purpose** (Tonberry premise).
  Zarg keeps a Light bow mode (VU light) so he is not locked out; Blanche is.
- The dagger/sword EF is inert against a plain blade (EF × IM = 0) — it pays only for an
  elemental blade. Deliberate; the study text points at it.

## Numbers & targets

- "3 actions at PE 75%" (user) = TP 0.75 → HP sized from that. Accuracy is outside the PE
  model; DEF/MDEF is the first dial to turn, not HP.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-09-03 | Built: Approach, Chef's Knife, Empty Stare, Karma | Tonberry for Fafnir Castle | user | chain verified by direct invocation |
| 2026-09-04 | DEF/MDEF 16 → 13, EF dagger/sword 150 | "easy to hit, hard to hurt" | user | Mindscape DPR +33% |
| 2026-09-03 | Kept row 13 although its Imp can strip the Light weapon that answers the Roo | flagged | user | — |
| 2026-10-31 | AI row "Chef's Knife" picked the loot weapon of the same name, so the knife did nothing in fights; the matcher now prefers the action | found while testing the knife shot | claude | First real run: 9995 to a PC, Knife Drawn, walks out at turn end |
| 2026-11-19 | Approach victim + Chef's Knife never target a summon or guest (IS_SUMMON/IS_GUEST); victim gone (KO'd, left) → walk restarts on a new victim; the action-list lookup still fell to the loot weapon, fixed | "always avoid summons/guests" | user (rule), claude (restart) | sandbox: knife 40/40 on the Marked PC; KO'd victim → new mark, back to step 1 |
| 2026-11-19 | Approach walk rebuilt: planned on the floor (not token.center, which reports the drawn spot on the 3D stage), ends beside the victim on their row, 4 strides + footsteps; tether/chevron/name removed; Marked + Approach counter hidden; walk no longer undone by the turn cue's return-home | "the walk alone tells the story" | user | sandbox BD fight on FafnirCastle_Battlemap001: 3 turns, drawn size within 1% of the depth factor, Roo on Zarg's row, knife 9999 → escaped |
| 2026-11-20 | Token scale 0.95 → 1.50 (all maps) | Sealed Cavern Battler Scale mockup, sized against the Nox Legion on the in-game stage | user | — |

```json dossier
{
  "monster": "Roo",
  "actorId": "VwClo606KbQSK6aQ",
  "status": "draft",
  "match_exclude": ["Bandit Roo"],
  "updated": "2026-10-21",
  "role": "rare random encounter in Fafnir Castle (Encounter rows 11 and 13)",
  "exceptions": [
    {
      "rule": "no-damage-action",
      "why": "Its damage is Chef's Knife (an auto-hit Active, 9999 ignore_immunity) after a three-step Approach — not a rolled attack the audit can read.",
      "decided_by": "claude",
      "date": "2026-09-03"
    }
  ],
  "invariants": [
    { "id": "physical-immune", "affinity": "physical", "equals": "IM",
      "why": "Tonberry premise — physical does nothing." },
    { "id": "light-vulnerable", "affinity": "light", "equals": "VU",
      "why": "Zarg's Light bow is the intended answer." },
    { "id": "slow-left-open", "prop": "condition_slow", "in": ["NA", ""],
      "why": "Delaying the clock is the counterplay." },
    { "id": "knife-ignores-immunity", "item": "Chef's Knife", "item_where": { "skill_type": "Active" }, "table": "effect_table", "row": "ck_cut", "field": "damage_keywords", "equals": "ignore_immunity",
      "why": "crush would only give 5000 vs IM; ignore_immunity is what makes the arrival lethal." },
    { "id": "knife-gated-on-arrival", "table": "action_pattern_table", "where": { "action_pattern_name": "Chef's Knife" }, "field": "action_pattern_string", "equals": "In Melee Range",
      "why": "The knife only comes after the three-step walk — the warning." },
    { "id": "three-steps", "item": "Approach", "table": "reaction_config_table", "where": { "reaction_effect_ref": "ap_step" }, "field": "condition_formula", "equals": "AE_CHARGES_APPROACH < 2 && (AE_CHARGES_APPROACH == 0 || COMBAT_LIVING_MAX_AE_CHARGES_MARKED > 0)",
      "why": "Step / arrive / restart rows are mutually exclusive on the charge count and on whether a living victim is still Marked." },
    { "id": "victim-never-a-decoy", "item": "Approach", "table": "effect_table", "row": "ap_victim", "field": "target_filter", "equals": "IS_SUMMON == 0 && IS_GUEST == 0",
      "why": "The walk is a grudge against a player; a summon or guest can't soak it (user, 2026-11-19)." }
  ],
  "blind_spots": [
    "The three-step Approach into the knife ran start to finish in a sandbox BD fight on 2026-11-19 (GM-driven: party turns forced, the knife's random target rolled by the GM). Not yet seen with real players connected.",
    "Mindscape reads Zarg and Blanche at 0 damage actions (model gap) and does not model Approach — sim verdicts on the Roo are meaningless."
  ],
  "open_questions": []
}
```
