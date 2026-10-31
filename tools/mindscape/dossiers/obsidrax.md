# Obsidrax — the stone dragon that grounds the Rod

> **Status: draft — intent largely unrecorded.** My only note (2026-08-17) describes a
> bare-shell placeholder; the sheet has since been fully statted with no design record.
> Everything below is read from the sheet; the open questions need the designer.

## Identity & role

- Actor `x8TBsDZaRgoSo5no`. L46 ELEMENTAL/DRAGON soldier, deliberately sized big (token 2.32).
- Valley random encounter: surface with Ampere, Mist Dragon; Underground with slimes, Mana Ray + Ampere,
  Fulgimite, Kurona.
- Possibly the "anti-synergy HP wall" slot from the Lightning Surge design idea — unconfirmed.

## The gimmick (user redesign 2026-10-22)

- **Earthen Wire** (replaced Lodestone Core): whenever Obsidrax would take **bolt** damage it
  takes 0, and one **random enemy** takes that same amount as bolt, computed with THAT
  creature's affinity. Built for the Lightning Storm and the Lightning Crystal, but any bolt
  source counts — a player's bolt action on it redirects too. Works on both the surface and
  the Underground (Lodestone needed the Rod, which the cave does not have).
- Implementation: an `transfer` AE on the Earthen Wire item carries a `creature_takes_damage`
  row (`TRIGGER_DAMAGE_IS_BOLT == 1`) → chain `adjust_damage set 0` + random-enemy targeting +
  `deal_damage "INCOMING_DAMAGE"` bolt. Needs engine `b1ec3638` + the follow-up
  `runtimeEffectTable` fix.
- **Bolt is NA, not IM.** The redirect reads the damage that LANDS; Immune lands 0 and nothing
  is redirected.
- Miasma Nova (save or Poisoned), Venomstone Spines (multi, Envenomed), Tectonic Collapse
  (Earth to all), Basalt Crush (35% Petrify).
- Underground: appears in 40% of Underground encounters (surface about 12.5%).

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-10-21 | Miasma Nova repeating every turn its condition holds: accepted | "already in the design when the monster is created" | user | audit pattern lint → intended |
| 2026-10-21 | Design intent: none yet — the current kit is not a recorded design | user answer | user | — |
| 2026-10-22 | Lodestone Core → Earthen Wire (bolt it would take is redirected to a random enemy, target's affinity applies); bolt IM → NA | Lodestone needed the Rod, so the gimmick was dead in the Underground (no Rod); soft update for both areas | user (NA bolt: claude, required by the redirect) | live sim: 20 + 23 bolt (Zarg's bow, Crystal blast) zeroed on Obsidrax and re-dealt to a party member |
| 2026-10-31 | 2 surface + 4 Underground rows, 12.5% and 40% of fights | Valley tables tightened to JRPG size: surface 1d32, Underground 1d40 | user | sim report in the commit |

```json dossier
{
  "monster": "Obsidrax",
  "actorId": "x8TBsDZaRgoSo5no",
  "status": "draft",
  "updated": "2026-10-22",
  "role": "Valley random encounter (2 surface + 4 Underground Encounter rows, about 12.5% and 40% of fights); bolt-redirect gimmick Earthen Wire (user, 2026-10-22)",
  "exceptions": [
    {
      "rule": "pattern",
      "why": "Miasma Nova firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created.",
      "decided_by": "user",
      "date": "2026-10-21"
    }
  ],
  "invariants": [
    {
      "id": "bolt-lands",
      "affinity": "bolt",
      "equals": "NE",
      "why": "Earthen Wire redirects the bolt damage that LANDS. IM lands 0 and nothing is redirected; RS would halve what the enemy receives."
    },
    {
      "id": "earthen-wire-flagged",
      "item": "Earthen Wire",
      "prop": "isReaction",
      "equals": true,
      "why": "Its reaction rows live on a transfer AE; the reaction lint requires the item flag or every structural rule skips it."
    }
  ],
  "blind_spots": [
    "Earthen Wire lives on a transfer AE read by the BD's pre-HP-write hook; the offline Mindscape engine is not verified to model it — trust live BD sims (sim.run) for Obsidrax fights, not offline numbers.",
    "An attack card still PREVIEWS bolt damage on Obsidrax; the redirect happens at Apply."
  ],
  "open_questions": [
    "Basalt Crush avg 44 sits just under the 45 basic-attack floor — leave?"
  ]
}
```
