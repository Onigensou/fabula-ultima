# Fulgimite — chaff that speeds up the Crystal, and sometimes is one

> **Status: draft.** Built 2026-10-31 from the user's brief and the approved mockup.
> Stats are read live from the world.

## Identity & role

- Actor `FulgimiteActor01`. L40 ELEMENTAL/INSECT soldier, Valley Underground.
- Weak utility monster. It is there to bring the Lightning Crystal's blast forward.

## Concept

**A pest on the clock.** It does almost no damage itself. A party that ignores it gets
blown up sooner, and a party that swings at the wrong Crystal gets bitten by the room.

## The gimmick

- **Resonance:** -2 on one Crystal's count, no roll, no cost. AI: always, when a Crystal with
  turns left is reachable (`target_count` 1-99 at priority 8 against Bite at 2).
- **Evasion:** `cannot_be_targeted_by: area`. Harmful actions declaring several targets can't
  pick it, "Up to N" included, and hostile `mode: all` rows skip it. The blast still lands, and
  Absorb Bolt heals it.
- **Impersonation:** 15% per fight with a Crystal, one fake at most, on any encounter (the world
  actor's `impersonates` flag, not the roster). The fake takes 0 from everything. An action
  picking it as the only target draws 18 Bolt + Paralyzed + Slow, then the real creature appears
  at full HP and acts next round. Reaching 0 reveals with no blast and no counter.
- Rules live on the `Crystal Disguise` AE stored on the passive (transfer off), copied onto the
  Crystal by `lightning-crystal.js`.

## Numbers & targets

- About 2 actions to kill at normal efficiency, one-shot allowed at 100% (Heavy EF 200, VU Earth).
- Encounter rows: Paryashera + 2 Fulgimite (weight 1, the one allowed break of "always alone"),
  Fulgimite + Prism (weight 4), Fulgimite + Skizzik + Fulgimite and Fulgimite + Obsidrax (weight 2 each).

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-10-31 | Built as designed | User brief, mockup approved | user | functions proven live; balance not tested, on the user's call |
| 2026-10-31 | Multi-target counts as area: more than one declared target = no hit, so Zarg's "Up to two" bow can't target it | "simple ruling" | user | as built |
| 2026-10-31 | Crystal targeting through `target_eligibility` + `target_count`, not a new AI condition and focus | Same behaviour, less code; an inline focus value is reverted when the sheet opens | claude | live: Resonance always picks a Crystal |
| 2026-10-31 | Rows kept on the smaller table, Prism row widened to 4, so 22.5% of Underground fights | Valley tables tightened to JRPG size: surface 1d28, Underground 1d40 | user | sim report in the commit |

## Open

- A human has not played it. Offline Mindscape does not model the Crystal or the disguise.

```json dossier
{
  "monster": "Fulgimite",
  "actorId": "FulgimiteActor01",
  "status": "draft",
  "updated": "2026-10-31",
  "role": "weak Underground utility soldier that speeds up the Lightning Crystal and may disguise as one",
  "exceptions": [
    {
      "rule": "absorb",
      "why": "Bolt absorb is the brief: the Crystal blast it hastens heals it.",
      "decided_by": "user",
      "date": "2026-10-31"
    }
  ],
  "invariants": [
    { "id": "absorbs-bolt", "affinity": "bolt", "equals": "AB",
      "why": "The blast heals it, and a Bolt hit can never reveal or bump a fake." },
    { "id": "resonance-reaches-crystal", "item": "Resonance", "field": "target_eligibility", "contains": "TARGET_COUNTDOWN",
      "why": "This identifier is what lets ActionReader pick a battlefield object at all." }
  ],
  "blind_spots": [
    "The offline Mindscape engine does not model the Crystal, Resonance or the disguise; use live sim.run with conflictEventOptions.",
    "Sim party brains don't know which Crystal to suspect or how to play around Resonance."
  ],
  "open_questions": [
    "Balance is unmeasured, by the user's call on 2026-10-31."
  ]
}
```
