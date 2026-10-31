# Asura — the four-armed element collector

> **Status: draft.** Seeded 2026-10-21 from the 2026-08-19 rework notes,
> `docs/asura-rework-proposal.md` (§9 as-built), `docs/asura-adaptive-affinity-proposal.md`
> and `docs/asura-live-test-report.md`. Stats are read live from the world — the world wins.

## Identity & role

- Actor `0AwQ7wEDz4ISA9mA`. L38 DEMON **elite**, 4 activations, enters every conflict with 0 MP.
- **Standalone story elite**, counterpart to Rakshasa (user, 2026-10-20). Removed from the
  Valley Encounter table that day; GM-spawnable via Valley Enemies row 7.
- **The Lightning Storm is load-bearing** — the HP prices in ~270 damage of Rod strikes.

## Concept

**It collects elements, not numbers.** Every element that damages it leaves a permanent Mark
(+8 damage each); the fourth Mark unlocks Asura Strike. One clock = stack collector,
doomsday clock, "ever-increasing strength" lore and the elemental theme at once.

## The gimmick

- **Adaptive affinity:** fire/bolt/ice/air start **VU**; each Mark AE flips its element to RS
  while that blade is lit. Holding the mark IS the resistance. Quad clears all marks → back
  to VU and the blade reverts to Physical.
- **Elemental Aspect** — the last element that hit it sets the Aspect of its Slash
  (bolt → Paralyzed, ice → Disarmed, air → Silence, fire → Overflow). The Aspect rows filter
  `cause: damage` so the storm cannot set it — **the party owns the blade's element**.
- **Mark rows keep the cause filter BLANK** on purpose — the storm hands it the Bolt mark for
  free. Do not "tidy" this to match the Aspect rows.
- Sword Enchants: self-damage + a Mark + 15 MP (re-arming competes with attacking).
- Single-target basic is the activation count, not a nerf: a 2-target basic at 4 activations
  is a round-1 TPK. Breadth lives on Overflow and Quad.

## Numbers & targets

- 900 HP was derived as 618 (3.0 TP × est. EffDPR) + 270 storm + 30 self-harm. Target party
  HP at the end: 40–60%. Dials in order: Quad per-beat damage, then HP.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-08-19 | Rework: Marks clock, Quad flurry, 4 activations, 900 HP | old build had three unconnected systems | claude | live: automation broken → fixed |
| 2026-08-19 | Adaptive affinity (VU → RS per lit blade) | static VU earth/light meant the party infused earth every turn | claude | n=2: party HP 66% / 84% (easy side) |
| 2026-08-19 | `include_persistent` on every clear row | resets were silent no-ops → TPK | claude (fix) | — |
| 2026-10-20 | Removed from the Valley Encounter table | standalone story elite | user | — |
| 2026-10-31 | Display rename: Quad-Elemental Slash → Asura Strike | User naming pass; no mechanical change | user | name-only diff proved |

```json dossier
{
  "monster": "Asura",
  "actorId": "0AwQ7wEDz4ISA9mA",
  "status": "draft",
  "updated": "2026-10-31",
  "role": "standalone story elite (Rakshasa's counterpart); GM-spawnable via Valley Enemies row 7; designed WITH the Lightning Storm",
  "exceptions": [
    {
      "rule": "vu-count",
      "why": "Adaptive affinity: the four elements start VU and each flips to RS when its Mark is lit — the 4 VU are the puzzle, not a legibility failure.",
      "decided_by": "claude",
      "date": "2026-08-19"
    },
    {
      "rule": "pattern",
      "why": "Starting at 0 MP is the design ('enters every conflict with no MP'): Overflow and Quad must be earned through Enchants and the storm's +30 MP.",
      "decided_by": "claude",
      "date": "2026-08-19"
    }
  ],
  "invariants": [
    { "id": "mark-bolt-cause-blank", "item": "Ascension", "table": "reaction_config_table", "where": { "reaction_effect_ref": "mark_bolt" }, "field": "reaction_cause_filter", "equals": "",
      "why": "The storm must be able to hand it the Bolt mark (priced into HP)." },
    { "id": "aspect-bolt-cause-damage", "item": "Elemental Aspect", "table": "reaction_config_table", "where": { "reaction_effect_ref": "aspect_set_bolt" }, "field": "reaction_cause_filter", "equals": "damage",
      "why": "The storm must NOT set the Aspect — the party owns the blade's element." },
    { "id": "aspect-clear-persistent", "item": "Elemental Aspect", "table": "effect_table", "row": "aspect_clear", "field": "include_persistent", "equals": true,
      "why": "Aspect AEs are persistent_counter; without it Aspects stack silently." },
    { "id": "quad-resets-marks", "item": "Asura Strike", "table": "effect_table", "row": "quad_reset_marks", "field": "include_persistent", "equals": true,
      "why": "Quad's reset was a silent no-op once → RS to everything from round 1 → TPK." },
    { "id": "quad-needs-four-marks", "table": "action_pattern_table", "where": { "action_pattern_name": "Asura Strike" }, "field": "action_pattern_value_1", "equals": "4",
      "why": "The fourth Mark unlocks Quad — the clock." },
    { "id": "mark-worth-8", "item": "Ascension", "table": "effect_table", "row": "ascension_bonus", "field": "damage_amount", "equals": "AE_CHARGES_ASCENSION * 8",
      "why": "Each collected element = +8 damage (the 'ever-increasing strength')." }
  ],
  "blind_spots": [
    "Mindscape: the sim reads Asura HARDER than live (calibration 2026-10-20: live 50% win r9 vs sim 3%) — offset not resolved.",
    "Sim observation: Asura rarely casts Quad (60 MP = its whole pool; enchants lock once all Marks are lit).",
    "Unverified: a free_action whose action_ref is an All Enemy item targets the whole party."
  ],
  "open_questions": [
    "Balance not settled: live samples ran 66–84% party HP vs the 40–60% target. Quad per-beat damage first, then HP?",
    "Should Quad be reachable more often (MP economy), given the sim almost never sees it?"
  ]
}
```
