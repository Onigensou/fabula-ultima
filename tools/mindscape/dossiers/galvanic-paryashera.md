# Galvanic Paryashera — the cave beast that drinks lightning

> **Status: draft — built 2026-10-31, tuning open.** Intent below is the user's; numbers
> marked claude are proposals awaiting the designer. Was the soldier Galvanize Golem.

## Identity & role

- Actor `ym6As1q7yG1EMl9M`. L46 BEAST / Reptilian elite, Lightning attribute, **4 activations**.
- **Always fought alone** (one width-2 row in `Valley of the Dragon Underground - Encounter`).
- Concept (user): a moderate fight that **spikes hard once Bolt hits it**. Built for the
  Lightning Crystal. Goal for the Supercharged phase (user, 2026-10-31): "super strong, but
  still beatable, just very inconvenient and tiresome".
- Paryashera family signature (user): cloaks itself in steam, plays with Hidden, drill attacks.
  Molten Paryashera is the fire version (sprite only). Underground only: under the Storm the
  Rod makes Bolt on it near-unavoidable, so the concept breaks there.

## The gimmick

- **Steam Veil** gains Hidden, once per round. **Spiral Drill** only fires while Hidden and
  ends it, so the rhythm is hide, then strike. While Hidden a single-target PC can still hit
  the Crystal (buying turns), use an area attack, or spend an Objective on Reveal.
- **Super Charge**: the first Bolt damage plays the form change and applies **Supercharge**
  until battle end, once. It adds +2 Accuracy, +10 damage, +2 DEF/MDEF, RS Physical, IM Bolt,
  EF spear 200 / heavy 150 / dagger 150, and swaps to the Supercharged art (AE `poseArt` flag).
  No die rise (user: a solo elite's dice are big enough).
- The Crystal ticks on EVERY turn, activations included: about 8 turns a round, so an untouched
  blast lands in 0.75 to 1.1 rounds. The play is **delay**, not "kill it first"; each delayed
  turn is one less activation at full power. Damage on the Crystal ADDS turns.
- **Thunder Vent** is gated by a hidden "Vent Ready" marker (one per round; 30 of 60 MP caps it
  at two), because the row's cooldown did not hold in a live battle.
- RS earth on purpose: the Crystal's best delay does little to the monster.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-10-22 | Super Charge concept, once per battle, until battle end | Crystal soldier | user | built as Golem |
| 2026-10-31 | Promoted to solo 4-activation elite, renamed, lore = cave beast, steam/Hidden/drill kit | user brief | user (kit: claude, passed by user) | live: rhythm and AI work |
| 2026-10-31 | HP 420; VU ice, RS earth + poison; EF spear 150, heavy 125, dagger 125, bow 100, brawling 75, sword 75 | "moderate" + spike | user (numbers: claude) | see below |
| 2026-10-31 | Galvanic Drill deals Bolt with Pierce; Thunder Vent damage kept | user | user | — |
| 2026-10-31 | Supercharge keeps flat DEF/MDEF +2 | Asked to check the band: DEF 14 = 40.5%, MDEF 13 = 49.2%, under the DEF 15 wall line; offline sim costs 4-7 points of win rate | user (verdict +2: claude) | keys moved to `defense` / `magic_defense`: `bonus_*` does nothing on an NPC |
| 2026-10-31 | IM Charm + Grappled | solo elite rule | user | — |
| 2026-10-31 | Bespoke shots: silhouette drill ram, purple bolts per target, form-change burst; token scale 2.2 | live review | user (shots: claude) | first review owed |
| 2026-10-31 | HP 420 -> **520**; animations approved | Live sims at 420 read too easy (2-3 rounds, 61-92% party HP) | user (number: claude) | 6 live sims, all 3-round wins: 0 Crystals 91%, 80%; 1 Crystal 60%, 66%, 79%; 2 Crystals 70%. Keren down in 2 of the 4 Crystal fights |
| 2026-10-31 | Spiral + Galvanic Drill = bare `chain 6`, shot cues each tick with oni.hit() | Purely visual: one roll and one damage shown as six ticks; passives fire once | user (count: claude) | live: 12 cues for 2 casts; balance approved at HP 520 |
| 2026-10-31 | Galvanic Drill gains Overflow (all enemies, one check), keeps Pierce + Chain 6 | "If players can handle it, they can take more hits"; absurd multi-hit visual | user | one live sim: overtime at round 8, party 26%, Zarg + Keren down, 9 casts. User watched it and accepted the risk, leaving it to real play |

**Live sims 2026-10-31 (real BD, 4 PCs, no guest, sim party brain):** 1 Crystal: win in 3 rounds at 61% party HP; 2 rounds at 74%; 3 rounds at 75%. 2 Crystals: 3 rounds at 71%. No PC down in any. With guest Kalina: 2 rounds at 75%. Sample is small and the sim party does not manage the Crystal or use Reveal, but it does make Ice through Gadgets and Thermokinesis. Those were at HP 420; see the decision log for 520.

```json dossier
{
  "monster": "Galvanic Paryashera",
  "actorId": "ym6As1q7yG1EMl9M",
  "aliases": ["Paryashera", "Galvanize Golem"],
  "status": "draft",
  "updated": "2026-10-31",
  "role": "Valley Underground elite, always alone; moderate fight that spikes once Bolt hits it (user, 2026-10-31)",
  "exceptions": [],
  "invariants": [
    { "id": "bolt-lands", "affinity": "bolt", "equals": "NE", "why": "Super Charge fires on Bolt damage taken, so it has to land; it becomes IM only through the AE." },
    { "id": "ice-weak", "affinity": "ice", "equals": "VU", "why": "The one clear weakness (user-approved)." },
    { "id": "four-activations", "prop": "activation", "equals": "4", "why": "Solo elite (user)." },
    { "id": "charm-immune", "prop": "condition_charm", "equals": "IM", "why": "Solo elite rule (user, 2026-10-31)." }
  ],
  "blind_spots": [
    "The offline Mindscape engine does not model Hidden, Super Charge or the Crystal; use live sim.run with conflictEventOptions.crystalCount.",
    "Sim party brains ignore the Crystal and never use Reveal, so a real party's Hidden windows and clock play are unmeasured."
  ],
  "open_questions": [
    "HP 520 is unproven with real players; the sim party ignores the Crystal and Reveal. User owns the verdict.",
    "A human has not played it. Reveal was proven through the skill simulator, not by a player."
  ]
}
```
