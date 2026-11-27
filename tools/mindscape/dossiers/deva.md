# Deva

> **Status: draft** — scaffolded from the sheet 2026-11-21 and filled from the design history
> (mockup + sim artifacts 2026-10-29 → 2026-11-09, build `_build-deva.js` 2026-11-09) and the
> 2026-11-21 runner playtest. Entries not marked `user` are unconfirmed.

## Identity & role

- Actor `amxILxU7mqQ0jKhZ`. elite L40, Humanoid, 4 turn(s), HP 1500. Summon actor `MsFistSummon0001` "Missile Fist".
- Story elite of Valley of the Dragon, loyal to Fafnir: third of the Asura / Rakshasa / Deva trio.
  Fought at The Kneeling Colossus (Valley_Map029) once Asura and Rakshasa are defeated; arena
  Valley_Battlemap007 with the Lightning Storm.

## Concept

Arrogant angelic brawler with floating energy fists. Trio axis: Asura = element, Rakshasa =
weapon category, **Deva = Strike vs Magic** (the class of the check: vs DEF = Strike, vs MDEF = Magic).

## The gimmick

- **Round parity.** Odd rounds are Guard rounds, even rounds Offense rounds. BD has no Foundry
  combat round in action patterns, so passive "Celestial Discipline" lays marker AEs at
  conflict / round start (Guard Round, Vajra/Maya Stance, Fist Ready, Strike/Magic Form, openers).
- **Guard:** a 50/50 stance each Guard round (Vajra DEF 14 / MDEF 12, Maya the reverse); Missile
  Fist every Guard round: 2 fists, DEF/MDEF 13, 3 hits to break, fuse 2, Detonate 60 flat on a random
  party member. One area attack can crack both (user: AoE is the intended answer; damaging a fist
  never damages Deva).
