# Obsidrax — the stone dragon that grounds the Rod

> **Status: draft — intent largely unrecorded.** My only note (2026-08-17) describes a
> bare-shell placeholder; the sheet has since been fully statted with no design record.
> Everything below is read from the sheet; the open questions need the designer.

## Identity & role

- Actor `x8TBsDZaRgoSo5no`. L46 ELEMENTAL/DRAGON soldier, deliberately sized big (token 2.32).
- Valley random encounter, 4 rows (with slimes + Prism, Skizzik, Kirin + Skizzik, Mist Dragon).
- Possibly the "anti-synergy HP wall" slot from the Lightning Surge design idea — unconfirmed.

## The gimmick (as built on the sheet)

- **Lodestone Core:** at the start of its turn while it **holds the Lightning Rod**, it
  discharges beneath a random enemy (30 Earth) and the Rod passes to that creature.
- **IM bolt** — the Rod's strike does nothing to it; it converts the storm into Earth damage
  on the party.
- Miasma Nova (save or Poisoned), Venomstone Spines (multi, Envenomed), Tectonic Collapse
  (Earth to all), Basalt Crush (35% Petrify).

```json dossier
{
  "monster": "Obsidrax",
  "actorId": "x8TBsDZaRgoSo5no",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Valley random encounter (4 Encounter rows) — design role unrecorded",
  "exceptions": [],
  "invariants": [
    { "id": "bolt-immune", "affinity": "bolt", "equals": "IM",
      "why": "Read from the sheet: the Rod cannot hurt it, which is what Lodestone Core turns into Earth damage." },
    { "id": "lodestone-needs-rod", "item": "Lodestone Core", "table": "reaction_config_table", "row": "lc_chain", "field": "condition_formula", "equals": "AE_COUNT_LIGHTNING_ROD > 0",
      "why": "Read from the sheet: only while it holds the Rod." }
  ],
  "blind_spots": [
    "Lodestone Core is modelled in the storm only."
  ],
  "open_questions": [
    "What is Obsidrax's role — the anti-synergy HP wall, a Rod controller, or something else? Nothing records the intent behind the current build.",
    "Miasma Nova's 3-round cooldown never applies (no other row within 2 priority of 11) — it casts every turn while MP lasts. Intended?",
    "Basalt Crush avg 44 sits just under the 45 basic-attack floor — leave?"
  ]
}
```
