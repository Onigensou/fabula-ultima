# Imp — strips your gear, then pranks you

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-31 build + live-verify notes.
> Stats are read live from the world — the world wins.

## Identity & role

- Actor `wjGqTFMH0Z7yZkZt`, folder Monster / Fafnir Castle. L50 DEMON soldier.
- Fafnir Castle **gear-stripping disruptor**: 4 Encounter rows (in pairs flanking Dire Orc,
  Dragon Guard, Death Gazer + Roo, the 5-body row).

## The gimmick

- **Strip Weapon / Strip Armor:** DEX+INS contest; on a loss the item leaves the inventory
  until battle end (no re-equip). AI ladder: strip weapons → strip armor → Prank (Disarmed +
  Confused) the robbed.
- **The caster is the answer, not the swordsman:** DEF 15 / MDEF 14 + VU light (user chose
  15/14 explicitly) — a ~33% party physical hit rate. First dial if it plays badly: 14/13.
- In row 13 it can strip the Light weapon that is the only answer to the Roo (flagged, kept).

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-31 | DEF 15 / MDEF 14 | "15 sounds good, go for 14 on MDEF" | user | 32.6% party hit rate |
| 2026-10-20 | Pitchfork dmg 15→43, chk 5→9 | too-weak pass | user | text still says "light" |

```json dossier
{
  "monster": "Imp",
  "actorId": "wjGqTFMH0Z7yZkZt",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "Fafnir Castle disruptor (4 Encounter rows)",
  "exceptions": [],
  "invariants": [
    { "id": "light-vulnerable", "affinity": "light", "equals": "VU",
      "why": "The caster is the answer." },
    { "id": "strip-weapon-slot", "item": "Strip Weapon", "table": "effect_table", "row": "sw_take", "field": "hide_item_slot", "equals": "weapon",
      "why": "Takes the main hand until battle end." },
    { "id": "strip-armor-slot", "item": "Strip Armor", "table": "effect_table", "row": "sa_take", "field": "hide_item_slot", "equals": "armor",
      "why": "Takes the armor until battle end." },
    { "id": "strip-weapons-first", "table": "action_pattern_table", "where": { "action_pattern_name": "Strip Weapon" }, "field": "action_pattern_priority", "equals": "10",
      "why": "Top of the strip ladder." }
  ],
  "blind_spots": [
    "The interactive contest leg dispatches to players' clients — never exercised solo-GM.",
    "Gauntlet continuation (stolen gear must not return on an in-place reinforce) verified by construction only."
  ],
  "open_questions": [
    "Brawling EF 175 is dead while Blanche uses a shield — keep as the 'party just lost its weapons' counter?",
    "Pitchfork's description still says 'light' after the 15→43 raise — retext?"
  ]
}
```
