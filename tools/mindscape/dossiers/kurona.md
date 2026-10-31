# Kurona

> **Status: draft.** Written 2026-10-31 from the user's rulings of 2026-10-21 to 2026-10-31.
> Stats are read live from the world — the world wins.

## Identity & role

- Actor `vmYeN1WWIF5TSjjF`. Soldier L44, BEAST, HP 30, high initiative.
- **A universal gimmick monster** (user), not a dungeon soldier. It has no Bolt synergy and first
  appears in the Valley Underground.
- **Normally appears in a group of its own. It rarely appears with normal dungeon monsters, though
  it can** (user, 2026-10-31).
- **Can appear on any map, at a low chance** (user, 2026-10-31). Kurona rows are **extra** to an
  area's encounter-group budget, so they never take a slot from the dungeon's own monsters.

## Concept

A weak, fast biter whose real damage happens after the battle. Its bite barely hurts, but it can
give the party Virus, and only Vaccine cures that.

## The gimmick

- **Infectious Bite:** near-zero damage, applies **Virus** and an "Eaten" marker on Kurona. Bat Wings
  lets the bite reach Flying targets.
- **Run Away:** once Eaten, it flees through a party DL 15 DEX+INS group check. A failed check means
  it escapes, so the party has to kill it quickly.
- **Virus:** 5% of max HP in combat and per dungeon turn, stops at 1 HP. No rest, cleanse, revive or
  battle end clears it, it persists across saves, and it can spread silently at Rest.
- **Vaccine** is bought only at the Hako shop. Kurona's steal table is also a source. Hako will be
  wired into the Valley later (user, 2026-10-31).
- Bolt VU on 30 HP: the Crystal blast kills it, and so does an Electro Slime's death burst, so
  mixed rows with slimes defeat themselves.

## Numbers & targets

- Valley odds: surface `Kurona x3` width 1 of 32 (3.1%); Underground `Kurona x3` width 2 and
  `Kurona, Obsidrax` width 1 of 40 (7.5%).
- Overworld chapter tables carry a width-1 solo `Kurona` row. Other dungeon tables have none yet.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-10-22 | Built: Virus on bite, high initiative, Vaccine-only steal table, Run Away | Universal gimmick monster | user (stats, 50/50 steal split: claude) | live: bite, Virus, Run Away work |
| 2026-10-31 | Own group normally, rarely mixed, any map at low chance, rows extra to the budget | Gimmick monster, shouldn't eat encounter budget | user | Valley tables updated |
| 2026-10-31 | Renamed from Crona to Kurona, name only | A play on words | user | actor and all table rows updated |

```json dossier
{
  "monster": "Kurona",
  "actorId": "vmYeN1WWIF5TSjjF",
  "status": "draft",
  "updated": "2026-10-31",
  "role": "universal gimmick monster: own group normally, rarely mixed, any map at a low chance, rows extra to the encounter budget",
  "exceptions": [
    {
      "rule": "basic-attack-min",
      "action": "Infectious Bite",
      "finding": "best basic attack avg 8 < 45",
      "why": "Its basic attack does about 0 damage by design: Virus is the threat.",
      "decided_by": "user",
      "date": "2026-10-21"
    }
  ],
  "candidate_exceptions": [
    {
      "rule": "not-simulated",
      "finding": "not simulated: Run Away: effect group_check"
    }
  ],
  "invariants": [],
  "blind_spots": [
    "The offline sim does not model Run Away, or what Virus costs after the battle, so Kurona fights read as trivial."
  ],
  "open_questions": [
    "Stats and the 50/50 steal split were claude's calls and have not been confirmed.",
    "Other dungeon tables have no Kurona row yet. Check its L44 stats before adding it to lower-level areas."
  ]
}
```