- **Stacks:** +1 per attack aimed at her (hit or miss), by check class. The higher stack picks the
  Offense form, same-class mapping: Strike Form (HP pressure: Ground Slam, Fists of Fury, Surya Palm)
  or Magic Form (MP pressure: Rahu's Eclipse, Fists of Focus, Kala Strike).
- **Enlightenment** (v4.4): on Offense rounds 4, 8, 12 her first action swaps the form her stacks picked.
- Immune: Provoked (stripped by name on apply — the NPC sheet has no provoked condition), Charm,
  Frightened, Fatigue.
- **Form-bound affinity** (2026-11-24): Fury (Strike Form) = RS Light / VU Dark / attribute LIGHT;
  Focus (Magic Form) = VU Light / RS Dark / attribute DARK; Guard rounds (no form AE) = Neutral, no
  attribute. The change lives on the form AE (holding it IS the affinity), so Enlightenment flips the
  weakness mid-round. Tell = arm colour, visible before the party acts. Other elements and the
  Strike/Magic class stay Neutral: Asura owns the element puzzle, the stances own the class axis.
- **Weapon efficiency** (static): spear 150 (reach beats a brawler), brawling 50 (fists catch
  fists), rest 100. Arcane stays 100 on purpose: every spell uses it, so it would be a second
  Strike/Magic lever.

## Numbers & targets

- v4.3 sim balance accepted by the user at HP 1000 (2026-11-09). Live runner 2026-11-21 at 1000:
  story fight 3.4 rounds, 78% PC HP left → HP 1500 for the 5–6 round target.
- Weapon-heavy parties land in Strike Form most of the time (story runs: Strike 28, Magic 4).
- 2026-11-24 with the Light/Dark weakness: HP 1550 for 5 rounds (1400 ran 4).

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-11-09 | Built v4.3/v4.4 (HP 1000, fists 3 hits / 60, Enlightenment rounds 4-8-12, Fury/Focus hit all enemies) | design artifacts v4.3 + v4.4; user "go" | user | sandbox sims 73–76% party HP |
| 2026-11-21 | Dossier scaffolded | — | claude | — |
| 2026-11-21 | HP 1000 → 1500 | Runner playtest (207 fights, Lightning Storm, guest Kalina): 3.4 rounds at 78% PC HP. User target 5–6 rounds; sweep ×1.4 → 5.4 r, ×1.6 → 6.0 r, ×1.8 → 5.9 r | user | pending real-table look; damage tuning proposed separately |
| 2026-11-21 | Missile Fist Detonate victim pool `enemy` → `party` | "enemy" is relative to the acting token and fails open when a fist acts without one; 1 of 6 detonations hit the other fist | user (bug fix) | — |
| 2026-11-21 | Tuning pass 2: HP 1500 → 1400; Vajra Fist / Mudra Lance 38 → 52, Double Slap 25 → 36, Ground Slam 30 → 45, Fists of Fury 28 → 42, Fists of Focus 12 → 18 (drain 3 × (HR + 18)), Surya Palm 62 → 78, Kala Strike 25 → 38; every attack check +4 → +6; Surya Palm and Kala Strike players-only | At 1500 she missed 30–60% and fights ran 4–5 rounds at ~80% party HP. Confirmation at 1400: 5.2 rounds, lowest party HP 45–76%, 1 KO in 5; all 14 epic casts aimed at a PC | user | real-table look 2026-11-21 evening |
| 2026-11-21 | Missile Fist: (1) engine fix — target-survey matches the performer by token before actor (both fists share one actor; the 2nd fist's Self Hover/Detonate found no performer and lost its turn); (2) Deva re-summons only when no fists are out: Celestial Discipline's round_start Guard row splits on OWN_SUMMON_COUNT (== 0 → guard with Fist Ready, > 0 → guard_nf without) | Every Guard round's new pair (summon_max 2) replaced fists still on the field before their fuse-2 Detonate whenever Deva acted first that round. User pick "A": keep fuse 2; ignored fists always detonate, broken fists come back next Guard round. Runner: 0 self-target errors in 15 fights; fists alive at a Guard round → no re-summon → Detonate lands | user | — |
| 2026-11-24 | Form-bound affinity: Fury = RS Light / VU Dark / attribute LIGHT, Focus = VU Light / RS Dark / attribute DARK, Guard = Neutral (changes on the 4 form AEs); EF spear 150 / brawling 50; HP 1400 → 1550. Engine fix: apply_ae no longer bakes an `attribute` change as a formula ("LIGHT" became "0") | To-do #15 (no affinities since the build; elite rule asks for 1 VU). JRPG shifting-weakness boss: the arm colour shows the weakness before the party acts; Enlightenment flips it mid-round. Party covers both elements (Hina Lux/Lunar Bow/Dark Orbit, Keren and Zarg dark weapons, Zarg dances, Elemental Weapon). Runner, story setup, 10 each: HP 1400 → median 4 rounds (the weakness shortened the fight), HP 1550 → median 5, ~82% party HP left, 0.2 KO/fight; 0 affinity-state mismatches in 19 fights | user | real-table look owed |
| 2026-11-28 | IM Doomed + Grappled (world + `_build-deva.js`) | Boss rule 2026-11-28: every boss/solo elite is IM Charmed, Doomed and Grappled (she already had Charm, Frightened, Fatigue) | user | — |

```json dossier
{
  "monster": "Deva",
  "actorId": "amxILxU7mqQ0jKhZ",
  "status": "draft",
  "updated": "2026-11-28",
  "role": "story elite — Valley of the Dragon, The Kneeling Colossus (Valley_Map029), arena Valley_Battlemap007 with the Lightning Storm",
  "exceptions": [
    {
      "rule": "vu-count",
      "why": "Form-bound affinity: the sheet is Neutral at rest; Fury carries VU Dark and Focus VU Light on the form AE, so every Offense round has exactly 1 VU and Guard rounds have none.",
      "decided_by": "user",
      "date": "2026-11-24"
    }
  ],
  "candidate_exceptions": [
    {
      "rule": "resisted-min",
      "action": "Surya Palm",
      "finding": "resisted hit = 25% of PC HP (< 25%)"
    },
    {
      "rule": "not-simulated",
      "finding": "not simulated: Celestial Discipline: ATTACK_VS_DEF; Celestial Discipline: ATTACK_VS_MDEF; Fists of Focus: HR"
    }
  ],
  "invariants": [],
  "blind_spots": [
    "Missile Fist detonation is rarely seen: the sim party breaks the fists first (~3.4 attacks a fight). A 99-HP-fist probe confirmed Detonate (60) works.",
    "Mindscape cannot model the Strike/Magic class axis (classAffinity is never populated).",
    "Mindscape cannot model the form-bound Light/Dark affinity (it lives on marker AEs); every Deva run caps at 7 rounds / 100% party HP. Use the snapshot runner."
  ],
  "open_questions": [
    "Missile Fist fuse 2 + re-summon rule: fists only detonate if the party leaves them for a full round; the sim party breaks them ~every time (by design — AoE is the answer)."
  ]
}
```
