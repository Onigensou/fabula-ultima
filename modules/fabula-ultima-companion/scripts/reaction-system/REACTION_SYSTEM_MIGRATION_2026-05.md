# Reaction System Refactor + New Triggers — 2026-05

## Summary

The reaction system was restructured around a single trigger registry, the
manager was slimmed down by extracting helpers, and **9 new triggers** were
added without altering existing behavior.

## Files added

| File | Role |
|---|---|
| `scripts/reaction-system/reaction-triggers.config.js` | Single source of truth for every trigger key, label, phase bucket, subject-resolution shape, filter set, and aliases |
| `scripts/reaction-system/reaction-manager-helpers.js` | DOM nuke, ownership resolution, window-state machinery, passive source-event helpers (extracted from manager.js) |

## Files modified

| File | Change |
|---|---|
| `scripts/reaction-system/reaction-triggerCore.js` | Reads taxonomy from registry; subject resolution is now table-driven (one switch removed) |
| `scripts/reaction-system/reaction-manager.js` | ~1227 → ~470 lines. Reads phase buckets from registry; window/DOM/socket helpers moved out |
| `module.json` | Loads `reaction-triggers.config.js` before triggerCore and `reaction-manager-helpers.js` before manager |
| `macros/Action Pipeline/CreateActionCard.js` | Emits `creature_critical_hit` / `creature_fumbles_check` after accuracy resolves |
| `macros/Action Pipeline/Create Damage Card.js` | Emits affinity triggers (`creature_takes_vulnerable_damage`, `_takes_weak_damage`, `_resists_damage`, `_absorbs_damage`, `_immune_damage`) and `creature_shield_break` |
| `macros/Action Pipeline/ApplyActiveEffect.js` | `applyEffectToActor` now returns boolean; emits `creature_status_applied` on real (non-duplicate) applications |
| `Game Object/Template/[Item] _Skill Template.json` | Adds 9 trigger dropdown options; updates `reaction_damage_type` visibility formula to include affinity + shield_break triggers; removes the duplicate crisis rows that were in the old template |

## New triggers

| Key | Bucket | Fires from |
|---|---|---|
| `creature_critical_hit` | `resolution_phase` | CreateActionCard, when `accuracy.isCrit && !isFumble` |
| `creature_fumbles_check` | `action_phase` | CreateActionCard, when `accuracy.isFumble` |
| `creature_takes_vulnerable_damage` | `resolution_phase` | Create Damage Card, when `effectivenessLabel === "vu"` |
| `creature_takes_weak_damage` | `resolution_phase` | when `effectivenessLabel === "wp"` |
| `creature_resists_damage` | `resolution_phase` | when `effectivenessLabel === "rs"` |
| `creature_absorbs_damage` | `resolution_phase` | when `effectivenessLabel === "ab"` |
| `creature_immune_damage` | `resolution_phase` | when `effectivenessLabel === "im"` |
| `creature_shield_break` | `resolution_phase` | when `commonPayload.shieldBreak === true` |
| `creature_status_applied` | `resolution_phase` | ApplyActiveEffect, after a real (non-duplicate) effect is created on a target |

All affinity / shield triggers fire **alongside** the existing
`creature_takes_damage` / `creature_recovers_hp` event, merged into the same
`resolution_phase` window. Old reactions keep working.

## Migration impact

### Skill items in player worlds

- **No saved trigger keys were renamed or removed.** The existing 17 keys all
  resolve through the registry exactly as before.
- The legacy aliases `creature_is_targeted` and `creature_perform_action` are
  retained as aliases (they map to `creature_targeted_by_action` and
  `creature_performs_action` respectively).
- Existing `reaction_config_table` rows in player items will continue to fire on
  the same events.

### Skill template (`[Item] _Skill Template.json`)

- This is a **template / sample** file used as a starting point when creating
  new skill items; it is not "live game state". Existing items in players'
  worlds carry their own copy of the skill definition and will keep working
  unchanged — they will not see the new dropdown options until the item
  definition is regenerated/edited.
- Two duplicate `creature_enter_crisis` / `creature_exit_crisis` rows were
  removed from the dropdown options. Saved data with these keys still works.

### Items in `Game Object/Template/[Item] Blazing Sword.json`, etc.

- These template items have empty `reaction_config_table: {}` and are
  unaffected.

### API surface

- `window["oni.ReactionTriggerCore"]` still exposes the same functions; the
  internal switch-cases were replaced by registry lookups but the signatures
  and semantics are unchanged.
- `window["oni.ReactionManager"]` still exposes the same debug helpers
  (`collectReactionsForTrigger`, `getCurrentPhaseBucket`,
  `debugListGMReactionWindows`, `processPassiveDebug`).
- New: `window["oni.ReactionTriggers"]` exposes
  `listTriggers()`, `getTrigger(key)`, `resolveKey(raw)`, `isValidKey(key)`,
  `bucketFor(key)`, `filtersFor(key)`, `subjectShapeFor(key)`. Use this to
  enumerate triggers in any future UI, or to add new triggers from a single
  place.

## Adding a new trigger in the future

1. Append an entry to the `TRIGGERS` array in
   `scripts/reaction-system/reaction-triggers.config.js` — set `key`, `label`,
   `bucket`, `subjectFrom` (use one of the `SUBJECT_*` shapes or a custom
   object), and `filters`.
2. Add a matching dropdown option to
   `Game Object/Template/[Item] _Skill Template.json`.
3. If the new trigger should show the `reaction_damage_type` filter column,
   extend the visibility formula at the `reaction_damage_type` field.
4. Emit the trigger from the appropriate site (combat hook, action pipeline,
   damage card, custom flow). The payload should include enough fields for the
   `subjectFrom` shape to resolve a token; see existing emit sites for
   examples.

No changes to `triggerCore.js` or `manager.js` should be needed — the registry
drives both.
