# Roper — the stalagmite that breathes

> **Status: draft — built 2026-10-22, tuning open.** Intent below is the user's; numbers
> marked claude are proposals awaiting the designer.

## Identity & role

- Actor `NlYBXQwmXIttrDod`. L46 MONSTER elite, EARTH, **4 activations**, token 2×2.
  Placeholder art: RO stalactic_golem.
- The Valley of the Dragon **Underground's elite**. Always fought **alone** (one width-2 row
  in `Valley of the Dragon Underground - Encounter`). A universal D&D-style monster: it does
  not synergise with the Lightning Crystal on purpose (IM bolt — the blast does nothing).
- A **wall** that dies fast only when the party exploits it: **5–6 landed actions at PE 90%**
  (user, 2026-10-22). HP 600 = typical landed hit ~30 × M 3.7 ≈ 111 per action → ~5.4.

## The gimmick (D&D 5e roper, ported)

- **Tentacle** (basic): Multi 4, heavy Physical, DEX+MIG; each creature hit rolls DL 13
  DEX+MIG or is **Grappled**. Once per round (self marker "Tentacle Lashed", round_end).
- **Bite**: heavy Physical to one creature, AI prefers a Grappled one (`status_focus:Grappled`).
- **Reel** (20 MP): every Grappled creature takes light Physical and stays held.
- **False Appearance**: at conflict start the party rolls a DL 13 (Hard) INS+INS group check;
  on a failure the Roper performs Tentacle as a free action.
- **Severed Tendrils**: Ice damage (or a heavy-weapon hit) frees every creature it holds.
  Exploiting its weakness is also the rescue.
- Grappled's own rule applies (user chose it knowing): effects that target the Roper also hit
  whoever it holds.
- IM bolt · VU ice · RS fire, air · EF heavy 200 / dagger, sword, bow 25.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-10-22 | Concept: Underground elite, always alone, high DEF / moderate MDEF, 4 activations, IM bolt / VU ice / RS fire+air, EF heavy 200 / dagger, sword, bow 25, Tentacle Multi 4 high physical | new elite for the Underground | user | — |
| 2026-10-22 | Size by action count: 5–6 landed actions at PE 90% → HP 600 | user asked for action count instead of rounds | user (600: claude rec, user OK) | — |
| 2026-10-22 | Grappled (not Snared), False Appearance = DL Hard INS+INS group check → free Tentacle | user | user (DL 13: claude) | live: check fires; party passed every time |
| 2026-10-22 | Kit wired from Carlbero; Tentacle needs on_activate_effect_ref; conflict_start passive needs blank reaction_source | first build ran with no grapple/marker (Tentacle ×4/round) | claude | fixed; Tentacle ~1/round, grapple → Bite/Reel live |
| 2026-10-22 | 2 live sims (full party, Crystal): overtime at round 4, party 9% / 14% HP, Roper 363 / 265 of 600; party landed 9–11 hits, avg 26–30 | measurement | claude | tuning proposal to the user |

```json dossier
{
  "monster": "Roper",
  "actorId": "NlYBXQwmXIttrDod",
  "status": "draft",
  "updated": "2026-10-22",
  "role": "Valley Underground elite, always alone; wall that dies in 5–6 landed actions at PE 90% (user, 2026-10-22)",
  "exceptions": [],
  "invariants": [
    { "id": "bolt-immune", "affinity": "bolt", "equals": "IM", "why": "Universal monster, no Crystal synergy by design (user)." },
    { "id": "ice-weak", "affinity": "ice", "equals": "VU", "why": "Ice is the efficient answer and frees grappled allies (Severed Tendrils)." },
    { "id": "four-activations", "prop": "activation", "equals": "4", "why": "Lone elite: 4 actions per round (user)." },
    { "id": "tentacle-wired", "item": "Tentacle", "prop": "on_activate_effect_ref", "equals": "tn_chain", "why": "Without it the save, Grappled and the once-per-round marker never run and Tentacle fires on every activation." }
  ],
  "blind_spots": [
    "Sim party plays far below PE 90% here (no heavy weapon, bow/dagger at 25%, rarely uses Ice) — sim rounds overstate the fight for an exploiting party.",
    "Severed Tendrils' heavy-weapon half reads USED_WEAPON_CATEGORY_IS_HEAVY on a resource-loss payload that may not carry the weapon; unverified (no PC has a heavy weapon).",
    "The offline Mindscape engine is not verified to model the grapple / Reel / Severed Tendrils loop — use live sim.run."
  ],
  "open_questions": [
    "Offence: party fell to 9–14% HP by round 4 while the Roper kept 44–60% HP. Tone damage down, or keep it as a punishing wall?",
    "Is HP 600 right for THIS party (no heavy weapon), or keep the PE 90% design point and accept a longer fight?"
  ]
}
```
