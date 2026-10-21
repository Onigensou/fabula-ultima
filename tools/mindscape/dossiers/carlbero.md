# Carlbero — the grab-and-drain breath plant

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-31 build + live-verify notes.
> Stats are read live from the world — the world wins.

## Identity & role

- Actor `B4qRdBIxFN6dZ6MT`, folder Monster / Fafnir Castle. L50 PLANT **elite**, 4 activations.
- **Solo fight** — Fafnir Castle Encounter row 16 (alone); Enemies row 9 (listed, never rolled).
- Lore: a Plant monster born from the pollution mankind causes to nature; it cannot survive fire.

## Concept

An MP loop the party can interfere with: a huge breath that has to be **re-earned** by
grabbing a PC and draining them.

## The gimmick

- **Stinky Breath** costs most of its MP and must be re-earned. **Mind Sap drains 10, not 25,
  on purpose** — at 25 one Sap re-arms the breath and it fires every round, which is not the
  "cast it, then work for the next one" shape.
- **Six cumulative save tiers** (DL16 INS+WLP; tiers 16/14/12/10/8/6): Basic debuffs → Denial
  (the five `disable_action` statuses) → Rot. Two no-repeat Denial draws always leave a PC
  three of five commands plus Guard and Inventory — **it can never fully lock anyone out**,
  and that falls out of the pool rather than a cap.
- **Tentacle Grab → Grappled** (code-backed): Carlbero gains Grappling, which gates the
  re-grab; attacking Carlbero splashes the held ally (shared-space rule). Mind Sap only
  appears while someone is grappled.
- AI priorities 10 / 6 / 5 / 4: Breath exclusive when affordable; the other three sit ONE
  apart so they compete. Spacing them 3 apart was rejected — Sap would chain-drain one PC all
  fight and never swing the Multi 3.
- Counterplay (user): Protect / Keren's shield redirect / heals.

## Numbers & targets

- Built at the user's explicit direction: **4 activations + Multi 3 + heavy**, kept over a
  Pressure objection. Projected ~167 damage per Slap activation against a 471 HP party.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-31 | Built: 4 activations, Multi 3 Slap, six-tier Breath | user's explicit direction | user | live-verified (tiers, AI, grab) |
| 2026-08-31 | Mind Sap drain 10 | breath must be re-earned, not fire every round | claude | — |
| 2026-09-01 | Retext: study/trait flavour + Breath description | action-text voice | user | — |

```json dossier
{
  "monster": "Carlbero",
  "actorId": "B4qRdBIxFN6dZ6MT",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "solo fight in Fafnir Castle (Encounter row 16); Enemies row 9 is listed-never-rolled",
  "exceptions": [
    {
      "rule": "resisted-min",
      "action": "Tentacle Slap",
      "why": "Slap is Multi 3 at 4 activations — the threat is volume across the party, not one hit; per-hit numbers are low on purpose.",
      "decided_by": "user",
      "date": "2026-08-31"
    }
  ],
  "invariants": [
    { "id": "four-activations", "prop": "activation", "equals": "4",
      "why": "User's explicit direction: 4 activations." },
    { "id": "sap-drains-10", "item": "Mind Sap", "table": "effect_table", "row": "cb_sap_gain", "field": "grant_amount", "equals": "10",
      "why": "At 25 one Sap re-arms the breath every round." },
    { "id": "breath-six-tiers", "item": "Stinky Breath", "table": "effect_table", "row": "cb_save", "field": "save_tiers", "equals": "16,14,12,10,8,6",
      "why": "The cumulative tier ladder." },
    { "id": "denial-pool-is-five-commands", "item": "Stinky Breath", "table": "effect_table", "row": "cb_t3", "field": "ae_name_pool", "equals": "Frightened, Paralyzed, Silence, Disarmed, Confused",
      "why": "Exactly the five disable_action statuses — two draws can never lock a PC out." },
    { "id": "breath-exclusive", "table": "action_pattern_table", "where": { "action_pattern_name": "Stinky Breath" }, "field": "action_pattern_priority", "equals": "10",
      "why": "Breath fires whenever affordable." },
    { "id": "sap-one-above-grab", "table": "action_pattern_table", "where": { "action_pattern_name": "Mind Sap" }, "field": "action_pattern_priority", "equals": "6",
      "why": "One apart from Grab (5) and Slap (4) so they compete — 3 apart chain-drains one PC all fight." }
  ],
  "blind_spots": [
    "The interactive save legs (Breath, Grab) dispatch to players' clients — never exercised in a real fight.",
    "No real fight has been played."
  ],
  "open_questions": [
    "Real art: Bandit Shroom stands in; token scale 2.2 pending the Training Ground eyeball pass."
  ]
}
```
